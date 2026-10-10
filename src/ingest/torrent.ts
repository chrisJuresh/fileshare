// Torrent v1 info dict construction (docs/ARCHITECTURE.md §4 hashing step 3, §9).
//
// Why not create-torrent at runtime: given a filesystem path it silently drops hidden files and
// "junk" (.DS_Store, Thumbs.db, …) regardless of `filterJunkFiles`, turns a directory holding a
// single file into a single-file torrent, strips a shared leading directory, hashes on the main
// thread, and (6.1.3, in-memory inputs) mis-hashes the last piece when an empty file sits between
// others. Any of those would make the info dict disagree with the library tree that the
// seeder/webseed serve. Instead we build the same info dict ourselves from an explicit, sorted
// file list (every regular file, hidden or not) and hash in a worker thread. The tests check the
// result is byte-identical to create-torrent's info dict (announceList: [], private: true, same
// pieceLength) for inputs where create-torrent's behaviour is well-defined.
import { Worker } from 'node:worker_threads';
import { HASH_WORKER_SOURCE } from './hash-worker.js';

export const MiB = 1024 * 1024;
export const SMALL_ITEM_LIMIT = 64 * MiB;

/** 1 MiB for items ≤ 64 MiB, otherwise 4 MiB. */
export function pieceLengthFor(totalBytes: number): number {
  return totalBytes <= SMALL_ITEM_LIMIT ? MiB : 4 * MiB;
}

// --- bencode (encode only; enough for info dicts) ---
export type BValue = number | string | Uint8Array | BValue[] | { [key: string]: BValue };

export function bencode(value: BValue): Buffer {
  const parts: Buffer[] = [];
  const enc = (v: BValue): void => {
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new Error('bencode: only safe integers are supported');
      parts.push(Buffer.from(`i${v}e`));
    } else if (typeof v === 'string') {
      const b = Buffer.from(v, 'utf8');
      parts.push(Buffer.from(`${b.length}:`), b);
    } else if (v instanceof Uint8Array) {
      parts.push(Buffer.from(`${v.length}:`), Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    } else if (Array.isArray(v)) {
      parts.push(Buffer.from('l'));
      for (const x of v) enc(x);
      parts.push(Buffer.from('e'));
    } else {
      parts.push(Buffer.from('d'));
      const keys = Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const k of keys) {
        enc(k);
        enc(v[k]!);
      }
      parts.push(Buffer.from('e'));
    }
  };
  enc(value);
  return Buffer.concat(parts);
}

/** Decode bencode. Byte strings come back as Uint8Array, dict keys as UTF-8 strings. */
export function bdecode(buf: Uint8Array): BValue {
  let pos = 0;
  const fail = (): never => {
    throw new Error('bdecode: malformed input');
  };
  const readUntil = (ch: number): string => {
    const end = buf.indexOf(ch, pos);
    if (end < 0) fail();
    const s = Buffer.from(buf.subarray(pos, end)).toString('latin1');
    pos = end + 1;
    return s;
  };
  const dec = (depth: number): BValue => {
    if (depth > 64 || pos >= buf.length) fail();
    const c = buf[pos]!;
    if (c === 0x69 /* i */) {
      pos++;
      const s = readUntil(0x65);
      if (!/^-?\d+$/.test(s)) fail();
      const n = Number(s);
      if (!Number.isSafeInteger(n)) fail();
      return n;
    }
    if (c === 0x6c /* l */) {
      pos++;
      const out: BValue[] = [];
      while (buf[pos] !== 0x65) out.push(dec(depth + 1));
      pos++;
      return out;
    }
    if (c === 0x64 /* d */) {
      pos++;
      const out: Record<string, BValue> = {};
      while (buf[pos] !== 0x65) {
        const k = dec(depth + 1);
        if (!(k instanceof Uint8Array)) fail();
        out[Buffer.from(k as Uint8Array).toString('utf8')] = dec(depth + 1);
      }
      pos++;
      return out;
    }
    if (c >= 0x30 && c <= 0x39) {
      const len = Number(readUntil(0x3a));
      if (!Number.isSafeInteger(len) || pos + len > buf.length) fail();
      const v = buf.slice(pos, pos + len);
      pos += len;
      return v;
    }
    return fail();
  };
  const v = dec(0);
  if (pos !== buf.length) fail();
  return v;
}

/** Re-encode an info dict with a new `name` (pieces and files unchanged; used on rename). */
export function renameInfoDict(info: Uint8Array, newName: string): Buffer {
  const d = bdecode(info);
  if (!d || typeof d !== 'object' || Array.isArray(d) || d instanceof Uint8Array) throw new Error('info is not a dict');
  return bencode({ ...d, name: newName });
}

export interface InfoFile {
  /** Path segments relative to the torrent root. Empty for a single-file torrent. */
  segs: string[];
  length: number;
}

/**
 * Build the bencoded info dict: `name`, `piece length`, `pieces`, `private: 1`, and `length`
 * (kind 'file') or `files` (kind 'dir', even if it holds a single file). No `source` key — p2p
 * adds `source: fileshare-<shareId>` per share.
 */
export function buildInfoDict(input: { name: string; kind: 'file' | 'dir'; files: InfoFile[]; pieceLength: number; pieces: Uint8Array }): Buffer {
  const info: Record<string, BValue> = {
    name: input.name,
    'piece length': input.pieceLength,
    pieces: input.pieces,
    private: 1,
  };
  if (input.kind === 'file') {
    if (input.files.length !== 1) throw new Error('single-file item must have exactly one file');
    info.length = input.files[0]!.length;
  } else {
    if (input.files.length === 0) throw new Error('directory item has no files');
    info.files = input.files.map((f) => ({ length: f.length, path: f.segs }));
  }
  return bencode(info);
}

export class HashAbortedError extends Error {
  constructor() {
    super('hashing aborted');
  }
}

/**
 * Hash `files` (absolute paths, in torrent order) into concatenated SHA-1 piece hashes, in a
 * worker thread. `onProgress` receives 0..1. Rejects with HashAbortedError if `signal` aborts.
 */
export function hashPieces(
  files: { path: string; size: number; mtimeMs: number }[],
  pieceLength: number,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<{ pieces: Uint8Array; totalBytes: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new HashAbortedError());
    const worker = new Worker(HASH_WORKER_SOURCE, {
      eval: true,
      workerData: { files, pieceLength },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => {
      void worker.terminate();
      finish(() => reject(new HashAbortedError()));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (msg: { type: string; done?: number; total?: number; pieces?: Uint8Array; totalBytes?: number; message?: string }) => {
      if (msg.type === 'progress' && onProgress) {
        onProgress(msg.total ? Math.min(1, (msg.done ?? 0) / msg.total) : 1);
      } else if (msg.type === 'done') {
        finish(() => resolve({ pieces: msg.pieces!, totalBytes: msg.totalBytes! }));
        void worker.terminate();
      } else if (msg.type === 'error') {
        finish(() => reject(new Error(msg.message ?? 'hashing failed')));
        void worker.terminate();
      }
    });
    worker.on('error', (err) => finish(() => reject(new Error(`hash worker failed: ${err.name}`))));
    worker.on('exit', (code) => finish(() => reject(new Error(`hash worker exited (${code})`))));
  });
}
