import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { makeEnv, makeItem, sleep, startPublic, waitFor, type MadeItem, type TestEnv } from '../../test/integration/p2p-helpers.js';
import type { P2P } from './index.js';
import { scrub, withInterval } from './tracker.js';
import { bencode } from './vendor.js';

let env: TestEnv;
let srv: Awaited<ReturnType<typeof startPublic>>;
let p2p: P2P;
let item: MadeItem;

beforeAll(async () => {
  env = await makeEnv();
  srv = await startPublic(env);
  p2p = srv.p2p;
  item = await makeItem(env.ctx, 'trk', [{ rel: 'f.bin', size: 10_000 }]);
});
afterAll(async () => {
  await srv.close();
  await env.cleanup();
});

const esc = (b: Buffer) => [...b].map((x) => '%' + x.toString(16).padStart(2, '0')).join('');
const str = (v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString() : v);

async function announce(token: string, infoHash: string, peerId: string, extra: Record<string, string | number> = {}, xff = '203.0.113.5') {
  const params = { port: 51413, uploaded: 0, downloaded: 0, left: 10_000, compact: 1, event: 'started', ...extra };
  const qs = `info_hash=${esc(Buffer.from(infoHash, 'hex'))}&peer_id=${esc(Buffer.from(peerId))}` + Object.entries(params).map(([k, v]) => `&${k}=${v}`).join('');
  const r = await fetch(`${srv.base}/tr/${token}/announce?${qs}`, { headers: { 'x-forwarded-for': xff } });
  return { status: r.status, body: bencode.decode(Buffer.from(await r.arrayBuffer())) as Record<string, unknown> };
}

async function newShare() {
  const s = await p2p.createShare({ itemId: item.id });
  return { share: s, token: p2p.shares.token(p2p.shares.getRow(s.id)!) };
}

function wsOpen(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`${srv.base.replace('http', 'ws')}/tr/${token}`);
  ws.on('error', () => {});
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('close', (c) => reject(new Error(`closed ${c}`)));
  });
}

function wsClose(ws: WebSocket): Promise<number> {
  return new Promise((r) => ws.once('close', (c) => r(c)));
}

