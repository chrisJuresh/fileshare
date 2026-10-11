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

// --- appending files to an existing (folder) torrent (docs/ARCHITECTURE.md §4 "add files") ---
//
// New files go AFTER the existing ones, starting on a piece boundary: if the old data ends inside a
// piece, a BEP 47 pad file (attr "p", path .pad/<length>, all zero bytes) fills the rest of that
// piece. Every old file keeps its offset, and every old full piece keeps its hash, so a torrent app
// that already holds the old files only re-downloads that one partial last piece (now ending in
// zeros) plus the new files. Only the old partial piece and the new files are hashed.

/** One entry of an info dict's file list, in torrent order (pad files included). */
export interface LayoutEntry {
  segs: string[];
  length: number;
  /** BEP 47 padding file: zero bytes, not on disk. */
  pad: boolean;
}

export interface AppendPlan {
  pieceLength: number;
  /** The old files and pads, in torrent order. */
  layout: LayoutEntry[];
  /** Bytes covered by the old info (pads included). */
  oldLength: number;
  /** Old pieces that stay as they are (every piece that ends at or before `tailStart`). */
  keptPieces: Uint8Array;
  /** Offset of the old partial last piece (= oldLength when the old data ends on a boundary). */
  tailStart: number;
  /** Zero bytes between the old data and the first new file. */
  padLength: number;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function infoDictOf(info: Uint8Array): Record<string, BValue> {
  const d = bdecode(info);
  if (!d || typeof d !== 'object' || Array.isArray(d) || d instanceof Uint8Array) throw new Error('info is not a dict');
  return d;
}

function bstr(v: BValue | undefined): string {
  if (v instanceof Uint8Array) return utf8.decode(v);
  if (typeof v === 'string') return v;
  throw new Error('info: expected a string');
}

export function planAppend(info: Uint8Array): AppendPlan {
  const d = infoDictOf(info);
  const pieceLength = d['piece length'];
  const pieces = d.pieces;
  if (typeof pieceLength !== 'number' || pieceLength <= 0 || !(pieces instanceof Uint8Array)) throw new Error('info: bad pieces');
  if (!Array.isArray(d.files)) throw new Error('files can only be added to a folder item');
  const layout = d.files.map((raw): LayoutEntry => {
    const f = raw as Record<string, BValue>;
    const p = f['path.utf-8'] ?? f.path;
    if (!Array.isArray(p) || p.length === 0 || typeof f.length !== 'number') throw new Error('info: bad file entry');
    return { segs: p.map((x) => bstr(x)), length: f.length, pad: f.attr !== undefined && bstr(f.attr).includes('p') };
  });
  const oldLength = layout.reduce((a, f) => a + f.length, 0);
  if (pieces.length !== Math.ceil(oldLength / pieceLength) * 20) throw new Error('info: piece count does not match the files');
  const full = Math.floor(oldLength / pieceLength);
  const tailStart = full * pieceLength;
  const tail = oldLength - tailStart;
  return {
    pieceLength,
    layout,
    oldLength,
    keptPieces: pieces.slice(0, full * 20),
    tailStart,
    padLength: tail === 0 ? 0 : pieceLength - tail,
  };
}

/** The parts of old (non-pad) files that lie in the old partial last piece, in order. */
export function tailRanges(plan: AppendPlan): { segs: string[]; size: number; start: number; length: number }[] {
  const out: { segs: string[]; size: number; start: number; length: number }[] = [];
  let offset = 0;
  for (const f of plan.layout) {
    const end = offset + f.length;
    if (end > plan.tailStart && f.length > 0) {
      // A pad never reaches into the partial piece (pads end on a piece boundary).
      if (f.pad) throw new Error('info: pad file inside the last piece');
      const start = Math.max(0, plan.tailStart - offset);
      out.push({ segs: f.segs, size: f.length, start, length: f.length - start });
    }
    offset = end;
  }
  return out;
}

/** The old info dict with a pad (if needed) and `newFiles` appended, and `pieces` replaced. */
export function buildAppendedInfo(info: Uint8Array, padLength: number, newFiles: InfoFile[], pieces: Uint8Array): Buffer {
  const d = infoDictOf(info);
  if (!Array.isArray(d.files)) throw new Error('files can only be added to a folder item');
  if (newFiles.length === 0) throw new Error('no files to add');
  const files: BValue[] = [...d.files];
  if (padLength > 0) files.push({ attr: 'p', length: padLength, path: ['.pad', String(padLength)] });
  for (const f of newFiles) {
    if (f.segs.length === 0) throw new Error('added files need a path');
    files.push({ length: f.length, path: f.segs });
  }
  return bencode({ ...d, files, pieces });
}

export class HashAbortedError extends Error {
  constructor() {
    super('hashing aborted');
  }
}

/** A hashing input: (part of) a file, checked against its expected size and mtime, or zero bytes. */
export type HashSource = { path: string; size: number; mtimeMs: number; start?: number; length?: number } | { zeros: number };

/**
 * Hash `files` (absolute paths, in torrent order) into concatenated SHA-1 piece hashes, in a
 * worker thread. `onProgress` receives 0..1. Rejects with HashAbortedError if `signal` aborts.
 */
export function hashPieces(
  files: HashSource[],
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
