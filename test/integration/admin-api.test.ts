// Admin API routes: validation, error mapping and DTO shapes (fake ingest/p2p, synthetic data).
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setSetting } from '../../src/db/index.js';
import type { ItemDto, ShareDto, SettingsDto, StatsDto, StatusDto } from '../../src/types.js';
import { ADMIN_ORIGIN, type Harness, insertItem, insertShare, type Jwks, signToken, startAdmin, startJwks } from './admin-helpers.js';

// bencode 4 ships no types; load it untyped.
const bencodeSpec: string = 'bencode';
const bencode = ((await import(bencodeSpec)) as { default: { encode(v: unknown): Uint8Array } }).default;

let jwks: Jwks;
let h: Harness;
let token: string;
let syncthing: Server;
const SYNC_PC = 'SYNTHETIC-DEVICE-ID';

beforeAll(async () => {
  jwks = await startJwks();
  syncthing = createServer((req, res) => {
    if (req.headers['x-api-key'] !== 'synthetic-api-key') return void res.writeHead(403).end();
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/rest/system/connections') res.end(JSON.stringify({ connections: { [SYNC_PC]: { connected: true } } }));
    else if (req.url?.startsWith('/rest/db/status?folder=fileshare-outbox')) res.end(JSON.stringify({ state: 'idle' }));
    else res.end('{}');
  });
  await new Promise<void>((r) => syncthing.listen(0, '127.0.0.1', r));
  h = await startAdmin({
    CF_ACCESS_CERTS_URL: jwks.url,
    SYNCTHING_API_URL: `http://127.0.0.1:${(syncthing.address() as AddressInfo).port}`,
    SYNCTHING_PC_DEVICE_ID: SYNC_PC,
  });
  writeFileSync(path.join(h.dir, 'secrets', 'syncthing-api-key'), 'synthetic-api-key\n');
  token = await signToken(jwks);
});
afterAll(async () => {
  await h?.close();
  await jwks?.close();
  await new Promise((r) => syncthing?.close(r));
});
beforeEach(() => {
  h.ctx.db.exec('DELETE FROM share_events; DELETE FROM share_stats; DELETE FROM shares; DELETE FROM items; DELETE FROM backup_requests; DELETE FROM settings;');
  h.ingest.calls = [];
  h.p2p.calls = [];
  h.ingest.progressMap = {};
});

function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
  const headers: Record<string, string> = { 'cf-access-jwt-assertion': token };
  if (method !== 'GET') {
    headers.origin = ADMIN_ORIGIN;
    headers['content-type'] = 'application/json';
  }
  return h.app.inject({ method, url, headers, ...(method !== 'GET' ? { payload: JSON.stringify(body ?? {}) } : {}) });
}

