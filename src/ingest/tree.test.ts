import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fingerprint, isSyncthingTmp, scanTree } from './tree.js';

describe('scanTree / fingerprint', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ingest-tree-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists every regular file (hidden too), sorted, and counts Syncthing temp files', async () => {
    const e = path.join(dir, 'Album');
    mkdirSync(path.join(e, 'sub', 'deeper'), { recursive: true });
    writeFileSync(path.join(e, 'b.bin'), randomBytes(10));
    writeFileSync(path.join(e, '.DS_Store'), randomBytes(3));
    writeFileSync(path.join(e, 'sub', 'a.bin'), randomBytes(5));
    writeFileSync(path.join(e, 'sub', 'deeper', 'z.bin'), randomBytes(0));
    writeFileSync(path.join(e, 'sub', '.syncthing.c.bin.tmp'), randomBytes(7));
    writeFileSync(path.join(e, '~syncthing~d.bin.tmp'), randomBytes(7));
    symlinkSync('/etc/hostname', path.join(e, 'link'));
    const s = await scanTree(e);
    expect(s.kind).toBe('dir');
    expect(s.files.map((f) => f.rel)).toEqual(['.DS_Store', 'b.bin', 'sub/a.bin', 'sub/deeper/z.bin']);
    expect(s.files[2]!.segs).toEqual(['sub', 'a.bin']);
    expect(s.dirs).toEqual(['sub', 'sub/deeper']);
    expect(s.tmpCount).toBe(2);
    expect(s.special).toEqual(['link']);
  });

  it('handles single files and missing entries', async () => {
    const f = path.join(dir, 'one.bin');
    writeFileSync(f, randomBytes(100));
    const s = await scanTree(f);
    expect(s.kind).toBe('file');
    expect(s.files).toHaveLength(1);
    expect(s.files[0]!.size).toBe(100);
    expect((await scanTree(path.join(dir, 'nope'))).kind).toBe('missing');
  });

  it('fingerprint changes with size, mtime, new files and temp files only', async () => {
    const e = path.join(dir, 'E');
    mkdirSync(e);
    const f = path.join(e, 'grow.bin');
    writeFileSync(f, randomBytes(1000));
    const fp1 = fingerprint(await scanTree(e));
    expect(fingerprint(await scanTree(e))).toBe(fp1); // stable when nothing changes
    appendFileSync(f, randomBytes(10)); // a file still being written
    const fp2 = fingerprint(await scanTree(e));
    expect(fp2).not.toBe(fp1);
    utimesSync(f, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const fp3 = fingerprint(await scanTree(e));
    expect(fp3).not.toBe(fp2);
    writeFileSync(path.join(e, '.syncthing.x.tmp'), 'x');
    const fp4 = fingerprint(await scanTree(e));
    expect(fp4).not.toBe(fp3);
    writeFileSync(path.join(e, 'new.bin'), 'y');
    expect(fingerprint(await scanTree(e))).not.toBe(fp4);
  });

  it('recognises Syncthing temp names', () => {
    expect(isSyncthingTmp('.syncthing.movie.mkv.tmp')).toBe(true);
    expect(isSyncthingTmp('~syncthing~movie.mkv.tmp')).toBe(true);
    expect(isSyncthingTmp('.syncthing')).toBe(false);
    expect(isSyncthingTmp('movie.tmp')).toBe(false);
  });
});
