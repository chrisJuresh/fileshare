// OWNER: ingest builder. Contract: docs/ARCHITECTURE.md §4, §13.
//
// Pipeline: outbox entry → incoming → stabilising (fingerprint quiet period + Syncthing gate)
// → hashing (hard-link into the library, info dict in a worker) → snapshotting (wait for a
// covering restic run, then verified outbox removal) → ready. Web uploads join at hashing.
// Every step re-reads the item row and uses guarded transitions, so it is restart-safe.
import type { FastifyInstance } from 'fastify';
import { link, lstat, readdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { findCoveringBackup, requestSnapshot } from '../backup/queue.js';
import type { AppContext } from '../context.js';
import { newId } from '../core/ids.js';
import { assertNoSymlinks, NameError, safeJoin, validateSegment } from '../core/paths.js';
import type { ItemRow } from '../db/index.js';
import type { P2PService } from '../p2p/index.js';
import type { ItemStatus } from '../types.js';
import { chooseName, isNameTaken, tombstoneName } from './naming.js';
import { hardlinkTree, mkdirp0750, PlacementError, removeVerifiedOutboxEntry } from './placement.js';
import { INGEST_EVENT_TYPES, isUnderEntry, runEventLoop, SyncthingClient, type SyncthingEvent } from './syncthing.js';
import {
  buildAppendedInfo,
  buildInfoDict,
  HashAbortedError,
  hashPieces,
  pieceLengthFor,
  planAppend,
  renameInfoDict,
  tailRanges,
  type HashSource,
} from './torrent.js';
import { fingerprint, identityFingerprint, isSyncthingTmp, scanTree, totalBytes, type TreeScan } from './tree.js';
import { registerUploadRoutes, UploadsHttpError } from './uploads.js';

export interface IngestService {
  start(): Promise<void>;
  stop(): Promise<void>;
  retry(itemId: string): Promise<void>;
  renameItem(itemId: string, newName: string): Promise<void>;
  deleteItem(itemId: string): Promise<void>;
  /** Append the files of an open upload batch to a ready folder item (§4 "add files"). */
  addFiles(itemId: string, batchId: string): Promise<void>;
  /** tus endpoint + upload batch routes under /api/admin/uploads (admin listener only). */
  registerAdminRoutes(app: FastifyInstance): Promise<void>;
  /** itemId → 0..1 for items currently hashing. */
  progress(): Record<string, number>;
}

export type IngestDeps = { p2p: Pick<P2PService, 'revokeAllForItem' | 'repointItem' | 'refreshItemShares'> };

/** Internal tuning knobs (tests use short intervals). All optional. */
export interface IngestOptions {
  /** Stability check interval (default: quiet period / 4, clamped to 1–10 s). */
  tickMs?: number;
  /** Snapshot coverage poll interval (default 5 s). */
  snapshotPollMs?: number;
  /** Syncthing event long-poll timeout in seconds (default 60). */
  eventPollTimeoutS?: number;
  /** Minimum time between re-requests of an ingest snapshot for one item (default 60 s). */
  snapshotRerequestMs?: number;
}

export const OUTBOX_CHANGED_ERROR = 'outbox copy changed after ingest; not removed';
export const STILL_IN_OUTBOX = "still in the PC outbox — remove it there, or wait until it's ready";
export const ERROR_STILL_IN_OUTBOX = 'still in the PC outbox — remove it there first, then delete it here';

/** Error with an HTTP status for the admin API (Fastify uses `statusCode`). */
export class IngestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

type ItemFields = Partial<
  Pick<
    ItemRow,
    'error' | 'library_at' | 'info' | 'piece_length' | 'total_bytes' | 'file_count' | 'snapshot_run_id' | 'ready_at' | 'deleted_at' | 'kind' | 'name' | 'append_batch_id'
  >
>;
const FIELD_NAMES = new Set([
  'error',
  'library_at',
  'info',
  'piece_length',
  'total_bytes',
  'file_count',
  'snapshot_run_id',
  'ready_at',
  'deleted_at',
  'kind',
  'name',
  'append_batch_id',
]);

interface StabState {
  sourceName: string;
  fp: string | null;
  since: number;
}

function errCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  return typeof code === 'string' ? code : (err as Error)?.name ?? 'Error';
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

class Ingest implements IngestService {
  private readonly db;
  private readonly log;
  private readonly cfg;
  private readonly quietMs: number;
  private readonly tickMs: number;
  private readonly snapshotPollMs: number;
  private readonly rerequestMs: number;
  private readonly syncthing: SyncthingClient;

  private stab = new Map<string, StabState>();
  private hashQueue: string[] = [];
  private hashPump: Promise<void> | null = null;
  private progressMap = new Map<string, number>();
  private aborts = new Map<string, AbortController>();
  private locks = new Map<string, Promise<void>>();
  private running = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private kickTimer: NodeJS.Timeout | null = null;
  private stopCtl = new AbortController();
  private eventLoop: Promise<void> | null = null;
  private lastRequestAt = new Map<string, number>();
  private warnedOnce = new Set<string>();
  private started = false;
  private stopped = false;
  private cleanupUploads: (() => Promise<number>) | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: IngestDeps,
    private readonly opts: IngestOptions = {},
  ) {
    this.db = ctx.db;
    this.log = ctx.log.child({ module: 'ingest' });
    this.cfg = ctx.config;
    this.quietMs = this.cfg.env.INGEST_QUIET_SECONDS * 1000;
    this.tickMs = opts.tickMs ?? Math.min(10_000, Math.max(1000, Math.floor(this.quietMs / 4)));
    this.snapshotPollMs = opts.snapshotPollMs ?? 5000;
    this.rerequestMs = opts.snapshotRerequestMs ?? 60_000;
    this.syncthing = new SyncthingClient({
      baseUrl: this.cfg.env.SYNCTHING_API_URL,
      apiKey: () => this.cfg.secret('syncthing-api-key'),
    });
  }

  // ---------------------------------------------------------------- helpers: DB

  private getItem(id: string): ItemRow | undefined {
    return this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
  }

  private itemsWithStatus(...statuses: ItemStatus[]): ItemRow[] {
    return this.db
      .prepare(`SELECT * FROM items WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at, id`)
      .all(...statuses) as ItemRow[];
  }

  /** Guarded status transition. Returns false (and changes nothing) if the item isn't in `from`. */
  private transition(id: string, from: ItemStatus[], to: ItemStatus, fields: ItemFields = {}): boolean {
    const keys = Object.keys(fields).filter((k) => FIELD_NAMES.has(k));
    const sets = ['status = ?', 'updated_at = ?', ...keys.map((k) => `${k} = ?`)];
    const args: unknown[] = [to, Date.now(), ...keys.map((k) => (fields as Record<string, unknown>)[k] ?? null)];
    const r = this.db
      .prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`)
      .run(...args, id, ...from);
    if (r.changes === 0) return false;
    const row = this.getItem(id);
    if (to === 'error') this.log.warn({ itemId: id, name: row?.name, error: fields.error }, 'item failed');
    else this.log.info({ itemId: id, name: row?.name, status: to }, 'item status');
    this.ctx.events.emit('item.status', { itemId: id, status: to });
    return true;
  }

  /** Update fields without a status change, only if still in `status`. */
  private setFields(id: string, status: ItemStatus, fields: ItemFields): boolean {
    const keys = Object.keys(fields).filter((k) => FIELD_NAMES.has(k));
    if (keys.length === 0) return true;
    const r = this.db
      .prepare(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND status = ?`)
      .run(...keys.map((k) => (fields as Record<string, unknown>)[k] ?? null), Date.now(), id, status);
    return r.changes > 0;
  }

  private fail(id: string, from: ItemStatus[], message: string): void {
    this.transition(id, from, 'error', { error: message });
  }

  private async nameTaken(name: string, exceptItemId?: string): Promise<boolean> {
    return isNameTaken(this.db, this.cfg.paths.library, name, exceptItemId);
  }

  /** Insert a new item with a freshly allocated unique name. */
  private async insertItem(input: {
    baseName: string;
    kind: 'file' | 'dir';
    source: 'outbox' | 'upload';
    sourceName: string;
    batchId: string | null;
    status: ItemStatus;
  }): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const name = await chooseName(input.baseName, (n) => this.nameTaken(n));
      const id = newId();
      const now = Date.now();
      try {
        this.db
          .prepare(
            `INSERT INTO items (id, name, kind, source, source_name, upload_batch_id, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, name, input.kind, input.source, input.sourceName, input.batchId, input.status, now, now);
      } catch (err) {
        // Name raced with another insert: try again (the active-source index is a hard error).
        if (attempt < 5 && /UNIQUE constraint failed: items\.name/.test((err as Error).message)) continue;
        throw err;
      }
      this.log.info({ itemId: id, name, source: input.source }, 'item created');
      this.ctx.events.emit('item.status', { itemId: id, status: input.status });
      return id;
    }
  }

  private libraryPath(name: string): string {
    return safeJoin(this.cfg.paths.library, name);
  }
  private outboxPath(sourceName: string): string {
    return safeJoin(this.cfg.paths.outbox, sourceName);
  }
  private trashPath(itemId: string): string {
    return safeJoin(this.cfg.paths.data, '.ingest-trash', itemId);
  }

  private warnOnce(key: string, obj: Record<string, unknown>, msg: string): void {
    if (this.warnedOnce.has(key)) return;
    this.warnedOnce.add(key);
    this.log.warn(obj, msg);
  }

  // ---------------------------------------------------------------- helpers: concurrency

  /** Serialise all work on one item. */
  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  /** Run a periodic job, skipping if the previous run is still going. */
  private async guard(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.running.has(name) || this.stopped) return;
    this.running.add(name);
    try {
      await fn();
    } catch (err) {
      this.log.error({ job: name, err: errCode(err) }, 'ingest job failed');
    } finally {
      this.running.delete(name);
    }
  }

  private every(ms: number, fn: () => void): void {
    const t = setInterval(fn, ms);
    t.unref();
    this.timers.push(t);
  }

  /** Something changed (Syncthing event): rescan soon. */
  private kick(): void {
    if (this.kickTimer || this.stopped) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.guard('scan', () => this.scanOutbox()).then(() => this.guard('tick', () => this.stabilityTick()));
    }, 300);
    this.kickTimer.unref();
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const p = this.cfg.paths;
    for (const d of [p.library, p.staging, p.uploads]) await mkdirp0750(d);

    // Resume non-terminal items from DB state.
    for (const row of this.itemsWithStatus('incoming', 'stabilising')) {
      if (row.source === 'upload') this.transition(row.id, [row.status], 'hashing');
    }
    for (const row of this.itemsWithStatus('hashing')) this.enqueueHash(row.id);
    // snapshotting items are picked up by the snapshot poll; outbox items by the stability tick.
    const pendingBatches = this.db.prepare("SELECT id FROM upload_batches WHERE status = 'complete'").all() as { id: string }[];
    for (const b of pendingBatches) {
      await this.completeBatch(b.id).catch((err) => this.log.error({ batchId: b.id, err: errCode(err) }, 'resuming batch failed'));
    }

    if (!this.cfg.env.SYNCTHING_PC_DEVICE_ID) {
      this.warnOnce('no-device', {}, 'SYNCTHING_PC_DEVICE_ID is empty: outbox items will stay in stabilising');
    }

    await this.guard('scan', () => this.scanOutbox());
    this.every(this.cfg.env.INGEST_RESCAN_SECONDS * 1000, () => void this.guard('scan', () => this.scanOutbox()));
    this.every(this.tickMs, () => void this.guard('tick', () => this.stabilityTick()));
    this.every(this.snapshotPollMs, () => void this.guard('snapshot', () => this.snapshotPoll()));
    this.every(3600_000, () => void this.cleanupUploads?.().catch(() => undefined));
    void this.guard('tick', () => this.stabilityTick());
    void this.guard('snapshot', () => this.snapshotPoll());

    this.eventLoop = runEventLoop({
      client: this.syncthing,
      types: INGEST_EVENT_TYPES,
      signal: this.stopCtl.signal,
      log: this.log,
      pollTimeoutS: this.opts.eventPollTimeoutS ?? 60,
      onEvents: (evts) => this.onSyncthingEvents(evts),
    });
    this.log.info('ingest started');
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopCtl.abort();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.kickTimer) clearTimeout(this.kickTimer);
    for (const c of this.aborts.values()) c.abort();
    this.hashQueue = [];
    await Promise.allSettled([this.eventLoop, this.hashPump, ...this.locks.values()]);
    // Wait for in-flight periodic jobs to notice `stopped`.
    for (let i = 0; i < 100 && this.running.size > 0; i++) await new Promise((r) => setTimeout(r, 20));
  }

  // ---------------------------------------------------------------- outbox discovery

  private async scanOutbox(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.cfg.paths.outbox);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.warnOnce('no-outbox', {}, 'outbox folder does not exist yet');
        return;
      }
      throw err;
    }
    const activeQ = this.db.prepare(
      "SELECT id FROM items WHERE source = 'outbox' AND source_name = ? AND status NOT IN ('ready','deleted')",
    );
    for (const raw of names.sort()) {
      if (this.stopped) return;
      // .stfolder, .stignore, .stversions, other hidden entries, Syncthing temp files: never items.
      if (raw.startsWith('.') || isSyncthingTmp(raw)) continue;
      if (activeQ.get(raw)) continue;
      let base: string;
      try {
        base = validateSegment(raw);
      } catch (err) {
        if (err instanceof NameError) {
          this.warnOnce(`badname:${raw}`, { reason: err.message }, 'outbox entry has an invalid name; ignored');
          continue;
        }
        throw err;
      }
      let st;
      try {
        st = await lstat(this.outboxPath(raw));
      } catch {
        continue;
      }
      if (!st.isFile() && !st.isDirectory()) {
        this.warnOnce(`badkind:${raw}`, { name: base }, 'outbox entry is not a file or folder; ignored');
        continue;
      }
      const id = await this.insertItem({
        baseName: base,
        kind: st.isDirectory() ? 'dir' : 'file',
        source: 'outbox',
        sourceName: raw,
        batchId: null,
        status: 'incoming',
      });
      this.transition(id, ['incoming'], 'stabilising');
      this.stab.set(id, { sourceName: raw, fp: null, since: Date.now() });
    }
  }

  private onSyncthingEvents(events: SyncthingEvent[]): void {
    const folder = this.cfg.env.SYNCTHING_FOLDER_ID;
    const now = Date.now();
    let relevant = false;
    for (const e of events) {
      const data = e.data ?? {};
      if (data.folder !== undefined && data.folder !== folder) continue;
      relevant = true;
      const names: string[] = [];
      if (Array.isArray(data.filenames)) names.push(...data.filenames.filter((n): n is string => typeof n === 'string'));
      if (typeof data.item === 'string') names.push(data.item);
      for (const st of this.stab.values()) {
        if (names.some((n) => isUnderEntry(n, st.sourceName))) st.since = now;
      }
    }
    if (relevant) this.kick();
  }

  // ---------------------------------------------------------------- stabilising

  private async stabilityTick(): Promise<void> {
    const rows = this.itemsWithStatus('incoming', 'stabilising').filter((r) => r.source === 'outbox');
    if (rows.length === 0) return;
    let topTmp = false;
    try {
      topTmp = (await readdir(this.cfg.paths.outbox)).some(isSyncthingTmp);
    } catch {
      /* outbox missing: entries will be reported missing below */
    }
    const now = Date.now();
    const candidates: { row: ItemRow; st: StabState }[] = [];
    for (const row of rows) {
      if (this.stopped) return;
      if (row.status === 'incoming') this.transition(row.id, ['incoming'], 'stabilising');
      let st = this.stab.get(row.id);
      if (!st) {
        st = { sourceName: row.source_name, fp: null, since: now };
        this.stab.set(row.id, st);
      }
      let scan: TreeScan;
      try {
        scan = await scanTree(this.outboxPath(row.source_name));
      } catch {
        st.fp = null; // entry changing under us
        st.since = now;
        continue;
      }
      if (scan.kind === 'missing') {
        await this.withLock(row.id, async () => {
          if (await exists(this.outboxPath(row.source_name))) return;
          this.stab.delete(row.id);
          this.transition(row.id, ['incoming', 'stabilising'], 'deleted', {
            deleted_at: Date.now(),
            error: 'outbox entry disappeared before ingest',
            name: tombstoneName(row.name, row.id),
          });
        });
        continue;
      }
      if (scan.kind === 'other') {
        st.fp = null;
        st.since = now;
        continue;
      }
      if (scan.kind !== row.kind) this.setFields(row.id, 'stabilising', { kind: scan.kind });
      const fp = fingerprint(scan);
      if (st.fp !== fp) {
        st.fp = fp;
        st.since = now;
        continue;
      }
      const locallyStable = scan.tmpCount === 0 && scan.files.length > 0 && !(scan.kind === 'file' && topTmp);
      if (!locallyStable) {
        st.since = now;
        continue;
      }
      if (now - st.since >= this.quietMs) candidates.push({ row, st });
    }
    if (candidates.length === 0 || this.stopped) return;

    const gate = await this.syncthingGate();
    if (!gate.ok) {
      for (const c of candidates) c.st.since = Date.now();
      return;
    }
    for (const c of candidates) {
      if (gate.need.some((n) => isUnderEntry(n, c.row.source_name))) {
        c.st.since = Date.now();
        continue;
      }
      await this.withLock(c.row.id, () => this.placeOutboxItem(c.row.id, c.st));
    }
  }

  /** Conditions 1, 3 and 5 of §4 stabilising. Never "ok" without positive confirmation. */
  private async syncthingGate(): Promise<{ ok: true; need: string[] } | { ok: false }> {
    const device = this.cfg.env.SYNCTHING_PC_DEVICE_ID;
    const folder = this.cfg.env.SYNCTHING_FOLDER_ID;
    if (!device) {
      this.warnOnce('no-device', {}, 'SYNCTHING_PC_DEVICE_ID is empty: outbox items will stay in stabilising');
      return { ok: false };
    }
    try {
      const status = await this.syncthing.folderStatus(folder, this.stopCtl.signal);
      if (status.state !== 'idle') {
        this.log.debug({ state: status.state }, 'syncthing folder not idle');
        return { ok: false };
      }
      const comp = await this.syncthing.completion(folder, device, this.stopCtl.signal);
      if (comp.completion !== 100) {
        this.log.debug({ completion: comp.completion }, 'pc completion below 100');
        return { ok: false };
      }
      const need = await this.syncthing.neededNames(folder, this.stopCtl.signal);
      return { ok: true, need };
    } catch (err) {
      this.log.debug({ err: (err as Error).message }, 'syncthing gate unavailable');
      return { ok: false };
    }
  }

  /** stabilising → hashing: hard-link the stable outbox entry into the library. Runs under the item lock. */
  private async placeOutboxItem(id: string, st: StabState): Promise<void> {
    const row = this.getItem(id);
    if (!row || row.status !== 'stabilising' || this.stopped) return;
    const src = this.outboxPath(row.source_name);
    const scan = await scanTree(src);
    if (fingerprint(scan) !== st.fp || scan.tmpCount > 0) {
      st.since = Date.now();
      return;
    }
    if (scan.special.length > 0) {
      this.fail(id, ['stabilising'], 'item contains symlinks or special files; not ingested');
      return;
    }
    for (const f of scan.files) {
      try {
        for (const s of f.segs) validateSegment(s);
      } catch {
        this.fail(id, ['stabilising'], `item contains a file name that is not allowed: ${f.rel}`);
        return;
      }
    }
    for (const d of scan.dirs) {
      try {
        for (const s of d.split('/')) validateSegment(s);
      } catch {
        this.fail(id, ['stabilising'], `item contains a folder name that is not allowed: ${d}`);
        return;
      }
    }
    if (!this.transition(id, ['stabilising'], 'hashing')) return;
    const dst = this.libraryPath(row.name);
    try {
      await hardlinkTree(src, dst, scan);
      // Anything replaced/added while linking? Then the library copy may be inconsistent: undo.
      const after = await scanTree(src);
      if (identityFingerprint(after) !== identityFingerprint(scan)) {
        await rm(dst, { recursive: true, force: true });
        st.fp = null;
        st.since = Date.now();
        this.transition(id, ['hashing'], 'stabilising');
        return;
      }
      this.setFields(id, 'hashing', { library_at: Date.now(), kind: scan.kind as 'file' | 'dir' });
      this.stab.delete(id);
      this.enqueueHash(id);
    } catch (err) {
      const msg = err instanceof PlacementError ? err.message : `placing into the library failed (${errCode(err)})`;
      this.fail(id, ['hashing'], msg);
    }
  }

  // ---------------------------------------------------------------- hashing

  private enqueueHash(id: string): void {
    if (this.stopped || this.hashQueue.includes(id)) return;
    this.hashQueue.push(id);
    if (!this.hashPump) {
      this.hashPump = (async () => {
        while (this.hashQueue.length > 0 && !this.stopped) {
          const next = this.hashQueue.shift()!;
          await this.withLock(next, () => this.hashItem(next)).catch((err) =>
            this.log.error({ itemId: next, err: errCode(err) }, 'hash job failed'),
          );
        }
        this.hashPump = null;
      })();
    }
  }

  private async hashItem(id: string): Promise<void> {
    let row = this.getItem(id);
    if (!row || row.status !== 'hashing' || this.stopped) return;
    const ctl = new AbortController();
    this.aborts.set(id, ctl);
    const lib = this.libraryPath(row.name);
    try {
      if (row.append_batch_id !== null) return await this.appendItem(row, ctl.signal);
      if (row.library_at === null) {
        if (row.source === 'outbox') {
          // Interrupted during placement (restart): we no longer have the stability evidence.
          // Drop the partial library copy (hard links only) and stabilise again.
          await rm(lib, { recursive: true, force: true });
          this.transition(id, ['hashing'], 'stabilising');
          return;
        }
        await this.placeUpload(row);
        row = this.getItem(id)!;
      }
      const scan = await scanTree(lib);
      if (scan.kind === 'missing') return this.fail(id, ['hashing'], 'library copy is missing');
      if (scan.kind !== 'file' && scan.kind !== 'dir') return this.fail(id, ['hashing'], 'library copy is not a file or folder');
      if (scan.special.length > 0) return this.fail(id, ['hashing'], 'item contains symlinks or special files');
      if (scan.files.length === 0) return this.fail(id, ['hashing'], 'item contains no files');
      const total = totalBytes(scan);
      if (total === 0) return this.fail(id, ['hashing'], 'item contains no data');
      const pieceLength = pieceLengthFor(total);
      this.progressMap.set(id, 0);
      const files = scan.files.map((f) => ({
        path: scan.kind === 'file' ? lib : safeJoin(lib, ...f.segs),
        size: f.size,
        mtimeMs: f.mtimeMs,
      }));
      const { pieces, totalBytes: hashed } = await hashPieces(files, pieceLength, (p) => this.progressMap.set(id, p), ctl.signal);
      const after = await scanTree(lib);
      if (hashed !== total || identityFingerprint(after) !== identityFingerprint(scan)) {
        return this.fail(id, ['hashing'], 'library copy changed during hashing; retry');
      }
      const info = buildInfoDict({
        name: row.name,
        kind: scan.kind,
        files: scan.files.map((f) => ({ segs: f.segs, length: f.size })),
        pieceLength,
        pieces,
      });
      const ok = this.transition(id, ['hashing'], 'snapshotting', {
        info,
        piece_length: pieceLength,
        total_bytes: total,
        file_count: scan.files.length,
        kind: scan.kind,
      });
      if (ok) this.requestIngestSnapshot(id);
    } catch (err) {
      if (err instanceof HashAbortedError) return;
      const msg = err instanceof PlacementError ? err.message : `hashing failed: ${err instanceof Error && !('code' in err) ? err.message : errCode(err)}`;
      this.fail(id, ['hashing'], msg);
    } finally {
      this.aborts.delete(id);
      this.progressMap.delete(id);
    }
  }

  /** Upload source: rename staging/<batch>/<entry> into the library (same filesystem). */
  private async placeUpload(row: ItemRow): Promise<void> {
    const src = safeJoin(this.cfg.paths.staging, row.upload_batch_id ?? '', row.source_name);
    const dst = this.libraryPath(row.name);
    const srcExists = await exists(src);
    const dstExists = await exists(dst);
    if (srcExists) {
      if (dstExists) throw new PlacementError('library path already exists');
      await mkdirp0750(this.cfg.paths.library);
      await rename(src, dst);
    } else if (!dstExists) {
      throw new PlacementError('upload source is missing');
    } // else: renamed before a restart
    this.setFields(row.id, 'hashing', { library_at: Date.now() });
    if (row.upload_batch_id) {
      await rmdir(safeJoin(this.cfg.paths.staging, row.upload_batch_id)).catch(() => undefined); // only if empty
    }
  }

  // ---------------------------------------------------------------- add files (append)

  async addFiles(itemId: string, batchId: string): Promise<void> {
    if (typeof batchId !== 'string' || !/^[a-z2-7]{26}$/.test(batchId)) throw new IngestError(400, 'invalid upload round id');
    await this.withLock(itemId, async () => {
      const row = this.getItem(itemId);
      if (!row || row.status === 'deleted') throw new IngestError(404, 'item not found');
      if (row.kind !== 'dir') throw new IngestError(409, 'files can only be added to a folder item');
      if (row.status !== 'ready' || !row.info) throw new IngestError(409, 'files can be added once the item is ready');
      const batch = this.db.prepare('SELECT status FROM upload_batches WHERE id = ?').get(batchId) as { status: string } | undefined;
      if (!batch) throw new IngestError(404, 'upload round not found');
      if (batch.status !== 'open') throw new IngestError(409, 'this upload round was already used; start a new upload');
      const staged = await scanTree(safeJoin(this.cfg.paths.staging, batchId));
      if (staged.kind !== 'dir' || staged.files.length === 0) {
        throw new IngestError(400, 'no finished files in this upload round yet; finish or retry the uploads, then try again');
      }
      if (staged.special.length > 0) throw new IngestError(400, 'the upload contains special files');
      // Planning also checks the stored info is a folder torrent we can extend.
      try {
        planAppend(row.info);
      } catch (err) {
        throw new IngestError(409, (err as Error).message);
      }
      const lib = this.libraryPath(row.name);
      for (const f of staged.files) {
        for (let i = 1; i <= f.segs.length; i++) {
          let st;
          try {
            st = await lstat(safeJoin(lib, ...f.segs.slice(0, i)));
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
            throw err;
          }
          if (i === f.segs.length || !st.isDirectory()) {
            throw new IngestError(409, `“${f.segs.slice(0, i).join('/')}” already exists in “${row.name}”; rename the new file and upload it again`);
          }
        }
      }
      // Close the batch first: later tus finishes for it are rejected.
      const r = this.db
        .prepare("UPDATE upload_batches SET status = 'ingested', updated_at = ? WHERE id = ? AND status = 'open'")
        .run(Date.now(), batchId);
      if (r.changes === 0) throw new IngestError(409, 'this upload round was already used; start a new upload');
      try {
        if (!this.transition(itemId, ['ready'], 'hashing', { append_batch_id: batchId, library_at: Date.now(), error: null })) {
          throw new IngestError(409, 'the item changed; try again');
        }
      } catch (err) {
        this.db.prepare("UPDATE upload_batches SET status = 'open', updated_at = ? WHERE id = ?").run(Date.now(), batchId);
        // items_active_source: a new outbox entry with this item's source name is being ingested.
        if (/UNIQUE constraint failed/.test((err as Error).message)) {
          throw new IngestError(409, 'a new copy of this item is being ingested from the PC outbox; try again once it is done');
        }
        throw err;
      }
      this.log.info({ itemId, batchId, files: staged.files.length }, 'adding files to item');
      this.enqueueHash(itemId);
    });
  }

  /** Hard-link staging/<append batch> into the item's library folder, then drop the staging copy. Idempotent. */
  private async placeAppend(row: ItemRow): Promise<void> {
    const dir = safeJoin(this.cfg.paths.staging, row.append_batch_id!);
    const staged = await scanTree(dir);
    if (staged.kind === 'missing') return; // placed before a restart
    if (staged.kind !== 'dir' || staged.special.length > 0) throw new PlacementError('the upload contains special files');
    const lib = this.libraryPath(row.name);
    for (const f of staged.files) {
      for (const seg of f.segs) validateSegment(seg, { forUpload: true });
      const dst = safeJoin(lib, ...f.segs);
      await mkdirp0750(path.dirname(dst));
      await assertNoSymlinks(lib, path.dirname(dst));
      try {
        await link(safeJoin(dir, ...f.segs), dst); // never overwrites
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw err;
        const st = await lstat(dst);
        if (st.ino !== f.ino || st.dev !== f.dev) throw new PlacementError(`“${f.rel}” already exists in the item`);
      }
    }
    await rm(dir, { recursive: true, force: true });
  }

  /**
   * hashing (append mode): place the new files, then extend the stored info: old pieces are kept,
   * only the old partial last piece (+ pad) and the new files are hashed. Runs under the item lock.
   */
  private async appendItem(row: ItemRow, signal: AbortSignal): Promise<void> {
    const id = row.id;
    if (!row.info) return this.fail(id, ['hashing'], 'internal: torrent info missing');
    await this.placeAppend(row);
    const lib = this.libraryPath(row.name);
    const plan = planAppend(row.info);
    const scan = await scanTree(lib);
    if (scan.kind !== 'dir') return this.fail(id, ['hashing'], 'library copy is missing or not a folder');
    if (scan.special.length > 0) return this.fail(id, ['hashing'], 'item contains symlinks or special files');
    const byRel = new Map(scan.files.map((f) => [f.rel, f]));
    const old = new Set<string>();
    for (const f of plan.layout) {
      if (f.pad) continue;
      const rel = f.segs.join('/');
      old.add(rel);
      if (byRel.get(rel)?.size !== f.length) return this.fail(id, ['hashing'], `“${rel}” changed or is missing in the library copy`);
    }
    const added = scan.files.filter((f) => !old.has(f.rel));
    const real = { total_bytes: totalBytes(scan), file_count: scan.files.length };
    if (added.length === 0) {
      // Already appended (restart or retry after the info was stored): only the snapshot is left.
      if (this.transition(id, ['hashing'], 'snapshotting', real)) {
        await this.deps.p2p.refreshItemShares(id);
        this.requestIngestSnapshot(id);
      }
      return;
    }
    const sources: HashSource[] = tailRanges(plan).map((t) => {
      const f = byRel.get(t.segs.join('/'))!;
      return { path: safeJoin(lib, ...t.segs), size: f.size, mtimeMs: f.mtimeMs, start: t.start, length: t.length };
    });
    if (plan.padLength > 0) sources.push({ zeros: plan.padLength });
    for (const f of added) sources.push({ path: safeJoin(lib, ...f.segs), size: f.size, mtimeMs: f.mtimeMs });
    this.progressMap.set(id, 0);
    const { pieces } = await hashPieces(sources, plan.pieceLength, (p) => this.progressMap.set(id, p), signal);
    const after = await scanTree(lib);
    if (identityFingerprint(after) !== identityFingerprint(scan)) return this.fail(id, ['hashing'], 'library copy changed during hashing; retry');
    const all = new Uint8Array(plan.keptPieces.length + pieces.length);
    all.set(plan.keptPieces, 0);
    all.set(pieces, plan.keptPieces.length);
    const info = buildAppendedInfo(row.info, plan.padLength, added.map((f) => ({ segs: f.segs, length: f.size })), all);
    if (!this.transition(id, ['hashing'], 'snapshotting', { info, ...real })) return;
    this.log.info({ itemId: id, added: added.length, pad: plan.padLength }, 'files added to item');
    await this.deps.p2p.refreshItemShares(id);
    this.requestIngestSnapshot(id);
  }

  // ---------------------------------------------------------------- snapshotting + outbox removal

  private requestIngestSnapshot(id: string): void {
    requestSnapshot(this.db, 'ingest', id);
    this.lastRequestAt.set(id, Date.now());
  }

  private async snapshotPoll(): Promise<void> {
    for (const row of this.itemsWithStatus('snapshotting')) {
      if (this.stopped) return;
      await this.withLock(row.id, () => this.snapshotStep(row.id)).catch((err) =>
        this.log.error({ itemId: row.id, err: errCode(err) }, 'snapshot step failed'),
      );
    }
  }

  private async snapshotStep(id: string): Promise<void> {
    const row = this.getItem(id);
    if (!row || row.status !== 'snapshotting' || this.stopped) return;
    if (row.library_at === null) return this.fail(id, ['snapshotting'], 'internal: library time missing');
    let runId = row.snapshot_run_id;
    if (runId === null) {
      const run = findCoveringBackup(this.db, row.name, row.library_at);
      if (!run) {
        this.ensureSnapshotRequested(row);
        return;
      }
      runId = run.id;
      if (!this.setFields(id, 'snapshotting', { snapshot_run_id: runId })) return;
      this.log.info({ itemId: id, name: row.name, runId }, 'item covered by snapshot');
    }
    if (row.append_batch_id !== null) {
      // Files were added to a ready item: its outbox entry is long gone (an entry of the same name
      // now would be a new item). Make sure every share carries the new info, then done.
      await this.deps.p2p.refreshItemShares(id);
      this.transition(id, ['snapshotting'], 'ready', { ready_at: Date.now(), error: null, append_batch_id: null });
      this.lastRequestAt.delete(id);
      return;
    }
    if (row.source === 'outbox') {
      // The invariant: only now (verified in library AND covered by a successful snapshot)
      // may the outbox copy go — and only if it is still exactly the hard-linked tree.
      const res = await removeVerifiedOutboxEntry(this.outboxPath(row.source_name), this.libraryPath(row.name), this.trashPath(id));
      if (res.result === 'mismatch') {
        this.log.warn({ itemId: id, name: row.name, reason: res.reason, restored: res.restored }, 'outbox verification failed');
        this.fail(id, ['snapshotting'], OUTBOX_CHANGED_ERROR);
        return;
      }
      this.log.info({ itemId: id, name: row.name, result: res.result }, 'outbox entry handled');
    }
    this.transition(id, ['snapshotting'], 'ready', { ready_at: Date.now(), error: null });
    this.lastRequestAt.delete(id);
  }

  private ensureSnapshotRequested(row: ItemRow): void {
    const pending = this.db
      .prepare(
        `SELECT 1 FROM backup_requests r LEFT JOIN backup_runs b ON b.id = r.run_id
         WHERE r.item_id = ? AND r.reason = 'ingest' AND r.requested_at >= ?
           AND (r.run_id IS NULL OR b.status = 'running') LIMIT 1`,
      )
      .get(row.id, row.library_at ?? 0);
    if (pending) return;
    const last = this.lastRequestAt.get(row.id);
    if (last !== undefined && Date.now() - last < this.rerequestMs) return;
    this.requestIngestSnapshot(row.id);
  }

  // ---------------------------------------------------------------- admin operations

  async retry(itemId: string): Promise<void> {
    await this.withLock(itemId, async () => {
      const row = this.getItem(itemId);
      if (!row || row.status === 'deleted') throw new IngestError(404, 'item not found');
      if (row.status !== 'error') throw new IngestError(409, 'only failed items can be retried');
      let target: ItemStatus;
      if (row.append_batch_id !== null) {
        target = 'hashing'; // append mode finds out what is left to do (§4 "add files")
      } else if (row.source === 'outbox' && row.library_at === null) {
        await rm(this.libraryPath(row.name), { recursive: true, force: true }); // partial hard links only
        target = 'stabilising';
      } else if (row.info === null) {
        target = 'hashing';
      } else {
        target = 'snapshotting';
      }
      if (!this.transition(itemId, ['error'], target, { error: null })) return;
      if (target === 'stabilising') this.stab.set(itemId, { sourceName: row.source_name, fp: null, since: Date.now() });
      if (target === 'hashing') this.enqueueHash(itemId);
    });
  }

  async renameItem(itemId: string, newName: string): Promise<void> {
    if (typeof newName !== 'string') throw new NameError('name must be a string');
    // Item names become torrent names and webseed paths: apply the strict (upload) rules.
    const name = validateSegment(newName, { forUpload: true });
    let renamedOnDisk = false;
    let oldName = '';
    await this.withLock(itemId, async () => {
      const row = this.getItem(itemId);
      if (!row || row.status === 'deleted') throw new IngestError(404, 'item not found');
      if (row.status === 'hashing' || row.status === 'snapshotting') throw new IngestError(409, 'item is busy; try again when it is ready');
      if (name === row.name) return;
      if (await this.nameTaken(name, itemId)) throw new IngestError(409, 'an item with this name already exists');
      oldName = row.name;
      const from = this.libraryPath(row.name);
      const to = this.libraryPath(name);
      const onDisk = row.library_at !== null && (await exists(from));
      if (onDisk) {
        if (await exists(to)) throw new IngestError(409, 'an item with this name already exists');
        await rename(from, to);
      }
      try {
        const info = row.info ? renameInfoDict(row.info, name) : null;
        const r = this.db
          .prepare('UPDATE items SET name = ?, info = COALESCE(?, info), updated_at = ? WHERE id = ? AND status = ?')
          .run(name, info, Date.now(), itemId, row.status);
        if (r.changes === 0) throw new IngestError(409, 'item changed; try again');
      } catch (err) {
        if (onDisk) await rename(to, from).catch(() => undefined);
        if (err instanceof IngestError) throw err;
        if (/UNIQUE constraint failed/.test((err as Error).message)) throw new IngestError(409, 'an item with this name already exists');
        throw err;
      }
      renamedOnDisk = onDisk;
      this.log.info({ itemId, oldName, newName: name }, 'item renamed');
      this.ctx.events.emit('item.renamed', { itemId, oldName, newName: name });
    });
    if (renamedOnDisk) {
      await this.deps.p2p.repointItem(itemId);
      requestSnapshot(this.db, 'rename', itemId);
    }
  }

  /**
   * An outbox item that is not ready still has its outbox entry (removed only after a covering
   * snapshot). Deleting just the library copy would make the next scan ingest the entry again, and
   * we never delete an outbox entry that isn't snapshotted. So: refuse, except for `error` items
   * whose outbox entry is already gone.
   */
  private async assertDeletable(row: ItemRow): Promise<void> {
    // An item that is having files added left the outbox long ago.
    if (row.source !== 'outbox' || row.status === 'ready' || row.append_batch_id !== null) return;
    if (row.status !== 'error') throw new IngestError(409, STILL_IN_OUTBOX);
    if (await exists(this.outboxPath(row.source_name))) throw new IngestError(409, ERROR_STILL_IN_OUTBOX);
  }

  async deleteItem(itemId: string): Promise<void> {
    const pre = this.getItem(itemId);
    if (!pre || pre.status === 'deleted') throw new IngestError(404, 'item not found');
    await this.assertDeletable(pre);
    // Stop in-flight work first so we don't wait for a long hash.
    this.aborts.get(itemId)?.abort();
    this.hashQueue = this.hashQueue.filter((x) => x !== itemId);
    this.stab.delete(itemId);
    await this.withLock(itemId, async () => {
      const row = this.getItem(itemId);
      if (!row || row.status === 'deleted') throw new IngestError(404, 'item not found');
      await this.assertDeletable(row);
      await this.deps.p2p.revokeAllForItem(itemId);
      // The name is reserved for this item, so anything at its library path is ours.
      await rm(this.libraryPath(row.name), { recursive: true, force: true });
      if (row.source === 'upload' && row.library_at === null && row.upload_batch_id) {
        await rm(safeJoin(this.cfg.paths.staging, row.upload_batch_id, row.source_name), { recursive: true, force: true });
      }
      if (row.append_batch_id !== null) {
        await rm(safeJoin(this.cfg.paths.staging, row.append_batch_id), { recursive: true, force: true });
      }
      const all: ItemStatus[] = ['incoming', 'stabilising', 'hashing', 'snapshotting', 'ready', 'error'];
      // The row keeps a tombstone name so the real name can be used again by a new item.
      if (!this.transition(itemId, all, 'deleted', { deleted_at: Date.now(), name: tombstoneName(row.name, itemId) })) return;
      this.ctx.events.emit('item.deleted', { itemId });
      requestSnapshot(this.db, 'delete', itemId);
    });
  }

  // ---------------------------------------------------------------- uploads

  async registerAdminRoutes(app: FastifyInstance): Promise<void> {
    const r = await registerUploadRoutes(app, this.ctx, { completeBatch: (id) => this.completeBatch(id) });
    this.cleanupUploads = r.cleanup;
  }

  /** Turn every top-level entry of staging/<batch> into an item (straight to hashing). */
  async completeBatch(batchId: string): Promise<{ itemIds: string[] }> {
    const batch = this.db.prepare('SELECT status FROM upload_batches WHERE id = ?').get(batchId) as { status: string } | undefined;
    if (!batch) throw new UploadsHttpError(404, 'not_found');
    if (batch.status !== 'open' && batch.status !== 'complete') {
      throw new UploadsHttpError(409, 'batch_not_open', 'this upload round was already added to the library (or failed); start a new upload');
    }
    const dir = safeJoin(this.cfg.paths.staging, batchId);
    let entries: string[] = [];
    try {
      entries = (await readdir(dir)).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (batch.status === 'open') {
      if (entries.length === 0) {
        throw new UploadsHttpError(400, 'batch_empty', 'no finished files in this upload round yet; finish or retry the uploads, then try again');
      }
      // Close the batch first: later tus finishes for it are rejected.
      const r = this.db
        .prepare("UPDATE upload_batches SET status = 'complete', updated_at = ? WHERE id = ? AND status = 'open'")
        .run(Date.now(), batchId);
      if (r.changes === 0) throw new UploadsHttpError(409, 'batch_not_open');
      // Re-list: an upload may have finished between the first listing and closing the batch.
      try {
        entries = (await readdir(dir)).sort();
      } catch {
        /* keep the previous list */
      }
    }
    const itemIds: string[] = [];
    const existing = this.db.prepare("SELECT id FROM items WHERE source = 'upload' AND upload_batch_id = ? AND source_name = ?");
    try {
      for (const entry of entries) {
        const prev = existing.get(batchId, entry) as { id: string } | undefined;
        if (prev) {
          itemIds.push(prev.id);
          continue;
        }
        const base = validateSegment(entry, { forUpload: true });
        const st = await lstat(safeJoin(dir, entry));
        if (!st.isFile() && !st.isDirectory()) continue;
        const id = await this.insertItem({
          baseName: base,
          kind: st.isDirectory() ? 'dir' : 'file',
          source: 'upload',
          sourceName: entry,
          batchId,
          status: 'hashing',
        });
        itemIds.push(id);
        this.enqueueHash(id);
      }
      this.db.prepare("UPDATE upload_batches SET status = 'ingested', updated_at = ? WHERE id = ?").run(Date.now(), batchId);
    } catch (err) {
      this.db.prepare("UPDATE upload_batches SET status = 'failed', updated_at = ? WHERE id = ?").run(Date.now(), batchId);
      this.log.error({ batchId, err: errCode(err) }, 'completing upload batch failed');
      throw err;
    }
    this.log.info({ batchId, items: itemIds.length }, 'upload batch ingested');
    return { itemIds };
  }

  progress(): Record<string, number> {
    return Object.fromEntries(this.progressMap);
  }
}

export function createIngest(ctx: AppContext, deps: IngestDeps, opts: IngestOptions = {}): IngestService {
  return new Ingest(ctx, deps, opts);
}
