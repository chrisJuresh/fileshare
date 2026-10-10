// Real app: share enforcement (password / password change / expiry / revoke) on every public
// surface — page API, unlock, .torrent, HTTP + WebSocket tracker, webseed, live socket — and the
// admin boundary (no admin routes on the public listener; admin requires a valid Access JWT).
import { expect, test } from '@playwright/test';
// @ts-ignore untyped package
import bencode from 'bencode';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type { UnlockResponse } from '../../src/types.ts';
import { admin, adminToken, createShare, pub, seedItem, sleep, stack, type SeededItem } from '../helpers/stack.ts';

test.setTimeout(180_000);

let item: SeededItem;
test.beforeAll(async () => {
  const tag = randomBytes(4).toString('hex');
  item = await seedItem(`Secret Synthetic ${tag}`, [
    { path: 'hidden-folder/alpha-report.bin', size: 300_000 },
    { path: 'beta-notes.bin', size: 120_000 },
  ]);
});

/** Strings that must never appear before a successful unlock. */
function secrets(infoHash?: string): string[] {
  return [item.name, 'hidden-folder', 'alpha-report', 'beta-notes', ...(infoHash ? [infoHash] : [])];
}
function expectNoSecrets(text: string, infoHash?: string): void {
  for (const s of secrets(infoHash)) expect(text, `leaked "${s}"`).not.toContain(s);
}

const latin1 = (hex: string): string => Buffer.from(hex, 'hex').toString('latin1');
const peerId = (): string => `-FT0001-${randomBytes(6).toString('hex')}`;

async function httpAnnounce(token: string, infoHash: string): Promise<{ status: number; dict: Record<string, unknown> }> {
  const q = new URLSearchParams({ port: '28999', uploaded: '0', downloaded: '0', left: '1000', compact: '1', event: 'started' }).toString();
  const ih = [...Buffer.from(infoHash, 'hex')].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('');
  const pid = encodeURIComponent(peerId());
  const r = await fetch(`${stack().publicUrl}/tr/${token}/announce?info_hash=${ih}&peer_id=${pid}&${q}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const dict = bencode.decode(buf) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(dict)) out[k] = v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : v;
  return { status: r.status, dict: out };
}

interface WsConn {
  ws: WebSocket;
  closed: Promise<number>;
  messages: string[];
  next(): Promise<string>;
}
function wsOpen(path: string): WsConn {
  const ws = new WebSocket(`${stack().publicUrl.replace(/^http/, 'ws')}${path}`);
  const messages: string[] = [];
  const waiters: ((m: string) => void)[] = [];
  ws.on('message', (d) => {
    const m = String(d);
    messages.push(m);
    waiters.shift()?.(m);
  });
  ws.on('error', () => {});
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  return {
    ws,
    closed,
    messages,
    next: () => new Promise<string>((resolve, reject) => {
      waiters.push(resolve);
      setTimeout(() => reject(new Error('no ws message')), 10_000);
    }),
  };
}
const opened = (c: WsConn): Promise<void> =>
  new Promise((resolve, reject) => {
    c.ws.once('open', () => resolve());
    c.ws.once('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });

/** WS tracker: connect + announce; resolves with the first reply or the close code. */
async function wsAnnounce(token: string, infoHash: string): Promise<{ conn: WsConn; reply?: Record<string, unknown>; closeCode?: number }> {
  const conn = wsOpen(`/tr/${token}`);
  const first = await Promise.race([opened(conn).then(() => 'open' as const), conn.closed.then((c) => c)]);
  if (first !== 'open') return { conn, closeCode: first };
  conn.ws.send(JSON.stringify({ action: 'announce', info_hash: latin1(infoHash), peer_id: peerId(), numwant: 0, uploaded: 0, downloaded: 0, left: 1000, event: 'started', offers: [] }));
  const r = await Promise.race([conn.next().then((m) => ({ m })), conn.closed.then((c) => ({ c }))]);
  if ('c' in r) return { conn, closeCode: r.c };
  return { conn, reply: JSON.parse(r.m) as Record<string, unknown> };
}

/** Live socket: hello → first swarm message, or the close code. */
async function liveHello(shareId: string, token: string): Promise<{ conn: WsConn; msg?: Record<string, unknown>; closeCode?: number }> {
  const conn = wsOpen(`/api/s/${shareId}/live`);
  await opened(conn);
  conn.ws.send(JSON.stringify({ t: 'hello', token, peerId: randomBytes(20).toString('hex') }));
  const r = await Promise.race([conn.next().then((m) => ({ m })), conn.closed.then((c) => ({ c }))]);
  if ('c' in r) return { conn, closeCode: r.c };
  return { conn, msg: JSON.parse(r.m) as Record<string, unknown> };
}

async function webseed(token: string, file: string): Promise<{ status: number; body: Buffer }> {
  const r = await fetch(`${stack().publicUrl}/ws/${token}/${encodeURIComponent(item.name)}/${file.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { Range: 'bytes=0-99' },
  });
  return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
}

