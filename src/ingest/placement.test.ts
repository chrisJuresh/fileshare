import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareLinked, hardlinkTree, PlacementError, removeVerifiedOutboxEntry } from './placement.js';
import { scanTree } from './tree.js';

describe('placement', () => {
  let root: string;
  let outbox: string;
  let library: string;
  let trash: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'ingest-place-'));
    outbox = path.join(root, 'outbox');
    library = path.join(root, 'library');
    trash = path.join(root, '.ingest-trash');
    mkdirSync(outbox);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function makeAlbum(): string {
    const e = path.join(outbox, 'Album');
    mkdirSync(path.join(e, 'sub', 'empty'), { recursive: true });
    writeFileSync(path.join(e, 'a.bin'), randomBytes(2048));
    writeFileSync(path.join(e, 'sub', 'b.bin'), randomBytes(10));
    writeFileSync(path.join(e, '.hidden'), randomBytes(1));
    return e;
  }

  it('hard-links a tree: same inodes, dirs 0750, idempotent', async () => {
    const src = makeAlbum();
    const dst = path.join(library, 'Album');
    const scan = await scanTree(src);
    await hardlinkTree(src, dst, scan);
    for (const f of scan.files) {
      const a = statSync(path.join(src, ...f.segs));
      const b = statSync(path.join(dst, ...f.segs));
      expect(b.ino).toBe(a.ino);
      expect(b.nlink).toBe(2);
    }
    for (const d of ['', 'sub', 'sub/empty']) expect(statSync(path.join(dst, d)).mode & 0o777).toBe(0o750);
    expect(statSync(library).mode & 0o777).toBe(0o750);
    expect(compareLinked(await scanTree(src), await scanTree(dst))).toEqual({ ok: true });
    await hardlinkTree(src, dst, scan); // crash-recovery re-run
    expect(compareLinked(await scanTree(src), await scanTree(dst))).toEqual({ ok: true });
  });

  it('hard-links a single file and refuses foreign content at the destination', async () => {
    const src = path.join(outbox, 'one.bin');
    writeFileSync(src, randomBytes(64));
    const dst = path.join(library, 'one.bin');
    await hardlinkTree(src, dst, await scanTree(src));
    expect(statSync(dst).ino).toBe(statSync(src).ino);
    const other = path.join(outbox, 'two.bin');
    writeFileSync(other, randomBytes(64));
    await expect(hardlinkTree(other, dst, await scanTree(other))).rejects.toBeInstanceOf(PlacementError);
  });

  it('detects replaced, extra, missing and temp files', async () => {
    const src = makeAlbum();
    const dst = path.join(library, 'Album');
    await hardlinkTree(src, dst, await scanTree(src));
    // replaced (Syncthing writes a temp file and renames it over the original → new inode)
    writeFileSync(path.join(src, 'tmpnew'), randomBytes(2048));
    renameSync(path.join(src, 'tmpnew'), path.join(src, 'a.bin'));
    expect(compareLinked(await scanTree(src), await scanTree(dst))).toMatchObject({ ok: false });
    rmSync(src, { recursive: true });
    makeAlbum();
    rmSync(dst, { recursive: true });
    await hardlinkTree(src, dst, await scanTree(src));
    writeFileSync(path.join(src, 'extra.bin'), 'x');
    expect(compareLinked(await scanTree(src), await scanTree(dst))).toEqual({ ok: false, reason: 'file count differs' });
    rmSync(path.join(src, 'extra.bin'));
    rmSync(path.join(dst, 'sub', 'b.bin'));
    expect(compareLinked(await scanTree(src), await scanTree(dst))).toMatchObject({ ok: false });
    writeFileSync(path.join(src, '.syncthing.q.tmp'), 'x');
    expect(compareLinked(await scanTree(src), await scanTree(src))).toEqual({ ok: false, reason: 'temporary files present' });
  });

  it('removes a verified outbox entry via quarantine', async () => {
    const src = makeAlbum();
    const dst = path.join(library, 'Album');
    await hardlinkTree(src, dst, await scanTree(src));
    const data = readFileSync(path.join(dst, 'a.bin'));
    const res = await removeVerifiedOutboxEntry(src, dst, path.join(trash, 'item1'));
    expect(res).toEqual({ result: 'removed' });
    expect(existsSync(src)).toBe(false);
    expect(existsSync(path.join(trash, 'item1'))).toBe(false);
    expect(readFileSync(path.join(dst, 'a.bin')).equals(data)).toBe(true);
    expect(statSync(path.join(dst, 'a.bin')).nlink).toBe(1);
    expect(await removeVerifiedOutboxEntry(src, dst, path.join(trash, 'item1'))).toEqual({ result: 'absent' });
  });

  it('never deletes a changed outbox entry', async () => {
    const src = makeAlbum();
    const dst = path.join(library, 'Album');
    await hardlinkTree(src, dst, await scanTree(src));
    const fresh = randomBytes(2048);
    writeFileSync(path.join(src, 'a.new'), fresh);
    renameSync(path.join(src, 'a.new'), path.join(src, 'a.bin'));
    const res = await removeVerifiedOutboxEntry(src, dst, path.join(trash, 'item2'));
    expect(res.result).toBe('mismatch');
    expect(readFileSync(path.join(src, 'a.bin')).equals(fresh)).toBe(true);
    expect(existsSync(path.join(trash, 'item2'))).toBe(false);
  });

  it('refuses when the library copy is gone', async () => {
    const src = makeAlbum();
    const res = await removeVerifiedOutboxEntry(src, path.join(library, 'Album'), path.join(trash, 'x'));
    expect(res.result).toBe('mismatch');
    expect(existsSync(path.join(src, 'a.bin'))).toBe(true);
  });

  it('recovers a quarantined entry after a crash (and restores it on mismatch)', async () => {
    const src = makeAlbum();
    const dst = path.join(library, 'Album');
    await hardlinkTree(src, dst, await scanTree(src));
    mkdirSync(trash, { recursive: true });
    renameSync(src, path.join(trash, 'item3')); // crash right after the quarantine rename
    expect(await removeVerifiedOutboxEntry(src, dst, path.join(trash, 'item3'))).toEqual({ result: 'removed' });

    const src2 = makeAlbum();
    const dst2 = path.join(library, 'Album2');
    await hardlinkTree(src2, dst2, await scanTree(src2));
    writeFileSync(path.join(src2, 'late.bin'), 'late'); // arrived after verification
    renameSync(src2, path.join(trash, 'item4'));
    const res = await removeVerifiedOutboxEntry(src2, dst2, path.join(trash, 'item4'));
    expect(res).toMatchObject({ result: 'mismatch', restored: true });
    expect(readFileSync(path.join(src2, 'late.bin'), 'utf8')).toBe('late');
  });
});
