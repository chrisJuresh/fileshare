// Walking an item tree (outbox entry, library entry, staging entry): file list, fingerprint,
// Syncthing temp-file detection. Walks never follow symlinks.
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

export interface TreeFile {
  /** '/'-separated path relative to the entry root ('' for a single-file entry). */
  rel: string;
  /** Path segments relative to the entry root ([] for a single-file entry). */
  segs: string[];
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
}

export interface TreeScan {
  kind: 'file' | 'dir' | 'missing' | 'other';
  /** Regular files, sorted by byte order of their relative path. Excludes Syncthing temp files. */
  files: TreeFile[];
  /** Sub-directories (relative, '/'-separated), parents before children. Excludes the root. */
  dirs: string[];
  /** Number of Syncthing temp files found below the entry. */
  tmpCount: number;
  /** Relative paths of symlinks / sockets / devices etc. */
  special: string[];
}

const SYNCTHING_TMP = [/^\.syncthing\..*\.tmp$/s, /^~syncthing~.*\.tmp$/s];

export function isSyncthingTmp(name: string): boolean {
  return SYNCTHING_TMP.some((re) => re.test(name));
}

/** Byte-order comparison of strings (UTF-8), so ordering is deterministic and locale-free. */
export function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Scan an entry. Throws on I/O errors other than "entry missing". */
export async function scanTree(root: string): Promise<TreeScan> {
  const out: TreeScan = { kind: 'missing', files: [], dirs: [], tmpCount: 0, special: [] };
  let st;
  try {
    st = await lstat(root);
  } catch (err) {
    if (isNotFound(err)) return out;
    throw err;
  }
  if (st.isFile()) {
    out.kind = 'file';
    out.files.push({ rel: '', segs: [], size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev });
    return out;
  }
  if (!st.isDirectory()) {
    out.kind = 'other';
    return out;
  }
  out.kind = 'dir';
  // Iterative pre-order walk; children sorted so output order is deterministic.
  const stack: string[][] = [[]];
  while (stack.length > 0) {
    const segs = stack.pop()!;
    const dirPath = path.join(root, ...segs);
    const entries = await readdir(dirPath, { withFileTypes: true });
    entries.sort((a, b) => byteCompare(a.name, b.name));
    const subdirs: string[][] = [];
    for (const e of entries) {
      const childSegs = [...segs, e.name];
      const rel = childSegs.join('/');
      if (isSyncthingTmp(e.name)) {
        out.tmpCount++;
        continue;
      }
      const cst = await lstat(path.join(dirPath, e.name));
      if (cst.isDirectory()) {
        out.dirs.push(rel);
        subdirs.push(childSegs);
      } else if (cst.isFile()) {
        out.files.push({ rel, segs: childSegs, size: cst.size, mtimeMs: cst.mtimeMs, ino: cst.ino, dev: cst.dev });
      } else {
        out.special.push(rel);
      }
    }
    // push in reverse so the smallest name is processed first
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]!);
  }
  out.files.sort((a, b) => byteCompare(a.rel, b.rel));
  return out;
}

/**
 * Fingerprint of a tree: kind + every file's (path, size, mtimeMs) + dirs + specials + temp-file count.
 * Equal fingerprints mean "nothing observable changed".
 */
export function fingerprint(scan: TreeScan): string {
  const h = createHash('sha256');
  h.update(`k\0${scan.kind}\0t\0${scan.tmpCount}\n`);
  for (const f of scan.files) h.update(`f\0${f.rel}\0${f.size}\0${f.mtimeMs}\n`);
  for (const d of scan.dirs) h.update(`d\0${d}\n`);
  for (const s of scan.special) h.update(`s\0${s}\n`);
  return h.digest('hex');
}

/** Same as fingerprint() but also covers inode identity (used to detect replaced files). */
export function identityFingerprint(scan: TreeScan): string {
  const h = createHash('sha256');
  h.update(fingerprint(scan));
  for (const f of scan.files) h.update(`i\0${f.rel}\0${f.dev}\0${f.ino}\n`);
  return h.digest('hex');
}

export function totalBytes(scan: TreeScan): number {
  return scan.files.reduce((s, f) => s + f.size, 0);
}
