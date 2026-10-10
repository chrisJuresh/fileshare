// Real app + real Syncthing + real restic runner: a ~1.5 GiB file is copied SLOWLY into the "PC"
// folder (like a Windows copy, ~60 s) next to a nested folder. Proves: nothing is placed or hashed
// before the outbox entry has been quiet for INGEST_QUIET_SECONDS; the outbox entry (and therefore
// the PC copy) survives until a covering snapshot row exists; then it disappears from BOTH sides; the
// library copy's hashes match; the item is ready. Then restores from the snapshot following
// docs/RUNBOOK.md ("Restore a single item" and "Full restore" step 3) and compares hashes.
import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomFillSync } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { BackupRunRow, ItemRow } from '../../src/db/index.ts';
import { openStackDb, SCRATCH, sha256File, sleep, stack, writeRandomFile } from '../helpers/stack.ts';

test.describe.configure({ mode: 'serial' });

const MiB = 1024 * 1024;
const BIG = Number(process.env.FILESHARE_INGEST_BYTES ?? 1536 * MiB);
const COPY_SECONDS = Number(process.env.FILESHARE_INGEST_COPY_SECONDS ?? 60);

const tag = randomBytes(4).toString('hex');
const entry = `ingest-${tag}`;
const expected = new Map<string, string>(); // rel path → sha256
let itemName = '';

/** path:size:mtime of everything under `root` (incl. Syncthing temp files); '' if missing. */
async function fingerprint(root: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const name of (await readdir(d)).sort()) {
      const p = path.join(d, name);
      const st = await lstat(p);
      if (st.isDirectory()) await walk(p, `${rel}${name}/`);
      else parts.push(`${rel}${name}:${st.size}:${st.mtimeMs}`);
    }
  };
  try {
    const st = await lstat(root);
    if (!st.isDirectory()) return `file:${st.size}:${st.mtimeMs}`;
    await walk(root, '');
  } catch {
    return '';
  }
  return parts.join('|');
}

async function hashTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(path.join(d, e.name), `${rel}${e.name}/`);
      else out.set(`${rel}${e.name}`, await sha256File(path.join(d, e.name)));
    }
  };
  await walk(root, '');
  return out;
}

