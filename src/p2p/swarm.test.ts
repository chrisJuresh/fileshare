import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { makeEnv, makeItem, sleep, startPublic, waitFor, type MadeItem, type TestEnv } from '../../test/integration/p2p-helpers.js';
import type { ServerMsg } from '../types.js';
import type { P2P } from './index.js';
import { sanitizeNick } from './swarm.js';

describe('sanitizeNick', () => {
  it('trims, strips control/format chars, caps at 24 chars', () => {
    expect(sanitizeNick('  Sam  ')).toBe('Sam');
    expect(sanitizeNick('Sa\u0000m\u0007‮​')).toBe('Sam');
    expect(sanitizeNick('a\n\tb')).toBe('a b');
    expect(sanitizeNick('x'.repeat(40))).toBe('x'.repeat(24));
    expect(sanitizeNick('😀'.repeat(30))).toBe('😀'.repeat(24));
    expect(sanitizeNick('<img src=x onerror=1>')).toBe('<img src=x onerror=1>'); // rendered via textContent only
    expect(sanitizeNick('   ')).toBeUndefined();
    expect(sanitizeNick(42)).toBeUndefined();
  });
});

let env: TestEnv;
let srv: Awaited<ReturnType<typeof startPublic>>;
let p2p: P2P;
let item: MadeItem;

beforeAll(async () => {
  env = await makeEnv();
  srv = await startPublic(env, { live: { helloTimeoutMs: 300, lingerMs: 400, statsStaleMs: 1500 }, tickIntervalMs: 100 });
  p2p = srv.p2p;
  item = await makeItem(env.ctx, 'live', [{ rel: 'f.bin', size: 100_000 }]);
});
afterAll(async () => {
  await srv.close();
  await env.cleanup();
});

async function newShare(password?: string) {
  const s = await p2p.createShare({ itemId: item.id, password });
  return { share: s, token: p2p.shares.token(p2p.shares.getRow(s.id)!) };
}

interface Client {
  ws: WebSocket;
  msgs: ServerMsg[];
  closed: Promise<number>;
  last(): ServerMsg | undefined;
}

function connect(shareId: string): Promise<Client> {
  const ws = new WebSocket(`${srv.base.replace('http', 'ws')}/api/s/${shareId}/live`);
  const msgs: ServerMsg[] = [];
  ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
  ws.on('error', () => {});
  const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
  return new Promise((resolve) => ws.once('open', () => resolve({ ws, msgs, closed, last: () => msgs[msgs.length - 1] })));
}

const PEER_A = 'aa'.repeat(20);
const PEER_B = 'bb'.repeat(20);

