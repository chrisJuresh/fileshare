// Process-wide upload limiter (docs/ARCHITECTURE.md §10).
//
// There is exactly ONE token bucket for all server upload: a speed-limiter `ThrottleGroup` (the same
// class WebTorrent 3 uses for `client.throttleGroups.up`). The seeder installs this group as its
// client's upload group, so every TCP/uTP/WebRTC wire draws from it. Webseed responses pipe through
// `throttle()`, a Node Transform that draws tokens from the *same* group bucket (speed-limiter's own
// Throttle is a streamx stream, which Fastify cannot send directly), honouring the group's
// enabled flag, rate and chunk size.
//
// The group's bucket is replaced by a FIFO bucket (`FairBucket`). The stock `limiter` bucket serves
// whoever polls first after a drip, so seeder wires asking for 16 KiB blocks every few ms starved
// webseed responses (64 KiB) completely while the seeder was busy at the cap.
import { Transform, type TransformCallback } from 'node:stream';
import type { UploadLimiter } from './index.js';
import { ThrottleGroupCtor, type ThrottleGroup, type TokenBucket } from './vendor.js';

/** Sliding-window byte counter: `rate()` = bytes in the last `windowMs` / window seconds. */
export class RateMeter {
  private readonly slots: number[];
  private readonly stamps: number[];
  constructor(
    private readonly windowMs = 2000,
    private readonly slotMs = 100,
    private readonly now: () => number = Date.now,
  ) {
    const n = Math.ceil(windowMs / slotMs);
    this.slots = new Array<number>(n).fill(0);
    this.stamps = new Array<number>(n).fill(-1);
  }

  add(bytes: number): void {
    if (!(bytes > 0)) return;
    const slot = Math.floor(this.now() / this.slotMs);
    const i = slot % this.slots.length;
    if (this.stamps[i] !== slot) {
      this.stamps[i] = slot;
      this.slots[i] = 0;
    }
    this.slots[i]! += bytes;
  }

  /** Bytes per second averaged over the window. */
  rate(): number {
    const slot = Math.floor(this.now() / this.slotMs);
    const oldest = slot - this.slots.length + 1;
    let sum = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.stamps[i]!;
      if (s >= oldest && s <= slot) sum += this.slots[i]!;
    }
    return Math.round((sum * 1000) / this.windowMs);
  }
}

type BucketCb = (err: unknown, remaining?: number) => void;

/**
 * Drop-in for `limiter`'s TokenBucket (the interface speed-limiter's ThrottleGroup uses: bucketSize ==
 * tokensPerInterval == rate per second, content, drip, tryRemoveTokens, removeTokens) that serves
 * waiters strictly first-in, first-out: `tryRemoveTokens` fails while anyone is queued, and queued
 * `removeTokens` calls are granted in order as tokens drip in. A request larger than the bucket
 * (possible right after the rate was lowered) is granted once the bucket is full instead of failing.
 */
export class FairBucket implements TokenBucket {
  bucketSize: number;
  tokensPerInterval: number;
  readonly interval = 1000;
  content = 0;
  private lastDrip = Date.now();
  private readonly queue: { count: number; cb: BucketCb }[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(rate: number) {
    this.bucketSize = rate;
    this.tokensPerInterval = rate;
  }

  drip(): void {
    if (!this.tokensPerInterval) {
      this.content = this.bucketSize;
      return;
    }
    const now = Date.now();
    const dt = Math.max(now - this.lastDrip, 0);
    this.lastDrip = now;
    this.content = Math.min(this.content + (dt * this.tokensPerInterval) / this.interval, this.bucketSize);
  }

  tryRemoveTokens(count: number): boolean {
    if (!this.bucketSize) return true;
    if (count > this.bucketSize || this.queue.length > 0) return false;
    this.drip();
    if (count > this.content) return false;
    this.content -= count;
    return true;
  }

  removeTokens(count: number, cb: BucketCb): boolean {
    if (!this.bucketSize) {
      process.nextTick(cb, null, Number.POSITIVE_INFINITY);
      return true;
    }
    if (this.queue.length === 0) {
      this.drip();
      const need = Math.min(count, this.bucketSize);
      if (need <= this.content) {
        this.content -= need;
        process.nextTick(cb, null, this.content);
        return true;
      }
    }
    this.queue.push({ count, cb });
    this.schedule();
    return false;
  }

  /** Withdraw a queued request (its tokens are not taken). */
  cancel(cb: BucketCb): void {
    const i = this.queue.findIndex((w) => w.cb === cb);
    if (i >= 0) this.queue.splice(i, 1);
    if (this.queue.length === 0 && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  get waiting(): number {
    return this.queue.length;
  }

  private schedule(): void {
    if (this.timer || this.queue.length === 0) return;
    this.drip();
    const need = Math.min(this.queue[0]!.count, this.bucketSize || Number.POSITIVE_INFINITY);
    const ms = this.tokensPerInterval > 0 ? Math.ceil(((need - this.content) * this.interval) / this.tokensPerInterval) : MAX_POLL_MS;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.serve();
    }, Math.max(1, Math.min(ms, MAX_POLL_MS)));
  }

  private serve(): void {
    this.drip();
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      const need = this.bucketSize ? Math.min(head.count, this.bucketSize) : 0;
      if (need > this.content) break;
      this.content -= need;
      this.queue.shift();
      head.cb(null, this.content);
    }
    this.schedule();
  }
}

