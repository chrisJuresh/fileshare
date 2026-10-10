import { lstat } from 'node:fs/promises';
import path from 'node:path';

const FORBIDDEN_SEGMENT = /[\u0000-\u001f\u007f/\\]/;

/**
 * Validate one path segment (an item name or one component of an upload relativePath).
 * Returns the NFC-normalised segment or throws. See docs/ARCHITECTURE.md §9.
 */
export function validateSegment(raw: string, opts: { forUpload?: boolean } = {}): string {
  const s = raw.normalize('NFC');
  const bytes = Buffer.byteLength(s);
  if (bytes < 1 || bytes > 200) throw new NameError('name must be 1–200 bytes');
  if (s === '.' || s === '..') throw new NameError('name may not be . or ..');
  if (FORBIDDEN_SEGMENT.test(s)) throw new NameError('name contains a forbidden character');
  if (s !== s.trim()) throw new NameError('name may not start or end with spaces');
  if (s.startsWith('.syncthing.')) throw new NameError('reserved name');
  if (opts.forUpload && /[#?%]/.test(s)) throw new NameError('name may not contain # ? or %');
  return s;
}

/** Validate a '/'-separated relative path (e.g. an upload relativePath). Returns clean segments. */
export function validateRelativePath(raw: string, opts: { forUpload?: boolean } = {}): string[] {
  const trimmed = raw.replace(/^\/+/, '');
  const segs = trimmed.split('/').filter((s) => s.length > 0);
  if (segs.length === 0 || segs.length > 64) throw new NameError('bad path');
  return segs.map((s) => validateSegment(s, opts));
}

/**
 * Join segments under root, guaranteeing the result stays inside root (lexically).
 * Use `assertNoSymlinks` too before serving a file.
 */
export function safeJoin(root: string, ...segments: string[]): string {
  const base = path.resolve(root);
  const full = path.resolve(base, ...segments);
  if (full !== base && !full.startsWith(base + path.sep)) throw new NameError('path escapes root');
  return full;
}

/** Throws if any component of `full` below `root` is a symlink. */
export async function assertNoSymlinks(root: string, full: string): Promise<void> {
  const base = path.resolve(root);
  const rel = path.relative(base, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new NameError('path escapes root');
  let cur = base;
  for (const seg of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg);
    const st = await lstat(cur);
    if (st.isSymbolicLink()) throw new NameError('symlinks are not allowed');
  }
}

export class NameError extends Error {
  readonly statusCode = 400;
}
