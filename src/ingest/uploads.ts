// Web upload: tus 1.0 endpoint + upload batch routes (docs/ARCHITECTURE.md §7.2).
// Registered on the ADMIN listener only, after the admin module's Access-JWT guard, which applies
// to these routes too (we add no auth of our own and assume nothing is public).
import { FileStore } from '@tus/file-store';
import { Server as TusServer, type Upload } from '@tus/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { link, lstat, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { newId } from '../core/ids.js';
import { assertNoSymlinks, NameError, safeJoin, validateRelativePath } from '../core/paths.js';
import { mkdirp0750 } from './placement.js';

export const TUS_PREFIX = '/api/admin/uploads/tus';
/** Max body of a single tus request (Cloudflare limit is 100 MB; clients use 50 MiB chunks). */
export const MAX_TUS_REQUEST_BYTES = 100 * 1024 * 1024;
/** Unfinished tus uploads are discarded after this long. */
const UPLOAD_EXPIRY_MS = 7 * 24 * 3600 * 1000;
/** Free space required on /data beyond the upload size. */
const FREE_SPACE_MARGIN = 0.05;

export interface UploadHooks {
  completeBatch(batchId: string): Promise<{ itemIds: string[] }>;
}

interface TusError {
  status_code: number;
  body: string;
}
const tusError = (status_code: number, body: string): TusError => ({ status_code, body: `${body}\n` });

interface BatchRow {
  id: string;
  status: 'open' | 'complete' | 'failed' | 'ingested';
}

export class UploadsHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    /** Human-readable explanation for the dashboard (sent as `message`). */
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** Shown when a (resumed) upload belongs to a batch that was already completed. */
export const BATCH_CLOSED_MESSAGE =
  'this upload belongs to an upload round that is already finished; remove the file from the list and add it again';

