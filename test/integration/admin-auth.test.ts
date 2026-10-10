// Access JWT guard + CSRF checks on the admin listener (docs/ARCHITECTURE.md §7.2).
import { generateKeyPair } from 'jose';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ADMIN_ORIGIN, AUD, type Harness, type Jwks, signToken, startAdmin, startJwks } from './admin-helpers.js';

let jwks: Jwks;
let h: Harness;

beforeAll(async () => {
  jwks = await startJwks();
  h = await startAdmin({ CF_ACCESS_CERTS_URL: jwks.url });
});
afterAll(async () => {
  await h?.close();
  await jwks?.close();
});

const H = 'cf-access-jwt-assertion';

describe('Access JWT guard', () => {
  it('lets /healthz through without a JWT', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it('accepts a valid token', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/api/admin/items', headers: { [H]: await signToken(jwks) } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it('rejects a missing token with 403 JSON', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/api/admin/items' });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'forbidden' });
  });

  it('rejects HTML navigation with a plain 403 page and still sets security headers', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    expect(r.statusCode).toBe(403);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('serves the dashboard shell with a valid token', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/', headers: { [H]: await signToken(jwks), accept: 'text/html' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<div id="app">');
  });

  it.each([
    ['expired', { expSecondsFromNow: -120 }],
    ['wrong audience', { aud: 'some-other-aud' }],
    ['wrong issuer', { iss: 'https://evil.example.test' }],
  ])('rejects a token with %s', async (_label, opts) => {
    const r = await h.app.inject({ method: 'GET', url: '/api/admin/items', headers: { [H]: await signToken(jwks, opts) } });
    expect(r.statusCode).toBe(403);
  });

  it('accepts a token that expired within the 60 s clock tolerance', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/api/admin/items', headers: { [H]: await signToken(jwks, { expSecondsFromNow: -20 }) } });
    expect(r.statusCode).toBe(200);
  });

  it('rejects a token signed by a different key (same kid)', async () => {
    const other = await generateKeyPair('RS256');
    const r = await h.app.inject({ method: 'GET', url: '/api/admin/items', headers: { [H]: await signToken(jwks, { key: other.privateKey }) } });
    expect(r.statusCode).toBe(403);
  });

  it('rejects garbage and alg=none style tokens', async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(`{"aud":"${AUD}"}`).toString('base64url')}.`;
    for (const t of ['garbage', none, 'a'.repeat(20000)]) {
      const r = await h.app.inject({ method: 'GET', url: '/api/admin/items', headers: { [H]: t } });
      expect(r.statusCode).toBe(403);
    }
  });

  it('guards routes registered by ingest (tus) too', async () => {
    const r = await h.app.inject({ method: 'POST', url: '/api/admin/uploads/tus/', headers: { origin: ADMIN_ORIGIN } });
    expect(r.statusCode).toBe(403);
  });
});

describe('CSRF checks', () => {
  it('rejects a mutating request with a wrong Origin', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/admin/snapshots',
      headers: { [H]: await signToken(jwks), origin: 'https://evil.example.test', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(r.statusCode).toBe(403);
  });

  it('rejects a mutating request without an Origin', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/admin/snapshots',
      headers: { [H]: await signToken(jwks), 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(r.statusCode).toBe(403);
  });

  it('rejects a non-JSON body with 415', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/admin/snapshots',
      headers: { [H]: await signToken(jwks), origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1',
    });
    expect(r.statusCode).toBe(415);
  });

  it('accepts JSON with the right Origin', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/admin/snapshots',
      headers: { [H]: await signToken(jwks), origin: ADMIN_ORIGIN, 'content-type': 'application/json; charset=utf-8' },
      payload: '{}',
    });
    expect(r.statusCode).toBe(202);
  });

  it('exempts tus paths from the JSON requirement (but not from Origin)', async () => {
    const tok = await signToken(jwks);
    const ok = await h.app.inject({
      method: 'PATCH',
      url: '/api/admin/uploads/tus/abc',
      headers: { [H]: tok, origin: ADMIN_ORIGIN, 'content-type': 'application/offset+octet-stream' },
      payload: Buffer.from('synthetic'),
    });
    expect(ok.statusCode).toBe(204);
    const bad = await h.app.inject({
      method: 'PATCH',
      url: '/api/admin/uploads/tus/abc',
      headers: { [H]: tok, origin: 'https://evil.example.test', 'content-type': 'application/offset+octet-stream' },
      payload: Buffer.from('synthetic'),
    });
    expect(bad.statusCode).toBe(403);
  });
});

describe('admin live WebSocket', () => {
  let base: string;
  beforeAll(async () => {
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    base = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}/api/admin/live`;
  });

  function connect(headers: Record<string, string>): Promise<{ status?: number; msg?: unknown }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(base, { headers });
      ws.on('unexpected-response', (_req, res) => {
        resolve({ status: res.statusCode });
        ws.terminate();
      });
      ws.on('message', (data) => {
        resolve({ msg: JSON.parse(String(data)) });
        ws.close();
      });
      ws.on('error', (e) => reject(e));
    });
  }

  it('rejects an upgrade without a JWT', async () => {
    expect((await connect({ origin: ADMIN_ORIGIN })).status).toBe(403);
  });

  it('rejects an upgrade from a foreign Origin', async () => {
    expect((await connect({ origin: 'https://evil.example.test', [H]: await signToken(jwks) })).status).toBe(403);
  });

  it('streams AdminLiveMsg with a valid JWT', async () => {
    h.p2p.swarms = { shareA: { peers: [], totals: { peers: 1, serverBytes: 5, peerBytes: 7, completed: 0 } } };
    const r = await connect({ origin: ADMIN_ORIGIN, [H]: await signToken(jwks) });
    expect(r.msg).toMatchObject({ t: 'live', upload: { currentBps: 12_345 }, shares: { shareA: { totals: { peers: 1 } } }, items: [] });
  });
});

describe('fail closed', () => {
  it('refuses everything when Access is not configured', async () => {
    const h2 = await startAdmin({ CF_ACCESS_CERTS_URL: jwks.url, CF_ACCESS_AUD: '' });
    try {
      const r = await h2.app.inject({ method: 'GET', url: '/api/admin/items', headers: { [H]: await signToken(jwks) } });
      expect(r.statusCode).toBe(403);
      expect((await h2.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    } finally {
      await h2.close();
    }
  });

  it('enforces ADMIN_EMAILS', async () => {
    const h2 = await startAdmin({ CF_ACCESS_CERTS_URL: jwks.url, ADMIN_EMAILS: 'Owner@Example.test, second@example.test' });
    try {
      const ok = await h2.app.inject({ method: 'GET', url: '/api/admin/items', headers: { [H]: await signToken(jwks, { email: 'owner@example.test' }) } });
      expect(ok.statusCode).toBe(200);
      const no = await h2.app.inject({ method: 'GET', url: '/api/admin/items', headers: { [H]: await signToken(jwks, { email: 'intruder@example.test' }) } });
      expect(no.statusCode).toBe(403);
    } finally {
      await h2.close();
    }
  });
});
