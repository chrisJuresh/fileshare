// /api/admin/* routes (docs/ARCHITECTURE.md §7.2). Registered inside an encapsulated plugin so
// the error handler here does not affect ingest's tus/batch routes.
import type { FastifyError, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requestSnapshot } from '../backup/queue.js';
import type { AppContext } from '../context.js';
import { NameError, validateSegment } from '../core/paths.js';
import { isNameTaken } from '../ingest/naming.js';
import type { ShareRow } from '../db/index.js';
import { SHAREABLE_STATUSES, type ShareDto, type ShareEventDto, type ShareEventType } from '../types.js';
import { filesFromInfo, getItemRow, listItems } from './dto.js';
import type { AdminDeps } from './index.js';
import { KEY_CAP, MAX_CAP_BPS, MIN_CAP_BPS, readSettings, writeCap } from './settings.js';
import { buildStats, buildStatus, eventName, parseEventDetail } from './stats.js';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

const TEN_YEARS_MS = 10 * 366 * 24 * 3600 * 1000;
const idParam = z.object({ id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) });
const password = z.string().min(1).max(200);
const expiresAt = z
  .number()
  .int()
  .refine((v) => v > Date.now(), 'expiresAt must be in the future')
  .refine((v) => v <= Date.now() + TEN_YEARS_MS, 'expiresAt must be at most 10 years ahead');

const RenameBody = z.object({ name: z.string().min(1).max(1000) }).strict();
const AddFilesBody = z.object({ batchId: z.string().regex(/^[a-z2-7]{26}$/) }).strict();
const EmptyBody = z.object({}).strict().optional();
const CreateShareBody = z
  .object({ itemId: z.string().min(1).max(64), password: password.optional(), expiresAt: expiresAt.optional() })
  .strict();
const UpdateShareBody = z
  .object({ password: password.nullable().optional(), expiresAt: expiresAt.nullable().optional() })
  .strict()
  .refine((b) => b.password !== undefined || b.expiresAt !== undefined, 'nothing to update');
const SettingsBody = z.object({ uploadCapBps: z.number().int().min(MIN_CAP_BPS).max(MAX_CAP_BPS) }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const msg = r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
    throw new HttpError(400, 'invalid_request', msg);
  }
  return r.data;
}

function shareRow(ctx: AppContext, id: string): ShareRow | undefined {
  return ctx.db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as ShareRow | undefined;
}

const STATUS_CODES: Record<number, string> = { 400: 'invalid_request', 404: 'not_found', 409: 'conflict', 413: 'too_large', 415: 'unsupported_media_type', 429: 'rate_limited' };

export interface RouteOptions {
  /** Called after an in-process settings write (so the cross-process watcher does not re-emit). */
  onSettingsWritten?: (key: string) => void;
}