const MAX_POLL_MS = 250;

/** Node Transform that draws tokens from a ThrottleGroup's bucket. Destroy-safe (no leaked waits). */
class GroupThrottle extends Transform {
  private timer: NodeJS.Timeout | undefined;
  private wake: (() => void) | undefined;
  private dead = false;

  constructor(private readonly group: ThrottleGroup) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.throttleChunk(chunk).then(
      () => cb(),
      (err: unknown) => cb(err as Error),
    );
  }

  private async throttleChunk(chunk: Buffer): Promise<void> {
    let pos = 0;
    while (pos < chunk.length && !this.dead) {
      if (!this.group.getEnabled()) {
        this.push(chunk.subarray(pos));
        return;
      }
      const n = await this.acquireTokens(chunk.length - pos);
      if (this.dead) return;
      this.push(chunk.subarray(pos, pos + n));
      pos += n;
    }
  }

  /**
   * Waits (in the bucket's FIFO queue, alongside the seeder's wires) until up to `want` tokens are
   * granted. Returns the count taken (all of `want` when the cap is lifted meanwhile).
   */
  private async acquireTokens(want: number): Promise<number> {
    if (this.dead || !this.group.getEnabled()) return want;
    const bucket = this.group.bucket as FairBucket;
    const n = Math.max(1, Math.min(want, this.group.getChunksize(), bucket.bucketSize || want));
    if (bucket.tryRemoveTokens(n)) return n;
    let granted = false;
    const cb: BucketCb = () => {
      granted = true;
      this.wake?.();
    };
    bucket.removeTokens(n, cb);
    while (!granted && !this.dead) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, MAX_POLL_MS);
      });
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.wake = undefined;
      if (!granted && !this.group.getEnabled()) {
        bucket.cancel(cb);
        return want;
      }
    }
    if (!granted) bucket.cancel(cb);
    return n;
  }

  override _destroy(err: Error | null, cb: (error?: Error | null) => void): void {
    this.dead = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    cb(err);
  }
}

export class Limiter implements UploadLimiter {
  /** The single bucket. The seeder installs it as `client.throttleGroups.up`. */
  readonly group: ThrottleGroup = new ThrottleGroupCtor({ rate: 0, enabled: false });
  private readonly meter: RateMeter;
  private rateBps: number | null = null;

  constructor(now: () => number = Date.now) {
    this.meter = new RateMeter(2000, 100, now);
    // FIFO instead of first-come (see the header). setRate() keeps writing bucketSize/tokensPerInterval.
    this.group.bucket = new FairBucket(this.group.bucket.tokensPerInterval);
  }

  /** bytes/s; a non-finite or < 1 value means "unlimited". */
  setRate(bytesPerSec: number): void {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec < 1) {
      this.rateBps = null;
      this.group.setEnabled(false);
      return;
    }
    const rate = Math.floor(bytesPerSec);
    this.group.setRate(rate);
    this.group.setEnabled(true);
    this.rateBps = rate;
  }

  /** Current cap in bytes/s, or null when unlimited. */
  rate(): number | null {
    return this.rateBps;
  }

  throttle(): Transform {
    return new GroupThrottle(this.group);
  }

  /** Record bytes actually sent (seeder wires + webseed) for `currentBps()`. */
  record(bytes: number): void {
    this.meter.add(bytes);
  }

  currentBps(): number {
    return this.meter.rate();
  }
}
