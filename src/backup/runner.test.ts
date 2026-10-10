// Runner behaviour against a fake restic (a small shell script), with an injected clock.
// The real-binary round trip lives in restic.integration.test.ts.
process.env.TZ = 'Europe/London';

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSetting, openDb, type BackupRunRow, type Db } from '../db/index.js';
import { createLogger } from '../log.js';
import { BackupRunner, type ResticStatus } from './runner.js';

const FAKE_RESTIC = `#!/bin/sh
dir=$(dirname "$0")
case "$1" in
  cat)
    [ -f "$dir/initialised" ] && exit 0
    echo "Fatal: repository does not exist" >&2; exit 10 ;;
  init) touch "$dir/initialised"; exit 0 ;;
  backup)
    echo "$@" > "$dir/last-backup-args"
    trap 'exit 130' INT
    n=$(cat "$dir/ticks" 2>/dev/null || echo 0)
    i=0
    while [ "$i" -lt "$n" ]; do sleep 0.1 & wait $!; i=$((i+1)); done
    if [ -f "$dir/fail" ]; then echo "Fatal: simulated failure" >&2; exit 1; fi
    echo '{"message_type":"status","percent_done":0.5}'
    echo '{"message_type":"summary","snapshot_id":"0123456789abcdef0123","files_new":1}'
    exit 0 ;;
  forget) echo '[{"keep":[1,2],"remove":[3]}]'; exit 0 ;;
  check) echo '{"message_type":"summary","num_errors":0}'; exit 0 ;;
esac
exit 1
`;

const MIN = 60_000;
let dir: string;
let db: Db;
let clockNow: number;
let fake: string;

function makeRunner(over: Partial<ConstructorParameters<typeof BackupRunner>[0]> = {}): BackupRunner {
  return new BackupRunner({
    db,
    log: createLogger('silent'),
    restic: { bin: fake, repository: path.join(dir, 'repo'), passwordFile: path.join(dir, 'pw'), cacheDir: path.join(dir, 'cache') },
    libraryDir: path.join(dir, 'library'),
    dbBackupPath: path.join(dir, 'state', 'backup', 'fileshare.db'),
    extraPaths: [path.join(dir, 'missing-extra')],
    excludes: ['/secrets/restic-password'],
    debounceMs: 120_000,
    pause: { startMin: 3 * 60 + 45, endMin: 5 * 60 + 15 },
    clock: () => clockNow,
    pollMs: 20,
    killGraceMs: 2000,
    ...over,
  });
}

