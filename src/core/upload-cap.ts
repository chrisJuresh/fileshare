// The ONE definition of the effective server upload cap (docs/ARCHITECTURE.md §3, §10). Used by the
// limiter (p2p) and by everything that displays the cap (admin API, live stream, stats).
import { getSetting, type Db } from '../db/index.js';

export const KEY_CAP = 'upload.cap_bps';
export const KEY_CAPACITY = 'upload.capacity_bps';
/** Settings keys whose change can change the effective cap. */
export const CAP_KEYS: readonly string[] = [KEY_CAP, KEY_CAPACITY];

const finitePositive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * The effective cap in bytes/s: `upload.cap_bps` if set, else floor(0.9 × `upload.capacity_bps`) if a
 * capacity is known, else 0 (= no cap configured: unlimited).
 */
export function effectiveCapBps(db: Db): number {
  const cap = finitePositive(getSetting<number>(db, KEY_CAP));
  if (cap !== null) return Math.floor(cap);
  const capacity = finitePositive(getSetting<number>(db, KEY_CAPACITY));
  return capacity !== null ? Math.floor(0.9 * capacity) : 0;
}
