// The seams between modules, with nothing faked but Syncthing, the restic runner and the Access
// key server: REAL admin listener (Access JWT + CSRF guard, tus) + REAL ingest + REAL p2p + REAL
// public listener. Upload a folder → batch complete → ready → share → unlock → webseed bytes →
// revoke → webseed 404 + tracker denies. Synthetic random data only, ephemeral ports only.
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as tus from 'tus-js-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDirs } from '../../src/core/dirs.js';
import { createIngest, type IngestService } from '../../src/ingest/index.js';
import { createP2P, type P2P } from '../../src/p2p/index.js';
import { bencode } from '../../src/p2p/vendor.js';
import { buildAdminServer } from '../../src/server/admin.js';
import { buildPublicServer } from '../../src/server/public.js';
import type { ItemDto, ShareDto, UnlockResponse } from '../../src/types.js';
import { makeTestEnv, runFakeBackup, startFakeSyncthing, waitFor, type FakeSyncthing, type TestEnv } from '../helpers/ingest-fakes.js';
import { ADMIN_ORIGIN, AUD, signToken, startJwks, TEAM, type Jwks } from './admin-helpers.js';
import { freePort } from './p2p-helpers.js';

let jwks: Jwks;
let fake: FakeSyncthing;
let env: TestEnv;
let p2p: P2P;
let ingest: IngestService;
let adminApp: FastifyInstance;
let publicApp: FastifyInstance;
let adminBase: string;
let publicBase: string;
let jwt: string;
let web: string;

beforeAll(async () => {
  jwks = await startJwks();
  const apiKey = randomBytes(24).toString('hex');
  fake = await startFakeSyncthing(apiKey);
  const publicPort = await freePort();
  publicBase = `http://127.0.0.1:${publicPort}`;
  web = mkdtempSync(path.join(os.tmpdir(), 'fileshare-web-'));
  for (const [dir, html] of [
    ['admin', '<!doctype html><title>admin</title>'],
    ['recipient', '<!doctype html><title>share</title>'],
  ] as const) {
    mkdirSync(path.join(web, dir, 'assets'), { recursive: true });
    mkdirSync(path.join(web, dir, 'vendor'), { recursive: true });
    writeFileSync(path.join(web, dir, 'index.html'), html);
  }
  env = makeTestEnv(
    {
      SYNCTHING_API_URL: fake.url,
      PUBLIC_BASE_URL: publicBase,
      ADMIN_BASE_URL: ADMIN_ORIGIN,
      PUBLIC_BIND: '127.0.0.1',
      PUBLIC_PORT: String(publicPort),
      STUN_URLS: '',
      CF_ACCESS_TEAM_DOMAIN: TEAM,
      CF_ACCESS_AUD: AUD,
      CF_ACCESS_CERTS_URL: jwks.url,
      TRUST_PROXY: 'true',
      WEB_DIR: web,
    },
    apiKey,
  );

  await ensureDirs(env.ctx.config.paths);
  p2p = createP2P(env.ctx, { seeder: false, argon: { memoryCost: 4096, timeCost: 2 } });
  ingest = createIngest(env.ctx, { p2p }, { tickMs: 150, snapshotPollMs: 150, eventPollTimeoutS: 1 });
  publicApp = await buildPublicServer(env.ctx, p2p);
  adminApp = await buildAdminServer(env.ctx, { ingest, p2p });
  await p2p.start();
  await ingest.start();
  await publicApp.listen({ host: '127.0.0.1', port: publicPort });
  await adminApp.listen({ host: '127.0.0.1', port: 0 });
  adminBase = `http://127.0.0.1:${(adminApp.server.address() as AddressInfo).port}`;
  jwt = await signToken(jwks, { expSecondsFromNow: 600 });
});

afterAll(async () => {
  for (const app of [adminApp, publicApp]) {
    if (!app) continue;
    const closing = app.close();
    app.server.closeAllConnections();
    await closing;
  }
  await ingest?.stop();
  await p2p?.stop();
  await fake?.close();
  await jwks?.close();
  env?.cleanup();
  if (web) rmSync(web, { recursive: true, force: true });
});

/** Admin API call as the dashboard makes it (Access JWT, Origin, JSON). */
async function admin<T>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'cf-access-jwt-assertion': jwt, accept: 'application/json' };
  if (method !== 'GET') {
    headers.origin = ADMIN_ORIGIN;
    headers['content-type'] = 'application/json';
  }
  const r = await fetch(adminBase + url, { method, headers, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : undefined) as T };
}

function tusUpload(data: Buffer, metadata: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new tus.Upload(data, {
      endpoint: `${adminBase}/api/admin/uploads/tus/`,
      metadata,
      chunkSize: 32 * 1024,
      retryDelays: [],
      storeFingerprintForResuming: false,
      headers: { 'cf-access-jwt-assertion': jwt, origin: ADMIN_ORIGIN },
      onError: reject,
      onSuccess: () => resolve(),
    });
    u.start();
  });
}

