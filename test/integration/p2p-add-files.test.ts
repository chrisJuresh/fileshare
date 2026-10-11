// Files added to a shared folder item (§4 "add files"): the share keeps its link and token, gets a
// new infohash, and the appended torrent (with a BEP 47 pad file) downloads correctly from the
// seeder (pads read as zeros) and from the webseed (pads served as zeros). A torrent app that
// already holds the old files only fetches the new ones. Synthetic random data only.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
// @ts-ignore untyped
import parseTorrent from 'parse-torrent';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAppendedInfo, hashPieces, planAppend, tailRanges, type HashSource } from '../../src/ingest/torrent.js';
import { CONTENT_CHANGED_CLOSE, createP2P, type P2P } from '../../src/p2p/index.js';
import { WebTorrent, type WtClient, type WtTorrent } from '../../src/p2p/seeder.js';
import { buildPublicServer } from '../../src/server/public.js';
import type { UnlockResponse } from '../../src/types.js';
import { makeEnv, makeItem, sleep, waitFor, type MadeItem, type TestEnv } from './p2p-helpers.js';

const PL = 32 * 1024;

let env: TestEnv;
let p2p: P2P;
let app: FastifyInstance;
let base: string;
let item: MadeItem;
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

async function post(p: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

async function torrentOf(u: UnlockResponse): Promise<any> {
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

/** What ingest's append mode does to the library copy and the item row. */
async function appendToItem(it: MadeItem, added: { rel: string; bytes: Buffer }[]): Promise<void> {
  const row = env.ctx.db.prepare('SELECT info FROM items WHERE id = ?').get(it.id) as { info: Buffer };
  const plan = planAppend(row.info);
  const sources: HashSource[] = [];
  for (const t of tailRanges(plan)) {
    const p = path.join(it.dir, ...t.segs);
    const st = await stat(p);
    sources.push({ path: p, size: st.size, mtimeMs: st.mtimeMs, start: t.start, length: t.length });
  }
  if (plan.padLength > 0) sources.push({ zeros: plan.padLength });
  for (const f of added) {
    const p = path.join(it.dir, ...f.rel.split('/'));
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, f.bytes);
    const st = await stat(p);
    sources.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
  }
  const { pieces } = await hashPieces(sources, plan.pieceLength);
  const info = buildAppendedInfo(row.info, plan.padLength, added.map((f) => ({ segs: f.rel.split('/'), length: f.bytes.length })), Buffer.concat([plan.keptPieces, pieces]));
  it.files.push(...added);
  env.ctx.db.prepare('UPDATE items SET info = ?, file_count = ?, total_bytes = total_bytes + ? WHERE id = ?').run(info, it.files.length, added.reduce((a, f) => a + f.bytes.length, 0), it.id);
}

async function expectSameBytes(dlRoot: string, name: string, files: { rel: string; bytes: Buffer }[]): Promise<void> {
  for (const f of files) expect((await readFile(path.join(dlRoot, name, ...f.rel.split('/')))).equals(f.bytes)).toBe(true);
}

beforeAll(async () => {
  env = await makeEnv();
  p2p = createP2P(env.ctx, { argon: { memoryCost: 4096, timeCost: 2 }, tickIntervalMs: 200, flushIntervalMs: 500, sweepIntervalMs: 500, rtcBindAddress: '127.0.0.1' });
  app = await buildPublicServer(env.ctx, p2p);
  await p2p.start();
  await app.listen({ host: '127.0.0.1', port: env.ports.public });
  base = `http://127.0.0.1:${env.ports.public}`;
  item = await makeItem(
    env.ctx,
    'Set',
    [
      { rel: 'a.bin', size: 12 * PL + 100 },
      { rel: 'sub/b.bin', size: 5000 }, // old data ends 5100 bytes into a piece
    ],
    { pieceLength: PL },
  );
});

afterAll(async () => {
  await Promise.all(leechers.map((c) => new Promise<void>((r) => c.destroy(() => r()))));
  await app?.close();
  await p2p?.stop();
  await env?.cleanup();
});

describe('adding files to a shared item', () => {
  it('re-issues the share (same link and token), seeds and webseeds the padded torrent, and rechecks old files', async () => {
    const share = await p2p.createShare({ itemId: item.id });
    const u1 = (await post(`/api/s/${share.id}/unlock`, {})).body as UnlockResponse;
    const oldFiles = item.files.map((f) => ({ ...f }));

    // A torrent app downloads the original torrent.
    const oldDl = path.join(env.root, 'dl-old');
    const pt1 = await torrentOf(u1);
    pt1.announce = [u1.announce.http];
    pt1.urlList = [];
    await downloadAll(leecher().add(pt1, { path: oldDl }));

    // An open share page is connected to the live socket.
    const live = new WebSocket(`${base.replace('http', 'ws')}/api/s/${share.id}/live`);
    await new Promise((r) => live.on('open', r));
    live.send(JSON.stringify({ t: 'hello', token: u1.token, peerId: 'cd'.repeat(20) }));
    await new Promise((r) => live.once('message', r));
    const liveClosed = new Promise<number>((r) => live.on('close', (c) => r(c)));

    const added = [
      { rel: '0 new.bin', bytes: randomBytes(2 * PL + 7) }, // sorts first by name, still goes last
      { rel: 'sub/c.bin', bytes: randomBytes(900) },
    ];
    await appendToItem(item, added);
    await p2p.refreshItemShares(item.id);
    await p2p.refreshItemShares(item.id); // idempotent

    expect(await liveClosed).toBe(CONTENT_CHANGED_CLOSE);
    const row = p2p.shares.getRow(share.id)!;
    expect(row.info_hash).not.toBe(share.infoHash);
    expect(row.torrent_name).toBe('Set');
    const events = env.ctx.db.prepare("SELECT detail FROM share_events WHERE share_id = ? AND type = 'updated'").all(share.id) as { detail: string }[];
    expect(events.map((e) => JSON.parse(e.detail))).toEqual([{ content: 'files_added', files: 4 }]);

    // The token the page holds still works; refresh hands back the new file list (pads hidden).
    const r = await post(`/api/s/${share.id}/refresh`, { token: u1.token });
    expect(r.status).toBe(200);
    const u2 = r.body as UnlockResponse;
    expect(u2.token).toBe(u1.token);
    expect(u2.infoHash).toBe(row.info_hash);
    expect(u2.files.map((f) => f.path)).toEqual(['a.bin', 'sub/b.bin', '0 new.bin', 'sub/c.bin']);
    expect(u2.totalBytes).toBe(item.files.reduce((a, f) => a + f.bytes.length, 0));
    expect((await post(`/api/s/${share.id}/refresh`, { token: 'x.1.y' })).status).toBe(401);
    expect((await post(`/api/s/${share.id}/refresh`, {})).status).toBe(400);

    // The old infohash is no longer announced for; the new one is seeded.
    await waitFor(() => p2p.seeder?.torrent(share.id)?.infoHash === row.info_hash);
    expect(p2p.tracker.swarm(share.infoHash)).toBeUndefined();

    const pt2 = await torrentOf(u2);
    expect(pt2.infoHash).toBe(row.info_hash);
    const pad = pt2.files.find((f: { path: string }) => /\.pad/.test(f.path));
    expect(pad.length).toBe(PL - 5100);

    // 1) Seeder over TCP, fresh download: pads come out of the read-only store as zeros.
    const fresh = path.join(env.root, 'dl-fresh');
    const t2 = leecher().add({ ...pt2, announce: [u2.announce.http], urlList: [] }, { path: fresh });
    await downloadAll(t2);
    await expectSameBytes(fresh, 'Set', item.files);

    // 2) Webseed only: the pad file is served as zeros.
    const padUrl = `${u2.webseed}Set/.pad/${PL - 5100}`;
    const padRes = await fetch(padUrl, { headers: { range: 'bytes=10-19' } });
    expect(padRes.status).toBe(206);
    expect(Buffer.from(await padRes.arrayBuffer()).equals(Buffer.alloc(10))).toBe(true);
    expect((await fetch(`${u2.webseed}Set/.pad/123`)).status).toBe(404);
    const ws = path.join(env.root, 'dl-ws');
    const t3 = leecher({ tracker: false, webSeeds: true }).add({ ...pt2, announce: [] }, { path: ws, maxWebConns: 4 });
    await downloadAll(t3);
    await expectSameBytes(ws, 'Set', item.files);

    // 3) Recheck: the app that has the old files adds the new torrent into the same folder and only
    //    fetches the new files plus the old partial last piece.
    const t4 = leecher().add({ ...pt2, announce: [u2.announce.http], urlList: [] }, { path: oldDl });
    await new Promise<void>((r) => (t4.ready ? r() : t4.once('ready', () => r())));
    const bf = (t4 as unknown as { bitfield: { get(i: number): boolean } }).bitfield;
    const kept = t4.pieces.map((_, i) => i).filter((i) => bf.get(i));
    const fetched = t4.pieces.map((_, i) => i).filter((i) => !bf.get(i));
    await downloadAll(t4);
    await expectSameBytes(oldDl, 'Set', item.files);
    await expectSameBytes(oldDl, 'Set', oldFiles);
    // Old data: 12 full pieces + a partial one (12·PL + 5100 bytes). Only that partial piece (now
    // ending in the pad) and the 3 pieces of new data (2·PL + 907 bytes) are downloaded.
    expect(kept).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(fetched).toEqual([12, 13, 14, 15]);
    expect(t4.pieces.length).toBe(16);
    // Byte count varies with duplicate end-game blocks; a full re-download would be ~400 KiB.
    expect(t4.received).toBeLessThan(oldFiles.reduce((a, f) => a + f.bytes.length, 0) / 2);
  });
});
