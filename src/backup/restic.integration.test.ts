// Real restic round trip (the restore test): init → backup of a synthetic library →
// covering-run detection → forget → check → restore (full and single item) → compare hashes.
//
// Needs restic 0.19.1. Uses $RESTIC_TEST_BIN if set; otherwise downloads the official static
// binary once (sha256-verified) into the OS temp dir. Skips with a message when offline.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type BackupRunRow, type Db } from '../db/index.js';
import { createLogger } from '../log.js';
import { findCoveringBackup, requestSnapshot } from './queue.js';
import { runRestic, resticEnv, type ResticEnv } from './restic.js';
import { BackupRunner } from './runner.js';

const VERSION = '0.19.1';
const ASSETS: Record<string, { file: string; sha256: string }> = {
  x64: { file: `restic_${VERSION}_linux_amd64.bz2`, sha256: 'f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c' },
  arm64: { file: `restic_${VERSION}_linux_arm64.bz2`, sha256: 'a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465' },
};

async function resticBinary(): Promise<{ bin?: string; reason?: string }> {
  if (process.env.RESTIC_TEST_BIN) return { bin: process.env.RESTIC_TEST_BIN };
  const asset = ASSETS[process.arch];
  if (process.platform !== 'linux' || !asset) return { reason: `no restic asset for ${process.platform}/${process.arch}` };
  const cacheDir = path.join(os.tmpdir(), 'fileshare-test-cache', `restic-${VERSION}`);
  const bin = path.join(cacheDir, 'restic');
  if (existsSync(bin)) return { bin };
  try {
    const res = await fetch(`https://github.com/restic/restic/releases/download/v${VERSION}/${asset.file}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return { reason: `download failed: HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const sum = createHash('sha256').update(buf).digest('hex');
    if (sum !== asset.sha256) return { reason: `sha256 mismatch for ${asset.file}` };
    const out = spawnSync('bzip2', ['-dc'], { input: buf, maxBuffer: 256 * 1024 * 1024 });
    if (out.status !== 0) return { reason: 'bzip2 not available to unpack restic' };
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(`${bin}.tmp`, out.stdout);
    chmodSync(`${bin}.tmp`, 0o755);
    renameSync(`${bin}.tmp`, bin);
    return { bin };
  } catch (err) {
    return { reason: `offline? ${(err as Error).message}` };
  }
}

const found = await resticBinary();
if (!found.bin) console.warn(`[restic integration] SKIPPED: ${found.reason}`);

const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');

/** relative path → sha256 for every file under `root`. */
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p)] = sha(p);
    }
  };
  walk(root);
  return out;
}

