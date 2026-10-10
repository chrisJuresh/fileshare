// Library name allocation (docs/ARCHITECTURE.md §4 hashing step 1, §9 names).
import { lstat } from 'node:fs/promises';
import { safeJoin } from '../core/paths.js';
import type { Db } from '../db/index.js';

const MAX_NAME_BYTES = 200;

/**
 * The name a deleted item's row keeps, so its real name is free again (items.name is UNIQUE across
 * all rows). Never a valid live name collision in practice: it embeds the item's random id.
 */
export function tombstoneName(name: string, itemId: string): string {
  return `${name} [deleted ${itemId}]`;
}

/**
 * THE rule for "is this library name in use?", shared by ingest (allocation, rename) and the admin
 * API: an item row other than `exceptItemId` has it (deleted rows hold tombstone names, so they never
 * block), or something already exists at /data/library/<name>.
 */
export async function isNameTaken(db: Db, libraryDir: string, name: string, exceptItemId?: string): Promise<boolean> {
  if (db.prepare('SELECT 1 FROM items WHERE name = ? AND id != ?').get(name, exceptItemId ?? '')) return true;
  try {
    await lstat(safeJoin(libraryDir, name));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** ` (YYYY-MM-DD HHmm)` in the process's local time zone (TZ). */
export function timestampSuffix(d: Date): string {
  return ` (${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())})`;
}

/** Truncate `base` (by code points) so that `base + suffix` fits in MAX_NAME_BYTES, without trailing spaces. */
function fit(base: string, suffix: string): string {
  const budget = MAX_NAME_BYTES - Buffer.byteLength(suffix);
  if (Buffer.byteLength(base) <= budget) return base + suffix;
  let out = '';
  for (const ch of base) {
    if (Buffer.byteLength(out + ch) > budget) break;
    out += ch;
  }
  return out.trimEnd() + suffix;
}

/**
 * Pick a free name: `base`, else `base (YYYY-MM-DD HHmm)`, else `base (YYYY-MM-DD HHmm) (n)` for n = 2, 3, …
 * `taken` decides whether a candidate is already used (DB row of any status, or on disk).
 */
export async function chooseName(
  base: string,
  taken: (name: string) => boolean | Promise<boolean>,
  now: Date = new Date(),
): Promise<string> {
  if (!(await taken(base))) return base;
  const ts = timestampSuffix(now);
  const withTs = fit(base, ts);
  if (!(await taken(withTs))) return withTs;
  for (let n = 2; n < 10_000; n++) {
    const candidate = fit(base, `${ts} (${n})`);
    if (!(await taken(candidate))) return candidate;
  }
  throw new Error('could not allocate a free library name');
}
