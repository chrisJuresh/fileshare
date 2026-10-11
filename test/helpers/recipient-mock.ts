// Mock of the PUBLIC listener for recipient-page tests (Node, ESM; loaded by Playwright).
// Serves dist/web/recipient the way docs/ARCHITECTURE.md §7.1 describes, implements the share API
// (status, unlock, torrent), a WebSocket + HTTP tracker (bittorrent-tracker), a webseed with Range
// support, a minimal live swarm socket (§8), and seeds a small synthetic multi-file torrent from
// Node WebTorrent over WebRTC (node-datachannel). All data is random bytes in a temp dir.
//
// Usage:
//   const mock = await startRecipientMock({ password: 'pw' });
//   await page.goto(mock.shareUrl); ...; await mock.close();
import fastifyWebsocket from '@fastify/websocket';
import bencode from 'bencode';
import { Server as TrackerServer } from 'bittorrent-tracker';
import createTorrent from 'create-torrent';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import WebTorrent from 'webtorrent';
import type WebSocket from 'ws';
import { publicSecurityHeaders } from '../../src/server/headers.ts';
import type { ClientMsg, FileEntry, ServerMsg, SwarmPeer, UnlockResponse } from '../../src/types.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const webRoot = path.join(repoRoot, 'dist', 'web', 'recipient');

export interface MockFileSpec {
  path: string;
  size: number;
  /** Synthetic text to serve instead of `size` random bytes (e.g. a README.md). */
  content?: string;
}

export interface RecipientMockOptions {
  /** null/undefined = no password (status 'open'). */
  password?: string | null;
  /** Item (torrent) name. */
  name?: string;
  files?: MockFileSpec[];
  pieceLength?: number;
  /** Seed from Node WebTorrent over WebRTC (default true). */
  seed?: boolean;
  /** Webseed upload rate limit in bytes/s (default unlimited). */
  webseedBps?: number;
  port?: number;
}

export interface MockFile extends FileEntry {
  sha256: string;
}

export interface MockLiveClient {
  id: string;
  peerId: string;
  nick: string;
  stats: Extract<ClientMsg, { t: 'stats' }> | null;
}

export interface RecipientMock {
  baseUrl: string;
  shareId: string;
  shareUrl: string;
  /** A share URL that never existed (must look identical to a revoked one). */
  goneUrl: string;
  name: string;
  password: string | null;
  token: string;
  infoHash: string;
  files: MockFile[];
  /** `liveCloseCodes`: close code of every live socket that had said hello (1001 = page closed or reloaded). */
  stats: { unlockFailures: number; webseedBytes: number; hellos: number; live: MockLiveClient[]; liveCloseCodes: number[]; unlockNames: unknown[]; nameSwaps: unknown[]; refreshes: number };
  /** Makes the share gone and closes live sockets with 4404 (revocation mid-download). */
  revoke(): void;
  /** Closes live sockets with 4409 ("files were added": the page reloads its info via /refresh). */
  contentChanged(): void;
  close(): Promise<void>;
}

export const DEFAULT_FILES: MockFileSpec[] = [
  { path: 'docs/readme.txt', size: 3_000 },
  { path: 'docs/b.bin', size: 300_000 },
  { path: 'media/clip one.bin', size: 1_500_000 },
  { path: 'media/deep/x.bin', size: 700_000 },
  { path: 'top.bin', size: 1_000_000 },
];