describe('HTTP tracker', () => {
  it('accepts a valid announce for the share infohash and records the peer IP from the trusted proxy (memory only)', async () => {
    const { share, token } = await newShare();
    const r = await announce(token, share.infoHash, '-qB4650-abcdefghijkl');
    expect(r.status).toBe(200);
    expect(r.body['failure reason']).toBeUndefined();
    expect(r.body.interval).toBeGreaterThan(0);
    const sw = p2p.tracker.swarm(share.infoHash)!;
    const peer = sw.peers.peek(sw.peers.keys[0]!)!;
    expect(peer.type).toBe('http');
    expect(peer.ip).toBe('203.0.113.5');
  });

  it('rejects bad tokens, other infohashes and inactive shares', async () => {
    const a = await newShare();
    const b = await newShare();
    const fail = async (p: Promise<{ body: Record<string, unknown> }>) => expect(str((await p).body['failure reason'])).toBe('access denied');
    await fail(announce('garbage', a.share.infoHash, '-qB4650-abcdefghijkl'));
    await fail(announce(a.token.slice(0, -1) + 'Z', a.share.infoHash, '-qB4650-abcdefghijkl'));
    await fail(announce(a.token, b.share.infoHash, '-qB4650-abcdefghijkl'));
    await fail(announce(`${a.token}~not-the-secret`, b.share.infoHash, '-qB4650-abcdefghijkl'));
    await p2p.revokeShare(a.share.id);
    await fail(announce(a.token, a.share.infoHash, '-qB4650-abcdefghijkl'));
    expect(p2p.tracker.swarm(b.share.infoHash)).toBeUndefined();
  });

  it('labels a torrent app announcing with a recipient token by that name, and records its completion with it', async () => {
    const { share } = await newShare();
    const row = p2p.shares.getRow(share.id)!;
    const rid = p2p.shares.recipientId(share.id, 'Synthetic Sam')!;
    expect(p2p.shares.recipientId(share.id, 'Synthetic Sam')).toBe(rid); // one id per (share, name)
    const token = p2p.shares.token(row, rid);
    const peerId = '-qB4650-recipient001';
    expect((await announce(token, share.infoHash, peerId)).body['failure reason']).toBeUndefined();
    const hexPeer = Buffer.from(peerId).toString('hex');
    await waitFor(() => p2p.swarm(share.id)?.peers.some((p) => p.label === 'Synthetic Sam' && p.kind === 'client') === true);
    expect(JSON.stringify(p2p.swarm(share.id))).not.toContain(hexPeer);
    expect((await announce(token, share.infoHash, peerId, { event: 'completed', left: 0 })).body['failure reason']).toBeUndefined();
    const ev = env.ctx.db.prepare("SELECT detail FROM share_events WHERE share_id = ? AND type = 'completed'").all(share.id);
    expect(ev).toEqual([{ detail: '{"kind":"client","name":"Synthetic Sam"}' }]);
  });

  it('rejects recipient tokens for unknown recipients, other shares, and after a password change', async () => {
    const a = await newShare();
    const b = await newShare();
    const fail = async (p: Promise<{ body: Record<string, unknown> }>) => expect(str((await p).body['failure reason'])).toBe('access denied');
    const rowA = p2p.shares.getRow(a.share.id)!;
    await fail(announce(p2p.shares.token(rowA, 'aaaaaaaaaaaaaaaa'), a.share.infoHash, '-qB4650-recipient002')); // valid MAC, no such recipient
    const ridB = p2p.shares.recipientId(b.share.id, 'Synthetic Alex')!;
    await fail(announce(p2p.shares.token(rowA, ridB), a.share.infoHash, '-qB4650-recipient003')); // B's recipient on A
    const tokenA = p2p.shares.token(rowA, p2p.shares.recipientId(a.share.id, 'Synthetic Sam')!);
    expect((await announce(tokenA, a.share.infoHash, '-qB4650-recipient004')).body['failure reason']).toBeUndefined();
    await p2p.updateShare(a.share.id, { password: 'synthetic-new' });
    await fail(announce(tokenA, a.share.infoHash, '-qB4650-recipient004'));
  });

  it('the interval rewrite keeps compact peers byte for byte and leaves failures alone', () => {
    const peers = new Uint8Array([192, 0, 2, 1, 0x1a, 0xe1, 255, 0, 128, 7, 0, 1]);
    const out = bencode.decode(withInterval(bencode.encode({ complete: 1, incomplete: 0, interval: 600, peers })) as Uint8Array) as Record<string, unknown>;
    expect(out.interval).toBe(300);
    expect(Buffer.from(out.peers as Uint8Array).equals(Buffer.from(peers))).toBe(true);
    const failure = bencode.encode({ 'failure reason': 'access denied' });
    expect(withInterval(failure)).toBe(failure);
    expect(withInterval('404 Not Found')).toBe('404 Not Found');
  });

  it('tells torrent apps to announce every 5 min (libtorrent will not go lower)', async () => {
    const { share, token } = await newShare();
    const res = await announce(token, share.infoHash, '-qB4650-interval0001');
    expect(res.body.interval).toBe(300);
  });

  it('scrape and plain GET of the WS path are 404', async () => {
    const { token } = await newShare();
    expect((await fetch(`${srv.base}/tr/${token}/scrape`)).status).toBe(404);
    expect((await fetch(`${srv.base}/tr/${token}`)).status).toBe(404);
  });

  it('nobody but the seeder may use the server peer id', async () => {
    const { share, token } = await newShare();
    const serverPeerId = Buffer.from('-WW0300-serverpeer01').toString('hex');
    const fake = { peerId: serverPeerId, torrent: () => undefined, shareIds: () => [], remove: async () => {}, stop: async () => {} };
    (p2p as unknown as { seeder: unknown }).seeder = fake;
    try {
      const denied = await announce(token, share.infoHash, '-WW0300-serverpeer01');
      expect(str(denied.body['failure reason'])).toBe('access denied');
      const secret = (p2p as unknown as { internalSecret: string }).internalSecret;
      const ok = await announce(`${token}~${secret}`, share.infoHash, '-WW0300-serverpeer01', { left: 0, port: 40000 });
      expect(ok.body['failure reason']).toBeUndefined();
      // The seeder's loopback announce is advertised with the PUBLIC_BASE_URL host address.
      const sw = p2p.tracker.swarm(share.infoHash)!;
      const mine = sw.peers.keys.map((k) => sw.peers.peek(k)!).find((p) => p.peerId === serverPeerId)!;
      expect(mine.ip).toBe('127.0.0.1');
      expect(mine.port).toBe(40000);
    } finally {
      (p2p as unknown as { seeder: unknown }).seeder = undefined;
    }
  });

  it('forwards announce data (uploaded deltas, completed once) to share stats, keyed by peer id', async () => {
    const { share, token } = await newShare();
    await announce(token, share.infoHash, '-qB4650-statspeer001', { uploaded: 1000 });
    await announce(token, share.infoHash, '-qB4650-statspeer001', { uploaded: 3000, event: 'completed', left: 0 });
    await announce(token, share.infoHash, '-qB4650-statspeer001', { uploaded: 2000, event: '' }); // stale/lower: ignored
    await announce(token, share.infoHash, '-qB4650-statspeer001', { uploaded: 3500, event: 'completed', left: 0 });
    p2p.stats.flush();
    const st = p2p.getShare(share.id)!.stats;
    expect(st.peerBytes).toBe(3500);
    expect(st.completedDownloads).toBe(1);
    const snap = p2p.swarm(share.id)!;
    expect(snap.peers.find((x) => x.kind === 'client')).toMatchObject({ label: 'Torrent client', progress: 1, uploaded: 3500 });
    expect(JSON.stringify(snap)).not.toMatch(/203\.0\.113|statspeer|2d71/);
  });
});

