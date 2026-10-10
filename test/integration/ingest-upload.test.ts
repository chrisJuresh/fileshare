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

  beforeEach(async () => {
    const apiKey = randomBytes(24).toString('hex');
    fake = await startFakeSyncthing(apiKey);
    env = makeTestEnv({ SYNCTHING_API_URL: fake.url }, apiKey);
    ingest = createIngest(env.ctx, { p2p: { revokeAllForItem: async () => undefined, repointItem: async () => undefined } }, { tickMs: 150, snapshotPollMs: 150, eventPollTimeoutS: 1 });
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

  it('refuses to complete an empty or unknown batch', async () => {
    const batchId = await newBatch();
    expect((await fetch(`${base}/api/admin/uploads/batches/${batchId}/complete`, { method: 'POST' })).status).toBe(400);
    expect((await fetch(`${base}/api/admin/uploads/batches/${'b'.repeat(26)}/complete`, { method: 'POST' })).status).toBe(404);
  });
});
