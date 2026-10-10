import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReadOnlyStore } from './store.js';

let root: string;
let lib: string;
let seed: string;
const a = randomBytes(1000);
const b = randomBytes(10);
const c = randomBytes(2500);

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fileshare-store-')));
  lib = path.join(root, 'library');
  seed = path.join(root, 'seedlinks', 'S');
  await mkdir(path.join(lib, 'item', 'sub'), { recursive: true });
  await mkdir(seed, { recursive: true });
  await writeFile(path.join(lib, 'item', 'a:b*.bin'), a); // "reserved" chars that fs-chunk-store would strip
  await writeFile(path.join(lib, 'item', 'sub', 'b.bin'), b);
  await writeFile(path.join(lib, 'item', 'c.bin'), c);
  await symlink(path.join(lib, 'item'), path.join(seed, 'torrent name'));
});
afterAll(async () => rm(root, { recursive: true, force: true }));

const files = () => [
  { path: 'torrent name/a:b*.bin', length: 1000 },
  { path: 'torrent name/sub/b.bin', length: 10 },
  { path: 'torrent name/c.bin', length: 2500 },
];
const get = (s: ReadOnlyStore, i: number, o?: { offset?: number; length?: number }) =>
  new Promise<Buffer>((res, rej) => s.get(i, o ?? null, (e, v) => (e ? rej(e) : res(v!))));

describe('ReadOnlyStore', () => {
  it('reads pieces spanning files (through the seedlink)', async () => {
    const s = new ReadOnlyStore(512, { path: seed, files: files(), allowedRoot: lib });
    const all = Buffer.concat([a, b, c]);
    const pieces = Math.ceil(all.length / 512);
    const got: Buffer[] = [];
    for (let i = 0; i < pieces; i++) got.push(await get(s, i));
    expect(Buffer.concat(got).equals(all)).toBe(true);
    expect((await get(s, 1, { offset: 400, length: 100 })).equals(all.subarray(912, 1012))).toBe(true);
    expect(got[pieces - 1]!.length).toBe(all.length % 512 || 512);
    await expect(get(s, pieces)).rejects.toThrow();
    await expect(get(s, 0, { offset: 500, length: 100 })).rejects.toThrow();
    await new Promise((r) => s.close(r as () => void));
  });

  it('refuses writes and never deletes on destroy', async () => {
    const s = new ReadOnlyStore(512, { path: seed, files: files(), allowedRoot: lib });
    await expect(new Promise((res, rej) => s.put(0, Buffer.alloc(512), (e) => (e ? rej(e) : res(null))))).rejects.toThrow(/read-only/);
    await get(s, 0);
    await new Promise((r) => s.destroy(r as () => void));
    expect((await stat(path.join(lib, 'item', 'a:b*.bin'))).size).toBe(1000);
  });

  it('rejects paths escaping the store and files resolving outside the library', async () => {
    expect(() => new ReadOnlyStore(512, { path: seed, files: [{ path: '../../x', length: 1 }], allowedRoot: lib })).toThrow();
    const outside = path.join(root, 'outside.bin');
    await writeFile(outside, Buffer.alloc(10));
    await symlink(outside, path.join(lib, 'item', 'sub', 'evil.bin'));
    const s = new ReadOnlyStore(16, { path: seed, files: [{ path: 'torrent name/sub/evil.bin', length: 10 }], allowedRoot: lib });
    await expect(get(s, 0)).rejects.toThrow(/outside/);
  });

  it('errors if a file changed size on disk', async () => {
    const s = new ReadOnlyStore(512, { path: seed, files: [{ path: 'torrent name/c.bin', length: 2499 }], allowedRoot: lib });
    await expect(get(s, 0)).rejects.toThrow(/changed/);
  });
});
