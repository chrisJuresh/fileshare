// Upload cap / capacity settings (docs/ARCHITECTURE.md §3 settings keys). Shared by the admin API
// and the CLI. All rates are BYTES per second.
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/index.js';
import type { SettingsDto } from '../types.js';

export const KEY_CAP = 'upload.cap_bps';
export const KEY_CAPACITY = 'upload.capacity_bps';
export const KEY_MEASURED_AT = 'upload.measured_at';

/** Allowed cap range: 1 KiB/s … 10 GB/s. */
export const MIN_CAP_BPS = 1024;
export const MAX_CAP_BPS = 10_000_000_000;

const finitePositive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * The effective cap: `upload.cap_bps` if set, else floor(0.9 × capacity) if a capacity is known,
 * else 0 (= no cap configured).
 */
export function effectiveCapBps(db: Db): number {
  const cap = finitePositive(getSetting<number>(db, KEY_CAP));
  if (cap !== null) return Math.floor(cap);
  const capacity = finitePositive(getSetting<number>(db, KEY_CAPACITY));
  return capacity !== null ? Math.floor(0.9 * capacity) : 0;
}

export function readSettings(db: Db): SettingsDto {
  const capacity = finitePositive(getSetting<number>(db, KEY_CAPACITY));
  const measuredAt = finitePositive(getSetting<number>(db, KEY_MEASURED_AT));
  return {
    uploadCapBps: effectiveCapBps(db),
    uploadCapacityBps: capacity !== null ? Math.floor(capacity) : null,
    uploadMeasuredAt: measuredAt,
  };
}

export function validCap(bps: number): boolean {
  return Number.isInteger(bps) && bps >= MIN_CAP_BPS && bps <= MAX_CAP_BPS;
}

export function writeCap(db: Db, bps: number): void {
  if (!validCap(bps)) throw new RangeError(`upload cap must be an integer between ${MIN_CAP_BPS} and ${MAX_CAP_BPS} bytes/s`);
  setSetting(db, KEY_CAP, bps);
}

/** Records a speed test. Unless keepCap, also sets the cap to floor(0.9 × capacity). Returns written keys. */
export function recordCapacity(db: Db, capacityBps: number, opts: { keepCap?: boolean; at?: number } = {}): string[] {
  if (!Number.isFinite(capacityBps) || capacityBps <= 0) throw new RangeError('capacity must be a positive number');
  const capacity = Math.floor(capacityBps);
  const keys = [KEY_CAPACITY, KEY_MEASURED_AT];
  db.transaction(() => {
    setSetting(db, KEY_CAPACITY, capacity);
    setSetting(db, KEY_MEASURED_AT, opts.at ?? Date.now());
    if (!opts.keepCap) {
      const cap = Math.min(MAX_CAP_BPS, Math.max(MIN_CAP_BPS, Math.floor(0.9 * capacity)));
      setSetting(db, KEY_CAP, cap);
      keys.push(KEY_CAP);
    }
  })();
  return keys;
}

/** Mbit/s (decimal) → bytes/s. */
export const mbpsToBps = (mbps: number): number => Math.floor((mbps * 1_000_000) / 8);
export const bpsToMbps = (bps: number): number => (bps * 8) / 1_000_000;
