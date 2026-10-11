// End-to-end P2P: real public listener (buildPublicServer) + seeder on ephemeral ports, Node
// WebTorrent leechers. Synthetic random data only.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
// @ts-ignore untyped
import parseTorrent from 'parse-torrent';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSetting } from '../../src/db/index.js';
import { createP2P, type P2P } from '../../src/p2p/index.js';
import { WebTorrent, type WtClient, type WtTorrent } from '../../src/p2p/seeder.js';
import { buildPublicServer } from '../../src/server/public.js';
import type { UnlockResponse } from '../../src/types.js';
import { makeEnv, makeItem, sleep, waitFor, type MadeItem, type TestEnv } from './p2p-helpers.js';
// @ts-ignore untyped
import bencode from 'bencode';
import WebSocket from 'ws';

const ARGON = { memoryCost: 4096, timeCost: 2 };

let env: TestEnv;
let p2p: P2P;
let app: FastifyInstance;
let base: string;
let item: MadeItem;
let big: MadeItem;
const leechers: WtClient[] = [];

function leecher(opts: Record<string, unknown> = {}): WtClient {
  const c = new WebTorrent({
    dht: false,
    lsd: false,
    utPex: false,
    natUpnp: false,
    natPmp: false,
    webSeeds: false,
    utp: false,
    tracker: { rtcConfig: { iceServers: [], bindAddress: '127.0.0.1' } },
    ...opts,
  });
  c.on('error', () => {});
  leechers.push(c);
  return c;
}

async function unlock(shareId: string, password?: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/api/s/${shareId}/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(password === undefined ? {} : { password }),
  });
  return { status: r.status, body: await r.json() };
}

async function parsedTorrentFor(u: UnlockResponse): Promise<any> {
  const r = await fetch(u.torrentUrl);
  expect(r.status).toBe(200);
  return parseTorrent(Buffer.from(await r.arrayBuffer()));
}

async function downloadAll(t: WtTorrent, timeoutMs = 30_000): Promise<void> {
  if (t.done) return;
  await Promise.race([
    new Promise<void>((resolve) => t.once('done', () => resolve())),
    sleep(timeoutMs).then(() => {
      throw new Error('download timed out');
    }),
  ]);
}

async function expectSameBytes(dlRoot: string, it: MadeItem): Promise<void> {
  for (const f of it.files) {
    const p = path.join(dlRoot, it.name, ...f.rel.split('/'));
    expect((await readFile(p)).equals(f.bytes)).toBe(true);
  }
}

beforeAll(async () => {
  env = await makeEnv();
  p2p = createP2P(env.ctx, { argon: ARGON, tickIntervalMs: 200, flushIntervalMs: 500, sweepIntervalMs: 500, rtcBindAddress: '127.0.0.1' });
  app = await buildPublicServer(env.ctx, p2p);
  await p2p.start();
  await app.listen({ host: '127.0.0.1', port: env.ports.public });
  base = `http://127.0.0.1:${env.ports.public}`;
  item = await makeItem(env.ctx, 'Holiday set ü', [
    { rel: 'a.bin', size: 300 * 1024 },
    { rel: 'sub dir/b c.bin', size: 450 * 1024 + 17 },
    { rel: 'sub dir/ünï €.bin', size: 70 * 1024 },
  ]);
  big = await makeItem(env.ctx, 'big', [
    { rel: 'x.bin', size: 900 * 1024 },
    { rel: 'y.bin', size: 700 * 1024 + 5 },
  ], { pieceLength: 64 * 1024 });
});

function setCap(bps: number | null): void {
  setSetting(env.ctx.db, 'upload.cap_bps', bps);
  env.ctx.events.emit('settings.changed', { key: 'upload.cap_bps' });
}

const esc = (b: Buffer) => [...b].map((x) => '%' + x.toString(16).padStart(2, '0')).join('');

