// Share lifecycle: create/update/revoke, seedlinks, token authorisation, expiry (docs/ARCHITECTURE.md §2, §3, §9).
import argon2 from 'argon2';
import { lstat, mkdir, readdir, readlink, rename, rmdir, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { newRecipientId, newShareId, SHARE_ID_RE } from '../core/ids.js';
import { safeJoin } from '../core/paths.js';
import { makeShareToken, verifyShareToken } from '../core/tokens.js';
import type { ItemRow, ShareRow } from '../db/index.js';
import { SHAREABLE_STATUSES, type ShareDto, type ShareEventType, type ShareStatsDto } from '../types.js';
import { buildShareInfo, parseInfo, sharePageUrl, type ParsedInfo } from './metainfo.js';

export type ShareState = 'active' | 'expired' | 'revoked';

export class P2PError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function shareState(row: Pick<ShareRow, 'revoked_at' | 'expires_at'>, now: number): ShareState {
  if (row.revoked_at !== null) return 'revoked';
  if (row.expires_at !== null && row.expires_at <= now) return 'expired';
  return 'active';
}

export type AuthResult =
  /** `recipient`: the named recipient a recipient token was issued to (absent for plain tokens). */
  | { ok: true; share: ShareRow; recipient?: { id: string; name: string } }
  /** `invalid`: bad MAC or stale token_version. `gone`: unknown, revoked or expired. */
  | { ok: false; reason: 'invalid' | 'gone' };

export interface ArgonOptions {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

const DEFAULT_ARGON: ArgonOptions = { memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 };
const MAX_PASSWORD_CHARS = 1024;
/** Named recipients per share; beyond this, unlock hands out plain (unnamed) tokens. */
export const MAX_RECIPIENTS_PER_SHARE = 1000;

export type { ShareEventType };

export class ShareStore {
  private readonly infoCache = new Map<string, ParsedInfo>();
  private readonly argon: ArgonOptions;

  constructor(
    private readonly ctx: AppContext,
    opts: { argon?: Partial<ArgonOptions> } = {},
  ) {
    this.argon = { ...DEFAULT_ARGON, ...opts.argon };
  }

  private get db() {
    return this.ctx.db;
  }

  private hmacKey(): string {
    return this.ctx.config.secret('share-hmac-key');
  }

  // ---------- reads ----------

  getRow(id: string): ShareRow | undefined {
    if (typeof id !== 'string' || !SHARE_ID_RE.test(id)) return undefined;
    return this.db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as ShareRow | undefined;
  }

  allRows(): ShareRow[] {
    return this.db.prepare('SELECT * FROM shares ORDER BY created_at DESC').all() as ShareRow[];
  }

  activeRows(now = Date.now()): ShareRow[] {
    return this.db
      .prepare('SELECT * FROM shares WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)')
      .all(now) as ShareRow[];
  }

  item(itemId: string): ItemRow | undefined {
    return this.db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as ItemRow | undefined;
  }

  /** Parsed share info, cached per infohash (it changes when files are added to the item). */
  info(row: Pick<ShareRow, 'info_hash' | 'info'>): ParsedInfo {
    let p = this.infoCache.get(row.info_hash);
    if (!p) {
      p = parseInfo(row.info);
      this.infoCache.set(row.info_hash, p);
    }
    return p;
  }

  /** Plain token, or a recipient token when `recipientId` is given (§9). */
  token(row: Pick<ShareRow, 'id' | 'token_version'>, recipientId?: string): string {
    return makeShareToken(this.hmacKey(), row.id, row.token_version, recipientId);
  }

  /**
   * The recipient id for (share, name): reused for the same name, created otherwise. Undefined once
   * the share has MAX_RECIPIENTS_PER_SHARE names (random-name spam can't grow the table without bound).
   */
  recipientId(shareId: string, name: string, now = Date.now()): string | undefined {
    return this.db.transaction(() => {
      const found = this.db.prepare('SELECT id FROM share_recipients WHERE share_id = ? AND name = ?').get(shareId, name) as
        | { id: string }
        | undefined;
      if (found) return found.id;
      const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM share_recipients WHERE share_id = ?').get(shareId) as { n: number };
      if (n >= MAX_RECIPIENTS_PER_SHARE) return undefined;
      const id = newRecipientId();
      this.db.prepare('INSERT INTO share_recipients (id, share_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, shareId, name, now);
      return id;
    })();
  }

  /**
   * Verify a share token: MAC first (constant time), then the share's state on every use (§9).
   */
  authorize(token: string, now = Date.now()): AuthResult {
    const parsed = verifyShareToken(this.hmacKey(), token);
    if (!parsed) return { ok: false, reason: 'invalid' };
    const share = this.getRow(parsed.shareId);
    if (!share || shareState(share, now) !== 'active') return { ok: false, reason: 'gone' };
    if (share.token_version !== parsed.tokenVersion) return { ok: false, reason: 'invalid' };
    if (parsed.recipientId === undefined) return { ok: true, share };
    const r = this.db.prepare('SELECT name FROM share_recipients WHERE id = ? AND share_id = ?').get(parsed.recipientId, share.id) as
      | { name: string }
      | undefined;
    if (!r) return { ok: false, reason: 'invalid' };
    return { ok: true, share, recipient: { id: parsed.recipientId, name: r.name } };
  }

  toDto(row: ShareRow, stats: ShareStatsDto, now = Date.now()): ShareDto {
    const item = this.item(row.item_id);
    return {
      id: row.id,
      itemId: row.item_id,
      itemName: item?.name ?? row.torrent_name,
      torrentName: row.torrent_name,
      infoHash: row.info_hash,
      url: sharePageUrl(this.ctx.config, row.id),
      hasPassword: row.password_hash !== null,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
      state: shareState(row, now),
      stats,
    };
  }

  // ---------- events ----------

  event(shareId: string, type: ShareEventType, detail?: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO share_events (share_id, at, type, detail) VALUES (?, ?, ?, ?)')
      .run(shareId, Date.now(), type, detail ? JSON.stringify(detail) : null);
  }

  // ---------- mutations ----------

  private validatePassword(pw: unknown): string {
    if (typeof pw !== 'string' || pw.length === 0 || pw.length > MAX_PASSWORD_CHARS) {
      throw new P2PError(400, `password must be 1–${MAX_PASSWORD_CHARS} characters`);
    }
    return pw;
  }

  private validateExpiry(v: unknown, now: number): number {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new P2PError(400, 'expiresAt must be an integer (ms since epoch)');
    if (v <= now) throw new P2PError(400, 'expiresAt must be in the future');
    return v;
  }

  async hashPassword(pw: string): Promise<string> {
    return argon2.hash(pw, { type: argon2.argon2id, ...this.argon });
  }

  /** argon2 verify only. Never throws for a malformed hash (returns false). */
  async verifyPassword(hash: string, pw: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, pw);
    } catch {
      return false;
    }
  }

  async create(input: { itemId: string; password?: string; expiresAt?: number }): Promise<ShareRow> {
    const now = Date.now();
    if (typeof input?.itemId !== 'string') throw new P2PError(400, 'itemId required');
    const item = this.item(input.itemId);
    if (!item || item.status === 'deleted') throw new P2PError(404, 'item not found');
    if (!SHAREABLE_STATUSES.includes(item.status) || !item.info) throw new P2PError(409, 'item is not ready');
    const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? null : this.validateExpiry(input.expiresAt, now);
    const passwordHash =
      input.password === undefined || input.password === null ? null : await this.hashPassword(this.validatePassword(input.password));

    const id = newShareId();
    const built = buildShareInfo(item.info, item.name, id);
    const row: ShareRow = {
      id,
      item_id: item.id,
      info_hash: built.infoHash,
      torrent_name: built.name,
      info: built.info,
      password_hash: passwordHash,
      token_version: 1,
      expires_at: expiresAt,
      revoked_at: null,
      created_at: now,
      updated_at: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO shares (id, item_id, info_hash, torrent_name, info, password_hash, token_version, expires_at, revoked_at, created_at, updated_at)
           VALUES (@id, @item_id, @info_hash, @torrent_name, @info, @password_hash, @token_version, @expires_at, @revoked_at, @created_at, @updated_at)`,
        )
        .run(row);
      this.db.prepare('INSERT INTO share_stats (share_id) VALUES (?)').run(id);
      this.event(id, 'created', { password: passwordHash !== null, expiresAt });
    })();
    try {
      await this.ensureSeedlink(row, item);
    } catch (err) {
      this.ctx.log.warn({ shareId: id, err: (err as Error).message }, 'p2p: seedlink create failed');
    }
    return row;
  }

  async update(id: string, patch: { password?: string | null; expiresAt?: number | null }): Promise<ShareRow> {
    const now = Date.now();
    const row = this.getRow(id);
    if (!row) throw new P2PError(404, 'share not found');
    if (row.revoked_at !== null) throw new P2PError(409, 'share is revoked');
    const p = patch ?? {};
    let passwordHash = row.password_hash;
    let tokenVersion = row.token_version;
    let expiresAt = row.expires_at;
    const detail: Record<string, unknown> = {};
    if (p.password !== undefined) {
      passwordHash = p.password === null ? null : await this.hashPassword(this.validatePassword(p.password));
      tokenVersion += 1; // invalidates every issued token
      detail.password = p.password === null ? 'cleared' : 'set';
    }
    if (p.expiresAt !== undefined) {
      expiresAt = p.expiresAt === null ? null : this.validateExpiry(p.expiresAt, now);
      detail.expiresAt = expiresAt;
    }
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE shares SET password_hash = ?, token_version = ?, expires_at = ?, updated_at = ? WHERE id = ?')
        .run(passwordHash, tokenVersion, expiresAt, now, id);
      this.event(id, 'updated', detail);
    })();
    return this.getRow(id)!;
  }

  /** Returns true if the share was active-or-expired and is now revoked. */
  async revoke(id: string): Promise<boolean> {
    const row = this.getRow(id);
    if (!row) throw new P2PError(404, 'share not found');
    if (row.revoked_at !== null) return false;
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare('UPDATE shares SET revoked_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
      this.event(id, 'revoked');
    })();
    await this.removeSeedlink(id).catch((err: Error) =>
      this.ctx.log.warn({ shareId: id, err: err.message }, 'p2p: seedlink removal failed'),
    );
    return true;
  }

  async revokeAllForItem(itemId: string): Promise<string[]> {
    const ids = (this.db.prepare('SELECT id FROM shares WHERE item_id = ? AND revoked_at IS NULL').all(itemId) as { id: string }[]).map(
      (r) => r.id,
    );
    const done: string[] = [];
    for (const id of ids) if (await this.revoke(id)) done.push(id);
    return done;
  }

  /** Shares that expired since their last update and have no 'expired' event yet. Records the event. */
  sweepExpired(now = Date.now()): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM shares s WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?
           AND NOT EXISTS (SELECT 1 FROM share_events e WHERE e.share_id = s.id AND e.type = 'expired' AND e.at >= s.updated_at)`,
      )
      .all(now) as { id: string }[];
    for (const r of rows) this.event(r.id, 'expired');
    return rows.map((r) => r.id);
  }

  // ---------- seedlinks: /state/seedlinks/<shareId>/<torrent_name> -> /data/library/<item.name> ----------

  private seedlinkDir(shareId: string): string {
    if (!SHARE_ID_RE.test(shareId)) throw new P2PError(400, 'bad share id');
    return safeJoin(this.ctx.config.paths.seedlinks, shareId);
  }

  seedRoot(shareId: string): string {
    return this.seedlinkDir(shareId);
  }

  /** Idempotently (re)create the seedlink so it points at the item's current library path. */
  async ensureSeedlink(row: Pick<ShareRow, 'id' | 'item_id' | 'torrent_name'>, item = this.item(row.item_id)): Promise<void> {
    if (!item || item.status === 'deleted') throw new P2PError(409, 'item missing');
    const dir = this.seedlinkDir(row.id);
    const link = safeJoin(dir, row.torrent_name);
    if (path.dirname(link) !== dir) throw new P2PError(400, 'bad torrent name');
    const target = safeJoin(this.ctx.config.paths.library, item.name);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    try {
      const st = await lstat(link);
      if (st.isSymbolicLink() && (await readlink(link)) === target) return;
      if (!st.isSymbolicLink()) throw new P2PError(500, 'seedlink path is not a symlink');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // Atomic replace: create a temp link next to it, then rename over.
    const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}`);
    await symlink(target, tmp);
    await rename(tmp, link);
  }

  /** Remove the share's seedlink dir. Only unlinks symlinks; never recursive, never follows links. */
  async removeSeedlink(shareId: string): Promise<void> {
    const dir = this.seedlinkDir(shareId);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const p = path.join(dir, e);
      if ((await lstat(p)).isSymbolicLink()) await unlink(p);
    }
    await rmdir(dir);
  }

  /**
   * Files were added to the item: give every non-revoked share of it the item's new info (same
   * share id, token and frozen torrent_name, new infohash). Idempotent. Returns the changed shares
   * with their previous infohash.
   */
  refreshItem(itemId: string): { id: string; oldInfoHash: string }[] {
    const item = this.item(itemId);
    if (!item || item.status === 'deleted' || !item.info) return [];
    const rows = this.db.prepare('SELECT * FROM shares WHERE item_id = ? AND revoked_at IS NULL').all(itemId) as ShareRow[];
    const changed: { id: string; oldInfoHash: string }[] = [];
    const now = Date.now();
    for (const r of rows) {
      const built = buildShareInfo(item.info, r.torrent_name, r.id);
      if (built.infoHash === r.info_hash) continue;
      const files = parseInfo(built.info).files.length;
      this.db.transaction(() => {
        this.db.prepare('UPDATE shares SET info = ?, info_hash = ?, updated_at = ? WHERE id = ?').run(built.info, built.infoHash, now, r.id);
        this.event(r.id, 'updated', { content: 'files_added', files });
      })();
      this.infoCache.delete(r.info_hash);
      changed.push({ id: r.id, oldInfoHash: r.info_hash });
    }
    return changed;
  }

  async repointItem(itemId: string): Promise<void> {
    const item = this.item(itemId);
    if (!item) return;
    const rows = this.db.prepare('SELECT * FROM shares WHERE item_id = ? AND revoked_at IS NULL').all(itemId) as ShareRow[];
    for (const r of rows) await this.ensureSeedlink(r, item);
  }
}
