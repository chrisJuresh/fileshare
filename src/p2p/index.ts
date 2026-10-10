// OWNER: p2p builder. Contract: docs/ARCHITECTURE.md §7.1, §8–§11, §13.
//
// Wiring: ShareStore (DB + seedlinks) ─ Limiter (one upload bucket) ─ Seeder (WebTorrent) ─
// TrackerService (bittorrent-tracker, mounted on the public app) ─ webseed ─ SwarmStats (live WS +
// share_stats). Every change to a share goes through `reconcile()`, which seeds/unseeds, drops tracker
// swarms and closes stale sockets.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Transform } from 'node:stream';
import type { AppContext } from '../context.js';
import { getSetting } from '../db/index.js';
import type { ShareDto, SwarmSnapshot } from '../types.js';
import { Limiter } from './limiter.js';
import { DEFAULT_UNLOCK_LIMITS, UnlockRateLimiter, type UnlockLimits } from './ratelimit.js';
import { registerShareApi } from './routes.js';
import { internalAnnounceHost, Seeder } from './seeder.js';
import { P2PError, shareState, ShareStore, type ArgonOptions } from './shares.js';
import { SwarmStats, type SwarmTimings } from './swarm.js';
import { scrub, TrackerService } from './tracker.js';
import { registerWebseed, type WebseedControl } from './webseed.js';

export { P2PError } from './shares.js';

export interface UploadLimiter {
  setRate(bytesPerSec: number): void;
  throttle(): Transform;
  currentBps(): number;
}

export interface P2PService {
  start(): Promise<void>;
  stop(): Promise<void>;
  registerPublicRoutes(app: FastifyInstance): Promise<void>;
  createShare(input: { itemId: string; password?: string; expiresAt?: number }): Promise<ShareDto>;
  updateShare(id: string, patch: { password?: string | null; expiresAt?: number | null }): Promise<ShareDto>;
  revokeShare(id: string): Promise<void>;
  revokeAllForItem(itemId: string): Promise<void>;
  repointItem(itemId: string): Promise<void>;
  getShare(id: string): ShareDto | undefined;
  listShares(): ShareDto[];
  swarm(shareId: string): SwarmSnapshot | undefined;
  allSwarms(): Record<string, SwarmSnapshot>;
  limiter: UploadLimiter;
}

export interface P2POptions {
  /** Run the WebTorrent seeder (default true). */
  seeder?: boolean;
  sweepIntervalMs?: number;
  flushIntervalMs?: number;
  tickIntervalMs?: number;
  argon?: Partial<ArgonOptions>;
  unlockLimits?: UnlockLimits;
  /** WebRTC ICE bind address (default 0.0.0.0). */
  rtcBindAddress?: string;
  /** Live stats socket timings (tests). */
  live?: Partial<SwarmTimings>;
  /** Webseed: drop responses whose socket made no progress for this long (default 60 s). */
  webseedIdleMs?: number;
}

export const CAP_SETTING = 'upload.cap_bps';

export class P2P implements P2PService {
  readonly limiter = new Limiter();
  readonly shares: ShareStore;
  readonly tracker: TrackerService;
  readonly stats: SwarmStats;
  readonly unlockLimiter: UnlockRateLimiter;
  seeder: Seeder | undefined;