const esc = (b: Buffer) => [...b].map((x) => '%' + x.toString(16).padStart(2, '0')).join('');
async function announce(u: UnlockResponse): Promise<Record<string, unknown>> {
  const qs = `info_hash=${esc(Buffer.from(u.infoHash, 'hex'))}&peer_id=${esc(Buffer.from('-qB4650-fullstack001'))}&port=51413&uploaded=0&downloaded=0&left=1&compact=1&event=started`;
  const r = await fetch(`${u.announce.http}?${qs}`, { headers: { 'x-forwarded-for': '203.0.113.200' } });
  expect(r.status).toBe(200);
  return bencode.decode(Buffer.from(await r.arrayBuffer())) as Record<string, unknown>;
}

describe('full stack: admin + ingest + p2p', () => {
  it('upload → ready → share → unlock → webseed → revoke', async () => {
    // Without Access the admin listener refuses everything (incl. tus).
    expect((await fetch(`${adminBase}/api/admin/items`)).status).toBe(403);

    // 1. Upload a small folder through the admin listener (tus).
    const batch = await admin<{ id: string }>('POST', '/api/admin/uploads/batches');
    expect(batch.status).toBe(201);
    const a = randomBytes(150_000);
    const b = randomBytes(7_000);
    await tusUpload(a, { batchId: batch.body.id, relativePath: 'Holiday/a.bin', filename: 'a.bin' });
    await tusUpload(b, { batchId: batch.body.id, relativePath: 'Holiday/sub/b.bin', filename: 'b.bin' });
    expect((await admin<{ status: string }>('GET', `/api/admin/uploads/batches/${batch.body.id}`)).body.status).toBe('open');
    const done = await admin<{ itemIds: string[] }>('POST', `/api/admin/uploads/batches/${batch.body.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.itemIds).toHaveLength(1);
    const itemId = done.body.itemIds[0]!;

    // 2. Ingest hashes it; the (fake) restic runner covers it; it turns ready.
    const itemStatus = async () => (await admin<ItemDto[]>('GET', '/api/admin/items')).body.find((i) => i.id === itemId)?.status;
    await waitFor(async () => (await itemStatus()) === 'snapshotting');
    runFakeBackup(env.ctx.db, env.ctx.config.paths.library, 'ok');
    await waitFor(async () => (await itemStatus()) === 'ready');
    const files = await admin<{ path: string; length: number }[]>('GET', `/api/admin/items/${itemId}/files`);
    expect(files.body.map((f) => f.path).sort()).toEqual(['a.bin', 'sub/b.bin']);

    // 3. Share it via the admin API; the link points at the public listener.
    const created = await admin<ShareDto>('POST', '/api/admin/shares', { itemId });
    expect(created.status).toBe(201);
    const share = created.body;
    expect(share.url).toBe(`${publicBase}/s/${share.id}`);
    expect(share.torrentName).toBe('Holiday');

    // 4. Recipient: status, unlock, webseed bytes, tracker announce.
    expect(await (await fetch(`${publicBase}/api/s/${share.id}`)).json()).toEqual({ status: 'open', passwordRequired: false });
    expect((await fetch(`${publicBase}/s/${share.id}`)).status).toBe(200);
    const ur = await fetch(`${publicBase}/api/s/${share.id}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(ur.status).toBe(200);
    const u = (await ur.json()) as UnlockResponse;
    expect(u.files.map((f) => f.path).sort()).toEqual(['a.bin', 'sub/b.bin']);
    const ws = await fetch(`${u.webseed}Holiday/a.bin`);
    expect(ws.status).toBe(200);
    expect(Buffer.from(await ws.arrayBuffer()).equals(a)).toBe(true);
    const ranged = await fetch(`${u.webseed}Holiday/sub/b.bin`, { headers: { range: 'bytes=100-199' } });
    expect(ranged.status).toBe(206);
    expect(Buffer.from(await ranged.arrayBuffer()).equals(b.subarray(100, 200))).toBe(true);
    expect((await announce(u))['failure reason']).toBeUndefined();
    expect((await fetch(u.torrentUrl)).status).toBe(200);

    // The admin view sees the webseed bytes.
    p2p.stats.flush();
    const listed = await admin<ShareDto[]>('GET', '/api/admin/shares');
    expect(listed.body.find((s) => s.id === share.id)!.stats.serverBytesWebseed).toBe(a.length + 100);

    // 5. Revoke via the admin API: every public path refuses at once.
    expect((await admin('POST', `/api/admin/shares/${share.id}/revoke`)).status).toBe(200);
    expect((await fetch(`${u.webseed}Holiday/a.bin`)).status).toBe(404);
    expect(Buffer.from((await announce(u))['failure reason'] as Uint8Array).toString()).toMatch(/denied/);
    expect((await fetch(u.torrentUrl)).status).toBe(404);
    expect(await (await fetch(`${publicBase}/api/s/${share.id}`)).json()).toMatchObject({ status: 'gone' });

    // 6. Delete via the admin API frees the name and removes the files.
    expect((await admin('DELETE', `/api/admin/items/${itemId}`)).status).toBe(200);
    expect((await admin<ItemDto[]>('GET', '/api/admin/items')).body.some((i) => i.id === itemId)).toBe(false);
  });
});
