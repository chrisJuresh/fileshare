// The restic runner (docs/ARCHITECTURE.md §5). Talks to the app only through SQLite:
// consumes `backup_requests`, writes `backup_runs`, and publishes `status.restic` /
// `status.disk.restic` settings. One job at a time (in-process lock); restic's own repository
// locks are never touched.
import { mkdirSync, readdirSync, renameSync, rmSync, statfsSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BackupRunRow, Db } from '../db/index.js';
import { setSetting } from '../db/index.js';
import type { Logger } from '../log.js';
import { EXIT, errorText, isMsg, runRestic, type ResticEnv, type ResticProcess, type ResticResult } from './restic.js';
import {
  backoffMs,
  inPause,
  nextJob,
  startBlocked,
  type Job,
  type PauseWindow,
  type ScheduleState,
} from './schedule.js';

export const TAG = 'fileshare';
export const SNAPSHOT_HOST = 'fileshare';
export const FORGET_POLICY = ['--keep-within', '48h', '--keep-daily', '30', '--keep-weekly', '26'];
export const CHECK_SUBSET = '5%';

export interface RunnerOptions {
  db: Db;
  log: Logger;
  restic: ResticEnv;
  /** /data/library */
  libraryDir: string;
  /** /state/backup/fileshare.db — fresh db.backup() copy taken before each backup. */
  dbBackupPath: string;
  /** /config/.env, /secrets, /syncthing-config (missing ones are skipped). */
  extraPaths: string[];
  /** restic --exclude patterns. */
  excludes: string[];
  debounceMs: number;
  pause: PauseWindow;
  /** Injected clock (tests). */
  clock?: () => number;
  pollMs?: number;
  /** Touched every poll and every few seconds during a job; used by the container healthcheck. */
  heartbeatFile?: string;
  /** Grace before SIGKILL after SIGINT. */
  killGraceMs?: number;
}

export interface ResticStatus {
  repoInitialised: boolean;
  lastBackupAt: number | null;
  lastSnapshotId: string | null;
  lastCheckAt: number | null;
  lastCheckOk: boolean | null;
  lastForgetAt: number | null;
  paused: boolean;
  running: { kind: Job['kind'] | 'init'; startedAt: number } | null;
  error: string | null;
  at: number;
}

type Outcome = { status: 'ok' | 'failed' | 'interrupted'; snapshotId?: string; error?: string; summary?: unknown };

export class BackupRunner {
  private readonly o: Required<Omit<RunnerOptions, 'heartbeatFile'>> & { heartbeatFile?: string };
  private readonly now: () => number;
  private current: { proc: ResticProcess | null; runId: number; kind: string } | null = null;
  private stopping = false;
  private loopDone: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private repoInitialised = false;
  private repoError: string | null = null;
  private backupFailures = 0;
  private backupNotBefore = 0;
  private lastDiskAt = 0;

  constructor(opts: RunnerOptions) {
    this.o = { clock: Date.now, pollMs: 10_000, killGraceMs: 60_000, ...opts };
    this.now = this.o.clock;
  }

  get log(): Logger {
    return this.o.log;
  }

  /** Mark runs left `running` by a crashed runner as failed and release their requests. */
  recoverStale(): number {
    const { db } = this.o;
    const t = this.now();
    const n = db
      .prepare(`UPDATE backup_runs SET status = 'failed', finished_at = ?, error = 'runner restarted while running' WHERE status = 'running'`)
      .run(t).changes;
    db.prepare(
      `UPDATE backup_requests SET run_id = NULL
       WHERE run_id IN (SELECT id FROM backup_runs WHERE status != 'ok')`,
    ).run();
    if (n) this.log.warn({ runs: n }, 'marked stale running jobs as failed');
    return n;
  }

  // ---------------------------------------------------------------------------------- repo

  /** `restic cat config`: true if the repo exists, false if missing; throws on other errors. */
  async repoExists(): Promise<boolean> {
    const res = await runRestic(this.o.restic, ['cat', 'config', '--no-lock']).result;
    if (res.code === EXIT.ok) return true;
    if (res.code === EXIT.repoMissing) return false;
    throw new Error(errorText(res));
  }

  /** Initialise the repository if it is missing. Returns true when the repo is usable. */
  async ensureRepo(): Promise<boolean> {
    if (this.repoInitialised) return true;
    try {
      if (await this.repoExists()) {
        this.repoInitialised = true;
        this.repoError = null;
        return true;
      }
    } catch (err) {
      this.repoError = (err as Error).message;
      this.log.error({ err: this.repoError }, 'restic repository not usable');
      this.publishStatus();
      return false;
    }
    const outcome = await this.runTracked({ kind: 'init', trigger: 'schedule' }, async () => {
      const res = await this.exec(['init']);
      return res.code === EXIT.ok ? { status: 'ok' } : this.failure(res);
    });
    this.repoInitialised = outcome.status === 'ok';
    this.repoError = outcome.status === 'ok' ? null : (outcome.error ?? 'init failed');
    if (this.repoInitialised) this.log.info('restic repository initialised');
    return this.repoInitialised;
  }

