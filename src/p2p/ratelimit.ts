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

  /** Drop expired entries (run periodically). */
  prune(): void {
    const now = this.now();
    for (const [k, v] of this.perIp) if (UnlockRateLimiter.live(v, this.limits.perIp.windowMs, now).length === 0) this.perIp.delete(k);
    for (const [k, v] of this.perShare)
      if (UnlockRateLimiter.live(v, this.limits.perShare.windowMs, now).length === 0) this.perShare.delete(k);
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
