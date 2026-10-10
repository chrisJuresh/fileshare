import { lstat, readlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, makeItem, startPublic, type MadeItem, type TestEnv } from '../../test/integration/p2p-helpers.js';
import type { P2P } from './index.js';

let env: TestEnv;
let srv: Awaited<ReturnType<typeof startPublic>>;
let p2p: P2P;
let item: MadeItem;
const changed: { shareId: string; reason: string }[] = [];

beforeAll(async () => {
  env = await makeEnv({ PUBLIC_BASE_URL: 'https://files.example.test' });
  srv = await startPublic(env, { sweepIntervalMs: 100 });
  p2p = srv.p2p;
  item = await makeItem(env.ctx, 'Item one', [{ rel: 'f.bin', size: 10_000 }]);
  env.ctx.events.on('share.changed', (e) => changed.push(e));
});
afterAll(async () => {
  await srv.close();
  await env.cleanup();
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('shares', () => {
  it('create: needs a ready item; builds DTO with URL from PUBLIC_BASE_URL; creates seedlink; emits', async () => {
    await expect(p2p.createShare({ itemId: 'nope' })).rejects.toMatchObject({ statusCode: 404 });
    env.ctx.db.prepare("UPDATE items SET status = 'hashing' WHERE id = ?").run(item.id);
    await expect(p2p.createShare({ itemId: item.id })).rejects.toMatchObject({ statusCode: 409 });
    env.ctx.db.prepare("UPDATE items SET status = 'ready' WHERE id = ?").run(item.id);
    await expect(p2p.createShare({ itemId: item.id, expiresAt: Date.now() - 1 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(p2p.createShare({ itemId: item.id, password: '' })).rejects.toMatchObject({ statusCode: 400 });

    const s = await p2p.createShare({ itemId: item.id });
    expect(s).toMatchObject({ itemId: item.id, itemName: 'Item one', torrentName: 'Item one', hasPassword: false, state: 'active', revokedAt: null });
    expect(s.url).toBe(`https://files.example.test/s/${s.id}`);
    expect(s.infoHash).toMatch(/^[0-9a-f]{40}$/);
    expect(s.stats).toEqual({ serverBytesWebseed: 0, serverBytesP2p: 0, peerBytes: 0, completedDownloads: 0, peakSwarm: 0, lastActivityAt: null });
    const link = path.join(env.ctx.config.paths.seedlinks, s.id, 'Item one');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(path.join(env.ctx.config.paths.library, 'Item one'));
    expect(changed).toContainEqual({ shareId: s.id, reason: 'created' });
    expect(p2p.listShares().map((x) => x.id)).toContain(s.id);
  });

  it('update: password set/clear bumps token_version; expiry change does not', async () => {
    const s = await p2p.createShare({ itemId: item.id });
    const v = () => p2p.shares.getRow(s.id)!.token_version;
    expect(v()).toBe(1);
    await p2p.updateShare(s.id, { expiresAt: Date.now() + 60_000 });
    expect(v()).toBe(1);
    const withPw = await p2p.updateShare(s.id, { password: 'pw' });
    expect(withPw.hasPassword).toBe(true);
    expect(v()).toBe(2);
    expect((await p2p.updateShare(s.id, { password: null })).hasPassword).toBe(false);
    expect(v()).toBe(3);
    expect((await p2p.updateShare(s.id, {})).expiresAt).not.toBeNull();
    expect((await p2p.updateShare(s.id, { expiresAt: null })).expiresAt).toBeNull();
    expect(changed.filter((c) => c.shareId === s.id && c.reason === 'updated').length).toBe(5);
  });

  it('revoke: idempotent, removes seedlink, emits, cannot be updated after', async () => {
    const s = await p2p.createShare({ itemId: item.id });
    await p2p.revokeShare(s.id);
    await p2p.revokeShare(s.id);
    expect(p2p.getShare(s.id)!.state).toBe('revoked');
    await expect(lstat(path.join(env.ctx.config.paths.seedlinks, s.id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(changed.filter((c) => c.shareId === s.id && c.reason === 'revoked').length).toBe(1);
    await expect(p2p.updateShare(s.id, { password: 'x' })).rejects.toMatchObject({ statusCode: 409 });
    // The library is untouched.
    expect((await lstat(path.join(env.ctx.config.paths.library, 'Item one', 'f.bin'))).isFile()).toBe(true);
  });

  it('revokeAllForItem + repointItem', async () => {
    const other = await makeItem(env.ctx, 'Other', [{ rel: 'g.bin', size: 1000 }]);
    const a = await p2p.createShare({ itemId: other.id });
    const b = await p2p.createShare({ itemId: other.id });
    // rename on disk + in DB, then repoint
    await rename(other.dir, path.join(env.ctx.config.paths.library, 'Other renamed'));
    env.ctx.db.prepare('UPDATE items SET name = ? WHERE id = ?').run('Other renamed', other.id);
    await p2p.repointItem(other.id);
    expect(await readlink(path.join(env.ctx.config.paths.seedlinks, a.id, 'Other'))).toBe(path.join(env.ctx.config.paths.library, 'Other renamed'));
    expect(p2p.getShare(a.id)!.torrentName).toBe('Other');
    const c = await p2p.createShare({ itemId: other.id });
    expect(c.torrentName).toBe('Other renamed');
    await p2p.revokeAllForItem(other.id);
    expect([a, b, c].map((x) => p2p.getShare(x.id)!.state)).toEqual(['revoked', 'revoked', 'revoked']);
  });

  it('expiry sweep marks shares expired once and emits share.changed(expired)', async () => {
    const s = await p2p.createShare({ itemId: item.id, expiresAt: Date.now() + 150 });
    await new Promise((r) => setTimeout(r, 500));
    expect(p2p.getShare(s.id)!.state).toBe('expired');
    expect(changed.filter((c) => c.shareId === s.id && c.reason === 'expired').length).toBe(1);
    const ev = env.ctx.db.prepare("SELECT COUNT(*) AS n FROM share_events WHERE share_id = ? AND type = 'expired'").get(s.id) as { n: number };
    expect(ev.n).toBe(1);
  });
});

describe('public share API', () => {
  it('status: unknown / revoked / expired are indistinguishable', async () => {
    const live = await p2p.createShare({ itemId: item.id });
    const revoked = await p2p.createShare({ itemId: item.id });
    await p2p.revokeShare(revoked.id);
    const expired = await p2p.createShare({ itemId: item.id, expiresAt: Date.now() + 50 });
    await new Promise((r) => setTimeout(r, 80));
    const get = async (id: string) => {
      const r = await fetch(`${srv.base}/api/s/${id}`);
      return { status: r.status, body: await r.text(), cc: r.headers.get('cache-control') };
    };
    const g = [await get('AAAAAAAAAAAAAAAAAAAAAA'), await get(revoked.id), await get(expired.id), await get('bad id')];
    for (const x of g) expect(x).toEqual(g[0]);
    expect(JSON.parse(g[0]!.body)).toEqual({ status: 'gone', passwordRequired: false });
    expect(JSON.parse((await get(live.id)).body)).toEqual({ status: 'open', passwordRequired: false });

    const u = async (id: string) => {
      const r = await post(`${srv.base}/api/s/${id}/unlock`, {});
      return { status: r.status, body: await r.text() };
    };
    const ug = [await u('AAAAAAAAAAAAAAAAAAAAAA'), await u(revoked.id), await u(expired.id)];
    for (const x of ug) expect(x).toEqual({ status: 404, body: JSON.stringify({ error: 'gone' }) });
  });

  it('unlock response: URLs from PUBLIC_BASE_URL even when Host differs', async () => {
    const s = await p2p.createShare({ itemId: item.id });
    // inject() so the Host header really is the attacker's (fetch may not let us override it).
    const r = await srv.app.inject({
      method: 'POST',
      url: `/api/s/${s.id}/unlock`,
      headers: { host: 'attacker.example:1234', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({
      infoHash: s.infoHash,
      name: 'Item one',
      totalBytes: 10_000,
      files: [{ path: 'f.bin', length: 10_000 }],
      iceServers: [],
      expiresAt: null,
    });
    const tok = b.token as string;
    expect(b.torrentUrl).toBe(`https://files.example.test/api/s/${s.id}/torrent?t=${tok}`);
    expect(b.announce).toEqual({ ws: `wss://files.example.test/tr/${tok}`, http: `https://files.example.test/tr/${tok}/announce` });
    expect(b.webseed).toBe(`https://files.example.test/ws/${tok}/`);
    expect(JSON.stringify(b)).not.toMatch(/attacker|evil|127\.0\.0\.1/);

    const t = await srv.app.inject({ method: 'GET', url: `/api/s/${s.id}/torrent?t=${tok}`, headers: { host: 'attacker.example' } });
    expect(t.statusCode).toBe(200);
    expect(t.headers['content-type']).toBe('application/x-bittorrent');
    expect(t.headers['content-disposition']).toMatch(/^attachment; filename="Item one\.torrent"/);
    expect(t.rawPayload.toString('latin1')).not.toMatch(/attacker|5:nodes/);
    expect(t.rawPayload.toString('latin1')).toContain('https://files.example.test/tr/');
  });

  it('torrent endpoint enforces token + share', async () => {
    const a = await p2p.createShare({ itemId: item.id });
    const b = await p2p.createShare({ itemId: item.id });
    const tokA = p2p.shares.token(p2p.shares.getRow(a.id)!);
    expect((await fetch(`${srv.base}/api/s/${a.id}/torrent`)).status).toBe(404);
    expect((await fetch(`${srv.base}/api/s/${a.id}/torrent?t=garbage`)).status).toBe(404);
    expect((await fetch(`${srv.base}/api/s/${b.id}/torrent?t=${tokA}`)).status).toBe(404); // token for another share
    expect((await fetch(`${srv.base}/api/s/${a.id}/torrent?t=${tokA.slice(0, -1)}x`)).status).toBe(404); // bad MAC
    expect((await fetch(`${srv.base}/api/s/${a.id}/torrent?t=${tokA}`)).status).toBe(200);
  });

  it('unlock validates the body', async () => {
    const s = await p2p.createShare({ itemId: item.id, password: 'pw' });
    expect((await post(`${srv.base}/api/s/${s.id}/unlock`, { password: 5 })).status).toBe(400);
    expect((await post(`${srv.base}/api/s/${s.id}/unlock`, ['x'])).status).toBe(400);
    expect((await post(`${srv.base}/api/s/${s.id}/unlock`, { password: 'x'.repeat(2000) })).status).toBe(400);
    const ok = await post(`${srv.base}/api/s/${s.id}/unlock`, { password: 'pw' });
    expect(ok.status).toBe(200);
    // Unlock is the only token issuer; status shows locked.
    expect(await (await fetch(`${srv.base}/api/s/${s.id}`)).json()).toEqual({ status: 'locked', passwordRequired: true });
  });

  it('password failures take about as long as successes (argon2 verify always runs)', async () => {
    const s = await p2p.createShare({ itemId: item.id, password: 'right' });
    const time = async (body: unknown, ip: string) => {
      const t0 = performance.now();
      await post(`${srv.base}/api/s/${s.id}/unlock`, body, { 'x-forwarded-for': ip });
      return performance.now() - t0;
    };
    const ok = await time({ password: 'right' }, '192.0.2.50');
    const missing = await time({}, '192.0.2.51');
    const wrong = await time({ password: 'wrong' }, '192.0.2.52');
    expect(missing).toBeGreaterThan(ok * 0.3);
    expect(wrong).toBeGreaterThan(ok * 0.3);
  });

  it('parallel wrong guesses from one IP cannot exceed the per-IP limit', async () => {
    const s = await p2p.createShare({ itemId: item.id, password: 'right' });
    const rs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post(`${srv.base}/api/s/${s.id}/unlock`, { password: `guess ${i}` }, { 'x-forwarded-for': '192.0.2.99' })),
    );
    const codes = rs.map((r) => r.status);
    expect(codes.filter((c) => c === 401).length).toBe(5);
    expect(codes.filter((c) => c === 429).length).toBe(15);
  });
});