/** Writes `size` random bytes into `file` in 8 MiB chunks spread over `seconds` (a slow copy). */
async function slowCopy(file: string, size: number, seconds: number): Promise<string> {
  const fh = await open(file, 'wx', 0o640);
  const h = createHash('sha256');
  const chunk = Buffer.allocUnsafe(8 * MiB);
  const n = Math.ceil(size / chunk.length);
  const t0 = Date.now();
  try {
    for (let i = 0; i < n; i++) {
      const len = Math.min(chunk.length, size - i * chunk.length);
      const buf = randomFillSync(chunk.subarray(0, len));
      h.update(buf);
      let off = 0;
      while (off < len) off += (await fh.write(buf, off, len - off)).bytesWritten;
      const due = t0 + ((i + 1) / n) * seconds * 1000;
      if (due > Date.now()) await sleep(due - Date.now());
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

test('slow copy through real Syncthing: stable → hashed → snapshot → removed from outbox and PC', async () => {
  test.setTimeout(20 * 60_000);
  const s = stack();
  test.skip(s.syncthing.mode !== 'real', 'needs real Syncthing (FILESHARE_SYNCTHING=real)');
  test.skip(!s.restic, 'needs the restic runner');
  const quietMs = s.ingestQuietSeconds * 1000;
  const pcEntry = path.join(s.paths.pcFolder, entry);
  const outboxEntry = path.join(s.paths.outbox, entry);
  const db = openStackDb(true);
  const itemQ = db.prepare(`SELECT * FROM items WHERE source = 'outbox' AND source_name = ? ORDER BY created_at DESC LIMIT 1`);
  const runsQ = db.prepare(`SELECT * FROM backup_runs WHERE kind = 'backup' AND status = 'ok' AND started_at >= ? ORDER BY started_at`);

  type Sample = { at: number; status: string | null; libraryAt: number | null; outbox: boolean; pc: boolean; covered: BackupRunRow | undefined; libExists: boolean };
  const samples: Sample[] = [];
  const outboxChanges: number[] = []; // times the outbox entry's tree fingerprint changed
  let lastFp = '';
  let monitoring = true;
  let copyEnd = 0;
  const monitor = (async () => {
    while (monitoring) {
      const at = Date.now();
      const fp = await fingerprint(outboxEntry);
      if (fp !== lastFp) {
        lastFp = fp;
        if (fp) outboxChanges.push(at);
      }
      const row = itemQ.get(entry) as ItemRow | undefined;
      const covered =
        row?.library_at != null
          ? (runsQ.all(row.library_at) as BackupRunRow[]).find((r) => (JSON.parse(r.library_entries ?? '[]') as string[]).includes(row.name))
          : undefined;
      samples.push({
        at,
        status: row?.status ?? null,
        libraryAt: row?.library_at ?? null,
        outbox: existsSync(outboxEntry),
        pc: existsSync(pcEntry),
        covered,
        libExists: row ? existsSync(path.join(s.paths.library, row.name)) : false,
      });
      await sleep(500);
    }
  })();

  try {
    // Nested folder first (quick), then the big file slowly — into a folder that starts empty.
    await mkdir(pcEntry);
    for (const [rel, size] of [
      ['nested/a/b/one.bin', 3 * MiB],
      ['nested/a/b/two.bin', 1 * MiB + 17],
      ['nested/a/c.bin', 2 * MiB],
      ['readme.txt', 900],
    ] as const) {
      expected.set(rel, await writeRandomFile(path.join(pcEntry, rel), size));
    }
    const copyStart = Date.now();
    expected.set('big.bin', await slowCopy(path.join(pcEntry, 'big.bin'), BIG, COPY_SECONDS));
    copyEnd = Date.now();
    console.log(`[ingest] copied ${(BIG / MiB).toFixed(0)} MiB in ${((copyEnd - copyStart) / 1000).toFixed(1)} s`);

    // Until ready (or error).
    await expect
      .poll(() => (itemQ.get(entry) as ItemRow | undefined)?.status, { timeout: 15 * 60_000, intervals: [1000] })
      .toMatch(/^(ready|error)$/);
    // ...and until Syncthing removed the PC copy.
    await expect.poll(() => existsSync(pcEntry), { timeout: 5 * 60_000, intervals: [1000] }).toBe(false);
    await sleep(1000);
  } finally {
    monitoring = false;
    await monitor;
  }

  const row = itemQ.get(entry) as ItemRow;
  itemName = row.name;
  expect(row.status, row.error ?? '').toBe('ready');
  expect(row.snapshot_run_id).not.toBeNull();
  const run = db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(row.snapshot_run_id) as BackupRunRow;
  db.close();

  // 1. Not placed/hashed while the copy was running, nor before the outbox was quiet for the quiet period.
  const during = samples.filter((x) => x.at <= copyEnd);
  expect(during.length).toBeGreaterThan(20);
  for (const x of during) {
    expect([null, 'incoming', 'stabilising']).toContain(x.status);
    expect(x.libExists).toBe(false);
  }
  const placedAt = row.library_at!;
  const lastChangeBeforePlacement = Math.max(...outboxChanges.filter((at) => at < placedAt));
  expect(placedAt).toBeGreaterThan(copyEnd);
  expect(placedAt - lastChangeBeforePlacement).toBeGreaterThanOrEqual(quietMs - 1500);

  // 2. Outbox entry and PC copy existed in every sample before a covering snapshot row existed.
  const firstCovered = samples.find((x) => x.covered);
  expect(firstCovered).toBeDefined();
  const outboxSeen = samples.find((x) => x.outbox)!;
  for (const x of samples.filter((y) => !y.covered && y.at >= outboxSeen.at)) {
    expect(x.outbox, `outbox gone at ${x.at} without a covering snapshot`).toBe(true);
    expect(x.pc).toBe(true);
  }
  const outboxGone = samples.find((x) => !x.outbox && x.at > outboxSeen.at)!;
  const pcGone = samples.find((x) => !x.pc && x.at > outboxSeen.at);
  expect(outboxGone.at).toBeGreaterThanOrEqual(firstCovered!.at);
  expect(run.status).toBe('ok');
  expect(run.started_at).toBeGreaterThanOrEqual(placedAt);
  expect(JSON.parse(run.library_entries!)).toContain(itemName);

  // 3. Gone from BOTH sides; the library copy is complete and correct.
  expect(existsSync(outboxEntry)).toBe(false);
  expect(existsSync(pcEntry)).toBe(false);
  expect(readdirSync(path.join(s.paths.data, '.ingest-trash')).length).toBe(0);
  expect(Object.fromEntries(await hashTree(path.join(s.paths.library, itemName)))).toEqual(Object.fromEntries(expected));

  const t = (ms: number | undefined) => (ms === undefined ? '-' : `+${((ms - copyEnd) / 1000).toFixed(1)} s`);
  console.log(
    `[ingest] after copy end: outbox entry first seen ${t(outboxSeen.at)}, ${outboxChanges.length} outbox changes, last ${t(lastChangeBeforePlacement)}, ` +
      `last outbox change ${t(lastChangeBeforePlacement)}, placed ${t(placedAt)}, ` +
      `snapshot run ${run.id} ${t(run.started_at)}–${t(run.finished_at ?? undefined)}, covered seen ${t(firstCovered!.at)}, ` +
      `outbox gone ${t(outboxGone.at)}, pc gone ${t(pcGone?.at)}, ready ${t(row.ready_at!)}`,
  );
});

test('restore from the snapshot following docs/RUNBOOK.md', async () => {
  test.setTimeout(10 * 60_000);
  const s = stack();
  test.skip(!itemName, 'needs the ingest test');
  const restoreRoot = path.join(SCRATCH, `restore-${tag}`);
  const one = path.join(restoreRoot, 'single');
  const full = path.join(restoreRoot, 'full');
  const compose = (...args: string[]) =>
    execFileSync('docker', ['compose', '-p', s.compose.project, '-f', s.compose.file, '--env-file', s.compose.envFile, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    // "List and browse"
    expect(compose('exec', '-T', 'restic', 'restic', 'snapshots', '--tag', 'fileshare')).toContain('/data/library');
    expect(compose('exec', '-T', 'restic', 'restic', 'ls', 'latest', '/data/library')).toContain(`/data/library/${itemName}`);

    // "Restore a single item" — the RUNBOOK command, with this stack's compose project.
    await mkdir(one, { recursive: true });
    compose('run', '--rm', '--no-deps', '-v', `${one}:/restore`, 'restic', 'restic', 'restore', 'latest', '--target', '/restore', '--include', `/data/library/${itemName}`);
    expect(readdirSync(path.join(one, 'data', 'library'))).toEqual([itemName]);
    const restored = await hashTree(path.join(one, 'data', 'library', itemName));
    expect(Object.fromEntries(restored)).toEqual(Object.fromEntries(expected));
    expect(Object.fromEntries(restored)).toEqual(Object.fromEntries(await hashTree(path.join(s.paths.library, itemName))));

    // "Full restore" step 3: everything into a staging directory.
    await mkdir(full, { recursive: true });
    compose('run', '--rm', '--no-deps', '-v', `${full}:/restore`, 'restic', 'restic', 'restore', 'latest', '--target', '/restore');
    const dbCopy = path.join(full, 'state', 'backup', 'fileshare.db');
    expect(existsSync(dbCopy)).toBe(true);
    const rdb = new Database(dbCopy, { readonly: true, fileMustExist: true });
    try {
      expect(rdb.pragma('integrity_check', { simple: true })).toBe('ok');
      expect((rdb.prepare('SELECT name FROM items WHERE name = ?').get(itemName) as { name: string } | undefined)?.name).toBe(itemName);
    } finally {
      rdb.close();
    }
    expect(Object.fromEntries(await hashTree(path.join(full, 'data', 'library', itemName)))).toEqual(Object.fromEntries(expected));
    expect(existsSync(path.join(full, 'config', '.env'))).toBe(true);
    expect(existsSync(path.join(full, 'secrets', 'share-hmac-key'))).toBe(true);
    expect(existsSync(path.join(full, 'secrets', 'restic-password'))).toBe(false); // excluded
    expect(existsSync(path.join(full, 'syncthing-config', 'cert.pem'))).toBe(true);
    expect(readdirSync(path.join(full, 'syncthing-config')).filter((n) => n.startsWith('index-'))).toEqual([]); // Syncthing DB excluded
    console.log(`[restore] single item + full restore OK (${restored.size} files, db copy present)`);
  } finally {
    await rm(restoreRoot, { recursive: true, force: true });
  }
});