function metaSegments(meta: Record<string, string | null> | undefined): { batchId: string; segs: string[] } {
  const batchId = meta?.batchId ?? '';
  if (!/^[a-z2-7]{26}$/.test(batchId)) throw tusError(400, 'invalid batchId');
  let rel = meta?.relativePath ?? '';
  // Uppy sends the string "null" when a file has no relative path.
  if (!rel || rel === 'null') rel = meta?.filename ?? '';
  try {
    return { batchId, segs: validateRelativePath(rel, { forUpload: true }) };
  } catch (err) {
    if (err instanceof NameError) throw tusError(400, `invalid relativePath: ${err.message}`);
    throw err;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function registerUploadRoutes(app: FastifyInstance, ctx: AppContext, hooks: UploadHooks): Promise<{ cleanup: () => Promise<number> }> {
  const { db, config, log } = ctx;
  const uploadsDir = config.paths.uploads;
  const stagingDir = config.paths.staging;
  await mkdirp0750(uploadsDir);
  await mkdirp0750(stagingDir);

  const getBatch = db.prepare('SELECT id, status FROM upload_batches WHERE id = ?');
  // Uploads resume by tus fingerprint with the metadata of the request that CREATED them, so a
  // finished upload always lands in the batch it was started in; it must still be open.
  const requireOpenBatch = (batchId: string): void => {
    const b = getBatch.get(batchId) as BatchRow | undefined;
    if (!b) throw tusError(404, 'unknown batch');
    if (b.status !== 'open') throw tusError(409, `batch is not open: ${BATCH_CLOSED_MESSAGE}`);
  };
  const targetPath = (batchId: string, segs: string[]): string => safeJoin(stagingDir, batchId, ...segs);

  const store = new FileStore({ directory: uploadsDir, expirationPeriodInMilliseconds: UPLOAD_EXPIRY_MS });
  const tus = new TusServer({
    path: TUS_PREFIX,
    datastore: store,
    relativeLocation: true,
    respectForwardedHeaders: false,
    allowedOrigins: [config.adminBaseUrl.origin],
    disableTerminationForFinishedUploads: true,
    async onUploadCreate(_req, upload: Upload) {
      const { batchId, segs } = metaSegments(upload.metadata);
      requireOpenBatch(batchId);
      if (upload.sizeIsDeferred || upload.size === undefined) throw tusError(400, 'Upload-Length is required');
      const fs = await statfs(config.paths.data);
      const free = fs.bavail * fs.bsize;
      if (free < upload.size * (1 + FREE_SPACE_MARGIN)) throw tusError(507, 'not enough free disk space');
      if (await exists(targetPath(batchId, segs))) throw tusError(409, 'a file with this path already exists in the batch');
      return { metadata: { ...upload.metadata, relativePath: segs.join('/') } };
    },
    async onUploadFinish(_req, upload: Upload) {
      const { batchId, segs } = metaSegments(upload.metadata);
      const src = safeJoin(uploadsDir, upload.id);
      try {
        requireOpenBatch(batchId);
        const dst = targetPath(batchId, segs);
        await mkdirp0750(path.dirname(dst));
        await assertNoSymlinks(stagingDir, path.dirname(dst));
        try {
          await link(src, dst); // never overwrites: EEXIST if the path is taken
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EEXIST' || code === 'ENOTDIR') throw tusError(409, 'a file with this path already exists in the batch');
          throw err;
        }
      } catch (err) {
        // The upload cannot be used; drop it so it doesn't linger in /data/uploads.
        await store.remove(upload.id).catch(() => undefined);
        if ((err as TusError).status_code) throw err;
        log.error({ code: (err as NodeJS.ErrnoException).code }, 'upload finish failed');
        throw tusError(500, 'could not store upload');
      }
      await store.remove(upload.id).catch(() => undefined); // drops the tus copy + .json; the staging link keeps the data
      return {};
    },
  });

  const handleTus = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const method = req.raw.method ?? 'GET';
    if (!['POST', 'PATCH', 'HEAD', 'DELETE', 'OPTIONS'].includes(method)) {
      return reply.code(405).send({ error: 'method_not_allowed' });
    }
    if (method === 'PATCH' || method === 'POST') {
      const cl = req.headers['content-length'];
      const te = req.headers['transfer-encoding'];
      // Every body must declare its length (tus then caps the read at it). Close the connection on
      // refusal so the client can't make us drain an oversized body.
      if ((method === 'PATCH' || te !== undefined) && cl === undefined) {
        return reply.code(411).header('connection', 'close').send({ error: 'length_required' });
      }
      if (cl !== undefined && (!/^\d+$/.test(cl) || Number(cl) > MAX_TUS_REQUEST_BYTES)) {
        return reply.code(413).header('connection', 'close').send({ error: 'request_too_large' });
      }
    }
    // Hand the raw request/response to tus. Fastify must not touch the response afterwards, so
    // copy the headers set by earlier hooks (security headers) onto the raw response first.
    for (const [k, v] of Object.entries(reply.getHeaders())) {
      if (v !== undefined) reply.raw.setHeader(k, v as string | number | string[]);
    }
    reply.hijack();
    try {
      await tus.handle(req.raw, reply.raw);
    } catch (err) {
      log.error({ err: (err as Error).name }, 'tus handler failed');
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.end();
      } else {
        reply.raw.destroy();
      }
    }
  };

  await app.register(
    async (sub) => {
      // Leave tus bodies unread for @tus/server (scoped to this prefix only).
      sub.addContentTypeParser('application/offset+octet-stream', (_req, _payload, done) => done(null));
      sub.route({ method: ['POST', 'PATCH', 'HEAD', 'DELETE', 'OPTIONS', 'GET'], url: '/', handler: handleTus, exposeHeadRoute: false });
      sub.route({ method: ['POST', 'PATCH', 'HEAD', 'DELETE', 'OPTIONS', 'GET'], url: '/*', handler: handleTus, exposeHeadRoute: false });
    },
    { prefix: TUS_PREFIX },
  );

  app.post('/api/admin/uploads/batches', async (_req, reply) => {
    const id = newId();
    const now = Date.now();
    db.prepare("INSERT INTO upload_batches (id, status, created_at, updated_at) VALUES (?, 'open', ?, ?)").run(id, now, now);
    await mkdirp0750(safeJoin(stagingDir, id));
    log.info({ batchId: id }, 'upload batch created');
    return reply.code(201).send({ id });
  });

  // The dashboard keeps its batch id across reloads and asks whether it can still add to it.
  app.get<{ Params: { id: string } }>('/api/admin/uploads/batches/:id', async (req, reply) => {
    const id = req.params.id;
    const b = /^[a-z2-7]{26}$/.test(id) ? (getBatch.get(id) as BatchRow | undefined) : undefined;
    if (!b) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ id: b.id, status: b.status });
  });

  app.post<{ Params: { id: string } }>('/api/admin/uploads/batches/:id/complete', async (req, reply) => {
    const id = req.params.id;
    if (!/^[a-z2-7]{26}$/.test(id)) return reply.code(404).send({ error: 'not_found' });
    try {
      const r = await hooks.completeBatch(id);
      return reply.send(r);
    } catch (err) {
      if (err instanceof UploadsHttpError) {
        return reply.code(err.statusCode).send({ error: err.message, ...(err.detail ? { message: err.detail } : {}) });
      }
      throw err;
    }
  });

  return { cleanup: () => tus.cleanUpExpiredUploads() };
}
