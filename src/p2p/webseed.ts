// HTTP webseed (BEP19) — GET/HEAD /ws/:token/<torrent_name>/<file path> (docs/ARCHITECTURE.md §7.1, §9).
// Token + share state are checked on every request; the path must name a file in the share's file
// list; the file is resolved under the library with safeJoin + assertNoSymlinks and opened O_NOFOLLOW;
// bytes go through the shared upload limiter.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline, Transform, type TransformCallback } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { assertNoSymlinks, safeJoin } from '../core/paths.js';
import type { FileEntry } from '../types.js';
import type { Limiter } from './limiter.js';
import { isPlainSegment } from './metainfo.js';
import type { ShareStore } from './shares.js';

export type RangeResult = { kind: 'full' } | { kind: 'range'; start: number; end: number } | { kind: 'unsatisfiable' };

/**
 * Parse a single `Range: bytes=…` header against `size`.
 * No header → full. Multiple ranges, other units or malformed values → unsatisfiable (416).
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined || header === '') return { kind: 'full' };
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return { kind: 'unsatisfiable' };
  const [, a, b] = m as unknown as [string, string, string];
  if (a.length > 16 || b.length > 16) return { kind: 'unsatisfiable' };
  if (a === '' && b === '') return { kind: 'unsatisfiable' };
  if (size === 0) return { kind: 'unsatisfiable' };
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (start >= size || (b !== '' && Number(b) < start)) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end };
}

/** Decode and validate the path segments after `/ws/<token>/` from the RAW url (no double decoding). */
export function parseWebseedPath(rawUrl: string): { token: string; segments: string[] } | undefined {
  const pathOnly = rawUrl.split('?')[0]!.split('#')[0]!;
  const m = /^\/ws\/([^/]+)(?:\/(.*))?$/.exec(pathOnly);
  if (!m) return undefined;
  const token = m[1]!;
  const rest = m[2] ?? '';
  const raw = rest === '' ? [] : rest.split('/');
  const segments: string[] = [];
  for (const r of raw) {
    let s: string;
    try {
      s = decodeURIComponent(r);
    } catch {
      return undefined;
    }
    if (!isPlainSegment(s)) return undefined;
    segments.push(s);
  }
  return { token, segments };
}

class Counter extends Transform {
  constructor(private readonly onBytes: (n: number) => void) {
    super();
  }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    this.onBytes(chunk.length);
    cb(null, chunk);
  }
}

export interface WebseedDeps {
  shares: ShareStore;
  limiter: Limiter;
  /** Bytes actually sent for a share. */
  onBytes: (shareId: string, bytes: number) => void;
  /** Drop a response whose socket made no progress for this long (stalled reader). Default 60 s. */
  idleTimeoutMs?: number;
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9 ._()+,-]/g, '_');
  const star = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

export async function registerWebseed(app: FastifyInstance, ctx: AppContext, deps: WebseedDeps): Promise<void> {
  const { shares, limiter } = deps;
  const fileIndex = new Map<string, Map<string, FileEntry>>();
  const idleMs = deps.idleTimeoutMs ?? 60_000;
  /** In-flight body streams, destroyed on shutdown so close() never waits on a slow client. */
  const active = new Set<Transform>();
  app.addHook('preClose', async () => {
    for (const s of active) s.destroy();
    active.clear();
  });

  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'gone' });

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    reply.header('Cache-Control', 'no-store');
    reply.header('Accept-Ranges', 'bytes');

    const parsed = parseWebseedPath(req.raw.url ?? '');
    if (!parsed) return notFound(reply);
    const auth = shares.authorize(parsed.token);
    if (!auth.ok) return notFound(reply);
    const share = auth.share;
    const info = shares.info(share);
    const segs = parsed.segments;

    let entry: FileEntry | undefined;
    let rel: string[];
    if (info.single) {
      // WebTorrent requests the url-list entry as-is for single-file torrents; BEP19 clients append the name.
      if (segs.length === 0 || (segs.length === 1 && segs[0] === info.name)) entry = info.files[0];
      rel = [];
    } else {
      if (segs.length >= 2 && segs[0] === info.name) {
        let idx = fileIndex.get(share.id);
        if (!idx) fileIndex.set(share.id, (idx = new Map(info.files.map((f) => [f.path, f]))));
        entry = idx.get(segs.slice(1).join('/'));
      }
      rel = segs.slice(1);
    }
    if (!entry) return notFound(reply);

    const item = shares.item(share.item_id);
    if (!item || item.status === 'deleted') return notFound(reply);
    const lib = ctx.config.paths.library;
    let full: string;
    try {
      full = safeJoin(lib, item.name, ...rel);
      await assertNoSymlinks(lib, full);
    } catch {
      return notFound(reply);
    }
    let fh;
    try {
      fh = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return notFound(reply);
    }
    let handedOff = false;
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size !== entry.length) return notFound(reply);
      const size = st.size;
      const range = parseRange(req.headers.range, size);
      const baseName = entry.path.split('/').pop() ?? info.name;
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', contentDisposition(baseName));
      if (range.kind === 'unsatisfiable') {
        return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      }
      const start = range.kind === 'range' ? range.start : 0;
      const end = range.kind === 'range' ? range.end : size - 1;
      const length = size === 0 ? 0 : end - start + 1;
      if (range.kind === 'range') reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
      reply.header('Content-Length', String(length));
      if (req.method === 'HEAD' || length === 0) return reply.send();

      const file = fh.createReadStream({ start, end, highWaterMark: 64 * 1024, autoClose: true });
      handedOff = true;
      const shareId = share.id;
      const counter = new Counter((n) => {
        limiter.record(n);
        deps.onBytes(shareId, n);
      });
      // pipeline destroys every stage (and closes the fd) if the client disconnects mid-transfer:
      // Fastify destroys the payload stream when the response closes early.
      pipeline(file, limiter.throttle(), counter, () => {});
      active.add(counter);
      counter.once('close', () => active.delete(counter));
      // A client that stops reading (backpressure) would otherwise hold the fd and socket forever.
      const res = reply.raw;
      res.setTimeout(idleMs, () => {
        counter.destroy();
        res.destroy();
      });
      res.once('finish', () => res.setTimeout(0));
      return reply.send(counter);
    } finally {
      if (!handedOff) await fh.close().catch(() => {});
    }
  };

  app.route({ method: ['GET', 'HEAD'], url: '/ws/:token', exposeHeadRoute: false, handler });
  app.route({ method: ['GET', 'HEAD'], url: '/ws/:token/*', exposeHeadRoute: false, handler });
}