/** Every token-gated public surface works with `u`. */
async function expectAllAllowed(shareId: string, u: UnlockResponse): Promise<void> {
  const t = await pub('GET', `/api/s/${shareId}/torrent?t=${u.token}`);
  expect(t.status).toBe(200);
  expect(t.headers.get('content-type')).toBe('application/x-bittorrent');
  const ann = await httpAnnounce(u.token, u.infoHash);
  expect(ann.dict['failure reason']).toBeUndefined();
  expect(typeof ann.dict.interval).toBe('number');
  expect((await httpAnnounce(u.token, '00'.repeat(20))).dict['failure reason']).toBe('access denied'); // other infohash
  const w = await wsAnnounce(u.token, u.infoHash);
  expect(w.reply?.['failure reason']).toBeUndefined();
  expect(w.reply?.action).toBe('announce');
  w.conn.ws.close();
  const ws = await webseed(u.token, 'hidden-folder/alpha-report.bin');
  expect(ws.status).toBe(206);
  expect(ws.body.length).toBe(100);
  const live = await liveHello(shareId, u.token);
  expect(live.msg?.t).toBe('swarm');
  live.conn.ws.close();
}

/** Every token-gated public surface refuses `token`; nothing about the item is revealed. */
async function expectAllRefused(shareId: string, token: string, infoHash: string, wsCode: number): Promise<void> {
  const t = await pub('GET', `/api/s/${shareId}/torrent?t=${token}`);
  expect(t.status).toBe(404);
  expectNoSecrets(t.text, infoHash);
  const ann = await httpAnnounce(token, infoHash);
  expect(ann.dict['failure reason']).toBe('access denied');
  expectNoSecrets(JSON.stringify(ann.dict), infoHash);
  const w = await wsAnnounce(token, infoHash);
  expect(w.closeCode).toBe(wsCode);
  const ws = await webseed(token, 'hidden-folder/alpha-report.bin');
  expect(ws.status).toBe(404);
  expectNoSecrets(ws.body.toString('latin1'), infoHash);
  const live = await liveHello(shareId, token);
  expect(live.closeCode).toBe(wsCode);
}

async function expectGone(shareId: string, infoHash: string): Promise<void> {
  const st = await pub('GET', `/api/s/${shareId}`);
  expect(st.body).toEqual({ status: 'gone', passwordRequired: false });
  const un = await pub('POST', `/api/s/${shareId}/unlock`, { password: 'anything' });
  expect(un.status).toBe(404);
  expect(un.body).toEqual({ error: 'gone' });
  expectNoSecrets(st.text + un.text, infoHash);
}

