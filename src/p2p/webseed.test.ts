import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, makeItem, startPublic, waitFor, type MadeItem, type TestEnv } from '../../test/integration/p2p-helpers.js';
import type { P2P } from './index.js';
import { parseRange, parseWebseedPath } from './webseed.js';

describe('parseRange', () => {
  it('parses single ranges', () => {
    expect(parseRange(undefined, 100)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=0-9', 100)).toEqual({ kind: 'range', start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ kind: 'range', start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ kind: 'range', start: 90, end: 99 });
    expect(parseRange('bytes=-1000', 100)).toEqual({ kind: 'range', start: 0, end: 99 });
    expect(parseRange('bytes=50-5000', 100)).toEqual({ kind: 'range', start: 50, end: 99 });
  });
  it('rejects bad / multiple / unsatisfiable ranges', () => {
    for (const h of ['bytes=100-', 'bytes=5-4', 'bytes=0-1,5-6', 'items=0-1', 'bytes=-0', 'bytes=-', 'bytes=a-b', 'bytes=99999999999999999-'])
      expect(parseRange(h, 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-0', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});

describe('parseWebseedPath', () => {
  it('decodes each segment once and rejects traversal', () => {
    expect(parseWebseedPath('/ws/T/a%20b/c.bin?x=1')).toEqual({ token: 'T', segments: ['a b', 'c.bin'] });
    expect(parseWebseedPath('/ws/T/')).toEqual({ token: 'T', segments: [] });
    expect(parseWebseedPath('/ws/T')).toEqual({ token: 'T', segments: [] });
    for (const bad of ['/ws/T/a/../b', '/ws/T/%2e%2e/b', '/ws/T/a%2Fb', '/ws/T/a%5Cb', '/ws/T/a%00b', '/ws/T/a//b', '/ws/T/%E0%A4%A', '/ws/T/.', '/x/T/a'])
      expect(parseWebseedPath(bad)).toBeUndefined();
  });
});

let env: TestEnv;
let srv: Awaited<ReturnType<typeof startPublic>>;
let p2p: P2P;
let item: MadeItem;
let single: MadeItem;
let token: string;
let singleToken: string;
const NAME = 'Fotos 2026 ü+(1)';

/** Send a raw HTTP request (no client-side URL normalisation or encoding). */
function raw(port: number, target: Buffer | string, method = 'GET', headers = ''): Promise<{ status: number; head: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    s.on('data', (c) => chunks.push(c));
    s.on('error', reject);
    s.on('end', () => {
      const all = Buffer.concat(chunks);
      const i = all.indexOf('\r\n\r\n');
      const head = all.subarray(0, i).toString('latin1');
      resolve({ status: Number(head.split(' ')[1]), head, body: all.subarray(i + 4) });
    });
    s.write(Buffer.concat([Buffer.from(`${method} `), Buffer.from(target), Buffer.from(` HTTP/1.1\r\nHost: x\r\nConnection: close\r\n${headers}\r\n`)]));
  });
}

beforeAll(async () => {
  env = await makeEnv();
  srv = await startPublic(env, { webseedIdleMs: 1000 });
  p2p = srv.p2p;
  item = await makeItem(env.ctx, NAME, [
    { rel: 'a.bin', size: 5000 },
    { rel: 'sub dir/ünï €.bin', size: 3000 },
    { rel: 'sub dir/x+y=z&w.bin', size: 100 },
    { rel: 'deep/link.bin', size: 64 },
  ]);
  single = await makeItem(env.ctx, 'single file.bin', [{ rel: 'single file.bin', size: 4096 }], { single: true });
  const s = await p2p.createShare({ itemId: item.id });
  token = p2p.shares.token(p2p.shares.getRow(s.id)!);
  const ss = await p2p.createShare({ itemId: single.id });
  singleToken = p2p.shares.token(p2p.shares.getRow(ss.id)!);
});
afterAll(async () => {
  await srv.close();
  await env.cleanup();
});

const enc = (rel: string) => rel.split('/').map(encodeURIComponent).join('/');
const fileBytes = (rel: string) => item.files.find((f) => f.rel === rel)!.bytes;

describe('webseed', () => {
  it('serves a multi-file item with Range, CORS, no cookies', async () => {
    const url = `${srv.base}/ws/${token}/${enc(NAME)}/a.bin`;
    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(Buffer.from(await full.arrayBuffer()).equals(fileBytes('a.bin'))).toBe(true);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('access-control-allow-origin')).toBe('*');
    expect(full.headers.get('set-cookie')).toBeNull();
    const part = await fetch(url, { headers: { range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/5000');
    expect(part.headers.get('content-length')).toBe('100');
    expect(Buffer.from(await part.arrayBuffer()).equals(fileBytes('a.bin').subarray(100, 200))).toBe(true);
    const bad = await fetch(url, { headers: { range: 'bytes=6000-' } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */5000');
    expect((await fetch(url, { headers: { range: 'bytes=0-1,4-5' } })).status).toBe(416);
  });

  it('HEAD returns headers only; OPTIONS/POST are not served', async () => {
    const url = `${srv.base}/ws/${token}/${enc(NAME)}/a.bin`;
    const h = await fetch(url, { method: 'HEAD' });
    expect(h.status).toBe(200);
    expect(h.headers.get('content-length')).toBe('5000');
    expect((await h.arrayBuffer()).byteLength).toBe(0);
    expect((await fetch(url, { method: 'POST' })).status).toBe(404);
    expect((await fetch(url, { method: 'OPTIONS' })).status).toBe(404);
  });

  it('handles spaces, unicode and URL-special names: encoded, as WebTorrent sends them, and raw UTF-8', async () => {
    for (const rel of ['sub dir/ünï €.bin', 'sub dir/x+y=z&w.bin']) {
      const want = fileBytes(rel);
      const encoded = await fetch(`${srv.base}/ws/${token}/${enc(NAME)}/${enc(rel)}`);
      expect(Buffer.from(await encoded.arrayBuffer()).equals(want)).toBe(true);
      // WebTorrent concatenates without encoding; the WHATWG URL parser then escapes only spaces/non-ASCII.
      const asWebTorrent = new URL(`${srv.base}/ws/${token}/${NAME}/${rel}`).toString();
      const r2 = await fetch(asWebTorrent);
      expect(r2.status).toBe(200);
      expect(Buffer.from(await r2.arrayBuffer()).equals(want)).toBe(true);
      // Raw ASCII specials (+ = & ( )) unencoded on the wire.
      const r3 = await raw(env.ports.public, `/ws/${token}/${enc(NAME).replace(/%2B/g, '+').replace(/%28/g, '(').replace(/%29/g, ')')}/${rel.split('/').map((x) => encodeURIComponent(x).replace(/%2B/g, '+').replace(/%3D/g, '=').replace(/%26/g, '&')).join('/')}`);
      expect(r3.status).toBe(200);
      expect(r3.body.equals(want)).toBe(true);
    }
    // Raw (unescaped) UTF-8 bytes in the request line are rejected by Node's HTTP parser before routing.
    const r4 = await raw(env.ports.public, Buffer.from(`/ws/${token}/${enc(NAME)}/sub%20dir/ünï%20€.bin`, 'utf8'));
    expect(r4.status).toBe(400);
  });

  it('single-file share: url-list as-is (WebTorrent) and with the name (BEP19)', async () => {
    const want = single.files[0]!.bytes;
    for (const u of [`${srv.base}/ws/${singleToken}/`, `${srv.base}/ws/${singleToken}/${enc('single file.bin')}`]) {
      const r = await fetch(u);
      expect(r.status).toBe(200);
      expect(Buffer.from(await r.arrayBuffer()).equals(want)).toBe(true);
    }
    expect((await fetch(`${srv.base}/ws/${singleToken}/other.bin`)).status).toBe(404);
  });

  it('rejects traversal, unknown files, wrong torrent name and bad tokens', async () => {
    const base = `/ws/${token}/${enc(NAME)}`;
    for (const target of [
      `${base}/../${enc(NAME)}/a.bin`,
      `${base}/%2e%2e/%2e%2e/secrets/share-hmac-key`,
      `${base}/..%2f..%2fsecrets%2fshare-hmac-key`,
      `${base}/sub%20dir%2f..%2fa.bin`,
      `${base}/a.bin%00.txt`,
      `${base}/nope.bin`,
      `${base}/sub%20dir`,
      `/ws/${token}/wrong-name/a.bin`,
      `/ws/${token}/..%2f..%2fstate%2ffileshare.db`,
      `/ws/garbage/${enc(NAME)}/a.bin`,
      `/ws/${token.slice(0, -2)}xx/${enc(NAME)}/a.bin`,
      `/ws/${singleToken}/${enc(NAME)}/a.bin`,
    ]) {
      const r = await raw(env.ports.public, target);
      expect([400, 404]).toContain(r.status);
      expect(r.body.toString()).not.toMatch(/[0-9a-f]{64}/);
    }
  });

  it('refuses symlinks inside the library item (file and directory)', async () => {
    const outside = path.join(env.root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.bin'), Buffer.alloc(64, 7)); // same size as the real file
    const victim = path.join(item.dir, 'deep', 'link.bin');
    await rename(victim, victim + '.orig');
    await symlink(path.join(outside, 'secret.bin'), victim);
    expect((await fetch(`${srv.base}/ws/${token}/${enc(NAME)}/deep/link.bin`)).status).toBe(404);
    // Directory component as a symlink.
    await rename(path.join(item.dir, 'deep'), path.join(outside, 'deep'));
    await symlink(path.join(outside, 'deep'), path.join(item.dir, 'deep'));
    expect((await fetch(`${srv.base}/ws/${token}/${enc(NAME)}/deep/link.bin`)).status).toBe(404);
  });

  it('counts bytes into share stats and stops on revoke', async () => {
    const s = await p2p.createShare({ itemId: item.id });
    const t = p2p.shares.token(p2p.shares.getRow(s.id)!);
    const url = `${srv.base}/ws/${t}/${enc(NAME)}/a.bin`;
    await (await fetch(url)).arrayBuffer();
    p2p.stats.flush();
    await waitFor(() => p2p.getShare(s.id)!.stats.serverBytesWebseed === 5000);
    await p2p.revokeShare(s.id);
    expect((await fetch(url)).status).toBe(404);
  });

  it('a client disconnect mid-transfer frees the stream', async () => {
    const big = await makeItem(env.ctx, 'slow', [{ rel: 'big.bin', size: 2 * 1024 * 1024 }]);
    const s = await p2p.createShare({ itemId: big.id });
    const t = p2p.shares.token(p2p.shares.getRow(s.id)!);
    p2p.limiter.setRate(64 * 1024);
    try {
      const ac = new AbortController();
      const r = await fetch(`${srv.base}/ws/${t}/slow/big.bin`, { signal: ac.signal });
      const reader = r.body!.getReader();
      await reader.read();
      ac.abort();
      await new Promise((res) => setTimeout(res, 500));
      p2p.stats.flush();
      const sent = p2p.getShare(s.id)!.stats.serverBytesWebseed;
      await new Promise((res) => setTimeout(res, 1000));
      p2p.stats.flush();
      expect(p2p.getShare(s.id)!.stats.serverBytesWebseed).toBe(sent);
      expect(sent).toBeLessThan(512 * 1024);
    } finally {
      p2p.limiter.setRate(Number.POSITIVE_INFINITY);
    }
  });

  it('drops a stalled reader (no progress) after the idle timeout', async () => {
    const big = await makeItem(env.ctx, 'stall', [{ rel: 'big.bin', size: 24 * 1024 * 1024 }], { pieceLength: 1024 * 1024 });
    const s = await p2p.createShare({ itemId: big.id });
    const t = p2p.shares.token(p2p.shares.getRow(s.id)!);
    const conns = () => new Promise<number>((res) => srv.app.server.getConnections((_e, n) => res(n)));
    const before = await conns();
    const sock = net.connect(env.ports.public, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    sock.write(`GET /ws/${t}/stall/big.bin HTTP/1.1\r\nHost: x\r\n\r\n`);
    sock.pause(); // never read: the server hits backpressure
    sock.on('error', () => {});
    await waitFor(async () => (await conns()) > before, 2000);
    await waitFor(async () => (await conns()) === before, 6000);
    sock.destroy();
  });
});