export async function adminRoutes(api: FastifyInstance, ctx: AppContext, deps: AdminDeps, opts: RouteOptions = {}): Promise<void> {
  const { db, events } = ctx;
  const { ingest, p2p } = deps;

  api.setErrorHandler((err: FastifyError | HttpError | NameError | Error, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof NameError) return reply.code(400).send({ error: 'invalid_name', message: err.message });
    const sc = (err as { statusCode?: unknown }).statusCode;
    if (typeof sc === 'number' && STATUS_CODES[sc]) {
      return reply.code(sc).send({ error: STATUS_CODES[sc], message: err.message.slice(0, 300) });
    }
    req.log.error({ err: { name: err.name, message: err.message } }, 'admin: request failed');
    return reply.code(500).send({ error: 'internal' });
  });
  api.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));
  // The dashboard's static wildcard on '/' would otherwise answer unknown /api/admin/* GETs.
  api.all('/*', async (_req, reply) => reply.code(404).send({ error: 'not_found' }));

  // ---- items ---------------------------------------------------------------------------------
  api.get('/items', async () => listItems(db, ingest.progress()));

  api.patch('/items/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(RenameBody, req.body);
    const name = validateSegment(body.name);
    const item = getItemRow(db, id);
    if (!item) throw new HttpError(404, 'not_found');
    if (item.name === name) return { ok: true };
    if (await isNameTaken(db, ctx.config.paths.library, name, id)) throw new HttpError(409, 'name_taken', 'an item with that name already exists');
    await ingest.renameItem(id, name);
    return { ok: true };
  });

  api.delete('/items/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    parse(EmptyBody, req.body ?? undefined);
    if (!getItemRow(db, id)) throw new HttpError(404, 'not_found');
    await ingest.deleteItem(id);
    return { ok: true };
  });

  api.post('/items/:id/retry', async (req) => {
    const { id } = parse(idParam, req.params);
    parse(EmptyBody, req.body ?? undefined);
    const item = getItemRow(db, id);
    if (!item) throw new HttpError(404, 'not_found');
    if (item.status !== 'error') throw new HttpError(409, 'not_in_error', 'only items in error can be retried');
    await ingest.retry(id);
    return { ok: true };
  });

  // Append the files of an open upload round to a ready folder item; its shares keep their links.
  api.post('/items/:id/add-files', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(AddFilesBody, req.body);
    if (!getItemRow(db, id)) throw new HttpError(404, 'not_found');
    await ingest.addFiles(id, body.batchId);
    return { ok: true };
  });

  api.get('/items/:id/files', async (req) => {
    const { id } = parse(idParam, req.params);
    const item = getItemRow(db, id);
    if (!item) throw new HttpError(404, 'not_found');
    if (!item.info) throw new HttpError(409, 'not_ready', 'the file list is available once hashing is done');
    try {
      return await filesFromInfo(item.info);
    } catch {
      throw new HttpError(500, 'bad_info', 'stored torrent info could not be read');
    }
  });

  // ---- shares --------------------------------------------------------------------------------
  api.get('/shares', async (): Promise<ShareDto[]> => p2p.listShares());

  api.post('/shares', async (req, reply) => {
    const body = parse(CreateShareBody, req.body);
    const item = getItemRow(db, body.itemId);
    if (!item) throw new HttpError(404, 'not_found', 'item not found');
    if (!SHAREABLE_STATUSES.includes(item.status)) throw new HttpError(409, 'not_ready', 'items can be shared once hashing is done');
    const share = await p2p.createShare({
      itemId: body.itemId,
      ...(body.password !== undefined ? { password: body.password } : {}),
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
    });
    return reply.code(201).send(share);
  });

  api.patch('/shares/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(UpdateShareBody, req.body);
    const row = shareRow(ctx, id);
    if (!row) throw new HttpError(404, 'not_found');
    if (row.revoked_at !== null) throw new HttpError(409, 'revoked', 'a revoked share cannot be changed');
    const patch: { password?: string | null; expiresAt?: number | null } = {};
    if (body.password !== undefined) patch.password = body.password;
    if (body.expiresAt !== undefined) patch.expiresAt = body.expiresAt;
    return p2p.updateShare(id, patch);
  });

  api.post('/shares/:id/revoke', async (req) => {
    const { id } = parse(idParam, req.params);
    parse(EmptyBody, req.body ?? undefined);
    const row = shareRow(ctx, id);
    if (!row) throw new HttpError(404, 'not_found');
    if (row.revoked_at === null) await p2p.revokeShare(id);
    return { ok: true };
  });

  api.post('/shares/:id/reset-limits', async (req) => {
    const { id } = parse(idParam, req.params);
    parse(EmptyBody, req.body ?? undefined);
    if (!shareRow(ctx, id)) throw new HttpError(404, 'not_found');
    p2p.resetUnlockLimits(id);
    req.log.info({ admin: req.adminEmail ? 'yes' : 'service' }, 'admin: share unlock limits reset');
    return { ok: true };
  });

  api.get('/shares/:id/events', async (req) => {
    const { id } = parse(idParam, req.params);
    if (!shareRow(ctx, id)) throw new HttpError(404, 'not_found');
    const rows = db
      .prepare('SELECT id, at, type, detail FROM share_events WHERE share_id = ? ORDER BY at DESC, id DESC LIMIT 500')
      .all(id) as { id: number; at: number; type: ShareEventType; detail: string | null }[];
    return rows.map((r): ShareEventDto => {
      const detail = parseEventDetail(r.detail);
      return { id: r.id, at: r.at, type: r.type, name: eventName(detail), detail };
    });
  });

  // ---- stats / status / settings / snapshots ---------------------------------------------------
  api.get('/stats', async () => buildStats(db, p2p.limiter.currentBps()));
  api.get('/status', async () => buildStatus(ctx.config, db));

  api.get('/settings', async () => readSettings(db));
  api.put('/settings', async (req) => {
    const body = parse(SettingsBody, req.body);
    writeCap(db, body.uploadCapBps);
    events.emit('settings.changed', { key: KEY_CAP });
    opts.onSettingsWritten?.(KEY_CAP);
    req.log.info({ admin: req.adminEmail ? 'yes' : 'service', capBps: body.uploadCapBps }, 'admin: upload cap changed');
    return readSettings(db);
  });

  api.post('/snapshots', async (req, reply) => {
    parse(EmptyBody, req.body ?? undefined);
    const id = requestSnapshot(db, 'manual');
    return reply.code(202).send({ id });
  });
}