test('password, password change, expiry: every surface before/after', async () => {
  const share = await createShare(item.id, { password: 'synthetic-pw-1' });
  const id = share.id;
  const ih = share.infoHash;

  // Locked: nothing revealed.
  const st = await pub('GET', `/api/s/${id}`);
  expect(st.body).toEqual({ status: 'locked', passwordRequired: true });
  const page = await pub('GET', `/s/${id}`);
  expect(page.status).toBe(200);
  expect(page.text).toBe((await pub('GET', `/s/${randomBytes(16).toString('base64url')}`)).text); // constant shell
  for (const body of [{}, { password: 'wrong' }]) {
    const r = await pub('POST', `/api/s/${id}/unlock`, body);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'bad_password' });
    expectNoSecrets(r.text, ih);
  }
  expectNoSecrets(st.text + page.text, ih);
  const forged = `${id}.1.${randomBytes(16).toString('base64url')}`;
  await expectAllRefused(id, forged, ih, 4401);
  await expectAllRefused(id, 'garbage', ih, 4401);

  // Unlocked.
  const u1 = (await pub<UnlockResponse>('POST', `/api/s/${id}/unlock`, { password: 'synthetic-pw-1' })).body;
  expect(u1.name).toBe(item.name);
  expect(u1.files.map((f) => f.path).sort()).toEqual(item.files.map((f) => f.path).sort());
  await expectAllAllowed(id, u1);

  // Password change: open sockets dropped (4401), old token refused everywhere, old password refused.
  const trk = await wsAnnounce(u1.token, ih);
  expect(trk.reply?.action).toBe('announce');
  const live = await liveHello(id, u1.token);
  expect(live.msg?.t).toBe('swarm');
  const p = await admin('PATCH', `/api/admin/shares/${id}`, { password: 'synthetic-pw-2' });
  expect(p.status).toBe(200);
  expect(await trk.conn.closed).toBe(4401);
  expect(await live.conn.closed).toBe(4401);
  await expectAllRefused(id, u1.token, ih, 4401);
  expect((await pub('POST', `/api/s/${id}/unlock`, { password: 'synthetic-pw-1' })).status).toBe(401);
  const u2 = (await pub<UnlockResponse>('POST', `/api/s/${id}/unlock`, { password: 'synthetic-pw-2' })).body;
  expect(u2.token).not.toBe(u1.token);
  await expectAllAllowed(id, u2);

  // Expiry: works until expiresAt, then gone everywhere; open sockets are closed by the sweep (≤ 30 s).
  const trk2 = await wsAnnounce(u2.token, ih);
  const live2 = await liveHello(id, u2.token);
  const expiresAt = Date.now() + 3000;
  expect((await admin('PATCH', `/api/admin/shares/${id}`, { expiresAt })).status).toBe(200);
  await expectAllAllowed(id, u2);
  await sleep(expiresAt - Date.now() + 300);
  await expectGone(id, ih);
  await expectAllRefused(id, u2.token, ih, 4404);
  const codes = await Promise.race([Promise.all([trk2.conn.closed, live2.conn.closed]), sleep(40_000).then(() => null)]);
  expect(codes).toEqual([4404, 4404]);
  expect((await admin<{ state: string }[]>('GET', '/api/admin/shares')).body.find((x: any) => x.id === id)?.state).toBe('expired');
});

test('revoke: immediate, sockets closed, identical to an unknown link', async () => {
  const share = await createShare(item.id);
  const id = share.id;
  const st = await pub('GET', `/api/s/${id}`);
  expect(st.body).toEqual({ status: 'open', passwordRequired: false });
  expectNoSecrets(st.text, share.infoHash);
  const u = (await pub<UnlockResponse>('POST', `/api/s/${id}/unlock`, {})).body;
  await expectAllAllowed(id, u);
  const trk = await wsAnnounce(u.token, share.infoHash);
  const live = await liveHello(id, u.token);
  expect((await admin('POST', `/api/admin/shares/${id}/revoke`, {})).status).toBe(200);
  expect(await trk.conn.closed).toBe(4404);
  expect(await live.conn.closed).toBe(4404);
  await expectGone(id, share.infoHash);
  await expectAllRefused(id, u.token, share.infoHash, 4404);
  // Revoked and never-existing shares are indistinguishable.
  const unknown = randomBytes(16).toString('base64url');
  expect((await pub('GET', `/api/s/${unknown}`)).text).toBe((await pub('GET', `/api/s/${id}`)).text);
  const a = await pub('POST', `/api/s/${unknown}/unlock`, {});
  const b = await pub('POST', `/api/s/${id}/unlock`, {});
  expect([a.status, a.text]).toEqual([b.status, b.text]);
  expect((await admin('PATCH', `/api/admin/shares/${id}`, { password: 'x1' })).status).toBe(409);
});

test('a locked share page reveals nothing in the browser before unlock', async ({ page }) => {
  const share = await createShare(item.id, { password: 'synthetic-pw-3' });
  const bodies: string[] = [];
  page.on('response', async (r) => {
    try {
      bodies.push((await r.body()).toString('latin1'));
    } catch {
      /* ignore */
    }
  });
  await page.goto(share.url);
  await expect(page.getByLabel('Password')).toBeVisible();
  await page.getByLabel('Password').fill('not-it');
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  for (const b of [...bodies, await page.content()]) expectNoSecrets(b, share.infoHash);
  await page.getByLabel('Password').fill('synthetic-pw-3');
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: item.name })).toBeVisible();
});