  // ------------------------------------------------------------------------------ schedule

  scheduleState(): ScheduleState {
    const { db } = this.o;
    const pending = db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(requested_at) AS oldestAt, MAX(requested_at) AS newestAt,
                MAX(reason = 'manual') AS manual,
                MAX(CASE WHEN reason = 'manual' THEN requested_at END) AS manualNewestAt
         FROM backup_requests WHERE run_id IS NULL`,
      )
      .get() as { count: number; oldestAt: number | null; newestAt: number | null; manual: number | null; manualNewestAt: number | null };
    const lastStarted = (sql: string): number | null =>
      (db.prepare(sql).get() as { t: number | null } | undefined)?.t ?? null;
    return {
      now: this.now(),
      pending:
        pending.count > 0
          ? {
              count: pending.count,
              oldestAt: pending.oldestAt!,
              newestAt: pending.newestAt!,
              manual: pending.manual === 1,
              ...(pending.manualNewestAt !== null ? { manualNewestAt: pending.manualNewestAt } : {}),
            }
          : null,
      lastOkBackupStartedAt: lastStarted(`SELECT MAX(started_at) AS t FROM backup_runs WHERE kind = 'backup' AND status = 'ok'`),
      lastForgetStartedAt: lastStarted(
        `SELECT MAX(started_at) AS t FROM backup_runs WHERE kind = 'forget' AND status IN ('ok','failed')`,
      ),
      lastCheckStartedAt: lastStarted(
        `SELECT MAX(started_at) AS t FROM backup_runs WHERE kind = 'check' AND status IN ('ok','failed')`,
      ),
      firstRunAt: lastStarted(`SELECT MIN(started_at) AS t FROM backup_runs`),
      backupNotBefore: this.backupNotBefore,
      lastBackupFailedAt: lastStarted(`SELECT MAX(started_at) AS t FROM backup_runs WHERE kind = 'backup' AND status = 'failed'`),
    };
  }

  /** One scheduling step: ensure the repo, pick a job, run it to completion. Returns the job run (if any). */
  async tick(): Promise<Job | null> {
    this.heartbeat();
    this.publishDisk();
    if (this.stopping) return null;
    if (startBlocked(this.now(), this.o.pause)) {
      this.publishStatus();
      return null;
    }
    if (!(await this.ensureRepo())) return null;
    const job = nextJob(this.scheduleState(), { debounceMs: this.o.debounceMs, pause: this.o.pause });
    if (job && !this.stopping) await this.runJob(job);
    else this.publishStatus();
    return job;
  }

  async runJob(job: Job): Promise<Outcome> {
    switch (job.kind) {
      case 'backup':
        return this.backup(job.trigger);
      case 'forget':
        return this.forget();
      case 'check':
        return this.check();
    }
  }

  // ---------------------------------------------------------------------------------- jobs

  async backup(trigger: string): Promise<Outcome> {
    const { db } = this.o;
    const outcome = await this.runTracked({ kind: 'backup', trigger }, async (runId) => {
      // Claim every unconsumed request now; they are released again if the run doesn't succeed.
      db.prepare('UPDATE backup_requests SET run_id = ? WHERE run_id IS NULL').run(runId);

      await this.snapshotDb();
      // Listed immediately before restic starts (findCoveringBackup relies on this ordering).
      const entries = this.listLibrary();
      db.prepare('UPDATE backup_runs SET library_entries = ? WHERE id = ?').run(JSON.stringify(entries), runId);

      const paths = [this.o.libraryDir, this.o.dbBackupPath, ...this.o.extraPaths].filter((p) => existsSync(p));
      const args = ['backup', '--json', '--tag', TAG, '--host', SNAPSHOT_HOST, '--retry-lock', '2m'];
      for (const ex of this.o.excludes) args.push('--exclude', ex);
      const res = await this.exec([...args, ...paths], (msg) => {
        if (isMsg(msg, 'status')) this.log.debug({ percent: msg.percent_done, files: msg.files_done }, 'backup progress');
      });
      const summary = res.json.find((m) => isMsg(m, 'summary')) as Record<string, unknown> | undefined;
      const errors = res.errors.filter((m) => isMsg(m, 'error'));
      const fullId = typeof summary?.snapshot_id === 'string' ? summary.snapshot_id : undefined;
      if (res.code === EXIT.ok && fullId) return { status: 'ok', snapshotId: fullId.slice(0, 8), summary };
      if (res.interrupted || res.code === EXIT.interrupted) return { status: 'interrupted', error: 'interrupted' };
      if (res.code === EXIT.incomplete && fullId) {
        // A snapshot was written but some files could not be read. Only acceptable if none of
        // them are in the library (that is what ingest relies on).
        const items = errors.map((e) => String(e.item ?? ''));
        const libraryHit = items.some((i) => i === '' || i === this.o.libraryDir || i.startsWith(this.o.libraryDir + '/'));
        const warnings = items.slice(0, 20);
        if (!libraryHit) return { status: 'ok', snapshotId: fullId.slice(0, 8), summary: { ...summary, warnings } };
        return { status: 'failed', snapshotId: fullId.slice(0, 8), error: `unreadable files in library: ${warnings.join(', ')}`.slice(0, 500), summary };
      }
      return this.failure(res);
    });
    if (outcome.status !== 'ok') {
      // Release requests so they are retried after the window / back-off.
      db.prepare(
        `UPDATE backup_requests SET run_id = NULL WHERE run_id IN (SELECT id FROM backup_runs WHERE status != 'ok')`,
      ).run();
    }
    if (outcome.status === 'failed') {
      this.backupFailures++;
      this.backupNotBefore = this.now() + backoffMs(this.backupFailures);
    } else if (outcome.status === 'ok') {
      this.backupFailures = 0;
      this.backupNotBefore = 0;
    }
    return outcome;
  }

  async forget(): Promise<Outcome> {
    return this.runTracked({ kind: 'forget', trigger: 'schedule' }, async () => {
      const res = await this.exec(['forget', '--json', '--tag', TAG, ...FORGET_POLICY, '--prune', '--retry-lock', '2m']);
      if (res.interrupted || res.code === EXIT.interrupted) return { status: 'interrupted', error: 'interrupted' };
      if (res.code !== EXIT.ok) return this.failure(res);
      const groups = (res.json.find((m) => Array.isArray(m)) as { keep?: unknown[]; remove?: unknown[] }[] | undefined) ?? [];
      const summary = {
        kept: groups.reduce((n, g) => n + (g.keep?.length ?? 0), 0),
        removed: groups.reduce((n, g) => n + (g.remove?.length ?? 0), 0),
      };
      return { status: 'ok', summary };
    });
  }

  async check(): Promise<Outcome> {
    return this.runTracked({ kind: 'check', trigger: 'schedule' }, async () => {
      const res = await this.exec(['check', `--read-data-subset=${CHECK_SUBSET}`, '--json', '--retry-lock', '2m']);
      if (res.interrupted || res.code === EXIT.interrupted) return { status: 'interrupted', error: 'interrupted' };
      const summary = res.json.find((m) => isMsg(m, 'summary')) ?? { exitCode: res.code };
      if (res.code !== EXIT.ok) return { ...this.failure(res), summary };
      return { status: 'ok', summary };
    });
  }

  // ----------------------------------------------------------------------------- lifecycle

  /** Run the polling loop until stop(). */
  start(): Promise<void> {
    if (this.loopDone) return this.loopDone;
    this.recoverStale();
    this.loopDone = (async () => {
      while (!this.stopping) {
        try {
          await this.tick();
        } catch (err) {
          this.log.error({ err: (err as Error).message }, 'runner tick failed');
        }
        if (this.stopping) break;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.o.pollMs);
          this.wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        this.wake = null;
      }
    })();
    return this.loopDone;
  }

  /** Graceful stop: interrupt a running restic (SIGINT), wait for it, end the loop. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.current?.proc?.interrupt(this.o.killGraceMs);
    this.wake?.();
    await this.loopDone;
  }

  // ------------------------------------------------------------------------------- helpers

  private async exec(args: string[], onJson?: (m: unknown) => void): Promise<ResticResult> {
    const proc = runRestic(this.o.restic, args, { onJson });
    if (this.current) this.current.proc = proc;
    if (this.stopping) proc.interrupt(this.o.killGraceMs);
    // Watch the pause window while the job runs, and keep the heartbeat fresh.
    const watch = setInterval(() => {
      this.heartbeat();
      if (inPause(this.now(), this.o.pause)) {
        this.log.warn({ args: args[0] }, 'pause window started: interrupting restic');
        proc.interrupt(this.o.killGraceMs);
      }
    }, 1000);
    try {
      return await proc.result;
    } finally {
      clearInterval(watch);
      if (this.current) this.current.proc = null;
    }
  }

  private failure(res: ResticResult): Outcome {
    return { status: 'failed', error: errorText(res) };
  }

  /** Insert a `running` row, run `fn`, record the outcome, publish status. Never throws. */
  private async runTracked(
    job: { kind: BackupRunRow['kind']; trigger: string },
    fn: (runId: number) => Promise<Outcome>,
  ): Promise<Outcome> {
    const { db } = this.o;
    const startedAt = this.now();
    const runId = Number(
      db
        .prepare(`INSERT INTO backup_runs (kind, trigger, started_at, status) VALUES (?, ?, ?, 'running')`)
        .run(job.kind, job.trigger, startedAt).lastInsertRowid,
    );
    this.current = { proc: null, runId, kind: job.kind };
    this.publishStatus();
    this.log.info({ runId, kind: job.kind, trigger: job.trigger }, 'job started');
    let outcome: Outcome;
    try {
      outcome = await fn(runId);
    } catch (err) {
      outcome = { status: 'failed', error: String((err as Error).message ?? err).slice(0, 500) };
    }
    db.prepare(
      `UPDATE backup_runs SET status = ?, finished_at = ?, snapshot_id = ?, error = ?, summary = ? WHERE id = ?`,
    ).run(
      outcome.status,
      this.now(),
      outcome.snapshotId ?? null,
      outcome.error ?? null,
      outcome.summary === undefined ? null : JSON.stringify(outcome.summary),
      runId,
    );
    this.current = null;
    const level = outcome.status === 'ok' ? 'info' : outcome.status === 'interrupted' ? 'warn' : 'error';
    this.log[level](
      { runId, kind: job.kind, status: outcome.status, snapshotId: outcome.snapshotId, error: outcome.error, ms: this.now() - startedAt },
      'job finished',
    );
    this.publishStatus();
    return outcome;
  }

  /** Online copy of the app DB to /state/backup/fileshare.db (via a temp file + rename). */
  async snapshotDb(): Promise<void> {
    const dest = this.o.dbBackupPath;
    mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp`;
    rmSync(tmp, { force: true });
    await this.o.db.backup(tmp);
    renameSync(tmp, dest);
  }