/** Raw HTTP tracker announce as a torrent client would send it. */
async function httpAnnounce(trackerHttp: string, infoHash: string, peerId: string, extra: Record<string, string | number> = {}) {
  const q = new URLSearchParams();
  const qs =
    `info_hash=${esc(Buffer.from(infoHash, 'hex'))}&peer_id=${esc(Buffer.from(peerId))}` +
    Object.entries({ port: 51413, uploaded: 0, downloaded: 0, left: 1000, compact: 1, event: 'started', ...extra })
      .map(([k, v]) => `&${k}=${encodeURIComponent(String(v))}`)
      .join('');
  void q;
  const r = await fetch(`${trackerHttp}?${qs}`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
  return { status: r.status, body: bencode.decode(Buffer.from(await r.arrayBuffer())) as Record<string, unknown> };
}

function wsCloseCode(url: string, firstMsg?: unknown): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('open', () => {
      if (firstMsg !== undefined) ws.send(JSON.stringify(firstMsg));
    });
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => {});
  });
}

afterAll(async () => {
  await Promise.all(leechers.map((c) => new Promise<void>((r) => c.destroy(() => r()))));
  await app?.close();
  await p2p?.stop();
  await env?.cleanup();
});

describe('p2p end-to-end', () => {
  it('(a) leecher downloads over the HTTP tracker + TCP and gets identical bytes', async () => {
    const share = await p2p.createShare({ itemId: item.id });
    const u = (await unlock(share.id)).body as UnlockResponse;
    const pt = await parsedTorrentFor(u);
    expect(pt.infoHash).toBe(share.infoHash);
    expect(pt.announce).toEqual([u.announce.http, u.announce.ws]);
    pt.announce = [u.announce.http];
    pt.urlList = [];
    const dl = path.join(env.root, 'dl-a');
    const c = leecher();
    const t = c.add(pt, { path: dl });
    await downloadAll(t);
    expect(t.wires.some((w) => w.type === 'tcpOutgoing')).toBe(true);
    await expectSameBytes(dl, item);
    // The tracker sees the seeder (http + ws) and the leecher in ONE swarm.
    const swarm = p2p.tracker.swarm(share.infoHash)!;
    const types = swarm.peers.keys.map((k) => swarm.peers.peek(k)?.type);
    expect(types.filter((x) => x === 'ws').length).toBeGreaterThanOrEqual(1);
    expect(types.filter((x) => x === 'http').length).toBeGreaterThanOrEqual(2);
  });

  it('(a2) single-file item with reserved characters in its name seeds correctly (read-only store)', async () => {
    const one = await makeItem(env.ctx, 'clip: final*.bin', [{ rel: 'clip: final*.bin', size: 200 * 1024 + 3 }], { single: true });
    const share = await p2p.createShare({ itemId: one.id });
    const u = (await unlock(share.id)).body as UnlockResponse;
    const pt = await parsedTorrentFor(u);
    pt.announce = [u.announce.http];
    pt.urlList = [];
    const c = leecher();
    const t = c.add(pt, { path: path.join(env.root, 'dl-a2') }) as WtTorrent & { files: { arrayBuffer(): Promise<ArrayBuffer> }[] };
    await downloadAll(t);
    expect(Buffer.from(await t.files[0]!.arrayBuffer()).equals(one.files[0]!.bytes)).toBe(true);
  });

  it('(b) leecher downloads over WebRTC (WS tracker) from the server on the single ICE UDP port', async () => {
    const share = await p2p.createShare({ itemId: item.id });
    const u = (await unlock(share.id)).body as UnlockResponse;
    const pt = await parsedTorrentFor(u);
    pt.announce = [u.announce.ws];
    pt.urlList = [];
    const dl = path.join(env.root, 'dl-b');
    const c = leecher();
    const t = c.add(pt, { path: dl });
    await downloadAll(t);
    await expectSameBytes(dl, item);
    const rtc = t.wires.filter((w) => w.type === 'webrtc') as unknown as { remotePort: number }[];
    expect(rtc.length).toBeGreaterThan(0);
    expect(t.wires.every((w) => w.type === 'webrtc')).toBe(true);
    // The server's end of the data channel is the muxed ICE port.
    expect(rtc.map((w) => Number(w.remotePort))).toContain(env.ports.webrtc);
  });

  it('(c) webseed-only download works and is throttled to the cap', async () => {
    const cap = 256 * 1024;
    setCap(cap);
    try {
      const share = await p2p.createShare({ itemId: big.id });
      const u = (await unlock(share.id)).body as UnlockResponse;
      const pt = await parsedTorrentFor(u);
      expect(pt.urlList).toEqual([u.webseed]);
      pt.announce = [];
      const dl = path.join(env.root, 'dl-c');
      const c = leecher({ tracker: false, webSeeds: true });
      await sleep(1100); // let the bucket fill to its 1 s burst, so the bound below is deterministic
      const t0 = Date.now();
      const t = c.add(pt, { path: dl, maxWebConns: 4 });
      let peakBps = 0;
      // Sample the 2 s moving average once the initial 1 s burst has left the window.
      const sampler = setInterval(() => {
        if (Date.now() - t0 > 2500 && !t.done) peakBps = Math.max(peakBps, p2p.limiter.currentBps());
      }, 200);
      await downloadAll(t);
      clearInterval(sampler);
      const secs = (Date.now() - t0) / 1000;
      await expectSameBytes(dl, big);
      expect(t.wires.every((w) => w.type === 'webSeed')).toBe(true);
      const total = big.files.reduce((a, f) => a + f.bytes.length, 0);
      // At most one second of burst, then `cap` bytes/s.
      expect(secs).toBeGreaterThanOrEqual(((total - cap) / cap) * 0.9);
      expect(secs).toBeLessThan((total / cap) * 2 + 2);
      expect(peakBps).toBeGreaterThan(cap * 0.6);
      expect(peakBps).toBeLessThan(cap * 1.25);
      await p2p.stats.flush();
      expect(p2p.getShare(share.id)!.stats.serverBytesWebseed).toBeGreaterThanOrEqual(total);
    } finally {
      setCap(null);
    }
  });

  it('(c2) seeder (TCP) and webseed draw from ONE shared bucket', async () => {
    const cap = 512 * 1024;
    setCap(cap);
    try {
      const share = await p2p.createShare({ itemId: big.id });
      const u = (await unlock(share.id)).body as UnlockResponse;
      const ptTcp = await parsedTorrentFor(u);
      ptTcp.announce = [u.announce.http];
      ptTcp.urlList = [];
      const ptWeb = await parsedTorrentFor(u);
      ptWeb.announce = [];
      const before = p2p.getShare(share.id)!.stats;
      await sleep(1100);
      const t0 = Date.now();
      const a = leecher().add(ptTcp, { path: path.join(env.root, 'dl-c2a') });
      const b = leecher({ tracker: false, webSeeds: true }).add(ptWeb, { path: path.join(env.root, 'dl-c2b'), maxWebConns: 4 });
      await Promise.all([downloadAll(a, 60_000), downloadAll(b, 60_000)]);
      const secs = (Date.now() - t0) / 1000;
      await expectSameBytes(path.join(env.root, 'dl-c2a'), big);
      await expectSameBytes(path.join(env.root, 'dl-c2b'), big);
      expect(a.wires.some((w) => w.type === 'tcpOutgoing')).toBe(true);
      const total = 2 * big.files.reduce((x, f) => x + f.bytes.length, 0);
      // If the paths had separate buckets this would take about half as long.
      expect(secs).toBeGreaterThanOrEqual(((total - cap) / cap) * 0.85);
      p2p.stats.flush();
      const after = p2p.getShare(share.id)!.stats;
      expect(after.serverBytesP2p - before.serverBytesP2p).toBeGreaterThan(0);
      expect(after.serverBytesWebseed - before.serverBytesWebseed).toBeGreaterThan(0);
    } finally {
      setCap(null);
    }
  }, 90_000);

  it('(d) revoke: tracker rejects, webseed 404, seeder drops the torrent, sockets close', async () => {
    const share = await p2p.createShare({ itemId: item.id });
    const u = (await unlock(share.id)).body as UnlockResponse;
    await waitFor(() => p2p.seeder!.torrent(share.id)?.ready);
    const ok = await httpAnnounce(u.announce.http, share.infoHash, '-qB0000-aaaaaaaaaaaa');
    expect(ok.body['failure reason']).toBeUndefined();
    expect((await fetch(u.webseed + encodeURI(`${item.name}/a.bin`), { headers: { range: 'bytes=0-9' } })).status).toBe(206);
    const wsTracker = new WebSocket(u.announce.ws);
    await new Promise((r) => wsTracker.on('open', r));
    const wsClosed = new Promise<number>((r) => wsTracker.on('close', (c) => r(c)));
    const live = new WebSocket(`${base.replace('http', 'ws')}/api/s/${share.id}/live`);
    await new Promise((r) => live.on('open', r));
    live.send(JSON.stringify({ t: 'hello', token: u.token, peerId: 'ab'.repeat(20) }));
    await new Promise((r) => live.once('message', r));
    const liveClosed = new Promise<number>((r) => live.on('close', (c) => r(c)));

    await p2p.revokeShare(share.id);

    expect(await wsClosed).toBe(4404);
    expect(await liveClosed).toBe(4404);
    expect(p2p.seeder!.torrent(share.id)).toBeUndefined();
    expect(p2p.tracker.swarm(share.infoHash)).toBeUndefined();
    const denied = await httpAnnounce(u.announce.http, share.infoHash, '-qB0000-aaaaaaaaaaaa');
    expect(Buffer.from(denied.body['failure reason'] as Uint8Array).toString()).toMatch(/denied/);
    expect((await fetch(u.webseed + encodeURI(`${item.name}/a.bin`))).status).toBe(404);
    expect((await fetch(u.torrentUrl)).status).toBe(404);
    expect(await wsCloseCode(u.announce.ws)).toBe(4404);
    expect((await (await fetch(`${base}/api/s/${share.id}`)).json()).status).toBe('gone');
    expect((await unlock(share.id)).status).toBe(404);
  });

  it('(d2) expiry: the sweep unseeds the share and drops its swarm', async () => {
    const share = await p2p.createShare({ itemId: item.id, expiresAt: Date.now() + 1500 });
    await waitFor(() => p2p.seeder!.torrent(share.id)?.ready);
    const u = (await unlock(share.id)).body as UnlockResponse;
    await httpAnnounce(u.announce.http, share.infoHash, '-qB0000-bbbbbbbbbbbb');
    expect(p2p.tracker.swarm(share.infoHash)).toBeDefined();
    await waitFor(() => p2p.seeder!.torrent(share.id) === undefined, 5000);
    // reconcile() drops the tracker swarm after the seeder's async remove() resolves; under load that
    // takes longer than one poll, so wait for it instead of asserting in the same tick.
    await waitFor(() => p2p.tracker.swarm(share.infoHash) === undefined, 5000);
    expect(p2p.getShare(share.id)!.state).toBe('expired');
  });

  it('(e) password share: no token without password; wrong passwords are rate limited', async () => {
    const share = await p2p.createShare({ itemId: item.id, password: 'correct horse' });
    expect((await (await fetch(`${base}/api/s/${share.id}`)).json())).toEqual({ status: 'locked', passwordRequired: true });
    expect((await unlock(share.id)).status).toBe(401);
    for (let i = 0; i < 4; i++) expect((await unlock(share.id, `wrong ${i}`)).status).toBe(401);
    const limited = await unlock(share.id, 'correct horse');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
    expect(limited.body.retryAfter).toBeGreaterThan(0);
    // Another client IP (via the trusted proxy) is not affected by the per-IP limit.
    const r = await fetch(`${base}/api/s/${share.id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.23' },
      body: JSON.stringify({ password: 'correct horse' }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as UnlockResponse;
    expect(body.token.startsWith(`${share.id}.`)).toBe(true);
    expect((await fetch(body.torrentUrl)).status).toBe(200);

    // Changing the password invalidates issued tokens immediately.
    await p2p.updateShare(share.id, { password: 'new one' });
    expect((await fetch(body.torrentUrl)).status).toBe(404);
    expect((await fetch(body.webseed + encodeURI(`${item.name}/a.bin`))).status).toBe(404);

    const events = env.ctx.db.prepare('SELECT type, detail FROM share_events WHERE share_id = ?').all(share.id) as { type: string; detail: string | null }[];
    expect(events.filter((e) => e.type === 'unlock_failed').length).toBe(5);
    expect(JSON.stringify(events)).not.toMatch(/198\.51|203\.0|127\.0/);
  });

  it('records the recipient name on unlock: sanitised, once per name and client', async () => {
    const share = await p2p.createShare({ itemId: item.id });
    const post = (body: unknown) =>
      fetch(`${base}/api/s/${share.id}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ name: '  Synthetic\u0000 Sam ' })).status).toBe(200);
    expect((await post({ name: 'Synthetic Sam' })).status).toBe(200); // same person reloading: no new event
    expect((await post({ name: 'Synthetic Alex' })).status).toBe(200); // same IP, another person
    expect((await post({})).status).toBe(200);
    expect((await post({ name: 42 })).status).toBe(400);
    expect((await post({ name: 'x'.repeat(257) })).status).toBe(400);
    const details = (env.ctx.db.prepare("SELECT detail FROM share_events WHERE share_id = ? AND type = 'unlocked' ORDER BY id").all(share.id) as {
      detail: string | null;
    }[]).map((e) => e.detail);
    expect(details).toEqual(['{"name":"Synthetic Sam"}', '{"name":"Synthetic Alex"}', null]);
  });

  it('gives a named recipient their own token; its .torrent and magnet carry it to the tracker', async () => {
    const share = await p2p.createShare({ itemId: item.id });
    const post = async (body: unknown) =>
      (await (
        await fetch(`${base}/api/s/${share.id}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      ).json()) as UnlockResponse;
    const sam = await post({ name: 'Synthetic Sam' });
    const plain = await post({});
    expect(sam.token.split('.')).toHaveLength(4);
    expect(plain.token.split('.')).toHaveLength(3);
    expect((await post({ name: 'Synthetic Sam' })).token).toBe(sam.token); // same name → same token
    expect((await post({ name: 'Synthetic Alex' })).token).not.toBe(sam.token);
    const auth = p2p.shares.authorize(sam.token);
    expect(auth.ok && auth.recipient?.name).toBe('Synthetic Sam');
    const t = await parsedTorrentFor(sam);
    expect(t.announce.every((u: string) => u.includes(`/tr/${sam.token}`))).toBe(true);
    expect(t.urlList).toEqual([sam.webseed]);
    expect(sam.magnet).toContain(encodeURIComponent(`/tr/${sam.token}`));
    // The live socket and webseed accept it like a plain token.
    expect((await fetch(sam.webseed + encodeURI(`${item.name}/a.bin`))).status).toBe(200);
    // Names never reach the logs.
    expect(env.logs.join('')).not.toContain('Synthetic Sam');
  });

  it('never logs or persists tokens or client IPs', async () => {
    const all = env.logs.join('');
    expect(all).not.toMatch(/198\.51\.100|203\.0\.113/);
    expect(all.includes((p2p as unknown as { internalSecret: string }).internalSecret)).toBe(false);
    const shares = p2p.listShares();
    for (const s of shares) {
      const row = p2p.shares.getRow(s.id)!;
      expect(all.includes(p2p.shares.token(row))).toBe(false);
      expect(all.includes(`${s.id}.1.`)).toBe(false);
    }
    const dump = JSON.stringify(env.ctx.db.prepare('SELECT * FROM share_events').all()) + JSON.stringify(env.ctx.db.prepare('SELECT * FROM share_stats').all());
    expect(dump).not.toMatch(/198\.51|203\.0|127\.0\.0\.1/);
  });
});
