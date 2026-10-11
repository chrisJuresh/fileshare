// Read-only abstract-chunk-store for the seeder. Replaces WebTorrent's default fs-chunk-store, which
// opens files O_RDWR, strips "reserved" characters from file names (so names like `a:b` would not
// resolve) and deletes files on `destroy()`. This store:
//  - opens files read-only (O_NOFOLLOW on the final component),
//  - requires every file's real path to stay inside `allowedRoot` (the library),
//  - refuses `put`, and never deletes anything,
//  - reads BEP 47 pad files (`pads[i]`) as zero bytes without touching the disk.
import { constants, type promises as fsp } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

type Cb<T = void> = (err: Error | null, value?: T) => void;

interface StoreFile {
  /** Absolute path (through the seedlink). */
  path: string;
  length: number;
  offset: number;
  pad: boolean;
}

export interface ReadOnlyStoreOpts {
  path: string;
  files: { path: string; length: number; offset?: number }[];
  length?: number;
  /** Real (resolved) library directory every file must live in. */
  allowedRoot: string;
  /** Per file (torrent order): true for a BEP 47 pad file. */
  pads?: boolean[];
}

export class ReadOnlyStore {
  readonly chunkLength: number;
  readonly length: number;
  private readonly files: StoreFile[];
  private readonly handles = new Map<number, Promise<fsp.FileHandle>>();
  private closed = false;
  private readonly allowedRoot: string;

  constructor(chunkLength: number, opts: ReadOnlyStoreOpts) {
    this.chunkLength = Number(chunkLength);
    if (!(this.chunkLength > 0)) throw new Error('chunkLength required');
    if (!opts?.path || !Array.isArray(opts.files)) throw new Error('path and files required');
    if (!opts.allowedRoot) throw new Error('allowedRoot required');
    this.allowedRoot = opts.allowedRoot;
    const root = path.resolve(opts.path);
    if (opts.pads && opts.pads.length !== opts.files.length) throw new Error('pads must match files');
    let offset = 0;
    this.files = opts.files.map((f, i) => {
      const p = path.resolve(root, f.path);
      if (!p.startsWith(root + path.sep)) throw new Error('file path escapes store root');
      const file = { path: p, length: Number(f.length), offset, pad: opts.pads?.[i] === true };
      offset += file.length;
      return file;
    });
    this.length = offset;
  }

  private lastChunkLength(): number {
    return this.length % this.chunkLength || this.chunkLength;
  }

  private lastChunkIndex(): number {
    return Math.ceil(this.length / this.chunkLength) - 1;
  }

  private handle(i: number): Promise<fsp.FileHandle> {
    let h = this.handles.get(i);
    if (!h) {
      const f = this.files[i]!;
      h = (async () => {
        const real = await realpath(f.path);
        if (!real.startsWith(this.allowedRoot + path.sep)) throw new Error('file is outside the library');
        const fh = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
        if (this.closed) {
          await fh.close();
          throw new Error('Storage is closed');
        }
        const st = await fh.stat();
        if (!st.isFile() || st.size !== f.length) {
          await fh.close();
          throw new Error('file changed on disk');
        }
        return fh;
      })();
      h.catch(() => this.handles.delete(i));
      this.handles.set(i, h);
    }
    return h;
  }

  /** Index of the first file whose range ends after `pos` (binary search). */
  private fileAt(pos: number): number {
    let lo = 0;
    let hi = this.files.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const f = this.files[mid]!;
      if (f.offset + f.length <= pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private async read(start: number, length: number): Promise<Buffer> {
    const out = Buffer.allocUnsafe(length);
    let done = 0;
    let i = this.fileAt(start);
    while (done < length && i < this.files.length) {
      const f = this.files[i]!;
      const pos = start + done;
      if (f.length === 0 || pos >= f.offset + f.length) {
        i++;
        continue;
      }
      const inFile = pos - f.offset;
      const n = Math.min(length - done, f.length - inFile);
      if (f.pad) {
        out.fill(0, done, done + n);
        done += n;
        i++;
        continue;
      }
      const fh = await this.handle(i);
      let got = 0;
      while (got < n) {
        const { bytesRead } = await fh.read(out, done + got, n - got, inFile + got);
        if (bytesRead === 0) throw new Error('short read');
        got += bytesRead;
      }
      done += n;
      i++;
    }
    if (done !== length) throw new Error('read past end');
    return out;
  }

  get(index: number, opts: { offset?: number; length?: number } | null | Cb<Buffer>, cb?: Cb<Buffer>): void {
    if (typeof opts === 'function') return this.get(index, null, opts);
    const done = cb ?? (() => {});
    if (this.closed) return queueMicrotask(() => done(new Error('Storage is closed')));
    const last = this.lastChunkIndex();
    if (!Number.isInteger(index) || index < 0 || index > last) return queueMicrotask(() => done(new Error('bad chunk index')));
    const chunkLength = index === last ? this.lastChunkLength() : this.chunkLength;
    const from = opts?.offset ?? 0;
    const to = opts?.length ? from + opts.length : chunkLength;
    if (from < 0 || to > chunkLength || to < from) return queueMicrotask(() => done(new Error('Invalid offset and/or length')));
    this.read(index * this.chunkLength + from, to - from).then(
      (buf) => done(null, buf),
      (err: Error) => done(err),
    );
  }

  put(_index: number, _buf: Uint8Array, cb?: Cb): void {
    queueMicrotask(() => cb?.(new Error('read-only store')));
  }

  close(cb?: Cb): void {
    this.closed = true;
    const hs = [...this.handles.values()];
    this.handles.clear();
    Promise.allSettled(hs.map(async (h) => (await h).close())).then(() => cb?.(null));
  }

  /** Same as close(): this store never deletes data. */
  destroy(cb?: Cb): void {
    this.close(cb);
  }
}