describe('items', () => {
  it('lists items with progress and active share counts, newest first, excluding deleted', async () => {
    const a = insertItem(h.ctx, { name: 'alpha', status: 'hashing', totalBytes: 10, fileCount: 2 });
    const b = insertItem(h.ctx, { name: 'beta', status: 'ready' });
    insertItem(h.ctx, { name: 'gone', status: 'deleted' });
    insertShare(h.ctx, b);
    insertShare(h.ctx, b, { expiresAt: Date.now() - 1000 });
    h.ingest.progressMap = { [a]: 0.25 };
    const r = await call('GET', '/api/admin/items');
    expect(r.statusCode).toBe(200);
    const items = r.json() as ItemDto[];
    expect(items.map((i) => i.name).sort()).toEqual(['alpha', 'beta']);
    const alpha = items.find((i) => i.id === a)!;
    expect(alpha).toEqual({
      id: a, name: 'alpha', kind: 'dir', source: 'upload', status: 'hashing', error: null, totalBytes: 10, fileCount: 2,
      createdAt: expect.any(Number), readyAt: null, progress: 0.25, activeShares: 0,
    });
    expect(items.find((i) => i.id === b)!.activeShares).toBe(1);
  });

  it('renames with validation and conflict detection', async () => {
    const a = insertItem(h.ctx, { name: 'alpha' });
    insertItem(h.ctx, { name: 'taken' });
    expect((await call('PATCH', `/api/admin/items/${a}`, { name: '../x' })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/admin/items/${a}`, { name: ' padded' })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/admin/items/${a}`, {})).statusCode).toBe(400);
    expect((await call('PATCH', `/api/admin/items/${a}`, { name: 'ok', extra: 1 })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/admin/items/nope', { name: 'new' })).statusCode).toBe(404);
    expect((await call('PATCH', `/api/admin/items/${a}`, { name: 'taken' })).statusCode).toBe(409);
    const ok = await call('PATCH', `/api/admin/items/${a}`, { name: 'Renamed item' });
    expect(ok.statusCode).toBe(200);
    expect(h.ingest.calls).toEqual([{ method: 'renameItem', args: [a, 'Renamed item'] }]);
  });

  it('maps ingest errors carrying a statusCode', async () => {
    const a = insertItem(h.ctx, { name: 'alpha' });
    h.ingest.renameItem = async () => {
      throw Object.assign(new Error('rename conflict on disk'), { statusCode: 409 });
    };
    try {
      const r = await call('PATCH', `/api/admin/items/${a}`, { name: 'beta' });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ error: 'conflict' });
    } finally {
      delete (h.ingest as { renameItem?: unknown }).renameItem;
    }
  });

  it('hides internal errors', async () => {
    const a = insertItem(h.ctx, { name: 'alpha', status: 'error' });
    h.ingest.retry = async () => {
      throw new Error('ENOENT /data/library/secret-path');
    };
    try {
      const r = await call('POST', `/api/admin/items/${a}/retry`);
      expect(r.statusCode).toBe(500);
      expect(r.json()).toEqual({ error: 'internal' });
    } finally {
      delete (h.ingest as { retry?: unknown }).retry;
    }
  });

  it('deletes (404 for unknown or deleted)', async () => {
    const a = insertItem(h.ctx, { name: 'alpha' });
    insertShare(h.ctx, a);
    expect((await call('DELETE', '/api/admin/items/unknown')).statusCode).toBe(404);
    expect((await call('DELETE', `/api/admin/items/${a}`)).statusCode).toBe(200);
    expect(h.p2p.calls.map((c) => c.method)).toEqual(['revokeAllForItem']);
    expect((await call('DELETE', `/api/admin/items/${a}`)).statusCode).toBe(404);
  });

  it('retries only items in error', async () => {
    const ready = insertItem(h.ctx, { status: 'ready' });
    const failed = insertItem(h.ctx, { status: 'error' });
    expect((await call('POST', `/api/admin/items/${ready}/retry`)).statusCode).toBe(409);
    expect((await call('POST', `/api/admin/items/${failed}/retry`)).statusCode).toBe(200);
    expect(h.ingest.calls).toEqual([{ method: 'retry', args: [failed] }]);
  });

  it('lists files of single- and multi-file items', async () => {
    const single = insertItem(h.ctx, {
      kind: 'file',
      info: Buffer.from(bencode.encode({ name: 'single.bin', length: 1234, 'piece length': 16384, pieces: new Uint8Array(20), private: 1 })),
    });
    const multi = insertItem(h.ctx, {
      info: Buffer.from(
        bencode.encode({
          name: 'folder',
          files: [
            { length: 5, path: ['a.txt'] },
            { length: 7, path: ['sub', 'b.bin'] },
            { length: 3, path: ['.pad', '3'], attr: 'p' },
          ],
          'piece length': 16384,
          pieces: new Uint8Array(20),
          private: 1,
        }),
      ),
    });
    const pending = insertItem(h.ctx, { status: 'hashing' });
    expect((await call('GET', `/api/admin/items/${single}/files`)).json()).toEqual([{ path: 'single.bin', length: 1234 }]);
    expect((await call('GET', `/api/admin/items/${multi}/files`)).json()).toEqual([
      { path: 'a.txt', length: 5 },
      { path: 'sub/b.bin', length: 7 },
    ]);
    expect((await call('GET', `/api/admin/items/${pending}/files`)).statusCode).toBe(409);
  });
});