  private readonly internalSecret = randomBytes(18).toString('base64url');
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly unsubs: (() => void)[] = [];
  private readonly chains = new Map<string, Promise<void>>();
  private readonly log;
  private app: FastifyInstance | undefined;
  private webseed: WebseedControl | undefined;
  private started = false;
  private listening = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: P2POptions = {},
  ) {
    this.log = ctx.log.child({ mod: 'p2p' });
    this.shares = new ShareStore(ctx, { argon: opts.argon });
    this.unlockLimiter = new UnlockRateLimiter(opts.unlockLimits ?? DEFAULT_UNLOCK_LIMITS);
    this.tracker = new TrackerService(ctx, this.shares, {
      internalSecret: this.internalSecret,
      serverPeerId: () => this.seeder?.peerId,
      onAnnounce: (a) => this.stats.onAnnounce(a),
      announceIp: ctx.config.env.WEBRTC_ANNOUNCE_IP.trim(),
      webrtcPort: ctx.config.env.WEBRTC_PORT,
    });
    this.stats = new SwarmStats(ctx, {
      shares: this.shares,
      seedTorrent: (id) => this.seeder?.torrent(id),
      serverPeerId: () => this.seeder?.peerId,
    }, opts.live);
  }

  // ---------- lifecycle ----------

  async registerPublicRoutes(app: FastifyInstance): Promise<void> {
    this.app = app;
    await registerShareApi(app, this.ctx, { shares: this.shares, unlockLimiter: this.unlockLimiter });
    await this.tracker.register(app);
    this.webseed = await registerWebseed(app, this.ctx, {
      shares: this.shares,
      limiter: this.limiter,
      onBytes: (id, n) => this.stats.addWebseed(id, n),
      idleTimeoutMs: this.opts.webseedIdleMs,
    });
    await this.stats.register(app);
    // The seeder announces to this listener over loopback, so only add torrents once it listens.
    app.addHook('onListen', async () => {
      this.listening = true;
      if (this.started) await this.syncSeeder();
    });
  }

  private applyCap(): void {
    const v = getSetting<unknown>(this.ctx.db, CAP_SETTING);
    this.limiter.setRate(typeof v === 'number' ? v : Number.POSITIVE_INFINITY);
    this.log.info({ capBps: this.limiter.rate() }, 'upload cap applied');
  }

  async start(): Promise<void> {
    if (this.started) return;
    const { config } = this.ctx;
    this.applyCap();
    this.unsubs.push(
      this.ctx.events.on('settings.changed', ({ key }) => {
        if (key === CAP_SETTING) this.applyCap();
      }),
      this.ctx.events.on('share.changed', ({ shareId }) => void this.reconcile(shareId)),
    );
    if (this.opts.seeder !== false) {
      this.seeder = new Seeder(this.ctx, this.shares, this.limiter, {
        btPort: config.env.BT_PORT,
        webrtcPort: config.env.WEBRTC_PORT,
        stunUrls: config.stunUrls,
        internalHost: internalAnnounceHost(config.env.PUBLIC_BIND, config.env.PUBLIC_PORT),
        internalSecret: this.internalSecret,
        rtcBindAddress: this.opts.rtcBindAddress,
        onUpload: (id, n) => {
          this.limiter.record(n);
          this.stats.addP2p(id, n);
        },
      });
      await this.seeder.start();
    }
    this.started = true;
    if (this.listening || this.app?.server.listening) await this.syncSeeder();

    const every = (ms: number, fn: () => void | Promise<void>) => {
      const t = setInterval(() => {
        Promise.resolve()
          .then(fn)
          .catch((err: Error) => this.log.warn({ err: scrub(err?.message) }, 'p2p periodic task failed'));
      }, ms);
      t.unref();
      this.timers.push(t);
    };
    every(this.opts.sweepIntervalMs ?? 30_000, () => this.sweep());
    every(this.opts.flushIntervalMs ?? 10_000, () => this.stats.flush());
    every(this.opts.tickIntervalMs ?? 1_500, () => this.stats.tick(this.seeder?.shareIds() ?? []));
    every(60_000, () => this.unlockLimiter.prune());
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.started = false;
    this.stats.flush();
    this.stats.closeAll();
    this.tracker.close();
    await this.seeder?.stop();
    this.seeder = undefined;
  }

  private async syncSeeder(): Promise<void> {
    const active = this.shares.activeRows();
    for (const r of active) {
      await this.shares.ensureSeedlink(r).catch((err: Error) => this.log.warn({ shareId: r.id, err: err.message }, 'seedlink failed'));
    }
    await this.seeder?.sync(active);
  }

  /** Expiry sweep: record + announce newly expired shares; unseed anything no longer active. */
  async sweep(): Promise<void> {
    for (const id of this.shares.sweepExpired()) this.ctx.events.emit('share.changed', { shareId: id, reason: 'expired' });
    const now = Date.now();
    for (const id of this.seeder?.shareIds() ?? []) {
      const row = this.shares.getRow(id);
      if (!row || shareState(row, now) !== 'active') await this.reconcile(id);
    }
  }

  /** Bring seeder / tracker / live sockets in line with the share's DB state. Serialised per share. */
  reconcile(shareId: string): Promise<void> {
    const prev = this.chains.get(shareId) ?? Promise.resolve();
    const next = prev
      .then(() => this.doReconcile(shareId))
      .catch((err: Error) => this.log.warn({ shareId, err: scrub(err?.message) }, 'reconcile failed'));
    this.chains.set(shareId, next);
    void next.then(() => {
      if (this.chains.get(shareId) === next) this.chains.delete(shareId);
    });
    return next;
  }

  private async doReconcile(shareId: string): Promise<void> {
    const row = this.shares.getRow(shareId);
    if (!row) return;
    if (shareState(row, Date.now()) === 'active') {
      this.tracker.closeStale(row.id, row.token_version);
      this.stats.closeStale(row.id, row.token_version);
      this.webseed?.closeStale(row.id, row.token_version);
      if (this.seeder && this.started && (this.listening || this.app?.server.listening)) {
        await this.shares.ensureSeedlink(row);
        await this.seeder.ensure(row);
      }
    } else {
      this.webseed?.closeShare(row.id);
      await this.seeder?.remove(row.id);
      this.tracker.dropShare(row.id, row.info_hash);
      this.stats.closeShare(row.id, 4404);
    }
  }

  // ---------- shares ----------

  private dto(id: string): ShareDto {
    const row = this.shares.getRow(id);
    if (!row) throw new P2PError(404, 'share not found');
    return this.shares.toDto(row, this.stats.statsDto(id));
  }

  async createShare(input: { itemId: string; password?: string; expiresAt?: number }): Promise<ShareDto> {
    const row = await this.shares.create(input);
    this.ctx.events.emit('share.changed', { shareId: row.id, reason: 'created' });
    await this.reconcile(row.id);
    return this.dto(row.id);
  }

  async updateShare(id: string, patch: { password?: string | null; expiresAt?: number | null }): Promise<ShareDto> {
    const row = await this.shares.update(id, patch);
    this.ctx.events.emit('share.changed', { shareId: row.id, reason: 'updated' });
    await this.reconcile(row.id);
    return this.dto(row.id);
  }

  async revokeShare(id: string): Promise<void> {
    const changed = await this.shares.revoke(id);
    if (!changed) return;
    this.ctx.events.emit('share.changed', { shareId: id, reason: 'revoked' });
    await this.reconcile(id);
  }

  async revokeAllForItem(itemId: string): Promise<void> {
    const ids = await this.shares.revokeAllForItem(itemId);
    for (const id of ids) {
      this.ctx.events.emit('share.changed', { shareId: id, reason: 'revoked' });
      await this.reconcile(id);
    }
    // The item's files are about to be deleted: end every in-flight webseed response for it, also
    // for shares that were already inactive (e.g. expired but not yet swept).
    for (const r of this.shares.allRows()) if (r.item_id === itemId) this.webseed?.closeShare(r.id);
  }

  async repointItem(itemId: string): Promise<void> {
    await this.shares.repointItem(itemId);
  }

  getShare(id: string): ShareDto | undefined {
    const row = this.shares.getRow(id);
    return row ? this.shares.toDto(row, this.stats.statsDto(id)) : undefined;
  }

  listShares(): ShareDto[] {
    return this.shares.allRows().map((r) => this.shares.toDto(r, this.stats.statsDto(r.id)));
  }

  swarm(shareId: string): SwarmSnapshot | undefined {
    return this.stats.snapshot(shareId);
  }

  allSwarms(): Record<string, SwarmSnapshot> {
    return this.stats.allSnapshots(this.shares.activeRows().map((r) => r.id));
  }

  /** Current cap in bytes/s (null = unlimited). */
  uploadCapBps(): number | null {
    return this.limiter.rate();
  }
}

export function createP2P(ctx: AppContext, opts: P2POptions = {}): P2P {
  return new P2P(ctx, opts);
}
