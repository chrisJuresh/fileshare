// Shared helpers for p2p tests. Synthetic random data only, temp dirs only, ephemeral ports only.
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
// @ts-ignore untyped
import bencode from 'bencode';
// @ts-ignore untyped
import createTorrent from 'create-torrent';
import pino from 'pino';
import { loadConfig } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import { AppEvents } from '../../src/core/events.js';
import { newId } from '../../src/core/ids.js';
import { openDb } from '../../src/db/index.js';

export const FORBIDDEN_PORTS = new Set([6890, 6891, 8090, 8091]);

/** A free TCP port (also checked free for UDP), never one of the production defaults. */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
    if (FORBIDDEN_PORTS.has(port)) continue;
    const udpFree = await new Promise<boolean>((resolve) => {
      const s = dgram.createSocket('udp4');
      s.once('error', () => resolve(false));
      s.bind(port, '0.0.0.0', () => s.close(() => resolve(true)));
    });
    if (udpFree) return port;
  }
}

export interface TestEnv {
  ctx: AppContext;
  root: string;
  logs: string[];
  ports: { public: number; bt: number; webrtc: number };
  cleanup(): Promise<void>;
}

export async function makeEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fileshare-p2p-'));
  const data = path.join(root, 'data');
  const state = path.join(root, 'state');
  const secrets = path.join(root, 'secrets');
  const web = path.join(root, 'web');
  await mkdir(path.join(data, 'library'), { recursive: true });
  await mkdir(path.join(state, 'seedlinks'), { recursive: true });
  await mkdir(path.join(web, 'recipient', 'vendor'), { recursive: true });
  await writeFile(path.join(web, 'recipient', 'index.html'), '<!doctype html><title>t</title>');
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  await writeFile(path.join(secrets, 'share-hmac-key'), randomBytes(32).toString('hex'), { mode: 0o600 });
  const ports = { public: await freePort(), bt: await freePort(), webrtc: await freePort() };
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'debug',
    PUBLIC_BASE_URL: `http://127.0.0.1:${ports.public}`,
    ADMIN_BASE_URL: 'https://admin.example.test',
    PUBLIC_BIND: '127.0.0.1',
    PUBLIC_PORT: String(ports.public),
    BT_PORT: String(ports.bt),
    WEBRTC_PORT: String(ports.webrtc),
    STUN_URLS: '',
    DATA_DIR: data,
    STATE_DIR: state,
    SECRETS_DIR: secrets,
    WEB_DIR: web,
    TRUST_PROXY: 'true',
    ...overrides,
  });
  const logs: string[] = [];
  const sink = new Writable({
    write(chunk, _e, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const log = pino({ level: 'debug', base: undefined }, sink);
  const db = openDb(config.paths.db);
  const ctx: AppContext = { config, db, log, events: new AppEvents() };
  return {
    ctx,
    root,
    logs,
    ports,
    async cleanup() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

export interface MadeItem {
  id: string;
  name: string;
  /** Absolute path of the library entry. */
  dir: string;
  files: { rel: string; bytes: Buffer }[];
  info: Buffer;
}

/**
 * Create a ready library item with random content. `files` are relative paths (a single entry with
 * `single: true` makes a single-file item named `name`).
 */
export async function makeItem(
  ctx: AppContext,
  name: string,
  files: { rel: string; size: number }[],
  opts: { single?: boolean; pieceLength?: number } = {},
): Promise<MadeItem> {
  const lib = ctx.config.paths.library;
  const dir = path.join(lib, name);
  const made: { rel: string; bytes: Buffer }[] = [];
  if (opts.single) {
    const bytes = randomBytes(files[0]!.size);
    await writeFile(dir, bytes);
    made.push({ rel: name, bytes });
  } else {
    for (const f of files) {
      const p = path.join(dir, ...f.rel.split('/'));
      await mkdir(path.dirname(p), { recursive: true });
      const bytes = randomBytes(f.size);
      await writeFile(p, bytes);
      made.push({ rel: f.rel, bytes });
    }
  }
  const torrentBuf: Buffer = await new Promise((resolve, reject) =>
    createTorrent(dir, { private: true, announceList: [], pieceLength: opts.pieceLength ?? 32 * 1024, createdBy: 'test' }, (err: Error | null, buf: Buffer) =>
      err ? reject(err) : resolve(buf),
    ),
  );
  const decoded = bencode.decode(torrentBuf) as { info: unknown };
  const info = Buffer.from(bencode.encode(decoded.info));
  const id = newId();
  const now = Date.now();
  const total = made.reduce((a, f) => a + f.bytes.length, 0);
  ctx.db
    .prepare(
      `INSERT INTO items (id, name, kind, source, source_name, status, total_bytes, file_count, piece_length, info, library_at, created_at, updated_at, ready_at)
       VALUES (?, ?, ?, 'upload', ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, opts.single ? 'file' : 'dir', name, total, made.length, opts.pieceLength ?? 32 * 1024, info, now, now, now, now);
  return { id, name, dir, files: made, info };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 10_000, stepMs = 50): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor: timed out');
    await sleep(stepMs);
  }
}

/** Public listener + p2p service on the env's ephemeral public port (seeder off by default). */
export async function startPublic(
  env: TestEnv,
  opts: import('../../src/p2p/index.js').P2POptions = {},
): Promise<{ p2p: import('../../src/p2p/index.js').P2P; app: import('fastify').FastifyInstance; base: string; close(): Promise<void> }> {
  const { createP2P } = await import('../../src/p2p/index.js');
  const { buildPublicServer } = await import('../../src/server/public.js');
  const p2p = createP2P(env.ctx, { seeder: false, argon: { memoryCost: 4096, timeCost: 2 }, ...opts });
  const app = await buildPublicServer(env.ctx, p2p);
  await p2p.start();
  await app.listen({ host: '127.0.0.1', port: env.ports.public });
  return {
    p2p,
    app,
    base: `http://127.0.0.1:${env.ports.public}`,
    async close() {
      // Idle keep-alive / never-used client connections would otherwise keep close() waiting.
      const closing = app.close();
      app.server.closeAllConnections();
      await closing;
      await p2p.stop();
    },
  };
}