export async function startRecipientMock(opts: RecipientMockOptions = {}): Promise<RecipientMock> {
  const name = opts.name ?? 'Synthetic Item';
  const password = opts.password ?? null;
  const specs = opts.files ?? DEFAULT_FILES;
  const pieceLength = opts.pieceLength ?? 64 * 1024;
  const shareId = randomBytes(16).toString('base64url');
  const token = `${shareId}.1.${randomBytes(16).toString('base64url')}`;

  // --- synthetic data ---
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'fileshare-recipient-'));
  const single = specs.length === 1 && specs[0]!.path === name;
  const files: MockFile[] = [];
  for (const spec of specs) {
    const data = spec.content === undefined ? randomBytes(spec.size) : Buffer.from(spec.content, 'utf8');
    const abs = single ? path.join(tmp, name) : path.join(tmp, name, ...spec.path.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
    files.push({ path: spec.path, length: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }

  // --- server ---
  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  let host = 'localhost';
  app.addHook('onRequest', async (_req, reply) => {
    publicSecurityHeaders(reply, host);
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });
  // Static files (same mapping as src/server/public.ts intends; @fastify/static isn't loadable under
  // Playwright's module loader, so a tiny equivalent).
  const types: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.map': 'application/json',
    '.html': 'text/html; charset=utf-8',
  };
  const sendStatic = async (dir: string, rel: string, reply: import('fastify').FastifyReply, extra: Record<string, string> = {}) => {
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep)) return reply.code(404).send({ error: 'not_found' });
    let body: Buffer;
    try {
      body = await readFile(abs);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    reply.header('Content-Type', types[path.extname(abs)] ?? 'application/octet-stream');
    for (const [k, v] of Object.entries(extra)) reply.header(k, v);
    return reply.send(body);
  };
  app.get<{ Params: { '*': string } }>('/assets/*', (req, reply) => sendStatic(path.join(webRoot, 'assets'), req.params['*'], reply));
  app.get<{ Params: { '*': string } }>('/vendor/*', (req, reply) => sendStatic(path.join(webRoot, 'vendor'), req.params['*'], reply));
  app.get('/sw.min.js', (_req, reply) =>
    sendStatic(path.join(webRoot, 'vendor'), 'sw.min.js', reply, { 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache' }),
  );
  app.get('/s/:shareId', (_req, reply) => sendStatic(webRoot, 'index.html', reply, { 'Cache-Control': 'no-store' }));

  let revoked = false;
  const stats: RecipientMock['stats'] = { unlockFailures: 0, webseedBytes: 0, hellos: 0, live: [], liveCloseCodes: [], unlockNames: [], nameSwaps: [], refreshes: 0 };
  const isShare = (id: string): boolean => id === shareId && !revoked;
  const tokenOk = (t: string | undefined): boolean => t === token && !revoked;

  app.get<{ Params: { id: string } }>('/api/s/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isShare(req.params.id)) return { status: 'gone', passwordRequired: false };
    return password ? { status: 'locked', passwordRequired: true } : { status: 'open', passwordRequired: false };
  });

  // Filled in after listen (URLs need the port).
  let unlockBody: UnlockResponse | null = null;
  let torrentBuf: Buffer | null = null;

  app.post<{ Params: { id: string }; Body: { password?: unknown; name?: unknown } }>('/api/s/:id/unlock', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    stats.unlockNames.push(req.body?.name);
    if (!isShare(req.params.id)) return reply.code(404).send({ error: 'gone' });
    if (stats.unlockFailures >= 5) return reply.code(429).send({ error: 'rate_limited', retryAfter: 30 });
    if (password && req.body?.password !== password) {
      stats.unlockFailures++;
      return reply.code(401).send({ error: 'bad_password' });
    }
    return unlockBody;
  });

  // Token-for-name swap: the mock keeps its one token (a real server returns a recipient token).
  app.post<{ Params: { id: string }; Body: { token?: unknown; name?: unknown } }>('/api/s/:id/name', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isShare(req.params.id)) return reply.code(404).send({ error: 'gone' });
    if (typeof req.body?.token !== 'string' || !tokenOk(req.body.token)) return reply.code(401).send({ error: 'invalid' });
    stats.nameSwaps.push(req.body?.name);
    return unlockBody;
  });

  // Same token back with the current info (the mock's files never change).
  app.post<{ Params: { id: string }; Body: { token?: unknown } }>('/api/s/:id/refresh', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isShare(req.params.id)) return reply.code(404).send({ error: 'gone' });
    if (typeof req.body?.token !== 'string' || !tokenOk(req.body.token)) return reply.code(401).send({ error: 'invalid' });
    stats.refreshes++;
    return unlockBody;
  });

  app.get<{ Params: { id: string }; Querystring: { t?: string } }>('/api/s/:id/torrent', async (req, reply) => {
    if (!isShare(req.params.id) || !tokenOk(req.query.t)) return reply.code(404).send({ error: 'gone' });
    reply
      .header('Content-Type', 'application/x-bittorrent')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}.torrent`)
      .header('Cache-Control', 'no-store');
    return reply.send(torrentBuf);
  });

  // --- tracker ---
  let infoHash = '';
  const tracker = new TrackerServer({
    http: false,
    udp: false,
    ws: false,
    stats: false,
    filter: (ih: string, _params: unknown, cb: (err: Error | null) => void) => {
      cb(!revoked && ih === infoHash ? null : new Error('not allowed'));
    },
  });
  tracker.on('warning', () => {});
  tracker.on('error', () => {});
  app.route<{ Params: { token: string } }>({
    method: 'GET',
    url: '/tr/:token',
    handler: async (_req, reply) => reply.code(426).send({ error: 'upgrade required' }),
    wsHandler: (socket, req) => {
      if (!tokenOk(req.params.token)) {
        socket.close(4004);
        return;
      }
      (socket as unknown as { upgradeReq: unknown }).upgradeReq = req.raw;
      tracker.onWebSocketConnection(socket);
    },
  });
  app.get<{ Params: { token: string } }>('/tr/:token/announce', (req, reply) => {
    if (!tokenOk(req.params.token)) {
      void reply.code(404).send();
      return;
    }
    reply.hijack();
    tracker.onHttpRequest(req.raw, reply.raw, { action: 'announce' });
  });

  // --- webseed: /ws/<token>/<name>/<path> (multi-file) or /ws/<token>/<name> (single file) ---
  app.get<{ Params: { token: string; '*': string } }>('/ws/:token/*', async (req, reply) => {
    if (!tokenOk(req.params.token)) return reply.code(404).send();
    let segs: string[];
    try {
      segs = req.params['*'].split('/').map((s) => decodeURIComponent(s));
    } catch {
      return reply.code(400).send();
    }
    if (segs[0] !== name || segs.some((s) => !s || s === '.' || s === '..')) return reply.code(404).send();
    const rel = segs.slice(1).join('/');
    const entry = single ? (segs.length === 1 ? files[0] : undefined) : files.find((f) => f.path === rel);
    if (!entry) return reply.code(404).send();
    const abs = single ? path.join(tmp, name) : path.join(tmp, name, ...rel.split('/'));
    const size = (await stat(abs)).size;
    let start = 0;
    let end = size - 1;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    reply
      .header('Accept-Ranges', 'bytes')
      .header('Content-Length', String(end - start + 1))
      .header('Content-Type', 'application/octet-stream')
      .header('Access-Control-Allow-Origin', '*');
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        stats.webseedBytes += chunk.length;
        if (!opts.webseedBps) return cb(null, chunk);
        setTimeout(() => cb(null, chunk), (chunk.length / opts.webseedBps) * 1000);
      },
    });
    return reply.send(createReadStream(abs, { start, end }).pipe(counter));
  });

  // --- live swarm socket (§8) ---
  const sockets = new Set<WebSocket>();
  let counter = 0;
  const serverRow = (): SwarmPeer => ({ id: 'srv', label: 'Server', kind: 'server', progress: 1, down: 0, up: 0, uploaded: stats.webseedBytes });
  const swarmFor = (me: MockLiveClient): ServerMsg => ({
    t: 'swarm',
    you: me.id,
    peers: [
      serverRow(),
      ...stats.live.map((c, i) => ({
        id: c.id,
        label: c.nick || `Friend ${i + 1}`,
        kind: 'browser' as const,
        progress: c.stats?.progress ?? 0,
        down: c.stats?.down ?? 0,
        up: c.stats?.up ?? 0,
        uploaded: c.stats?.uploaded ?? 0,
      })),
    ],
    totals: { peers: stats.live.length + 1, serverBytes: stats.webseedBytes, peerBytes: 0, completed: 0 },
  });
  app.get<{ Params: { id: string } }>('/api/s/:id/live', { websocket: true }, (socket, req) => {
    if (!isShare(req.params.id)) {
      socket.close(4404);
      return;
    }
    sockets.add(socket);
    let me: MockLiveClient | null = null;
    const helloTimer = setTimeout(() => socket.close(4401), 10_000);
    let timer: NodeJS.Timeout | null = null;
    socket.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw)) as ClientMsg;
      } catch {
        return;
      }
      if (!me) {
        if (msg.t !== 'hello' || !tokenOk(msg.token) || !/^[0-9a-f]{40}$/.test(msg.peerId)) {
          socket.close(4401);
          return;
        }
        clearTimeout(helloTimer);
        stats.hellos++;
        me = { id: `p${++counter}`, peerId: msg.peerId, nick: (msg.nick ?? '').slice(0, 24), stats: null };
        stats.live.push(me);
        const send = (): void => {
          if (me && socket.readyState === 1) socket.send(JSON.stringify(swarmFor(me)));
        };
        send();
        timer = setInterval(send, 1500);
        return;
      }
      if (msg.t === 'stats') me.stats = msg;
      else if (msg.t === 'nick') me.nick = String(msg.nick).slice(0, 24);
    });
    socket.on('close', (code: number) => {
      clearTimeout(helloTimer);
      if (timer) clearInterval(timer);
      sockets.delete(socket);
      if (me) {
        stats.live = stats.live.filter((c) => c !== me);
        stats.liveCloseCodes.push(code);
      }
    });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

  await app.listen({ host: '127.0.0.1', port: opts.port ?? 0 });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  host = `localhost:${port}`;
  const baseUrl = `http://localhost:${port}`;
  const announceWs = `ws://localhost:${port}/tr/${token}`;
  const announceHttp = `${baseUrl}/tr/${token}/announce`;
  const webseed = `${baseUrl}/ws/${token}/`;

  torrentBuf = await new Promise<Buffer>((resolve, reject) => {
    createTorrent(
      single ? path.join(tmp, name) : path.join(tmp, name),
      {
        name,
        private: true,
        pieceLength,
        announceList: [[announceHttp], [announceWs]],
        urlList: [webseed],
        createdBy: 'fileshare-test',
        creationDate: new Date(),
      },
      (err: Error | null, buf: Buffer) => (err ? reject(err) : resolve(buf)),
    );
  });
  const decoded = bencode.decode(torrentBuf) as { info: unknown };
  infoHash = createHash('sha1').update(bencode.encode(decoded.info)).digest('hex');

  unlockBody = {
    token,
    infoHash,
    name,
    totalBytes: files.reduce((s, f) => s + f.length, 0),
    pieceLength,
    files: files.map(({ path: p, length }) => ({ path: p, length })),
    torrentUrl: `${baseUrl}/api/s/${shareId}/torrent?t=${encodeURIComponent(token)}`,
    magnet: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}&tr=${encodeURIComponent(announceWs)}&tr=${encodeURIComponent(announceHttp)}&ws=${encodeURIComponent(webseed)}`,
    announce: { ws: announceWs, http: announceHttp },
    webseed,
    iceServers: [],
    expiresAt: null,
  };

  // --- Node seeder over WebRTC ---
  let seeder: { destroy(cb?: () => void): void } | null = null;
  if (opts.seed !== false) {
    const client = new WebTorrent({
      dht: false,
      lsd: false,
      utPex: false,
      natUpnp: false,
      natPmp: false,
      webSeeds: false,
      tracker: { rtcConfig: { iceServers: [] }, getAnnounceOpts: () => ({ numwant: 0 }) },
    });
    client.on('error', () => {});
    seeder = client;
    await new Promise<void>((resolve, reject) => {
      const t = client.add(torrentBuf, { path: tmp, skipVerify: true, uploads: 64 });
      t.on('error', reject);
      t.on('warning', () => {});
      t.once('ready', () => resolve());
    });
  }

  return {
    baseUrl,
    shareId,
    shareUrl: `${baseUrl}/s/${shareId}`,
    goneUrl: `${baseUrl}/s/${randomBytes(16).toString('base64url')}`,
    name,
    password,
    token,
    infoHash,
    files,
    stats,
    revoke() {
      revoked = true;
      for (const s of sockets) s.close(4404);
    },
    contentChanged() {
      for (const s of sockets) s.close(4409);
    },
    async close() {
      for (const s of sockets) s.terminate();
      await new Promise<void>((resolve) => (seeder ? seeder.destroy(() => resolve()) : resolve()));
      await new Promise<void>((resolve) => tracker.close(() => resolve()));
      app.server.closeAllConnections();
      await app.close();
      await rm(tmp, { recursive: true, force: true });
    },
  };
}