test('admin routes do not exist on the public listener', async () => {
  const paths = ['/api/admin/items', '/api/admin/shares', '/api/admin/stats', '/api/admin/settings', '/api/admin/status', '/api/admin/live',
    '/api/admin/uploads/batches', '/api/admin/uploads/tus/x', '/api/admin/snapshots', '/', '/index.html'];
  const token = await adminToken();
  for (const p of paths) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await fetch(`${stack().publicUrl}${p}`, {
        method,
        headers: { 'Cf-Access-Jwt-Assertion': token, Origin: stack().adminUrl, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
        body: method === 'GET' ? undefined : '{}',
      });
      expect(r.status, `${method} ${p}`).toBe(404);
      const text = await r.text();
      expect(text).not.toMatch(/items|shares|uploadCap|status/i);
    }
  }
  // /assets/* on the public listener is the recipient bundle, never the dashboard's.
  const { readFile } = await import('node:fs/promises');
  const publicJs = await (await fetch(`${stack().publicUrl}/assets/app.js`)).text();
  expect(publicJs).toBe(await readFile(`${stack().repoDir}/dist/web/recipient/assets/app.js`, 'utf8'));
  expect(publicJs).not.toBe(await readFile(`${stack().repoDir}/dist/web/admin/assets/app.js`, 'utf8'));
  const ws = new WebSocket(`${stack().publicUrl.replace(/^http/, 'ws')}/api/admin/live`, { headers: { 'Cf-Access-Jwt-Assertion': token } });
  const res = await new Promise<number>((resolve) => {
    ws.on('unexpected-response', (_q, r) => resolve(r.statusCode ?? 0));
    ws.on('open', () => resolve(101));
    ws.on('error', () => {});
  });
  expect(res).toBe(404);
});

test('admin listener requires a valid Access JWT (and Origin + JSON for changes)', async () => {
  const s = stack();
  const get = (headers: Record<string, string>) => fetch(`${s.adminUrl}/api/admin/items`, { headers });
  expect((await fetch(`${s.adminUrl}/healthz`)).status).toBe(200);
  expect((await get({})).status).toBe(403);
  expect((await get({ 'Cf-Access-Jwt-Assertion': 'not.a.jwt' })).status).toBe(403);
  expect((await get({ 'Cf-Access-Jwt-Assertion': await adminToken({ audience: 'other-aud' }) })).status).toBe(403);
  expect((await get({ 'Cf-Access-Jwt-Assertion': await adminToken({ email: 'intruder@example.invalid' }) })).status).toBe(403);
  expect((await get({ 'Cf-Access-Jwt-Assertion': await adminToken({ expSeconds: -600 }) })).status).toBe(403);
  // Same claims, signed by a key the JWKS doesn't know.
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  void exportJWK(publicKey);
  const now = Math.floor(Date.now() / 1000);
  const rogue = await new SignJWT({ email: s.access.email })
    .setProtectedHeader({ alg: 'RS256', kid: JSON.parse(await (await import('node:fs/promises')).readFile(s.paths.jwk, 'utf8')).kid })
    .setIssuer(s.access.issuer)
    .setAudience(s.access.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
  expect((await get({ 'Cf-Access-Jwt-Assertion': rogue })).status).toBe(403);
  expect((await get({ 'Cf-Access-Jwt-Assertion': await adminToken() })).status).toBe(200);
  // Static dashboard is behind the guard too.
  expect((await fetch(`${s.adminUrl}/`)).status).toBe(403);
  // Mutations: Origin must be the admin origin, body must be JSON.
  const snap = (o: { origin?: string | null; contentType?: string | null }) => admin('POST', '/api/admin/snapshots', {}, o);
  expect((await snap({ origin: null })).status).toBe(403);
  expect((await snap({ origin: 'https://evil.example.invalid' })).status).toBe(403);
  expect((await snap({ contentType: 'text/plain' })).status).toBe(415);
  expect((await admin('PUT', '/api/admin/settings', { uploadCapBps: 1 })).status).toBe(400);
  // Admin live socket: JWT + Origin checked on upgrade.
  for (const headers of [{}, { 'Cf-Access-Jwt-Assertion': await adminToken() }]) {
    const ws = new WebSocket(`${s.adminUrl.replace(/^http/, 'ws')}/api/admin/live`, { headers });
    const code = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_q, r) => resolve(r.statusCode ?? 0));
      ws.on('open', () => resolve(101));
      ws.on('error', () => {});
    });
    expect(code).toBe(403);
  }
});
