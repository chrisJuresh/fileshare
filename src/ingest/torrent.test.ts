import bencodePkg from 'bencode';
import createTorrent from 'create-torrent';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bdecode, bencode, buildInfoDict, HashAbortedError, hashPieces, MiB, pieceLengthFor, renameInfoDict } from './torrent.js';
import { scanTree } from './tree.js';

const sha1 = (b: Uint8Array): Buffer => createHash('sha1').update(b).digest();

/** Reference: concat all file data, split into pieces, SHA-1 each. */
function referencePieces(datas: Buffer[], pieceLength: number): Buffer {
  const all = Buffer.concat(datas);
  const out: Buffer[] = [];
  for (let i = 0; i < all.length; i += pieceLength) out.push(sha1(all.subarray(i, i + pieceLength)));
  return Buffer.concat(out);
}

/** create-torrent with in-memory inputs; returns its bencoded info dict. */
function createTorrentInfo(inputs: Buffer[] | Buffer, opts: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    createTorrent(inputs, { announceList: [], private: true, filterJunkFiles: false, ...opts }, (err: Error | null, t: Uint8Array) => {
      if (err) return reject(err);
      const decoded = bencodePkg.decode(t);
      expect(decoded.announce).toBeUndefined();
      expect(decoded['url-list']).toBeUndefined();
      resolve(Buffer.from(bencodePkg.encode(decoded.info)));
    });
  });
}

async function buildFromDisk(entry: string, name: string, onProgress?: (p: number) => void) {
  const scan = await scanTree(entry);
  const total = scan.files.reduce((s, f) => s + f.size, 0);
  const pieceLength = pieceLengthFor(total);
  const { pieces, totalBytes } = await hashPieces(
    scan.files.map((f) => ({ path: scan.kind === 'file' ? entry : path.join(entry, ...f.segs), size: f.size, mtimeMs: f.mtimeMs })),
    pieceLength,
    onProgress,
  );
  const info = buildInfoDict({ name, kind: scan.kind as 'file' | 'dir', files: scan.files.map((f) => ({ segs: f.segs, length: f.size })), pieceLength, pieces });
  return { scan, info, pieces, totalBytes, pieceLength };
}

