// Restic runner process entry (docs/ARCHITECTURE.md §5). Runs in the `restic` service
// (same image as the app, no network). Talks to the app only through SQLite.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createContext } from '../bootstrap.js';
import type { Config } from '../config.js';
import { getSetting } from '../db/index.js';
import { latestRuns, pendingRequestCount, requestSnapshot } from './queue.js';
import { BackupRunner, type RunnerOptions } from './runner.js';

export const HEARTBEAT_FILE = process.env.RUNNER_HEARTBEAT_FILE ?? '/tmp/restic-runner.alive';

/** restic --exclude patterns for the configured backup paths (§5). */
export function excludesFor(config: Config, extraPaths: string[]): string[] {
  const ex = [path.join(config.paths.secrets, 'restic-password')];
  for (const p of extraPaths) {
    if (path.basename(p) === 'syncthing-config') {
      // Syncthing's database (index-v2/ in 2.x, index-v0.14.0.db in 1.x) is rebuilt from the
      // folder contents on restore; only its config, keys and certs are worth keeping.
      ex.push(`${p}/index-*`, `${p}/*.db`, `${p}/*.db-*`, `${p}/*.log`, `${p}/syncthing.lock`);
    }
  }
  return ex;
}

export function runnerOptionsFrom(config: Config): Omit<RunnerOptions, 'db' | 'log'> {
  const extraPaths = config.env.BACKUP_EXTRA_PATHS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    restic: {
      bin: config.env.RESTIC_BIN,
      repository: config.env.RESTIC_REPOSITORY,
      passwordFile: path.join(config.paths.secrets, 'restic-password'),
      cacheDir: path.join(config.paths.state, 'restic-cache'),
    },
    libraryDir: config.paths.library,
    dbBackupPath: path.join(config.paths.backupDir, 'fileshare.db'),
    extraPaths,
    excludes: excludesFor(config, extraPaths),
    debounceMs: config.env.SNAPSHOT_DEBOUNCE_SECONDS * 1000,
    pause: config.pauseWindow,
    heartbeatFile: HEARTBEAT_FILE,
  };
}

async function main(): Promise<void> {
  const ctx = createContext('restic');
  const { log, db, config } = ctx;
  const runner = new BackupRunner({ db, log, ...runnerOptionsFrom(config) });
  log.info(
    { repository: config.env.RESTIC_REPOSITORY, pauseWindow: config.env.SNAPSHOT_PAUSE_WINDOW, tz: config.env.TZ },
    'restic runner starting',
  );

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'restic runner stopping');
    runner
      .stop()
      .catch((err: unknown) => log.error({ err: (err as Error).message }, 'stop failed'))
      .finally(() => {
        db.close();
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await runner.start();
}

/**
 * Operator helpers (run inside the restic container):
 *   node dist/backup/main.js request   queue a manual snapshot (runs outside the pause window)
 *   node dist/backup/main.js status    print status.restic, disk usage and the latest runs
 */
function command(cmd: string): void {
  const ctx = createContext('restic-cli');
  try {
    if (cmd === 'request') {
      const id = requestSnapshot(ctx.db, 'manual');
      console.log(JSON.stringify({ requested: id, pending: pendingRequestCount(ctx.db) }));
    } else {
      const out = {
        status: getSetting(ctx.db, 'status.restic') ?? null,
        disk: getSetting(ctx.db, 'status.disk.restic') ?? null,
        pending: pendingRequestCount(ctx.db),
        latest: latestRuns(ctx.db),
      };
      console.log(JSON.stringify(out, null, 2));
    }
  } finally {
    ctx.db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  if (cmd === 'request' || cmd === 'status') command(cmd);
  else if (cmd === undefined) await main();
  else {
    console.error(`unknown command: ${cmd} (expected: request | status)`);
    process.exit(2);
  }
}
