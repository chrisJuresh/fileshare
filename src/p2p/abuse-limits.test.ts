// Abuse bounds on the public P2P surface: per-IP HTTP announce limit, tracker WebSocket caps,
// one `unlocked` event per recipient per 10 minutes. Synthetic data, ephemeral ports.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { makeEnv, makeItem, startPublic, type MadeItem, type TestEnv } from '../../test/integration/p2p-helpers.js';
import type { P2P } from './index.js';
import { IpRateLimiter, RecentOnce } from './ratelimit.js';
import { bencode } from './vendor.js';

let env: TestEnv;
let srv: Awaited<ReturnType<typeof startPublic>>;
let p2p: P2P;
let item: MadeItem;

beforeAll(async () => {
  env = await makeEnv();
  srv = await startPublic(env, { trackerLimits: { announceLimit: { max: 3, windowMs: 60_000 }, maxWsPerShare: 2, maxWsTotal: 3 } });
  p2p = srv.p2p;
  item = await makeItem(env.ctx, 'abuse', [{ rel: 'f.bin', size: 10_000 }]);
});
afterAll(async () => {
  await srv.close();
  await env.cleanup();
});

const esc = (b: Buffer) => [...b].map((x) => '%' + x.toString(16).padStart(2, '0')).join('');

async function newShare() {
  const s = await p2p.createShare({ itemId: item.id });
  return { share: s, token: p2p.shares.token(p2p.shares.getRow(s.id)!) };
}

async function announce(token: string, infoHash: string, xff: string) {
  const qs = `info_hash=${esc(Buffer.from(infoHash, 'hex'))}&peer_id=${esc(Buffer.from('-qB4650-abcdefghijkl'))}&port=51413&uploaded=0&downloaded=0&left=1&compact=1`;
  const r = await fetch(`${srv.base}/tr/${token}/announce?${qs}`, { headers: { 'x-forwarded-for': xff } });
  return { status: r.status, body: bencode.decode(Buffer.from(await r.arrayBuffer())) as Record<string, unknown> };
}

/** Resolves 'open' or the close code. */
function wsTry(token: string): Promise<{ ws: WebSocket; result: 'open' | number }> {
  const ws = new WebSocket(`${srv.base.replace('http', 'ws')}/tr/${token}`);
  ws.on('error', () => {});
  return new Promise((resolve) => {
    // The server accepts the upgrade and then closes busy sockets: wait a moment after open.
    ws.once('open', () => setTimeout(() => resolve({ ws, result: ws.readyState === WebSocket.OPEN ? 'open' : -1 }), 150));
    ws.once('close', (c) => resolve({ ws, result: c }));
  });
}

describe('tracker abuse limits', () => {
  it('limits HTTP announces per client IP', async () => {
    const { share, token } = await newShare();
    for (let i = 0; i < 3; i++) expect((await announce(token, share.infoHash, '203.0.113.50')).status).toBe(200);
    const limited = await announce(token, share.infoHash, '203.0.113.50');
    expect(limited.status).toBe(429);
    expect(Buffer.from(limited.body['failure reason'] as Uint8Array).toString()).toBe('rate limited');
    // Another IP is unaffected; bad tokens count too (no free guessing).
    expect((await announce(token, share.infoHash, '203.0.113.51')).status).toBe(200);
    for (let i = 0; i < 3; i++) await announce('garbage', share.infoHash, '203.0.113.52');
    expect((await announce(token, share.infoHash, '203.0.113.52')).status).toBe(429);
  });

  it('caps tracker WebSockets per share and in total', async () => {
    const a = await newShare();
    const b = await newShare();
    const a1 = await wsTry(a.token);
    const a2 = await wsTry(a.token);
    const a3 = await wsTry(a.token);
    expect([a1.result, a2.result, a3.result]).toEqual(['open', 'open', 1013]);
    const b1 = await wsTry(b.token);
    const b2 = await wsTry(b.token); // global cap of 3 reached
    expect([b1.result, b2.result]).toEqual(['open', 1013]);
    for (const c of [a1, a2, b1]) c.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const again = await wsTry(b.token);
    expect(again.result).toBe('open');
    again.ws.close();
  });
});

describe('unlock events', () => {
  it('records one unlocked event per recipient per 10 minutes', async () => {
    const { share } = await newShare();
    const unlock = (xff: string) =>
      fetch(`${srv.base}/api/s/${share.id}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: '{}' });
    for (let i = 0; i < 5; i++) expect((await unlock('198.51.100.60')).status).toBe(200);
    expect((await unlock('198.51.100.61')).status).toBe(200);
    const n = env.ctx.db.prepare("SELECT COUNT(*) AS n FROM share_events WHERE share_id = ? AND type = 'unlocked'").get(share.id) as { n: number };
    expect(n.n).toBe(2);
  });
});

describe('IpRateLimiter / RecentOnce', () => {
  it('fixed window per IP; bounded keys', () => {
    let now = 0;
    const l = new IpRateLimiter({ max: 2, windowMs: 1000 }, () => now, 3);
    expect([l.hit('a'), l.hit('a'), l.hit('a')]).toEqual([true, true, false]);
    now = 1000;
    expect(l.hit('a')).toBe(true);
    for (const ip of ['b', 'c', 'd', 'e']) l.hit(ip);
    expect((l as unknown as { hits: Map<string, unknown> }).hits.size).toBeLessThanOrEqual(3);
  });

  it('first() per scope and IP within the TTL', () => {
    let now = 0;
    const r = new RecentOnce(600_000, () => now);
    expect(r.first('s1', 'ip')).toBe(true);
    expect(r.first('s1', 'ip')).toBe(false);
    expect(r.first('s2', 'ip')).toBe(true);
    now = 600_000;
    expect(r.first('s1', 'ip')).toBe(true);
  });
});
