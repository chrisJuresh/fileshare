import { createHash } from 'node:crypto';
// @ts-ignore untyped
import parseTorrent from 'parse-torrent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, makeItem, type MadeItem, type TestEnv } from '../../test/integration/p2p-helpers.js';
import {
  buildMagnet,
  buildShareInfo,
  buildTorrentFile,
  infoHashOf,
  parseInfo,
  shareUrls,
  torrentContentDisposition,
} from './metainfo.js';
import { bencode } from './vendor.js';

let env: TestEnv;
let multi: MadeItem;
let single: MadeItem;

beforeAll(async () => {
  env = await makeEnv({ PUBLIC_BASE_URL: 'https://files.example.test' });
  multi = await makeItem(env.ctx, 'Folder ü', [
    { rel: 'one.bin', size: 40_000 },
    { rel: 'deep/two words.bin', size: 70_001 },
  ]);
  single = await makeItem(env.ctx, 'solo file.bin', [{ rel: 'solo file.bin', size: 50_000 }], { single: true });
});
afterAll(async () => env.cleanup());

describe('share info', () => {
  it('adds source, keeps pieces, gives a distinct infohash per share', async () => {
    const a = buildShareInfo(multi.info, multi.name, 'AAAAAAAAAAAAAAAAAAAAAA');
    const b = buildShareInfo(multi.info, multi.name, 'BBBBBBBBBBBBBBBBBBBBBB');
    expect(a.infoHash).not.toBe(b.infoHash);
    expect(a.infoHash).toBe(createHash('sha1').update(a.info).digest('hex'));
    const d = bencode.decode(a.info) as Record<string, any>;
    const orig = bencode.decode(multi.info) as Record<string, any>;
    expect(Buffer.from(d.source).toString()).toBe('fileshare-AAAAAAAAAAAAAAAAAAAAAA');
    expect(d.private).toBe(1);
    expect(Buffer.from(d.pieces).equals(Buffer.from(orig.pieces))).toBe(true);
    expect(a.name).toBe('Folder ü');
  });

  it('infohash matches parse-torrent / WebTorrent parsing of the .torrent', async () => {
    const s = buildShareInfo(multi.info, multi.name, 'AAAAAAAAAAAAAAAAAAAAAA');
    const urls = shareUrls(env.ctx.config, 'AAAAAAAAAAAAAAAAAAAAAA', 'tok.1.mac');
    const t = await parseTorrent(buildTorrentFile(s.info, urls));
    expect(t.infoHash).toBe(s.infoHash);
    expect(t.private).toBe(true);
    expect(t.name).toBe('Folder ü');
    expect(t.files.map((f: { path: string }) => f.path.split(/[\\/]/).slice(1).join('/')).sort()).toEqual(['deep/two words.bin', 'one.bin']);
  });

  it('re-uses the item name (rename → new shares get the new name)', () => {
    const s = buildShareInfo(multi.info, 'Renamed', 'AAAAAAAAAAAAAAAAAAAAAA');
    expect(parseInfo(s.info).name).toBe('Renamed');
  });

  it('parses single and multi-file info', () => {
    const m = parseInfo(multi.info);
    expect(m.single).toBe(false);
    expect([...m.files].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'deep/two words.bin', length: 70_001 },
      { path: 'one.bin', length: 40_000 },
    ]);
    expect(m.totalBytes).toBe(110_001);
    const s = parseInfo(single.info);
    expect(s).toMatchObject({ single: true, name: 'solo file.bin', totalBytes: 50_000, files: [{ path: 'solo file.bin', length: 50_000 }] });
  });

  it('rejects traversal in info paths', () => {
    const d = bencode.decode(multi.info) as Record<string, any>;
    d.files[0].path = [Buffer.from('..'), Buffer.from('etc')];
    expect(() => parseInfo(bencode.encode(d))).toThrow();
    const e = bencode.decode(multi.info) as Record<string, any>;
    e.files[0].path = [Buffer.from('a/b')];
    expect(() => parseInfo(bencode.encode(e))).toThrow();
  });
});

describe('.torrent and magnet', () => {
  const id = 'AAAAAAAAAAAAAAAAAAAAAA';
  const token = `${id}.1.abcdefghijklmnopqrstuv`;

  it('.torrent: https announce, announce-list [[https],[wss]], url-list webseed, no nodes, private', async () => {
    const s = buildShareInfo(multi.info, multi.name, id);
    const buf = buildTorrentFile(s.info, shareUrls(env.ctx.config, id, token));
    const top = bencode.decode(buf) as Record<string, any>;
    const str = (v: Uint8Array) => Buffer.from(v).toString();
    expect(str(top.announce)).toBe(`https://files.example.test/tr/${token}/announce`);
    expect(top['announce-list'].map((t: Uint8Array[]) => t.map(str))).toEqual([
      [`https://files.example.test/tr/${token}/announce`],
      [`wss://files.example.test/tr/${token}`],
    ]);
    expect(top['url-list'].map(str)).toEqual([`https://files.example.test/ws/${token}/`]);
    expect(top.nodes).toBeUndefined();
    expect(Object.keys(top).sort()).toEqual(['announce', 'announce-list', 'info', 'url-list']);
    expect(top.info.private).toBe(1);
    expect(infoHashOf(bencode.encode(top.info))).toBe(s.infoHash);
  });

  it('magnet: xt, dn, both trackers, webseed, no x.pe', async () => {
    const s = buildShareInfo(multi.info, multi.name, id);
    const m = buildMagnet(s.infoHash, s.name, shareUrls(env.ctx.config, id, token));
    const u = new URL(m);
    expect(u.searchParams.get('xt')).toBe(`urn:btih:${s.infoHash}`);
    expect(u.searchParams.get('dn')).toBe('Folder ü');
    expect(u.searchParams.getAll('tr')).toEqual([`https://files.example.test/tr/${token}/announce`, `wss://files.example.test/tr/${token}`]);
    expect(u.searchParams.get('ws')).toBe(`https://files.example.test/ws/${token}/`);
    expect(u.searchParams.has('x.pe')).toBe(false);
    const parsed = await parseTorrent(m);
    expect(parsed.infoHash).toBe(s.infoHash);
  });

  it('URLs come only from PUBLIC_BASE_URL', () => {
    const u = shareUrls(env.ctx.config, id, token);
    for (const v of Object.values(u)) expect(v).toMatch(/^(https|wss):\/\/files\.example\.test\//);
  });

  it('content-disposition is safe', () => {
    const cd = torrentContentDisposition('evil"\r\nX: y/../ü');
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).toMatch(/^attachment; filename="[^"]*\.torrent"; filename\*=UTF-8''/);
    expect(cd).toContain('%C3%BC');
  });
});