describe('torrent info', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ingest-torrent-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('chooses piece length by size', () => {
    expect(pieceLengthFor(1)).toBe(MiB);
    expect(pieceLengthFor(64 * MiB)).toBe(MiB);
    expect(pieceLengthFor(64 * MiB + 1)).toBe(4 * MiB);
    expect(pieceLengthFor(10e9)).toBe(4 * MiB);
  });

  it('bencode matches the bencode package and round-trips', () => {
    const v = { b: 1, a: [Buffer.from('xy'), 'zé', -3], 'piece length': 1024, nested: { z: Buffer.alloc(0) } };
    const ours = bencode(v);
    expect(ours.equals(Buffer.from(bencodePkg.encode(v)))).toBe(true);
    expect(bencode(bdecode(ours)).equals(ours)).toBe(true);
    expect(() => bdecode(Buffer.from('d1:ai1e'))).toThrow();
  });

  it('multi-file item: pieces match an independent SHA-1 and create-torrent byte-for-byte (hidden/junk files kept)', async () => {
    const e = path.join(dir, 'Album');
    mkdirSync(path.join(e, 'sub'), { recursive: true });
    const files: [string, Buffer][] = [
      ['.DS_Store', randomBytes(100)],
      ['Thumbs.db', randomBytes(50)],
      ['a.bin', randomBytes(MiB + 12345)],
      ['empty.bin', Buffer.alloc(0)],
      ['sub/c.bin', randomBytes(3 * MiB + 7)],
    ];
    for (const [rel, data] of files) writeFileSync(path.join(e, rel), data);
    const progress: number[] = [];
    const { scan, info, pieces, totalBytes } = await buildFromDisk(e, 'Album', (p) => progress.push(p));
    expect(scan.files.map((f) => f.rel)).toEqual(files.map(([r]) => r));
    expect(totalBytes).toBe(files.reduce((s, [, d]) => s + d.length, 0));
    expect(Buffer.from(pieces).equals(referencePieces(files.map(([, d]) => d), MiB))).toBe(true);
    expect(progress.at(-1)).toBe(1);

    const d = bencodePkg.decode(info);
    expect(Buffer.from(d.name).toString()).toBe('Album');
    expect(d.private).toBe(1);
    expect(d['piece length']).toBe(MiB);
    expect(d.source).toBeUndefined();
    expect(d.files).toHaveLength(5); // file_count consistent with info dict
    expect(d.files.map((f: { path: Uint8Array[] }) => f.path.map((p) => Buffer.from(p).toString()).join('/'))).toEqual(files.map(([r]) => r));

  });

  it('is byte-identical to create-torrent (announceList: [], private, same piece length; hidden/junk kept)', async () => {
    // No empty file here: create-torrent 6.1.3 hashes the final piece wrongly when an empty
    // in-memory file sits between others (checked against the reference above).
    const e = path.join(dir, 'Album');
    mkdirSync(path.join(e, 'sub'), { recursive: true });
    const files: [string, Buffer][] = [
      ['.DS_Store', randomBytes(100)],
      ['Thumbs.db', randomBytes(50)],
      ['a.bin', randomBytes(MiB + 12345)],
      ['sub/c.bin', randomBytes(3 * MiB + 7)],
    ];
    for (const [rel, data] of files) writeFileSync(path.join(e, rel), data);
    const { info } = await buildFromDisk(e, 'Album');
    const inputs = files.map(([rel, data]) => Object.assign(Buffer.from(data), { name: `Album/${rel}` }));
    const ref = await createTorrentInfo(inputs, { name: 'Album', pieceLength: MiB });
    expect(info.equals(ref)).toBe(true);
    expect(sha1(info).toString('hex')).toBe(sha1(ref).toString('hex')); // same infohash
  });

  it('single-file item matches create-torrent; a folder with one file stays multi-file', async () => {
    const data = randomBytes(2 * MiB + 1);
    const f = path.join(dir, 'movie.bin');
    writeFileSync(f, data);
    const { info } = await buildFromDisk(f, 'movie.bin');
    const ref = await createTorrentInfo(Object.assign(Buffer.from(data), { name: 'movie.bin' }), { name: 'movie.bin', pieceLength: MiB });
    expect(info.equals(ref)).toBe(true);
    expect(bencodePkg.decode(info).length).toBe(data.length);

    const e = path.join(dir, 'Solo');
    mkdirSync(e);
    writeFileSync(path.join(e, 'only.bin'), data);
    const solo = bencodePkg.decode((await buildFromDisk(e, 'Solo')).info);
    expect(solo.length).toBeUndefined();
    expect(solo.files).toHaveLength(1);
  });

  it('uses 4 MiB pieces above 64 MiB', async () => {
    const f = path.join(dir, 'big.bin');
    const data = randomBytes(64 * MiB + 100);
    writeFileSync(f, data);
    const { info, pieceLength } = await buildFromDisk(f, 'big.bin');
    expect(pieceLength).toBe(4 * MiB);
    const d = bencodePkg.decode(info);
    expect(d.pieces.length / 20).toBe(Math.ceil(data.length / (4 * MiB)));
    expect(Buffer.from(d.pieces).equals(referencePieces([data], 4 * MiB))).toBe(true);
  });

  it('fails if a file changes between scan and hash, and can be aborted', async () => {
    const f = path.join(dir, 'x.bin');
    writeFileSync(f, randomBytes(1000));
    const st = statSync(f);
    utimesSync(f, new Date(2001, 1, 1), new Date(2001, 1, 1));
    await expect(hashPieces([{ path: f, size: st.size, mtimeMs: st.mtimeMs }], MiB)).rejects.toThrow(/changed/);
    await expect(hashPieces([{ path: path.join(dir, 'missing'), size: 1, mtimeMs: 0 }], MiB)).rejects.toThrow('I/O error while hashing (ENOENT)');
    const ctl = new AbortController();
    const st2 = statSync(f);
    const p = hashPieces([{ path: f, size: st2.size, mtimeMs: st2.mtimeMs }], MiB, undefined, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toBeInstanceOf(HashAbortedError);
  });

  it('renameInfoDict changes only the name', async () => {
    const f = path.join(dir, 'r.bin');
    writeFileSync(f, randomBytes(5000));
    const { info } = await buildFromDisk(f, 'r.bin');
    const renamed = bencodePkg.decode(renameInfoDict(info, 'New name ✓'));
    const orig = bencodePkg.decode(info);
    expect(Buffer.from(renamed.name).toString()).toBe('New name ✓');
    expect(Buffer.from(renamed.pieces).equals(Buffer.from(orig.pieces))).toBe(true);
    expect(renamed.length).toBe(orig.length);
    expect(readFileSync(f).length).toBe(5000);
  });
});
