// Web upload: tus round trip (tus-js-client in Node) → staging → batch complete → library → ready.
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import * as tus from 'tus-js-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ItemRow } from '../../src/db/index.js';
import { createIngest, type IngestService } from '../../src/ingest/index.js';
import { bdecode, planAppend } from '../../src/ingest/torrent.js';
import { parseInfo } from '../../src/p2p/metainfo.js';
import { makeTestEnv, runFakeBackup, startFakeSyncthing, waitFor, type FakeSyncthing, type TestEnv } from '../helpers/ingest-fakes.js';

const TUS = '/api/admin/uploads/tus/';

function upload(base: string, data: Buffer, metadata: Record<string, string>, chunkSize = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new tus.Upload(data, {
      endpoint: base + TUS,
      metadata,
      chunkSize,
      retryDelays: [],
      storeFingerprintForResuming: false,
      onError: reject,
      onSuccess: () => resolve(u.url ?? ''),
    });
    u.start();
  });
}

describe('web upload (tus)', () => {
  let fake: FakeSyncthing;
  let env: TestEnv;
  let ingest: IngestService;
  let app: FastifyInstance;
  let base: string;
  let refreshed: string[];

  beforeEach(async () => {
    const apiKey = randomBytes(24).toString('hex');
    fake = await startFakeSyncthing(apiKey);
    env = makeTestEnv({ SYNCTHING_API_URL: fake.url }, apiKey);
    refreshed = [];
    const p2p = { revokeAllForItem: async () => undefined, repointItem: async () => undefined, refreshItemShares: async (id: string) => void refreshed.push(id) };
    ingest = createIngest(env.ctx, { p2p }, { tickMs: 150, snapshotPollMs: 150, eventPollTimeoutS: 1 });
    app = Fastify({ bodyLimit: 1024 * 1024 });
    await ingest.registerAdminRoutes(app);
    await ingest.start();
    await app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app.close();
    await ingest.stop();
    await fake.close();
    env.cleanup();
  });

  const newBatch = async (): Promise<string> => {
    const r = await fetch(`${base}/api/admin/uploads/batches`, { method: 'POST' });
    expect(r.status).toBe(201);
    return ((await r.json()) as { id: string }).id;
  };

  it('uploads files into a batch and ingests them', async () => {
    const batchId = await newBatch();
    const a = randomBytes(200 * 1024 + 3);
    const b = randomBytes(1000);
    const s = randomBytes(5000);
    await upload(base, a, { batchId, relativePath: '/Folder/sub/a.bin', filename: 'a.bin' });
    await upload(base, b, { batchId, relativePath: 'Folder/b.bin', filename: 'b.bin' });
    await upload(base, s, { batchId, relativePath: 'null', filename: 'single.bin' }); // Uppy sends "null"
    const staging = path.join(env.ctx.config.paths.staging, batchId);
    expect(readFileSync(path.join(staging, 'Folder', 'sub', 'a.bin')).equals(a)).toBe(true);
    expect(statSync(path.join(staging, 'Folder')).mode & 0o777).toBe(0o750);
    // finished uploads are moved out of /data/uploads (no data or .json left behind)
    expect(readdirSync(env.ctx.config.paths.uploads)).toEqual([]);

    // duplicates and bad paths are refused
    await expect(upload(base, b, { batchId, relativePath: 'Folder/b.bin', filename: 'b.bin' })).rejects.toThrow(/409/);
    await expect(upload(base, b, { batchId, relativePath: '../escape.bin', filename: 'x' })).rejects.toThrow(/400/);
    await expect(upload(base, b, { batchId, relativePath: 'bad#name.bin', filename: 'x' })).rejects.toThrow(/400/);
    await expect(upload(base, b, { batchId: 'a'.repeat(26), relativePath: 'x.bin', filename: 'x' })).rejects.toThrow(/404/);

    const done = await fetch(`${base}/api/admin/uploads/batches/${batchId}/complete`, { method: 'POST' });
    expect(done.status).toBe(200);
    const { itemIds } = (await done.json()) as { itemIds: string[] };
    expect(itemIds).toHaveLength(2);
    const items = () => itemIds.map((id) => env.ctx.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow);
    expect(items().map((i) => [i.name, i.kind, i.source])).toEqual([
      ['Folder', 'dir', 'upload'],
      ['single.bin', 'file', 'upload'],
    ]);
    await waitFor(() => items().every((i) => i.status === 'snapshotting'));
    // batch closed: further uploads are refused
    await expect(upload(base, b, { batchId, relativePath: 'late.bin', filename: 'late.bin' })).rejects.toThrow(/409/);
    expect((await fetch(`${base}/api/admin/uploads/batches/${batchId}/complete`, { method: 'POST' })).status).toBe(409);

    runFakeBackup(env.ctx.db, env.ctx.config.paths.library, 'ok');
    await waitFor(() => items().every((i) => i.status === 'ready'));
    const lib = env.ctx.config.paths.library;
    expect(readFileSync(path.join(lib, 'Folder', 'sub', 'a.bin')).equals(a)).toBe(true);
    expect(readFileSync(path.join(lib, 'single.bin')).equals(s)).toBe(true);
    expect(items()[0]!.file_count).toBe(2);
    expect(items()[0]!.total_bytes).toBe(a.length + b.length);
    expect(existsSync(staging)).toBe(false); // empty batch dir cleaned up
  });

  it('enforces request limits and refuses GET', async () => {
    const batchId = await newBatch();
    const create = await fetch(base + TUS, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(200 * 1024 * 1024),
        'Upload-Metadata': `batchId ${Buffer.from(batchId).toString('base64')},relativePath ${Buffer.from('big.bin').toString('base64')}`,
      },
    });
    expect(create.status).toBe(201);
    const loc = create.headers.get('location')!;
    expect(loc.startsWith(TUS)).toBe(true); // relative Location, never built from Host
    const patch = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        // raw request so we control Content-Length without sending 100 MiB
        import('node:http').then(({ request }) => {
          const req = request(base + loc, { method: "PATCH", agent: false, headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream', ...headers } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on('error', reject);
          req.end();
        }, reject);
      });
    expect(await patch({ "Content-Length": String(100 * 1024 * 1024 + 1) })).toBe(413);
    expect(await patch({ "Transfer-Encoding": "chunked" })).toBe(411);
    expect((await fetch(base + loc)).status).toBe(405);
    const deferred = await fetch(base + TUS, {
      method: 'POST',
      headers: { 'Tus-Resumable': '1.0.0', 'Upload-Defer-Length': '1', 'Upload-Metadata': `batchId ${Buffer.from(batchId).toString('base64')},filename ${Buffer.from('d.bin').toString('base64')}` },
    });
    expect(deferred.status).toBe(400);
    const huge = await fetch(base + TUS, {
      method: 'POST',
      headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(2 ** 52), 'Upload-Metadata': `batchId ${Buffer.from(batchId).toString('base64')},filename ${Buffer.from('h.bin').toString('base64')}` },
    });
    expect(huge.status).toBe(507);
  });

  describe('resumed uploads (dashboard reload)', () => {
    const meta = (batchId: string, rel: string) =>
      `batchId ${Buffer.from(batchId).toString('base64')},relativePath ${Buffer.from(rel).toString('base64')}`;
    const create = async (batchId: string, rel: string, length: number): Promise<string> => {
      const r = await fetch(base + TUS, { method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(length), 'Upload-Metadata': meta(batchId, rel) } });
      expect(r.status).toBe(201);
      return base + r.headers.get('location')!;
    };
    // A resumed PATCH carries no metadata: the server uses what the upload was created with.
    const patch = (url: string, offset: number, body: Buffer) =>
      fetch(url, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }, body });
    const batchStatus = async (id: string) => {
      const r = await fetch(`${base}/api/admin/uploads/batches/${id}`);
      return r.status === 200 ? ((await r.json()) as { status: string }).status : r.status;
    };
    const complete = (id: string) => fetch(`${base}/api/admin/uploads/batches/${id}/complete`, { method: 'POST' });

    it('a remembered open batch is reused, so the resumed file and the completion meet', async () => {
      const batchId = await newBatch();
      const data = randomBytes(100_000);
      const url = await create(batchId, 'resumed.bin', data.length);
      expect((await patch(url, 0, data.subarray(0, 40_000))).status).toBe(204);
      // reload: the dashboard asks whether its remembered batch is still open, and reuses it
      expect(await batchStatus(batchId)).toBe('open');
      expect((await patch(url, 40_000, data.subarray(40_000))).status).toBe(204);
      const done = await complete(batchId);
      expect(done.status).toBe(200);
      expect(((await done.json()) as { itemIds: string[] }).itemIds).toHaveLength(1);
      expect(await batchStatus(batchId)).toBe('ingested');
      expect(await batchStatus('c'.repeat(26))).toBe(404);
    });

    it('explains an empty round and a resumed upload whose round was already completed', async () => {
      const empty = await newBatch();
      const r = await complete(empty);
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ error: 'batch_empty', message: expect.stringMatching(/no finished files/) });

      const batchId = await newBatch();
      const first = randomBytes(1000);
      const u1 = await create(batchId, 'one.bin', first.length);
      expect((await patch(u1, 0, first)).status).toBe(204);
      const second = randomBytes(2000);
      const u2 = await create(batchId, 'two.bin', second.length);
      expect((await patch(u2, 0, second.subarray(0, 500))).status).toBe(204);
      expect((await complete(batchId)).status).toBe(200);
      const late = await patch(u2, 500, second.subarray(500));
      expect(late.status).toBe(409);
      expect(await late.text()).toMatch(/already finished/);
      const again = await complete(batchId);
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: 'batch_not_open', message: expect.stringMatching(/start a new upload/) });
    });
  });

  it('refuses to complete an empty or unknown batch', async () => {
    const batchId = await newBatch();
    expect((await fetch(`${base}/api/admin/uploads/batches/${batchId}/complete`, { method: 'POST' })).status).toBe(400);
    expect((await fetch(`${base}/api/admin/uploads/batches/${'b'.repeat(26)}/complete`, { method: 'POST' })).status).toBe(404);
  });

  it('adds files to a ready folder item: appended after a pad, old pieces kept, links refreshed', async () => {
    const MiB = 1024 * 1024;
    const getItem = (id: string) => env.ctx.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow;
    const x = randomBytes(MiB + 3);
    const y = randomBytes(5000);
    const b1 = await newBatch();
    await upload(base, x, { batchId: b1, relativePath: 'Set/x.bin', filename: 'x.bin' }, MiB);
    await upload(base, y, { batchId: b1, relativePath: 'Set/y.bin', filename: 'y.bin' });
    await upload(base, y, { batchId: b1, relativePath: 'one.bin', filename: 'one.bin' });
    const { itemIds } = (await (await fetch(`${base}/api/admin/uploads/batches/${b1}/complete`, { method: 'POST' })).json()) as { itemIds: string[] };
    const [one, set] = itemIds.map(getItem).sort((a, b) => a.name.localeCompare(b.name)) as [ItemRow, ItemRow];
    expect([one.name, set.name]).toEqual(['one.bin', 'Set']);
    await waitFor(() => getItem(set.id).status === 'snapshotting' && getItem(one.id).status === 'snapshotting');

    const b2 = await newBatch();
    const z = randomBytes(300 * 1024);
    const w = randomBytes(10);
    await upload(base, z, { batchId: b2, relativePath: 'a-first.bin', filename: 'a-first.bin' });
    await upload(base, w, { batchId: b2, relativePath: 'more/w.bin', filename: 'w.bin' });
    // only once ready, only folders, only open rounds
    await expect(ingest.addFiles(set.id, b2)).rejects.toMatchObject({ statusCode: 409 });
    runFakeBackup(env.ctx.db, env.ctx.config.paths.library, 'ok');
    await waitFor(() => getItem(set.id).status === 'ready' && getItem(one.id).status === 'ready');
    await expect(ingest.addFiles(one.id, b2)).rejects.toMatchObject({ statusCode: 409, message: /folder/ });
    await expect(ingest.addFiles(set.id, b1)).rejects.toMatchObject({ statusCode: 409 });
    await expect(ingest.addFiles(set.id, 'c'.repeat(26))).rejects.toMatchObject({ statusCode: 404 });
    const empty = await newBatch();
    await expect(ingest.addFiles(set.id, empty)).rejects.toMatchObject({ statusCode: 400 });
    // a name that already exists in the item is refused, and the round stays open
    const clash = await newBatch();
    await upload(base, w, { batchId: clash, relativePath: 'y.bin', filename: 'y.bin' });
    await expect(ingest.addFiles(set.id, clash)).rejects.toMatchObject({ statusCode: 409, message: /already exists/ });
    const clash2 = await newBatch();
    await upload(base, w, { batchId: clash2, relativePath: 'x.bin/inner.bin', filename: 'inner.bin' });
    await expect(ingest.addFiles(set.id, clash2)).rejects.toMatchObject({ statusCode: 409 });
    expect(getItem(set.id).status).toBe('ready');

    const oldInfo = getItem(set.id).info!;
    const plan = planAppend(oldInfo);
    await ingest.addFiles(set.id, b2);
    expect(getItem(set.id).append_batch_id).toBe(b2);
    await expect(upload(base, w, { batchId: b2, relativePath: 'late.bin', filename: 'late.bin' })).rejects.toThrow(/409/);
    await waitFor(() => getItem(set.id).status === 'snapshotting');
    expect(refreshed).toEqual([set.id]);

    const row = getItem(set.id);
    const parsed = parseInfo(row.info!);
    expect(parsed.files.map((f) => f.path)).toEqual(['x.bin', 'y.bin', 'a-first.bin', 'more/w.bin']);
    expect(parsed.layout.filter((f) => f.pad).map((f) => f.length)).toEqual([plan.padLength]);
    expect(plan.padLength).toBe(MiB - 5003);
    const pieces = Buffer.from((bdecode(row.info!) as { pieces: Uint8Array }).pieces);
    expect(pieces.subarray(0, plan.keptPieces.length).equals(Buffer.from(plan.keptPieces))).toBe(true);
    expect(row.file_count).toBe(4);
    expect(row.total_bytes).toBe(x.length + y.length + z.length + w.length);
    const lib = env.ctx.config.paths.library;
    expect(readFileSync(path.join(lib, 'Set', 'a-first.bin')).equals(z)).toBe(true);
    expect(readFileSync(path.join(lib, 'Set', 'more', 'w.bin')).equals(w)).toBe(true);
    expect(existsSync(path.join(env.ctx.config.paths.staging, b2))).toBe(false);

    runFakeBackup(env.ctx.db, lib, 'ok');
    await waitFor(() => getItem(set.id).status === 'ready');
    expect(getItem(set.id).append_batch_id).toBeNull();
    expect(refreshed).toEqual([set.id, set.id]);
  });
});
