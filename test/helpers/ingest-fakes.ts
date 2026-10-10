// Test doubles for ingest: fake Syncthing REST server, fake restic runner, temp AppContext.
// Synthetic data only: every secret here is random bytes generated per test run.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import { AppEvents } from '../../src/core/events.js';
import { openDb, type Db } from '../../src/db/index.js';
import { createLogger } from '../../src/log.js';

export interface FakeSyncthingState {
  reachable: boolean;
  folderState: string;
  completion: number;
  need: string[];
  events: { id: number; type: string; data: Record<string, unknown> }[];
}

export interface FakeSyncthing {
  url: string;
  apiKey: string;
  state: FakeSyncthingState;
  /** Paths (without query) of requests received, newest last. */
  requests: { path: string; query: URLSearchParams; apiKey: string | undefined }[];
  pushEvent(type: string, data: Record<string, unknown>): void;
  close(): Promise<void>;
}

/** A local HTTP server implementing the Syncthing REST endpoints that ingest uses. */
export async function startFakeSyncthing(apiKey: string, folder = 'fileshare-outbox'): Promise<FakeSyncthing> {
  const state: FakeSyncthingState = { reachable: true, folderState: 'idle', completion: 100, need: [], events: [] };
  const requests: FakeSyncthing['requests'] = [];
  let nextEventId = 1;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const key = req.headers['x-api-key'];
    requests.push({ path: u.pathname, query: u.searchParams, apiKey: typeof key === 'string' ? key : undefined });
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!state.reachable) {
      res.destroy();
      return;
    }
    if (key !== apiKey) return send(403, { error: 'forbidden' });
    const qFolder = u.searchParams.get('folder');
    switch (u.pathname) {
      case '/rest/db/status':
        if (qFolder !== folder) return send(404, {});
        return send(200, { state: state.folderState, needFiles: state.need.length, needBytes: 0 });
      case '/rest/db/completion':
        if (qFolder !== folder) return send(404, {});
        return send(200, { completion: state.completion, needBytes: 0, needItems: 0, needDeletes: 0, remoteState: 'valid' });
      case '/rest/db/need': {
        if (qFolder !== folder) return send(404, {});
        const page = Number(u.searchParams.get('page') ?? '1');
        const perpage = Number(u.searchParams.get('perpage') ?? '100');
        const all = state.need.map((name) => ({ name, size: 1 }));
        const slice = all.slice((page - 1) * perpage, page * perpage);
        // split across the three lists like Syncthing does
        return send(200, { progress: slice.slice(0, 1), queued: slice.slice(1, 2), rest: slice.slice(2), page, perpage });
      }
      case '/rest/events': {
        const since = Number(u.searchParams.get('since') ?? '0');
        const timeoutS = Number(u.searchParams.get('timeout') ?? '60');
        const respond = (): void => send(200, state.events.filter((e) => e.id > since));
        if (state.events.some((e) => e.id > since)) return respond();
        const t = setTimeout(respond, Math.min(timeoutS * 1000, 300));
        req.on('close', () => clearTimeout(t));
        return;
      }
      default:
        return send(404, {});
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    apiKey,
    state,
    requests,
    pushEvent(type, data) {
      state.events.push({ id: nextEventId++, type, data });
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/**
 * Fake restic runner: consumes all pending backup_requests and records a finished backup run
 * whose library_entries is the current /data/library listing. Returns the run id.
 */
export function runFakeBackup(db: Db, libraryDir: string, status: 'ok' | 'failed' = 'ok'): number {
  const startedAt = Date.now();
  let entries: string[] = [];
  try {
    entries = readdirSync(libraryDir).sort();
  } catch {
    entries = [];
  }
  const r = db
    .prepare(
      `INSERT INTO backup_runs (kind, trigger, started_at, finished_at, status, snapshot_id, library_entries)
       VALUES ('backup', 'debounce', ?, ?, ?, ?, ?)`,
    )
    .run(startedAt, Date.now(), status, status === 'ok' ? randomBytes(4).toString('hex') : null, JSON.stringify(entries));
  const runId = Number(r.lastInsertRowid);
  db.prepare('UPDATE backup_requests SET run_id = ? WHERE run_id IS NULL').run(runId);
  return runId;
}

export interface TestEnv {
  root: string;
  ctx: AppContext;
  apiKey: string;
  cleanup(): void;
}

/** Temp dirs + real SQLite file + Config from loadConfig() with synthetic secrets. */
export function makeTestEnv(env: Record<string, string> = {}, apiKey = randomBytes(24).toString('hex')): TestEnv {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fileshare-ingest-'));
  const secrets = path.join(root, 'secrets');
  mkdirSync(secrets, { mode: 0o700 });
  for (const [name, value] of [
    ['syncthing-api-key', apiKey],
    ['share-hmac-key', randomBytes(32).toString('hex')],
    ['restic-password', randomBytes(24).toString('hex')],
  ] as const) {
    writeFileSync(path.join(secrets, name), value, { mode: 0o600 });
    chmodSync(path.join(secrets, name), 0o600);
  }
  const data = path.join(root, 'data');
  mkdirSync(path.join(data, 'outbox'), { recursive: true });
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLIC_BASE_URL: 'https://files.example.test',
    ADMIN_BASE_URL: 'https://admin.example.test',
    DATA_DIR: data,
    STATE_DIR: path.join(root, 'state'),
    SECRETS_DIR: secrets,
    SYNCTHING_PC_DEVICE_ID: 'FAKEDEV-AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG',
    INGEST_QUIET_SECONDS: '2',
    INGEST_RESCAN_SECONDS: '1',
    ...env,
  });
  const db = openDb(config.paths.db);
  const ctx: AppContext = { config, db, log: createLogger('silent'), events: new AppEvents() };
  return {
    root,
    ctx,
    apiKey,
    cleanup() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Poll `fn` until it returns a truthy value or the timeout passes. */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 15_000, intervalMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
