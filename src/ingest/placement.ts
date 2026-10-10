// Placing items into the library (hard links / rename) and the guarded outbox removal.
// Invariant (docs/ARCHITECTURE.md §4): an outbox file is never deleted unless it is verified to be
// the same inode as its library counterpart (and the caller has confirmed snapshot coverage).
import { chmod, link, lstat, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { scanTree, type TreeScan } from './tree.js';

export const DIR_MODE = 0o750;

/** mkdir -p with every directory WE create set to 0750 (umask-independent). */
export async function mkdirp0750(dir: string): Promise<void> {
  const missing: string[] = [];
  let cur = path.resolve(dir);
  for (;;) {
    try {
      const st = await stat(cur);
      if (!st.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      missing.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  for (const d of missing.reverse()) {
    try {
      await mkdir(d, { mode: DIR_MODE });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      continue;
    }
    await chmod(d, DIR_MODE);
  }
}

async function mkdirOwned(d: string): Promise<void> {
  try {
    await mkdir(d, { mode: DIR_MODE });
    await chmod(d, DIR_MODE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const st = await lstat(d);
    if (!st.isDirectory()) throw new PlacementError('library path exists and is not a directory');
  }
}

export class PlacementError extends Error {}

async function linkIdempotent(src: string, dst: string, expect: { dev: number; ino: number }): Promise<void> {
  try {
    await link(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const st = await lstat(dst);
    if (!st.isFile() || st.ino !== expect.ino || st.dev !== expect.dev) {
      throw new PlacementError('library path already exists with different content');
    }
  }
  const st = await lstat(dst);
  if (st.ino !== expect.ino || st.dev !== expect.dev) throw new PlacementError('hard link did not preserve the inode');
}

/**
 * Hard-link every file of `scan` (taken from `srcRoot`) into `dstRoot`. Directories are created
 * with mode 0750; files keep their inode (and therefore mode/owner). Idempotent: an existing
 * destination that is already the same inode is accepted (crash recovery).
 */
export async function hardlinkTree(srcRoot: string, dstRoot: string, scan: TreeScan): Promise<void> {
  if (scan.special.length > 0) throw new PlacementError('item contains symlinks or special files');
  await mkdirp0750(path.dirname(dstRoot));
  if (scan.kind === 'file') {
    const f = scan.files[0]!;
    await linkIdempotent(srcRoot, dstRoot, f);
    return;
  }
  if (scan.kind !== 'dir') throw new PlacementError(`cannot place entry of kind ${scan.kind}`);
  await mkdirOwned(dstRoot);
  for (const d of scan.dirs) await mkdirOwned(path.join(dstRoot, ...d.split('/')));
  for (const f of scan.files) await linkIdempotent(path.join(srcRoot, ...f.segs), path.join(dstRoot, ...f.segs), f);
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify that `a` and `b` contain exactly the same files (and dirs), each file being the same
 * inode on the same device, with no symlinks/specials/temp files anywhere.
 */
export function compareLinked(a: TreeScan, b: TreeScan): VerifyResult {
  if (a.kind !== b.kind) return { ok: false, reason: `kind differs (${a.kind} vs ${b.kind})` };
  if (a.kind !== 'file' && a.kind !== 'dir') return { ok: false, reason: `unexpected kind ${a.kind}` };
  if (a.tmpCount > 0 || b.tmpCount > 0) return { ok: false, reason: 'temporary files present' };
  if (a.special.length > 0 || b.special.length > 0) return { ok: false, reason: 'symlinks or special files present' };
  if (a.files.length !== b.files.length) return { ok: false, reason: 'file count differs' };
  if (a.dirs.length !== b.dirs.length) return { ok: false, reason: 'directory count differs' };
  const bDirs = new Set(b.dirs);
  for (const d of a.dirs) if (!bDirs.has(d)) return { ok: false, reason: 'directory set differs' };
  const bFiles = new Map(b.files.map((f) => [f.rel, f]));
  for (const f of a.files) {
    const g = bFiles.get(f.rel);
    if (!g) return { ok: false, reason: 'file set differs' };
    if (g.ino !== f.ino || g.dev !== f.dev) return { ok: false, reason: 'a file is not the same inode' };
  }
  return { ok: true };
}

export type RemovalResult =
  | { result: 'removed' }
  | { result: 'absent' }
  | { result: 'mismatch'; reason: string; restored: boolean };

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Remove an outbox entry after verifying it is fully hard-linked into the library.
 *
 * 1. verify in place (cheap reject);
 * 2. atomically rename the entry to `trashPath` (outside the Syncthing folder, same filesystem), so
 *    nothing Syncthing writes afterwards can be caught by the delete;
 * 3. verify the quarantined tree again;
 * 4. only then `rm -r` it. On a late mismatch the entry is renamed back (if its slot is still free).
 *
 * Crash recovery: if `outboxPath` is gone but `trashPath` exists, steps 3–4 are re-run.
 */
export async function removeVerifiedOutboxEntry(
  outboxPath: string,
  libraryPath: string,
  trashPath: string,
): Promise<RemovalResult> {
  const lib = await scanTree(libraryPath);
  if (lib.kind !== 'file' && lib.kind !== 'dir') {
    return { result: 'mismatch', reason: 'library copy is missing', restored: false };
  }
  if (await exists(outboxPath)) {
    const pre = compareLinked(await scanTree(outboxPath), lib);
    if (!pre.ok) return { result: 'mismatch', reason: pre.reason, restored: false };
    if (await exists(trashPath)) {
      return { result: 'mismatch', reason: 'quarantine path already in use', restored: false };
    }
    await mkdirp0750(path.dirname(trashPath));
    await rename(outboxPath, trashPath);
  } else if (!(await exists(trashPath))) {
    return { result: 'absent' };
  }
  const post = compareLinked(await scanTree(trashPath), await scanTree(libraryPath));
  if (!post.ok) {
    let restored = false;
    if (!(await exists(outboxPath))) {
      await rename(trashPath, outboxPath);
      restored = true;
    }
    return { result: 'mismatch', reason: post.reason, restored };
  }
  await rm(trashPath, { recursive: true, force: false });
  return { result: 'removed' };
}