describe.skipIf(!found.bin)(`restic ${VERSION} round trip (real binary)`, () => {
  let dir: string;
  let db: Db;
  let runner: BackupRunner;
  let restic: ResticEnv;
  let library: string;
  let secrets: string;
  let syncthingConfig: string;

  const run = async (args: string[]) => runRestic(restic, args).result;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'fileshare-restic-it-'));
    library = path.join(dir, 'data', 'library');
    secrets = path.join(dir, 'secrets');
    syncthingConfig = path.join(dir, 'syncthing-config');
    const repo = path.join(dir, 'restic'); // exists but empty, like a fresh bind mount
    for (const d of [library, secrets, repo, path.join(syncthingConfig, 'index-v2')]) mkdirSync(d, { recursive: true });

    // Synthetic library: a single file and a nested directory of random data.
    writeFileSync(path.join(library, 'single.bin'), randomBytes(3 * 1024 * 1024 + 17));
    mkdirSync(path.join(library, 'Album', 'Disc 1'), { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(path.join(library, 'Album', 'Disc 1', `track-${i}.dat`), randomBytes(64 * 1024 + i));
    writeFileSync(path.join(library, 'Album', 'notes.txt'), 'synthetic test data\n');

    writeFileSync(path.join(secrets, 'restic-password'), randomBytes(24).toString('base64url'), { mode: 0o600 });
    writeFileSync(path.join(secrets, 'share-hmac-key'), randomBytes(32).toString('base64url'), { mode: 0o600 });
    writeFileSync(path.join(syncthingConfig, 'config.xml'), '<configuration version="51"></configuration>\n');
    writeFileSync(path.join(syncthingConfig, 'index-v2', 'main.db'), randomBytes(1024));
    writeFileSync(path.join(dir, '.env'), 'PUBLIC_BASE_URL=https://files.example.com\n');

    restic = {
      bin: found.bin!,
      repository: repo,
      passwordFile: path.join(secrets, 'restic-password'),
      cacheDir: path.join(dir, 'state', 'restic-cache'),
    };
    db = openDb(path.join(dir, 'state', 'fileshare.db'));
    runner = new BackupRunner({
      db,
      log: createLogger('silent'),
      restic,
      libraryDir: library,
      dbBackupPath: path.join(dir, 'state', 'backup', 'fileshare.db'),
      extraPaths: [path.join(dir, '.env'), secrets, syncthingConfig],
      excludes: [path.join(secrets, 'restic-password'), `${syncthingConfig}/index-*`],
      debounceMs: 120_000,
      pause: { startMin: 0, endMin: 0 }, // empty window: never paused
    });
  });

  afterAll(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('initialises the missing repository', async () => {
    expect(await runner.repoExists()).toBe(false);
    expect(await runner.ensureRepo()).toBe(true);
    expect(await runner.repoExists()).toBe(true);
    const init = db.prepare(`SELECT * FROM backup_runs WHERE kind = 'init'`).get() as BackupRunRow;
    expect(init.status).toBe('ok');
  }, 60_000);

  it('backs up, records library entries and is found as the covering run', async () => {
    const libraryAt = Date.now();
    requestSnapshot(db, 'ingest');
    const outcome = await runner.backup('debounce');
    expect(outcome.status).toBe('ok');
    expect(outcome.snapshotId).toMatch(/^[0-9a-f]{8}$/);
    const covering = findCoveringBackup(db, 'Album', libraryAt);
    expect(covering?.snapshot_id).toBe(outcome.snapshotId);
    expect(findCoveringBackup(db, 'not-there', libraryAt)).toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) n FROM backup_requests WHERE run_id IS NULL').get() as { n: number }).n).toBe(0);

    // A later item is not covered until the next backup.
    const laterAt = Date.now() + 1;
    writeFileSync(path.join(library, 'later.bin'), randomBytes(100_000));
    await new Promise((r) => setTimeout(r, 5));
    expect(findCoveringBackup(db, 'later.bin', laterAt)).toBeUndefined();
    const second = await runner.backup('debounce');
    expect(second.status).toBe('ok');
    expect(findCoveringBackup(db, 'later.bin', laterAt)?.snapshot_id).toBe(second.snapshotId);
  }, 120_000);

  it('applies the excludes (no restic password, no Syncthing DB) and includes the DB copy', async () => {
    const ls = await run(['ls', 'latest', '--json']);
    expect(ls.code).toBe(0);
    const paths = ls.json.map((n) => (n as { path?: string }).path).filter(Boolean) as string[];
    expect(paths).toContain(path.join(secrets, 'share-hmac-key'));
    expect(paths).not.toContain(path.join(secrets, 'restic-password'));
    expect(paths).toContain(path.join(syncthingConfig, 'config.xml'));
    expect(paths.some((p) => p.includes('index-v2'))).toBe(false);
    expect(paths).toContain(path.join(dir, 'state', 'backup', 'fileshare.db'));
    expect(paths).toContain(path.join(dir, '.env'));
  }, 60_000);

  it('forgets/prunes and checks', async () => {
    const forget = await runner.forget();
    expect(forget.status).toBe('ok');
    expect(forget.summary).toMatchObject({ kept: 2, removed: 0 });
    const check = await runner.check();
    expect(check.status).toBe('ok');
  }, 120_000);

  it('restores everything and a single item byte-for-byte', async () => {
    const original = hashTree(library);
    const target = path.join(dir, 'restore-full');
    const full = await run(['restore', 'latest', '--target', target]);
    expect(full.code).toBe(0);
    expect(hashTree(path.join(target, library))).toEqual(original);

    // The DB copy restores as a valid SQLite database.
    const restoredDb = openDb(path.join(target, dir, 'state', 'backup', 'fileshare.db'));
    expect((restoredDb.prepare(`SELECT COUNT(*) n FROM backup_runs WHERE kind = 'init'`).get() as { n: number }).n).toBe(1);
    restoredDb.close();

    const one = path.join(dir, 'restore-one');
    const single = await run(['restore', 'latest', '--target', one, '--include', path.join(library, 'Album')]);
    expect(single.code).toBe(0);
    const restored = hashTree(path.join(one, library));
    const expected = Object.fromEntries(Object.entries(original).filter(([k]) => k.startsWith('Album/')));
    expect(restored).toEqual(expected);
    expect(existsSync(path.join(one, library, 'single.bin'))).toBe(false);
    expect(statSync(path.join(one, library, 'Album', 'Disc 1')).isDirectory()).toBe(true);
  }, 120_000);

  it.skipIf(process.getuid?.() === 0)('accepts unreadable files outside the library, fails on unreadable library files', async () => {
    const outside = path.join(syncthingConfig, 'unreadable.xml');
    writeFileSync(outside, 'synthetic');
    chmodSync(outside, 0o000);
    const ok = await runner.backup('manual');
    expect(ok.status).toBe('ok');
    expect(JSON.stringify(ok.summary)).toContain('unreadable.xml');
    rmSync(outside);

    const inside = path.join(library, 'Album', 'locked.bin');
    writeFileSync(inside, randomBytes(1000));
    chmodSync(inside, 0o000);
    const bad = await runner.backup('manual');
    expect(bad.status).toBe('failed');
    expect(bad.error).toContain('locked.bin');
    rmSync(inside);
    runner.resetBackoff();
  }, 120_000);

  it('does not leak the repository password into the restic environment', () => {
    const env = resticEnv(restic);
    expect(Object.keys(env)).not.toContain('RESTIC_PASSWORD');
    expect(env.RESTIC_PASSWORD_FILE).toBe(restic.passwordFile);
  });
});