describe('shares', () => {
  it('creates with validation', async () => {
    const ready = insertItem(h.ctx, { name: 'ready-item' });
    const hashing = insertItem(h.ctx, { status: 'hashing' });
    const day = 24 * 3600 * 1000;
    expect((await call('POST', '/api/admin/shares', { itemId: 'nope' })).statusCode).toBe(404);
    expect((await call('POST', '/api/admin/shares', { itemId: hashing })).statusCode).toBe(409);
    expect((await call('POST', '/api/admin/shares', { itemId: ready, password: '' })).statusCode).toBe(400);
    expect((await call('POST', '/api/admin/shares', { itemId: ready, password: 'x'.repeat(201) })).statusCode).toBe(400);
    expect((await call('POST', '/api/admin/shares', { itemId: ready, expiresAt: Date.now() - 1 })).statusCode).toBe(400);
    expect((await call('POST', '/api/admin/shares', { itemId: ready, expiresAt: Date.now() + 11 * 366 * day })).statusCode).toBe(400);
    expect((await call('POST', '/api/admin/shares', { itemId: ready, expiresAt: 'tomorrow' })).statusCode).toBe(400);
    expect(h.p2p.calls).toEqual([]);

    const expiresAt = Date.now() + 7 * day;
    const r = await call('POST', '/api/admin/shares', { itemId: ready, password: 'synthetic-pass', expiresAt });
    expect(r.statusCode).toBe(201);
    const dto = r.json() as ShareDto;
    expect(dto).toMatchObject({ itemId: ready, itemName: 'ready-item', hasPassword: true, expiresAt, state: 'active' });
    expect(dto.url).toMatch(/^https:\/\/files\.example\.test\/s\//);
    expect(h.p2p.calls[0]).toEqual({ method: 'createShare', args: [{ itemId: ready, password: 'synthetic-pass', expiresAt }] });

    const list = (await call('GET', '/api/admin/shares')).json() as ShareDto[];
    expect(list.map((s) => s.id)).toEqual([dto.id]);
  });

  it('allows sharing while the item waits for its snapshot, not before hashing is done', async () => {
    const snapshotting = insertItem(h.ctx, { status: 'snapshotting' });
    for (const status of ['incoming', 'stabilising', 'hashing', 'error'] as const) {
      const id = insertItem(h.ctx, { status });
      expect((await call('POST', '/api/admin/shares', { itemId: id })).statusCode).toBe(409);
    }
    expect((await call('POST', '/api/admin/shares', { itemId: snapshotting })).statusCode).toBe(201);
    expect(h.p2p.calls).toEqual([{ method: 'createShare', args: [{ itemId: snapshotting }] }]);
  });

  it('updates, clears and revokes', async () => {
    const item = insertItem(h.ctx);
    const id = insertShare(h.ctx, item, { password: 'p' });
    expect((await call('PATCH', `/api/admin/shares/${id}`, {})).statusCode).toBe(400);
    expect((await call('PATCH', '/api/admin/shares/unknown', { expiresAt: null })).statusCode).toBe(404);
    const r = await call('PATCH', `/api/admin/shares/${id}`, { password: null, expiresAt: null });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ hasPassword: false, expiresAt: null });
    expect(h.p2p.calls.at(-1)).toEqual({ method: 'updateShare', args: [id, { password: null, expiresAt: null }] });

    expect((await call('POST', `/api/admin/shares/${id}/revoke`)).statusCode).toBe(200);
    expect((await call('POST', `/api/admin/shares/${id}/revoke`)).statusCode).toBe(200); // idempotent
    expect(h.p2p.calls.filter((c) => c.method === 'revokeShare')).toHaveLength(1);
    expect((await call('PATCH', `/api/admin/shares/${id}`, { expiresAt: null })).statusCode).toBe(409);
    expect((await call('POST', '/api/admin/shares/unknown/revoke')).statusCode).toBe(404);
  });

  it('resets the unlock limits of a share', async () => {
    const id = insertShare(h.ctx, insertItem(h.ctx), { password: 'p' });
    expect((await call('POST', `/api/admin/shares/${id}/reset-limits`)).statusCode).toBe(200);
    expect(h.p2p.calls.at(-1)).toEqual({ method: 'resetUnlockLimits', args: [id] });
    expect((await call('POST', '/api/admin/shares/unknown/reset-limits')).statusCode).toBe(404);
  });

  it('returns share events', async () => {
    const id = insertShare(h.ctx, insertItem(h.ctx));
    const r = await call('GET', `/api/admin/shares/${id}/events`);
    expect(r.json()).toEqual([{ id: expect.any(Number), at: expect.any(Number), type: 'created', detail: { by: 'test' } }]);
    expect((await call('GET', '/api/admin/shares/unknown/events')).statusCode).toBe(404);
  });
});

