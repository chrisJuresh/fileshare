// Appending files to a folder torrent (§4 "add files"): the result must equal a from-scratch hash
// of old data + BEP 47 zero pad + new data, and keep every old full piece.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseInfo } from '../p2p/metainfo.js';
import { bdecode, buildAppendedInfo, buildInfoDict, hashPieces, planAppend, tailRanges, type BValue, type HashSource } from './torrent.js';

const PL = 16 * 1024; // small piece length keeps the test data small
const sha1 = (b: Uint8Array): Buffer => createHash('sha1').update(b).digest();

function referencePieces(all: Buffer, pieceLength: number): Buffer {
  const out: Buffer[] = [];
  for (let i = 0; i < all.length; i += pieceLength) out.push(sha1(all.subarray(i, i + pieceLength)));
  return Buffer.concat(out);
}

type Dict = Record<string, BValue>;
const dictOf = (info: Uint8Array): Dict => bdecode(info) as Dict;

describe('append to a folder torrent', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ingest-append-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const put = (rel: string, data: Buffer): { path: string; size: number; mtimeMs: number } => {
    const p = path.join(dir, ...rel.split('/'));
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, data);
    const st = statSync(p);
    return { path: p, size: st.size, mtimeMs: st.mtimeMs };
  };

  /** The info an existing item has: `files` hashed in order, no pads. */
  async function initialInfo(files: [string, Buffer][]): Promise<Buffer> {
    const srcs = files.map(([rel, d]) => put(rel, d));
    const { pieces } = await hashPieces(srcs, PL);
    return buildInfoDict({ name: 'Item', kind: 'dir', files: files.map(([rel, d]) => ({ segs: rel.split('/'), length: d.length })), pieceLength: PL, pieces });
  }

  /** What ingest does: hash tail + pad + new files, keep the old full pieces. */
  async function append(info: Uint8Array, added: [string, Buffer][]): Promise<Buffer> {
    const plan = planAppend(info);
    const sources: HashSource[] = tailRanges(plan).map((t) => {
      const p = path.join(dir, ...t.segs);
      const st = statSync(p);
      return { path: p, size: st.size, mtimeMs: st.mtimeMs, start: t.start, length: t.length };
    });
    if (plan.padLength > 0) sources.push({ zeros: plan.padLength });
    for (const [rel, d] of added) sources.push(put(rel, d));
    const { pieces } = await hashPieces(sources, plan.pieceLength);
    const all = Buffer.concat([plan.keptPieces, pieces]);
    return buildAppendedInfo(info, plan.padLength, added.map(([rel, d]) => ({ segs: rel.split('/'), length: d.length })), all);
  }

  it('pads the old partial piece and hashes like a from-scratch torrent', async () => {
    const a = randomBytes(PL * 2 + 100);
    const b = randomBytes(PL - 30); // a + b end 70 bytes into piece 3
    const c = randomBytes(PL * 3 + 5);
    const old = await initialInfo([
      ['a.bin', a],
      ['sub/b.bin', b],
    ]);
    const plan = planAppend(old);
    expect(plan.tailStart).toBe(PL * 3);
    expect(plan.padLength).toBe(PL - 70);
    expect(tailRanges(plan)).toEqual([{ segs: ['sub', 'b.bin'], size: b.length, start: b.length - 70, length: 70 }]);

    const next = await append(old, [['0-new.bin', c]]); // sorts first by name, still goes last
    const ref = referencePieces(Buffer.concat([a, b, Buffer.alloc(plan.padLength), c]), PL);
    const d = dictOf(next);
    expect(Buffer.from(d.pieces as Uint8Array).equals(ref)).toBe(true);
    // every old full piece is unchanged
    const oldPieces = dictOf(old).pieces as Uint8Array;
    expect(Buffer.from(ref.subarray(0, 3 * 20)).equals(Buffer.from(oldPieces.subarray(0, 3 * 20)))).toBe(true);

    const parsed = parseInfo(next);
    expect(parsed.files).toEqual([
      { path: 'a.bin', length: a.length },
      { path: 'sub/b.bin', length: b.length },
      { path: '0-new.bin', length: c.length },
    ]);
    expect(parsed.layout.map((f) => [f.path, f.pad])).toEqual([
      ['a.bin', false],
      ['sub/b.bin', false],
      [`.pad/${plan.padLength}`, true],
      ['0-new.bin', false],
    ]);
    expect(parsed.totalBytes).toBe(a.length + b.length + c.length);
    // name, piece length and private flag are kept
    expect(Buffer.from(d.name as Uint8Array).toString()).toBe('Item');
    expect(d['piece length']).toBe(PL);
    expect(d.private).toBe(1);
  });

  it('needs no pad when the old data ends on a piece boundary', async () => {
    const a = randomBytes(PL * 2);
    const c = randomBytes(10);
    const old = await initialInfo([['a.bin', a]]);
    const plan = planAppend(old);
    expect(plan.padLength).toBe(0);
    expect(tailRanges(plan)).toEqual([]);
    const next = await append(old, [['c.bin', c]]);
    expect(Buffer.from(dictOf(next).pieces as Uint8Array).equals(referencePieces(Buffer.concat([a, c]), PL))).toBe(true);
    expect(parseInfo(next).layout.some((f) => f.pad)).toBe(false);
  });

  it('appends again after an earlier append (pads stay in place)', async () => {
    const a = randomBytes(PL + 1);
    const b = randomBytes(500);
    const c = randomBytes(PL * 2 + 7);
    const once = await append(await initialInfo([['a.bin', a]]), [['b.bin', b]]);
    const pad1 = PL - 1;
    const twice = await append(once, [['more/c.bin', c]]);
    const pad2 = PL - 500;
    const ref = referencePieces(Buffer.concat([a, Buffer.alloc(pad1), b, Buffer.alloc(pad2), c]), PL);
    expect(Buffer.from(dictOf(twice).pieces as Uint8Array).equals(ref)).toBe(true);
    expect(parseInfo(twice).layout.filter((f) => f.pad).map((f) => f.length)).toEqual([pad1, pad2]);
    expect(parseInfo(twice).files.map((f) => f.path)).toEqual(['a.bin', 'b.bin', 'more/c.bin']);
  });

  it('spans the tail over several small files', async () => {
    const a = randomBytes(PL + 10);
    const b = randomBytes(20);
    const e = Buffer.alloc(0);
    const f = randomBytes(30);
    const old = await initialInfo([
      ['a', a],
      ['b', b],
      ['e', e],
      ['f', f],
    ]);
    const plan = planAppend(old);
    expect(tailRanges(plan).map((t) => [t.segs.join('/'), t.start, t.length])).toEqual([
      ['a', PL, 10],
      ['b', 0, 20],
      ['f', 0, 30],
    ]);
    const g = randomBytes(PL);
    const next = await append(old, [['g', g]]);
    const ref = referencePieces(Buffer.concat([a, b, f, Buffer.alloc(plan.padLength), g]), PL);
    expect(Buffer.from(dictOf(next).pieces as Uint8Array).equals(ref)).toBe(true);
  });

  it('refuses single-file torrents and inconsistent infos', async () => {
    const p = put('one.bin', randomBytes(100));
    const { pieces } = await hashPieces([p], PL);
    const single = buildInfoDict({ name: 'one.bin', kind: 'file', files: [{ segs: [], length: 100 }], pieceLength: PL, pieces });
    expect(() => planAppend(single)).toThrow(/folder/);
    const broken = buildInfoDict({ name: 'x', kind: 'dir', files: [{ segs: ['a'], length: PL * 3 }], pieceLength: PL, pieces });
    expect(() => planAppend(broken)).toThrow(/piece count/);
  });

  it('hashes file ranges and zero runs in the worker', async () => {
    const data = randomBytes(5000);
    const src = put('r.bin', data);
    const { pieces, totalBytes } = await hashPieces([{ ...src, start: 1000, length: 3000 }, { zeros: 1096 }], 4096);
    expect(totalBytes).toBe(4096);
    expect(Buffer.from(pieces).equals(sha1(Buffer.concat([data.subarray(1000, 4000), Buffer.alloc(1096)])))).toBe(true);
    await expect(hashPieces([{ ...src, start: 4000, length: 2000 }], 4096)).rejects.toThrow(/range/);
  });
});
