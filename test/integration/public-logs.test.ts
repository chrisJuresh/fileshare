// Request logging on the public listener: every request type a recipient or torrent client makes
// is logged (redacted), and no token, full share id or client IP ever reaches the log.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { UnlockResponse } from '../../src/types.js';
import { makeEnv, makeItem, sleep, startPublic, waitFor, type TestEnv } from './p2p-helpers.js';

const CLIENT_IP = '203.0.113.77';
const XFF = { 'x-forwarded-for': CLIENT_IP };
const esc = (b: Buffer) => [...b].map((x) => '%' + x.toString(16).padStart(2, '0')).join('');

let env: TestEnv;
let srv: Awaited<ReturnType<typeof startPublic>>;

beforeAll(async () => {
  env = await makeEnv();
  srv = await startPublic(env);
});

afterAll(async () => {
  await srv?.close();
  await env?.cleanup();
});

function wsRoundTrip(url: string, first?: unknown): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: XFF });
    ws.on('open', () => {
      if (first !== undefined) ws.send(JSON.stringify(first));
      setTimeout(() => ws.close(), 150);
    });
    ws.on('close', () => resolve());
    ws.on('error', () => resolve());
  });
}

describe('public request logs', () => {
  it('log tracker, webseed, unlock and live requests without tokens, share ids or IPs', async () => {
    const item = await makeItem(env.ctx, 'log-item', [{ rel: 'a.bin', size: 40_000 }]);
    const share = await srv.p2p.createShare({ itemId: item.id });
    const base = srv.base;
    env.logs.length = 0;

    expect((await fetch(`${base}/s/${share.id}`, { headers: XFF })).status).toBeLessThan(500);
    expect((await fetch(`${base}/api/s/${share.id}`, { headers: XFF })).status).toBe(200);
    const r = await fetch(`${base}/api/s/${share.id}/unlock`, {
      method: 'POST',
      headers: { ...XFF, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(200);
    const u = (await r.json()) as UnlockResponse;
    expect((await fetch(u.torrentUrl, { headers: XFF })).status).toBe(200);
    const ann =
      `${u.announce.http}?info_hash=${esc(Buffer.from(share.infoHash, 'hex'))}&peer_id=${esc(randomBytes(20))}` +
      '&port=51413&uploaded=0&downloaded=0&left=1000&compact=1&event=started';
    expect((await fetch(ann, { headers: XFF })).status).toBe(200);
    expect((await fetch(`${u.webseed}log-item/a.bin`, { headers: XFF })).status).toBe(200);
    expect((await fetch(`${u.webseed}log-item/missing.bin`, { headers: XFF })).status).toBe(404);
    await wsRoundTrip(u.announce.ws);
    await wsRoundTrip(`${base.replace('http', 'ws')}/api/s/${share.id}/live`, { t: 'hello', token: u.token, peerId: randomBytes(20).toString('hex') });
    expect((await fetch(`${base}/no/such/${share.id}`, { headers: XFF })).status).toBe(404);
    expect((await fetch(`${base}/api/s/${share.id}/torrent?t=${u.token}&t=${u.token}`, { headers: XFF })).status).toBe(404); // repeated t= is refused

    await waitFor(() => env.logs.filter((l) => l.includes('"msg":"req"')).length >= 9);
    await sleep(100);
    const all = env.logs.join('');
    // The redacted lines are there…
    expect(all).toContain('"url":"/tr/[token]/announce"'); // no query (info_hash / peer_id)
    expect(all).toContain('"url":"[unmatched]"');
    expect(all).toContain('/ws/[token]/log-item/a.bin');
    expect(all).toContain(`/api/s/${share.id.slice(0, 4)}…/unlock`);
    // …but nothing that grants access or identifies a recipient.
    expect(all.includes(share.id)).toBe(false);
    expect(all.includes(u.token)).toBe(false);
    expect(all.includes(CLIENT_IP)).toBe(false);
    expect(all).not.toMatch(/incoming request|request completed|Route GET/);
  });
});