describe('WebSocket tracker', () => {
  it('closes 4401 for bad tokens and 4404 for gone shares', async () => {
    const { share, token } = await newShare();
    const bad = new WebSocket(`${srv.base.replace('http', 'ws')}/tr/garbage`);
    expect(await wsClose(bad)).toBe(4401);
    await p2p.revokeShare(share.id);
    const gone = new WebSocket(`${srv.base.replace('http', 'ws')}/tr/${token}`);
    expect(await wsClose(gone)).toBe(4404);
  });

  it('answers announces; rejects other infohashes; closes stale tokens on password change', async () => {
    const a = await newShare();
    const b = await newShare();
    const ws = await wsOpen(a.token);
    const msgs: any[] = [];
    ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
    const ann = (ih: string) =>
      ws.send(JSON.stringify({ action: 'announce', info_hash: Buffer.from(ih, 'hex').toString('latin1'), peer_id: '-WW0300-browserpeer1', event: 'started', left: 10, uploaded: 0, downloaded: 0, numwant: 0, offers: [] }));
    ann(a.share.infoHash);
    await waitFor(() => msgs.length >= 1);
    expect(msgs[0]['failure reason']).toBeUndefined();
    expect(msgs[0].interval).toBe(120);
    ann(b.share.infoHash);
    await waitFor(() => msgs.length >= 2);
    expect(msgs[1]['failure reason']).toBe('access denied');
    const closed = wsClose(ws);
    await p2p.updateShare(a.share.id, { password: 'now locked' });
    expect(await closed).toBe(4401);
  });
});

describe('scrub', () => {
  it('removes tokens from messages', () => {
    expect(scrub('Error connecting to ws://127.0.0.1:1/tr/AAA.1.BBB~CCC: nope')).toBe('Error connecting to ws://127.0.0.1:1/tr/[token]: nope');
    expect(scrub('GET /ws/AAA.1.BBB/x and /api/s/x/torrent?t=AAA.1.BBB')).toBe('GET /ws/[token]/x and /api/s/x/torrent?t=[token]');
  });
});

describe('WEBRTC_ANNOUNCE_IP relay rewrite', () => {
  it('injects the host candidate only into SDPs relayed from the server peer', async () => {
    const env2 = await makeEnv({ WEBRTC_ANNOUNCE_IP: '192.0.2.44' });
    const srv2 = await startPublic(env2);
    const p = srv2.p2p as unknown as { seeder: unknown; internalSecret: string };
    try {
      const it2 = await makeItem(env2.ctx, 'sdp', [{ rel: 'f.bin', size: 1000 }]);
      const s = await srv2.p2p.createShare({ itemId: it2.id });
      const tok = srv2.p2p.shares.token(srv2.p2p.shares.getRow(s.id)!);
      const serverPid = '-WW0300-serverpeer02';
      p.seeder = { peerId: Buffer.from(serverPid).toString('hex'), torrent: () => undefined, shareIds: () => [], remove: async () => {}, stop: async () => {} };
      const ihBin = Buffer.from(s.infoHash, 'hex').toString('latin1');
      const open = (t: string) =>
        new Promise<WebSocket>((res) => {
          const w = new WebSocket(`${srv2.base.replace('http', 'ws')}/tr/${t}`);
          w.on('error', () => {});
          w.once('open', () => res(w));
        });
      const browser = await open(tok);
      const server = await open(`${tok}~${p.internalSecret}`);
      const other = await open(tok);
      const got: any[] = [];
      browser.on('message', (m) => got.push(JSON.parse(String(m))));
      const base = { action: 'announce', info_hash: ihBin, event: 'started', left: 0, uploaded: 0, downloaded: 0, numwant: 0, offers: [] };
      browser.send(JSON.stringify({ ...base, peer_id: '-WW0300-browserpeer2', left: 10 }));
      await waitFor(() => got.length >= 1);
      server.send(JSON.stringify({ ...base, peer_id: serverPid }));
      other.send(JSON.stringify({ ...base, peer_id: '-WW0300-otherpeer003' }));
      await sleep(100);
      const sdp = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=candidate:1 1 UDP 2114977791 10.0.0.9 6891 typ host\r\na=end-of-candidates\r\n';
      const answer = (pid: string) => ({ action: 'announce', info_hash: ihBin, peer_id: pid, to_peer_id: '-WW0300-browserpeer2', answer: { type: 'answer', sdp }, offer_id: 'x'.repeat(20) });
      server.send(JSON.stringify(answer(serverPid)));
      other.send(JSON.stringify(answer('-WW0300-otherpeer003')));
      await waitFor(() => got.filter((m) => m.answer).length >= 2);
      const answers = got.filter((m) => m.answer);
      const fromServer = answers.find((m) => m.peer_id === serverPid);
      const fromOther = answers.find((m) => m.peer_id === '-WW0300-otherpeer003');
      expect(fromServer.answer.sdp).toContain(`192.0.2.44 ${env2.ports.webrtc} typ host`);
      expect(fromOther.answer.sdp).toBe(sdp);
      for (const w of [browser, server, other]) w.close();
    } finally {
      p.seeder = undefined;
      await srv2.close();
      await env2.cleanup();
    }
  });
});