describe('live stats socket', () => {
  it('closes 4401 when hello does not arrive in time or is not first', async () => {
    const { share } = await newShare();
    const c = await connect(share.id);
    expect(await c.closed).toBe(4401);
    const d = await connect(share.id);
    d.ws.send(JSON.stringify({ t: 'stats', progress: 0, down: 0, up: 0, uploaded: 0, downloaded: 0, done: false }));
    expect(await d.closed).toBe(4401);
  });

  it('4401 for bad tokens or a token of another share, 4404 for gone shares', async () => {
    const a = await newShare();
    const b = await newShare();
    const c1 = await connect(a.share.id);
    c1.ws.send(JSON.stringify({ t: 'hello', token: 'garbage', peerId: PEER_A }));
    expect(await c1.closed).toBe(4401);
    const c2 = await connect(a.share.id);
    c2.ws.send(JSON.stringify({ t: 'hello', token: b.token, peerId: PEER_A }));
    expect(await c2.closed).toBe(4401);
    await p2p.revokeShare(b.share.id);
    const c3 = await connect(b.share.id);
    c3.ws.send(JSON.stringify({ t: 'hello', token: b.token, peerId: PEER_A }));
    expect(await c3.closed).toBe(4404);
    const c4 = await connect(a.share.id);
    c4.ws.send(JSON.stringify({ t: 'hello', token: a.token, peerId: 'not-hex' }));
    expect(await c4.closed).toBe(1008);
    const c5 = await connect(a.share.id);
    c5.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    expect(await c5.closed).toBe(1008);
  });

  it('broadcasts the swarm: server row, opaque ids, Friend N / nick labels, no peer ids or IPs', async () => {
    const { share, token } = await newShare();
    const a = await connect(share.id);
    a.ws.send(JSON.stringify({ t: 'hello', token, peerId: PEER_A, nick: '  Sam‮ ' }));
    const b = await connect(share.id);
    b.ws.send(JSON.stringify({ t: 'hello', token, peerId: PEER_B }));
    await waitFor(() => a.last()?.peers.length === 3 && b.last()?.peers.length === 3);
    const ma = a.last()!;
    const mb = b.last()!;
    expect(ma.t).toBe('swarm');
    expect(ma.peers[0]).toMatchObject({ id: 'srv', label: 'Server', kind: 'server', progress: 1 });
    const ids = ma.peers.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['srv', ma.you, mb.you]));
    expect(ma.you).toMatch(/^p\d+$/);
    expect(ma.you).not.toBe(mb.you);
    expect(ma.peers.find((p) => p.id === ma.you)!.label).toBe('Sam');
    expect(ma.peers.find((p) => p.id === mb.you)!.label).toBe(`Friend ${mb.you.slice(1)}`);
    expect(ma.totals).toMatchObject({ peers: 3, completed: 0 });
    const text = JSON.stringify(a.msgs);
    expect(text).not.toContain(PEER_A);
    expect(text).not.toContain(PEER_B);
    expect(text).not.toMatch(/127\.0\.0\.1/);

    // nick change
    b.ws.send(JSON.stringify({ t: 'nick', nick: 'Alex' }));
    await waitFor(() => a.last()?.peers.find((p) => p.id === mb.you)?.label === 'Alex');
    a.ws.close();
    b.ws.close();
  });

  it('rate-limits stats, ignores bad values, counts completion once, persists peer bytes', async () => {
    const { share, token } = await newShare();
    const a = await connect(share.id);
    a.ws.send(JSON.stringify({ t: 'hello', token, peerId: PEER_A }));
    await waitFor(() => a.last());
    await sleep(1000); // fresh rate window
    const st = (uploaded: number, extra: Record<string, unknown> = {}) =>
      a.ws.send(JSON.stringify({ t: 'stats', progress: 0.5, down: 10, up: 20, uploaded, downloaded: 1, done: false, ...extra }));
    st(100);
    st(200);
    st(300); // >2/s: ignored
    st(400); // ignored
    await waitFor(() => a.last()?.peers.find((p) => p.id === a.last()!.you)?.uploaded === 200);
    await sleep(1100);
    st(-5);
    st(Number.NaN); // serialised as null → ignored
    await sleep(300);
    expect(a.last()!.peers.find((p) => p.id === a.last()!.you)!.uploaded).toBe(200);
    await sleep(1000);
    st(1000, { done: true, progress: 1 });
    st(1000, { done: true, progress: 1 });
    await waitFor(() => a.last()?.totals.completed === 1);
    p2p.stats.flush();
    const s = p2p.getShare(share.id)!.stats;
    expect(s).toMatchObject({ peerBytes: 1000, completedDownloads: 1 });
    expect(s.peakSwarm).toBeGreaterThanOrEqual(2);
    expect(s.lastActivityAt).not.toBeNull();
    const ev = env.ctx.db.prepare("SELECT detail FROM share_events WHERE share_id = ? AND type = 'completed'").all(share.id);
    expect(ev).toEqual([{ detail: '{"kind":"browser"}' }]);
    a.ws.close();
  });

  it('a browser seeding a download from an earlier visit (resumed) is not a completion', async () => {
    const { share, token } = await newShare();
    const a = await connect(share.id);
    a.ws.send(JSON.stringify({ t: 'hello', token, peerId: PEER_A }));
    await waitFor(() => a.last());
    await sleep(1000); // fresh rate window
    const done = { t: 'stats', progress: 1, down: 0, up: 10, uploaded: 700, downloaded: 1, done: true };
    a.ws.send(JSON.stringify({ ...done, resumed: 'yes' })); // bad type: whole message ignored
    a.ws.send(JSON.stringify({ ...done, resumed: true }));
    await waitFor(() => a.last()?.peers.find((p) => p.id === a.last()!.you)?.uploaded === 700);
    await sleep(1100);
    a.ws.send(JSON.stringify({ ...done, resumed: true, uploaded: 800 }));
    await waitFor(() => a.last()?.peers.find((p) => p.id === a.last()!.you)?.uploaded === 800);
    p2p.stats.flush();
    expect(a.last()!.totals.completed).toBe(0);
    expect(p2p.getShare(share.id)!.stats).toMatchObject({ completedDownloads: 0, peerBytes: 800 });
    expect(env.ctx.db.prepare("SELECT COUNT(*) AS n FROM share_events WHERE share_id = ? AND type = 'completed'").get(share.id)).toEqual({ n: 0 });
    a.ws.close();
  });

  it("records a named browser's completion with its name", async () => {
    const { share, token } = await newShare();
    const a = await connect(share.id);
    a.ws.send(JSON.stringify({ t: 'hello', token, peerId: PEER_A, nick: 'Synthetic Sam' }));
    await waitFor(() => a.last());
    await sleep(1000); // fresh rate window
    a.ws.send(JSON.stringify({ t: 'stats', progress: 1, down: 0, up: 0, uploaded: 0, downloaded: 1, done: true }));
    await waitFor(() => a.last()?.totals.completed === 1);
    const ev = env.ctx.db.prepare("SELECT detail FROM share_events WHERE share_id = ? AND type = 'completed'").all(share.id);
    expect(ev).toEqual([{ detail: '{"kind":"browser","name":"Synthetic Sam"}' }]);
    a.ws.close();
  });

  it('disconnected peers linger, then disappear', async () => {
    const { share, token } = await newShare();
    const a = await connect(share.id);
    a.ws.send(JSON.stringify({ t: 'hello', token, peerId: PEER_A }));
    const b = await connect(share.id);
    b.ws.send(JSON.stringify({ t: 'hello', token, peerId: PEER_B }));
    await waitFor(() => a.last()?.peers.length === 3);
    b.ws.close();
    await sleep(150);
    expect(a.last()!.peers.length).toBe(3);
    await waitFor(() => a.last()?.peers.length === 2, 3000);
    a.ws.close();
  });

  it('a page that closes or reloads (1001) leaves at once, also from its tracker row; it can come back', async () => {
    const { share, token } = await newShare();
    const a = await connect(share.id);
    a.ws.send(JSON.stringify({ t: 'hello', token, peerId: PEER_A }));
    const b = await connect(share.id);
    b.ws.send(JSON.stringify({ t: 'hello', token, peerId: PEER_B }));
    // Its tracker socket is still winding down: the announce must not bring the row back.
    p2p.stats.onAnnounce({ shareId: share.id, peerId: PEER_B, type: 'ws', event: 'update', left: 1, uploaded: 0, downloaded: 0 });
    // The same person also seeds from a torrent app (its own peer id, named by their recipient token).
    const app = 'cc'.repeat(20);
    p2p.stats.onAnnounce({ shareId: share.id, peerId: app, type: 'http', event: 'start', left: 0, uploaded: 0, downloaded: 0, name: 'Synthetic Sam' });
    await waitFor(() => a.last()?.peers.length === 4);
    b.ws.close(1001);
    await sleep(250); // < lingerMs
    expect(a.last()!.peers.map((r) => r.kind)).toEqual(['server', 'browser', 'client']);
    expect(a.last()!.peers.find((r) => r.kind === 'client')!.label).toBe('Synthetic Sam');
    expect(a.last()!.totals.peers).toBe(3);
    // The same peer id saying hello again (a page restored from the back/forward cache) is back.
    const b2 = await connect(share.id);
    b2.ws.send(JSON.stringify({ t: 'hello', token, peerId: PEER_B }));
    await waitFor(() => a.last()?.peers.length === 4);
    b2.ws.close();
    a.ws.close();
  });

  it('a socket that stops sending stats (a frozen phone tab) loses its rows until its next stats', async () => {
    const { share, token } = await newShare();
    const a = await connect(share.id);
    a.ws.send(JSON.stringify({ t: 'hello', token, peerId: PEER_A }));
    const b = await connect(share.id);
    b.ws.send(JSON.stringify({ t: 'hello', token, peerId: PEER_B, nick: 'Synthetic Phone' }));
    p2p.stats.onAnnounce({ shareId: share.id, peerId: PEER_B, type: 'ws', event: 'update', left: 1, uploaded: 0, downloaded: 0 });
    const keepA = setInterval(() => a.ws.send(JSON.stringify({ t: 'stats', progress: 0, down: 0, up: 0, uploaded: 0, downloaded: 0, done: false })), 300);
    try {
      await waitFor(() => a.last()?.peers.some((r) => r.label === 'Synthetic Phone'));
      // B goes quiet: after statsStaleMs (+ the linger) neither its socket nor its tracker row shows.
      await waitFor(() => a.last()?.peers.length === 2 && !a.last()!.peers.some((r) => r.label === 'Synthetic Phone'), 5000);
      b.ws.send(JSON.stringify({ t: 'stats', progress: 0.25, down: 0, up: 0, uploaded: 0, downloaded: 0, done: false }));
      await waitFor(() => a.last()?.peers.some((r) => r.label === 'Synthetic Phone' && r.progress === 0.25));
    } finally {
      clearInterval(keepA);
      a.ws.close();
      b.ws.close();
    }
  });

  it("a torrent app's connection under a different peer id than its announce shows on the app's row", async () => {
    const { share } = await newShare();
    const hex = (s: string) => Buffer.from(s).toString('hex');
    const announced = hex('-LT2110-announce0001');
    p2p.stats.onAnnounce({ shareId: share.id, peerId: announced, type: 'http', event: 'start', left: 0, uploaded: 0, downloaded: 0, name: 'Synthetic Sam' });
    const wire = (peerId: string) => ({
      type: 'tcpIncoming',
      peerId,
      uploaded: 0,
      downloaded: 0,
      uploadSpeed: () => 2048,
      downloadSpeed: () => 0,
      peerPieces: { get: () => true },
    });
    const wires = [wire(hex('-LT2110-connection01')), wire(hex('-qB5010-unannounced1'))];
    const torrent = { pieces: [1, 2, 3], wires, uploadSpeed: 0 };
    const fake = { peerId: hex('-WW0300-serverpeer01'), torrent: () => torrent, shareIds: () => [], remove: async () => {}, stop: async () => {} };
    (p2p as unknown as { seeder: unknown }).seeder = fake;
    try {
      const rows = p2p.swarm(share.id)!.peers.filter((r) => r.kind === 'client');
      expect(rows).toEqual([expect.objectContaining({ label: 'Synthetic Sam', progress: 1, down: 2048 })]);
      // Two announced apps of the same client: the connection can't be told apart and gets no row.
      p2p.stats.onAnnounce({ shareId: share.id, peerId: hex('-LT2110-announce0002'), type: 'http', event: 'start', left: 0, uploaded: 0, downloaded: 0 });
      const two = p2p.swarm(share.id)!.peers.filter((r) => r.kind === 'client');
      expect(two.map((r) => [r.label, r.down])).toEqual([
        ['Synthetic Sam', 0],
        ['Torrent client', 0],
      ]);
    } finally {
      (p2p as unknown as { seeder: unknown }).seeder = undefined;
    }
  });

  it('closes 4401 when the password changes and 4404 when revoked', async () => {
    const { share, token } = await newShare();
    const a = await connect(share.id);
    a.ws.send(JSON.stringify({ t: 'hello', token, peerId: PEER_A }));
    await waitFor(() => a.last());
    await p2p.updateShare(share.id, { password: 'locked now' });
    expect(await a.closed).toBe(4401);
    const token2 = p2p.shares.token(p2p.shares.getRow(share.id)!);
    const b = await connect(share.id);
    b.ws.send(JSON.stringify({ t: 'hello', token: token2, peerId: PEER_B }));
    await waitFor(() => b.last());
    await p2p.revokeShare(share.id);
    expect(await b.closed).toBe(4404);
  });

  it('admin snapshots: swarm() and allSwarms() for active shares only', async () => {
    const { share } = await newShare();
    expect(p2p.swarm(share.id)!.peers[0]!.id).toBe('srv');
    expect(Object.keys(p2p.allSwarms())).toContain(share.id);
    await p2p.revokeShare(share.id);
    expect(p2p.swarm(share.id)).toBeUndefined();
    expect(Object.keys(p2p.allSwarms())).not.toContain(share.id);
  });
});