describe('stats, status, settings, snapshots', () => {
  it('computes totals and saved fraction', async () => {
    const item = insertItem(h.ctx, { name: 'stats-item' });
    insertShare(h.ctx, item, { stats: { server_bytes_webseed: 100, server_bytes_p2p: 200, peer_bytes: 900, completed_downloads: 3, peak_swarm: 5 } });
    insertShare(h.ctx, item, { stats: { server_bytes_p2p: 100, peer_bytes: 0, completed_downloads: 1, peak_swarm: 2 } });
    setSetting(h.ctx.db, 'upload.capacity_bps', 1_000_000);
    const s = (await call('GET', '/api/admin/stats')).json() as StatsDto;
    expect(s.upload).toEqual({ capBps: 900_000, capacityBps: 1_000_000, currentBps: 12_345 });
    expect(s.totals).toEqual({ serverBytes: 400, peerBytes: 900, savedFraction: 900 / 1300, completedDownloads: 4 });
    expect(s.shares).toHaveLength(2);
    expect(s.shares[0]).toMatchObject({ itemName: 'stats-item', shareId: expect.any(String) });
  });

  it('reports status with three disks, restic and syncthing', async () => {
    setSetting(h.ctx.db, 'status.disk.restic', { total: 1000, free: 100, used: 900, path: '/restic', at: Date.now() });
    setSetting(h.ctx.db, 'status.restic', { repoInitialised: true, lastBackupAt: 5, lastSnapshotId: 'abcd1234', lastCheckAt: 6, lastCheckOk: false, paused: false });
    h.ctx.db.prepare(`INSERT INTO backup_requests (reason, requested_at) VALUES ('manual', 1)`).run();
    const s = (await call('GET', '/api/admin/status')).json() as StatusDto;
    expect(s.disks.map((d) => d.label)).toEqual(['Data', 'Snapshot repository', 'Nightly backup disk']);
    expect(s.disks[0]!.mounted).toBe(true);
    expect(s.disks[1]).toMatchObject({ mounted: true, usedFraction: 0.9, warn: true });
    expect(s.disks[2]).toMatchObject({ mounted: false, note: 'mounted only during the nightly backup; not monitored' });
    expect(s.restic).toMatchObject({ repoInitialised: true, lastSnapshotId: 'abcd1234', lastCheckOk: false, pendingRequests: 1 });
    expect(s.syncthing).toEqual({ reachable: true, pcConnected: true, folderState: 'idle' });
    expect(typeof s.version).toBe('string');
  });

  it('gets and puts settings, emitting settings.changed', async () => {
    expect((await call('GET', '/api/admin/settings')).json()).toEqual({ uploadCapBps: 0, uploadCapacityBps: null, uploadMeasuredAt: null });
    const seen: string[] = [];
    const off = h.ctx.events.on('settings.changed', (e) => seen.push(e.key));
    try {
      expect((await call('PUT', '/api/admin/settings', { uploadCapBps: 1023 })).statusCode).toBe(400);
      expect((await call('PUT', '/api/admin/settings', { uploadCapBps: 10_000_000_001 })).statusCode).toBe(400);
      expect((await call('PUT', '/api/admin/settings', { uploadCapBps: 1.5e6 + 0.5 })).statusCode).toBe(400);
      expect(seen).toEqual([]);
      const r = await call('PUT', '/api/admin/settings', { uploadCapBps: 2_500_000 });
      expect(r.statusCode).toBe(200);
      expect((r.json() as SettingsDto).uploadCapBps).toBe(2_500_000);
      expect(seen).toEqual(['upload.cap_bps']);
    } finally {
      off();
    }
  });

  it('queues a manual snapshot', async () => {
    const r = await call('POST', '/api/admin/snapshots');
    expect(r.statusCode).toBe(202);
    const row = h.ctx.db.prepare('SELECT reason FROM backup_requests WHERE id = ?').get(r.json().id) as { reason: string };
    expect(row.reason).toBe('manual');
  });

  it('returns JSON 404 for unknown API paths', async () => {
    const r = await call('GET', '/api/admin/nope');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not_found' });
  });
});
