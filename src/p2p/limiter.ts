// Process-wide upload limiter (docs/ARCHITECTURE.md §10).
//
// There is exactly ONE token bucket for all server upload: a speed-limiter `ThrottleGroup` (the same
// class WebTorrent 3 uses for `client.throttleGroups.up`). The seeder installs this group as its
// client's upload group, so every TCP/uTP/WebRTC wire draws from it. Webseed responses pipe through
// `throttle()`, a Node Transform that draws tokens from the *same* group bucket (speed-limiter's own
// Throttle is a streamx stream, which Fastify cannot send directly), honouring the group's
// enabled flag, rate and chunk size.
import { Transform, type TransformCallback } from 'node:stream';
import type { UploadLimiter } from './index.js';
import { ThrottleGroupCtor, type ThrottleGroup } from './vendor.js';

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

  /** Waits until up to `want` tokens are available and removes them. Returns the count taken. */
  private async acquireTokens(want: number): Promise<number> {
    for (;;) {
      if (this.dead || !this.group.getEnabled()) return want;
      const bucket = this.group.bucket;
      const rate = this.group.getRate();
      const n = Math.max(1, Math.min(want, this.group.getChunksize(), bucket.bucketSize || want));
      if (rate > 0 && bucket.tryRemoveTokens(n)) return n;
      const deficit = Math.max(1, n - bucket.content);
      const waitMs = rate > 0 ? Math.min(MAX_POLL_MS, Math.max(5, Math.ceil((deficit * 1000) / rate))) : MAX_POLL_MS;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, waitMs);
      });
      this.timer = undefined;
      this.wake = undefined;
    }
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
