// Unlock failure rate limiting (docs/ARCHITECTURE.md §7.1): 5 failures / 10 min per (share, client IP)
// and 50 failures / hour per share. In memory only. Client IPs are never stored in clear: they are keyed
// by an HMAC with a per-process random key, and never logged or persisted.
import { createHmac, randomBytes } from 'node:crypto';

export interface Window {
  max: number;
  windowMs: number;
}

export interface UnlockLimits {
  perIp: Window;
  perShare: Window;
}

export const DEFAULT_UNLOCK_LIMITS: UnlockLimits = {
  perIp: { max: 5, windowMs: 10 * 60_000 },
  perShare: { max: 50, windowMs: 60 * 60_000 },
};

const MAX_KEYS = 100_000;

export class UnlockRateLimiter {
  private readonly ipKey = randomBytes(32);
  private readonly perIp = new Map<string, number[]>();
  private readonly perShare = new Map<string, number[]>();

  constructor(
    private readonly limits: UnlockLimits = DEFAULT_UNLOCK_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  private ipBucket(shareId: string, ip: string): string {
    return `${shareId}\n${createHmac('sha256', this.ipKey).update(ip).digest('base64url')}`;
  }

  private static live(list: number[] | undefined, windowMs: number, now: number): number[] {
    if (!list) return [];
    const cutoff = now - windowMs;
    let i = 0;
    while (i < list.length && list[i]! <= cutoff) i++;
    if (i > 0) list.splice(0, i);
    return list;
  }

  /** `retryAfter` in whole seconds when limited. */
  check(shareId: string, ip: string): { ok: true } | { ok: false; retryAfter: number } {
    const now = this.now();
    const a = UnlockRateLimiter.live(this.perIp.get(this.ipBucket(shareId, ip)), this.limits.perIp.windowMs, now);
    const b = UnlockRateLimiter.live(this.perShare.get(shareId), this.limits.perShare.windowMs, now);
    let until = 0;
    if (a.length >= this.limits.perIp.max) until = Math.max(until, a[a.length - this.limits.perIp.max]! + this.limits.perIp.windowMs);
    if (b.length >= this.limits.perShare.max)
      until = Math.max(until, b[b.length - this.limits.perShare.max]! + this.limits.perShare.windowMs);
    if (until > now) return { ok: false, retryAfter: Math.max(1, Math.ceil((until - now) / 1000)) };
    return { ok: true };
  }

  /**
   * Record a failure *before* the (slow) password check so concurrent attempts are counted.
   * Returns an undo function to call if the attempt turns out to be a success.
   */
  recordFailure(shareId: string, ip: string): () => void {
    const now = this.now();
    if (this.perIp.size > MAX_KEYS || this.perShare.size > MAX_KEYS) this.prune();
    const ka = this.ipBucket(shareId, ip);
    const a = this.perIp.get(ka) ?? [];
    const b = this.perShare.get(shareId) ?? [];
    a.push(now);
    b.push(now);
    this.perIp.set(ka, a);
    this.perShare.set(shareId, b);
    return () => {
      const ia = a.lastIndexOf(now);
      if (ia >= 0) a.splice(ia, 1);
      const ib = b.lastIndexOf(now);
      if (ib >= 0) b.splice(ib, 1);
    };
  }

  /** Admin action: forget every recorded failure for a share (per-share and per-IP counters). */
  resetShare(shareId: string): void {
    this.perShare.delete(shareId);
    const prefix = `${shareId}\n`;
    for (const k of this.perIp.keys()) if (k.startsWith(prefix)) this.perIp.delete(k);
  }

  /** Drop expired entries (run periodically). */
  prune(): void {
    const now = this.now();
    for (const [k, v] of this.perIp) if (UnlockRateLimiter.live(v, this.limits.perIp.windowMs, now).length === 0) this.perIp.delete(k);
    for (const [k, v] of this.perShare)
      if (UnlockRateLimiter.live(v, this.limits.perShare.windowMs, now).length === 0) this.perShare.delete(k);
  }
}

/** Keyed HMAC of a client IP with a per-process random key: the IP itself is never kept. */
function ipHasher(): (ip: string) => string {
  const key = randomBytes(32);
  return (ip) => createHmac('sha256', key).update(ip).digest('base64url');
}

/** Drop the oldest (first-inserted) entries until there is room for one more. */
function makeRoom(m: Map<string, unknown>, maxKeys: number): void {
  for (const k of m.keys()) {
    if (m.size < maxKeys) return;
    m.delete(k);
  }
}

/** Fixed-window request counter per client IP (e.g. HTTP tracker announces). Memory only. */
export class IpRateLimiter {
  private readonly hash = ipHasher();
  private readonly hits = new Map<string, { start: number; n: number }>();

  constructor(
    private readonly limit: Window,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = MAX_KEYS,
  ) {}

  /** Count one request; false when this IP is over the limit for the current window. */
  hit(ip: string): boolean {
    const now = this.now();
    const k = this.hash(ip);
    let e = this.hits.get(k);
    if (!e || now - e.start >= this.limit.windowMs) {
      this.hits.delete(k);
      makeRoom(this.hits, this.maxKeys);
      e = { start: now, n: 0 };
      this.hits.set(k, e);
    }
    e.n++;
    return e.n <= this.limit.max;
  }

  prune(): void {
    const now = this.now();
    for (const [k, e] of this.hits) if (now - e.start >= this.limit.windowMs) this.hits.delete(k);
  }
}

/**
 * "Has this (scope, client IP) pair been seen in the last `ttlMs`?" — e.g. record one `unlocked` share
 * event per recipient per 10 minutes instead of one per request. Memory only, IPs hashed.
 */
export class RecentOnce {
  private readonly hash = ipHasher();
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = MAX_KEYS,
  ) {}

  /** True the first time within the TTL (and marks the pair as seen). */
  first(scope: string, ip: string): boolean {
    const now = this.now();
    const k = `${scope}\n${this.hash(ip)}`;
    const at = this.seen.get(k);
    if (at !== undefined && now - at < this.ttlMs) return false;
    this.seen.delete(k);
    makeRoom(this.seen, this.maxKeys);
    this.seen.set(k, now);
    return true;
  }

  prune(): void {
    const now = this.now();
    for (const [k, at] of this.seen) if (now - at >= this.ttlMs) this.seen.delete(k);
  }
}

/** Small counting semaphore: bounds concurrent argon2 verifications (64 MiB each). */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}

  /** Returns a release function, or undefined if the queue is full. */
  async acquire(): Promise<(() => void) | undefined> {
    if (this.active >= this.max) {
      if (this.queue.length >= this.maxQueue) return undefined;
      await new Promise<void>((r) => this.queue.push(r));
    } else {
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    };
  }
}