  listLibrary(): string[] {
    try {
      return readdirSync(this.o.libraryDir).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  status(): ResticStatus {
    const { db } = this.o;
    const last = (kind: string, okOnly: boolean): BackupRunRow | undefined =>
      db
        .prepare(
          `SELECT * FROM backup_runs WHERE kind = ? AND status ${okOnly ? `= 'ok'` : `IN ('ok','failed')`}
           ORDER BY started_at DESC, id DESC LIMIT 1`,
        )
        .get(kind) as BackupRunRow | undefined;
    const backup = last('backup', true);
    const forget = last('forget', true);
    const check = last('check', false);
    const latestBackup = db
      .prepare(`SELECT * FROM backup_runs WHERE kind = 'backup' AND status != 'running' ORDER BY started_at DESC, id DESC LIMIT 1`)
      .get() as BackupRunRow | undefined;
    const running = this.current
      ? (db.prepare('SELECT kind, started_at FROM backup_runs WHERE id = ?').get(this.current.runId) as
          | { kind: Job['kind'] | 'init'; started_at: number }
          | undefined)
      : undefined;
    return {
      repoInitialised: this.repoInitialised,
      lastBackupAt: backup?.finished_at ?? null,
      lastSnapshotId: backup?.snapshot_id ?? null,
      lastCheckAt: check?.finished_at ?? null,
      lastCheckOk: check ? check.status === 'ok' : null,
      lastForgetAt: forget?.finished_at ?? null,
      paused: startBlocked(this.now(), this.o.pause),
      running: running ? { kind: running.kind, startedAt: running.started_at } : null,
      error: this.repoError ?? (latestBackup?.status === 'failed' ? latestBackup.error : null),
      at: this.now(),
    };
  }

  publishStatus(): void {
    try {
      setSetting(this.o.db, 'status.restic', this.status());
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'could not publish status.restic');
    }
  }

  /** statfs of the repository filesystem, at most once a minute. */
  publishDisk(force = false): void {
    const t = this.now();
    if (!force && t - this.lastDiskAt < 60_000) return;
    this.lastDiskAt = t;
    try {
      const s = statfsSync(this.o.restic.repository);
      const total = s.blocks * s.bsize;
      setSetting(this.o.db, 'status.disk.restic', {
        total,
        free: s.bavail * s.bsize,
        used: (s.blocks - s.bfree) * s.bsize,
        path: this.o.restic.repository,
        at: t,
      });
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'statfs of restic repository failed');
    }
  }

  private heartbeat(): void {
    if (!this.o.heartbeatFile) return;
    try {
      writeFileSync(this.o.heartbeatFile, String(Date.now()));
    } catch {
      // healthcheck will notice
    }
  }

  /** For tests: allow the next backup immediately even after failures. */
  resetBackoff(): void {
    this.backupFailures = 0;
    this.backupNotBefore = 0;
  }
}
