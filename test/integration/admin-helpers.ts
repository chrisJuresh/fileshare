// Test helpers for the admin listener: local JWKS (Access), fake ingest/p2p services, fixtures.
// All data here is synthetic.
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { loadConfig } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import { AppEvents } from '../../src/core/events.js';
import { newId, newShareId } from '../../src/core/ids.js';
import { openDb, type ShareRow, type ShareStatsRow } from '../../src/db/index.js';
import type { AddItemsResult, IngestService } from '../../src/ingest/index.js';
import { createLogger } from '../../src/log.js';
import type { P2PService } from '../../src/p2p/index.js';
import { buildAdminServer } from '../../src/server/admin.js';
import type { ItemStatus, ShareDto, SwarmSnapshot } from '../../src/types.js';

export const TEAM = 'team.example.test';
export const AUD = 'aud-synthetic-0001';
export const ADMIN_ORIGIN = 'https://files-admin.example.test';
export const PUBLIC_BASE = 'https://files.example.test';

export interface Jwks {
  url: string;
  kid: string;
  privateKey: CryptoKey;
  close(): Promise<void>;
}

export async function startJwks(): Promise<Jwks> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = 'test-key-1';
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const server: Server = createServer((req, res) => {
    if (req.url === '/cdn-cgi/access/certs') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/cdn-cgi/access/certs`,
    kid,
    privateKey,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export interface TokenOpts {
  email?: string;
  aud?: string;
  iss?: string;
  expSecondsFromNow?: number;
  key?: CryptoKey;
  kid?: string;
}

export async function signToken(jwks: Jwks, o: TokenOpts = {}): Promise<string> {
  const nowS = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: o.email ?? 'admin@example.test', type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: o.kid ?? jwks.kid })
    .setIssuer(o.iss ?? `https://${TEAM}`)
    .setAudience(o.aud ?? AUD)
    .setSubject('synthetic-user')
    .setIssuedAt(nowS - 30)
    .setExpirationTime(nowS + (o.expSecondsFromNow ?? 300))
    .sign(o.key ?? jwks.privateKey);
}

// ------------------------------------------------------------------------------------- fakes

export class FakeIngest implements IngestService {
  calls: { method: string; args: unknown[] }[] = [];
  progressMap: Record<string, number> = {};
  constructor(private readonly ctx: AppContext, private readonly p2p: FakeP2P) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async retry(itemId: string): Promise<void> {
    this.calls.push({ method: 'retry', args: [itemId] });
  }
  async renameItem(itemId: string, newName: string): Promise<void> {
    this.calls.push({ method: 'renameItem', args: [itemId, newName] });
    this.ctx.db.prepare('UPDATE items SET name = ?, updated_at = ? WHERE id = ?').run(newName, Date.now(), itemId);
  }
  async deleteItem(itemId: string): Promise<void> {
    this.calls.push({ method: 'deleteItem', args: [itemId] });
    await this.p2p.revokeAllForItem(itemId);
    this.ctx.db.prepare(`UPDATE items SET status = 'deleted', deleted_at = ? WHERE id = ?`).run(Date.now(), itemId);
  }
  async addFiles(itemId: string, batchId: string): Promise<void> {
    this.calls.push({ method: 'addFiles', args: [itemId, batchId] });
  }
  async addItems(itemId: string, sourceIds: string[]): Promise<AddItemsResult> {
    this.calls.push({ method: 'addItems', args: [itemId, sourceIds] });
    return { removed: [...sourceIds].sort(), kept: [] };
  }
  async registerAdminRoutes(app: FastifyInstance): Promise<void> {
    app.addContentTypeParser('application/offset+octet-stream', (_req, _payload, done) => done(null));
    app.post('/api/admin/uploads/batches', async () => ({ id: 'batch-synthetic' }));
    app.all('/api/admin/uploads/tus/*', async (_req, reply) => reply.code(204).send());
  }
  progress(): Record<string, number> {
    return this.progressMap;
  }
}

export class FakeP2P implements P2PService {
  calls: { method: string; args: unknown[] }[] = [];
  swarms: Record<string, SwarmSnapshot> = {};
  currentBps = 12_345;
  constructor(private readonly ctx: AppContext) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async registerPublicRoutes(): Promise<void> {}
  private dto(row: ShareRow): ShareDto {
    const item = this.ctx.db.prepare('SELECT name FROM items WHERE id = ?').get(row.item_id) as { name: string };
    const st = this.ctx.db.prepare('SELECT * FROM share_stats WHERE share_id = ?').get(row.id) as ShareStatsRow | undefined;
    const now = Date.now();
    return {
      id: row.id,
      itemId: row.item_id,
      itemName: item.name,
      torrentName: row.torrent_name,
      infoHash: row.info_hash,
      url: `${PUBLIC_BASE}/s/${row.id}`,
      hasPassword: row.password_hash !== null,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
      state: row.revoked_at !== null ? 'revoked' : row.expires_at !== null && row.expires_at <= now ? 'expired' : 'active',
      stats: {
        serverBytesWebseed: st?.server_bytes_webseed ?? 0,
        serverBytesP2p: st?.server_bytes_p2p ?? 0,
        peerBytes: st?.peer_bytes ?? 0,
        completedDownloads: st?.completed_downloads ?? 0,
        peakSwarm: st?.peak_swarm ?? 0,
        lastActivityAt: st?.last_activity_at ?? null,
      },
    };
  }
  async createShare(input: { itemId: string; password?: string; expiresAt?: number }): Promise<ShareDto> {
    this.calls.push({ method: 'createShare', args: [input] });
    return insertShare(this.ctx, input.itemId, { password: input.password, expiresAt: input.expiresAt }, (row) => this.dto(row));
  }
  async updateShare(id: string, patch: { password?: string | null; expiresAt?: number | null }): Promise<ShareDto> {
    this.calls.push({ method: 'updateShare', args: [id, patch] });
    const db = this.ctx.db;
    if (patch.password !== undefined) {
      db.prepare('UPDATE shares SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(patch.password === null ? null : 'fake-hash', id);
    }
    if (patch.expiresAt !== undefined) db.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(patch.expiresAt, id);
    return this.getShare(id)!;
  }
  async revokeShare(id: string): Promise<void> {
    this.calls.push({ method: 'revokeShare', args: [id] });
    this.ctx.db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ?').run(Date.now(), id);
  }
  async revokeAllForItem(itemId: string): Promise<void> {
    this.calls.push({ method: 'revokeAllForItem', args: [itemId] });
    this.ctx.db.prepare('UPDATE shares SET revoked_at = ? WHERE item_id = ? AND revoked_at IS NULL').run(Date.now(), itemId);
  }
  async repointItem(): Promise<void> {}
  async refreshItemShares(itemId: string): Promise<void> {
    this.calls.push({ method: 'refreshItemShares', args: [itemId] });
  }
  resetUnlockLimits(id: string): void {
    this.calls.push({ method: 'resetUnlockLimits', args: [id] });
  }
  getShare(id: string): ShareDto | undefined {
    const row = this.ctx.db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as ShareRow | undefined;
    return row ? this.dto(row) : undefined;
  }
  listShares(): ShareDto[] {
    return (this.ctx.db.prepare('SELECT * FROM shares ORDER BY created_at DESC').all() as ShareRow[]).map((r) => this.dto(r));
  }
  swarm(shareId: string): SwarmSnapshot | undefined {
    return this.swarms[shareId];
  }
  allSwarms(): Record<string, SwarmSnapshot> {
    return this.swarms;
  }
  limiter = {
    setRate: (_b: number): void => undefined,
    throttle: () => new PassThrough(),
    currentBps: (): number => this.currentBps,
  };
}

// ---------------------------------------------------------------------------------- fixtures

export function insertItem(
  ctx: AppContext,
  o: { name?: string; status?: ItemStatus; info?: Buffer | null; totalBytes?: number; fileCount?: number; kind?: 'file' | 'dir' } = {},
): string {
  const id = newId();
  const now = Date.now();
  ctx.db
    .prepare(
      `INSERT INTO items (id, name, kind, source, source_name, status, total_bytes, file_count, info, created_at, updated_at, ready_at)
       VALUES (?, ?, ?, 'upload', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      o.name ?? `synthetic-${id.slice(0, 6)}`,
      o.kind ?? 'dir',
      `src-${id}`,
      o.status ?? 'ready',
      o.totalBytes ?? 1000,
      o.fileCount ?? 1,
      o.info ?? null,
      now,
      now,
      (o.status ?? 'ready') === 'ready' ? now : null,
    );
  return id;
}

export function insertShare<T = string>(
  ctx: AppContext,
  itemId: string,
  o: { password?: string | undefined; expiresAt?: number | undefined; stats?: Partial<ShareStatsRow> } = {},
  map?: (row: ShareRow) => T,
): T {
  const id = newShareId();
  const now = Date.now();
  const infoHash = createHash('sha1').update(randomBytes(20)).digest('hex');
  ctx.db
    .prepare(
      `INSERT INTO shares (id, item_id, info_hash, torrent_name, info, password_hash, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'synthetic', ?, ?, ?, ?, ?)`,
    )
    .run(id, itemId, infoHash, Buffer.from('de'), o.password ? 'fake-hash' : null, o.expiresAt ?? null, now, now);
  const s = o.stats ?? {};
  ctx.db
    .prepare(
      `INSERT INTO share_stats (share_id, server_bytes_webseed, server_bytes_p2p, peer_bytes, completed_downloads, peak_swarm)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, s.server_bytes_webseed ?? 0, s.server_bytes_p2p ?? 0, s.peer_bytes ?? 0, s.completed_downloads ?? 0, s.peak_swarm ?? 0);
  ctx.db.prepare(`INSERT INTO share_events (share_id, at, type, detail) VALUES (?, ?, 'created', '{"by":"test"}')`).run(id, now);
  const row = ctx.db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as ShareRow;
  return map ? map(row) : (id as T);
}

// ---------------------------------------------------------------------------------- harness

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  ingest: FakeIngest;
  p2p: FakeP2P;
  dir: string;
  close(): Promise<void>;
}

export async function startAdmin(env: Record<string, string> = {}): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'fileshare-admin-test-'));
  mkdirSync(path.join(dir, 'web', 'admin'), { recursive: true });
  writeFileSync(path.join(dir, 'web', 'admin', 'index.html'), '<!doctype html><title>admin</title><div id="app"></div>');
  mkdirSync(path.join(dir, 'secrets'), { recursive: true });
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLIC_BASE_URL: PUBLIC_BASE,
    ADMIN_BASE_URL: ADMIN_ORIGIN,
    DATA_DIR: path.join(dir, 'data'),
    STATE_DIR: path.join(dir, 'state'),
    SECRETS_DIR: path.join(dir, 'secrets'),
    WEB_DIR: path.join(dir, 'web'),
    CF_ACCESS_TEAM_DOMAIN: TEAM,
    CF_ACCESS_AUD: AUD,
    SYNCTHING_API_URL: 'http://127.0.0.1:9',
    ...env,
  });
  const ctx: AppContext = { config, db: openDb(':memory:'), log: createLogger('silent'), events: new AppEvents() };
  const p2p = new FakeP2P(ctx);
  const ingest = new FakeIngest(ctx, p2p);
  const app = await buildAdminServer(ctx, { ingest, p2p });
  await app.ready();
  return {
    app,
    ctx,
    ingest,
    p2p,
    dir,
    async close() {
      await app.close();
      ctx.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