describe('swarm accounting under churn and spam', () => {
  const pid = (n: number) => n.toString(16).padStart(40, '0');
  const ann = (shareId: string, peerId: string, event: 'start' | 'update' | 'complete' | 'stop', uploaded = 0, left = event === 'complete' ? 0 : 1) =>
    p2p.stats.onAnnounce({ shareId, peerId, type: 'http', event, left, uploaded, downloaded: 0 });
  type St = { announced: Map<string, unknown>; lastUploaded: Map<string, number>; completed: Set<string> };
  const state = (shareId: string) => (p2p.stats as unknown as { states: Map<string, St> }).states.get(shareId);

  it('a peer returning after the share went idle is not counted twice', async () => {
    const { share } = await newShare();
    const X = 'cc'.repeat(20);
    ann(share.id, X, 'start', 1000);
    ann(share.id, X, 'complete', 1000);
    ann(share.id, X, 'stop');
    p2p.stats.flush();
    await sleep(800); // > lingerMs + a few ticks: the live state is idle now
    p2p.stats.flush();
    ann(share.id, X, 'start', 1000);
    ann(share.id, X, 'complete', 1000);
    p2p.stats.flush();
    const st = p2p.getShare(share.id)!.stats;
    expect(st.peerBytes).toBe(1000);
    expect(st.completedDownloads).toBe(1);
    // Revoking (inactive) drops the ledger with the rest of the state.
    await p2p.revokeShare(share.id);
    await waitFor(() => {
      p2p.stats.flush();
      return state(share.id) === undefined;
    }, 3000);
  });

  it('a completion counts only for a peer that announced before', async () => {
    const { share } = await newShare();
    ann(share.id, pid(1), 'complete');
    ann(share.id, pid(1), 'complete');
    p2p.stats.flush();
    expect(p2p.getShare(share.id)!.stats.completedDownloads).toBe(0);
  });

  it('a peer that starts out complete (seeding a finished download again) is not a completion', async () => {
    const { share } = await newShare();
    ann(share.id, pid(1), 'start', 0, 0);
    ann(share.id, pid(1), 'complete');
    ann(share.id, pid(1), 'update', 500, 0);
    p2p.stats.flush();
    expect(p2p.getShare(share.id)!.stats).toMatchObject({ completedDownloads: 0, peerBytes: 500 });
  });

  it('bounds remembered peers and completions per hour', async () => {
    const { share } = await newShare();
    for (let i = 1; i <= 1200; i++) {
      ann(share.id, pid(i), 'start', 10);
      ann(share.id, pid(i), 'complete', 10);
    }
    const s = state(share.id)!;
    expect(s.announced.size).toBeLessThanOrEqual(1000);
    expect(s.lastUploaded.size).toBeLessThanOrEqual(1000);
    expect(s.completed.size).toBeLessThanOrEqual(1000);
    p2p.stats.flush();
    expect(p2p.getShare(share.id)!.stats.completedDownloads).toBe(200);
    const events = env.ctx.db.prepare("SELECT COUNT(*) AS n FROM share_events WHERE share_id = ? AND type = 'completed'").get(share.id) as { n: number };
    expect(events.n).toBe(200);
  });
});