/** Like requestSnapshot(), but stamped with the fake clock. */
const request = (reason: string): void => {
  db.prepare('INSERT INTO backup_requests (reason, requested_at) VALUES (?, ?)').run(reason, clockNow);
};
const runs = (): BackupRunRow[] => db.prepare('SELECT * FROM backup_runs ORDER BY id').all() as BackupRunRow[];
const unconsumed = (): number => (db.prepare('SELECT COUNT(*) n FROM backup_requests WHERE run_id IS NULL').get() as { n: number }).n;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'fileshare-runner-'));
  for (const d of ['repo', 'library', 'state', 'bin']) mkdirSync(path.join(dir, d), { recursive: true });
  fake = path.join(dir, 'bin', 'restic');
  writeFileSync(fake, FAKE_RESTIC);
  chmodSync(fake, 0o755);
  writeFileSync(path.join(dir, 'library', 'item-a'), 'synthetic');
  db = openDb(path.join(dir, 'state', 'fileshare.db'));
  clockNow = new Date(2026, 9, 7, 12, 0).getTime(); // Wednesday 12:00 local
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('BackupRunner (fake restic)', () => {
  it('initialises a missing repo, then takes the first backup', async () => {
    const r = makeRunner();
    expect(await r.tick()).toEqual({ kind: 'backup', trigger: 'hourly' });
    const [init, backup] = runs();
    expect(init).toMatchObject({ kind: 'init', status: 'ok' });
    expect(backup).toMatchObject({ kind: 'backup', status: 'ok', snapshot_id: '01234567', trigger: 'hourly' });
    expect(JSON.parse(backup!.library_entries!)).toEqual(['item-a']);
    expect(existsSync(path.join(dir, 'state', 'backup', 'fileshare.db'))).toBe(true);
    const args = (await import('node:fs')).readFileSync(path.join(dir, 'bin', 'last-backup-args'), 'utf8');
    expect(args).toContain('--tag fileshare');
    expect(args).toContain('--exclude /secrets/restic-password');
    expect(args).not.toContain('missing-extra');
    const st = getSetting<ResticStatus>(db, 'status.restic')!;
    expect(st).toMatchObject({ repoInitialised: true, lastSnapshotId: '01234567', paused: false, running: null });
    expect(getSetting<{ total: number }>(db, 'status.disk.restic')!.total).toBeGreaterThan(0);
  });

  it('debounces requests and consumes them', async () => {
    const r = makeRunner();
    await r.tick(); // init + first backup
    clockNow += MIN;
    request('ingest');
    clockNow += MIN;
    expect(await r.tick()).toBeNull();
    clockNow += 61_000;
    expect(await r.tick()).toEqual({ kind: 'backup', trigger: 'debounce' });
    expect(unconsumed()).toBe(0);
    const lastId = runs().at(-1)!.id;
    expect(db.prepare('SELECT run_id FROM backup_requests').get()).toEqual({ run_id: lastId });
  });

  it('releases requests and backs off when a backup fails', async () => {
    const r = makeRunner();
    await r.tick();
    writeFileSync(path.join(dir, 'bin', 'fail'), '');
    request('manual');
    expect(await r.tick()).toEqual({ kind: 'backup', trigger: 'manual' });
    expect(runs().at(-1)).toMatchObject({ status: 'failed' });
    expect(runs().at(-1)!.error).toContain('simulated failure');
    expect(unconsumed()).toBe(1);
    expect(getSetting<ResticStatus>(db, 'status.restic')!.error).toContain('simulated failure');
    expect(await r.tick()).toBeNull(); // back-off
    clockNow += 5 * MIN;
    rmSync(path.join(dir, 'bin', 'fail'));
    expect(await r.tick()).toEqual({ kind: 'backup', trigger: 'manual' });
    expect(unconsumed()).toBe(0);
  });

  it('interrupts a running backup when the pause window starts', async () => {
    const r = makeRunner();
    await r.tick();
    writeFileSync(path.join(dir, 'bin', 'ticks'), '100'); // ~10 s
    clockNow = new Date(2026, 9, 7, 3, 29, 0).getTime(); // just before the blocked range
    request('manual');
    const job = r.tick();
    await new Promise((res) => setTimeout(res, 300));
    expect(getSetting<ResticStatus>(db, 'status.restic')!.running).toMatchObject({ kind: 'backup' });
    clockNow = new Date(2026, 9, 7, 3, 45, 0).getTime();
    await job;
    expect(runs().at(-1)).toMatchObject({ kind: 'backup', status: 'interrupted' });
    expect(unconsumed()).toBe(1);
    // Nothing starts inside the window; it runs after.
    expect(await r.tick()).toBeNull();
    expect(getSetting<ResticStatus>(db, 'status.restic')!.paused).toBe(true);
    writeFileSync(path.join(dir, 'bin', 'ticks'), '0');
    clockNow = new Date(2026, 9, 7, 5, 15, 0).getTime();
    expect(await r.tick()).toEqual({ kind: 'backup', trigger: 'manual' });
  });

  it('stops gracefully on stop(): the running job is interrupted', async () => {
    const r = makeRunner();
    await r.tick();
    writeFileSync(path.join(dir, 'bin', 'ticks'), '100');
    request('manual');
    const loop = r.start();
    await new Promise((res) => setTimeout(res, 400));
    const t0 = Date.now();
    await r.stop();
    await loop;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(runs().at(-1)).toMatchObject({ kind: 'backup', status: 'interrupted' });
  });

  it('marks stale running rows from a crashed runner as failed and releases their requests', () => {
    const id = Number(
      db.prepare(`INSERT INTO backup_runs (kind, trigger, started_at, status) VALUES ('backup','hourly',1,'running')`).run().lastInsertRowid,
    );
    db.prepare('INSERT INTO backup_requests (reason, requested_at, run_id) VALUES (?, ?, ?)').run('ingest', 1, id);
    const r = makeRunner();
    expect(r.recoverStale()).toBe(1);
    expect(runs()[0]).toMatchObject({ status: 'failed' });
    expect(unconsumed()).toBe(1);
  });

  it('runs weekly forget and check, catching up after downtime', async () => {
    const r = makeRunner();
    clockNow = new Date(2026, 9, 3, 12, 0).getTime(); // Saturday: init + backup
    await r.tick();
    clockNow = new Date(2026, 9, 5, 9, 0).getTime(); // Monday after a missed Sunday
    expect(await r.tick()).toEqual({ kind: 'backup', trigger: 'hourly' });
    expect(await r.tick()).toEqual({ kind: 'forget', trigger: 'schedule' });
    expect(runs().at(-1)).toMatchObject({ kind: 'forget', status: 'ok', summary: JSON.stringify({ kept: 2, removed: 1 }) });
    expect(await r.tick()).toEqual({ kind: 'check', trigger: 'schedule' });
    expect(runs().at(-1)).toMatchObject({ kind: 'check', status: 'ok' });
    expect(await r.tick()).toBeNull();
    const st = getSetting<ResticStatus>(db, 'status.restic')!;
    expect(st.lastCheckOk).toBe(true);
    expect(st.lastForgetAt).toBe(clockNow);
  });
});
