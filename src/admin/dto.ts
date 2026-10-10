// Row → DTO mapping and info-dict file listing for the admin API.
import type { Db, ItemRow } from '../db/index.js';
import type { FileEntry, ItemDto } from '../types.js';

type Bencode = { decode(data: Uint8Array): unknown };
let bencodeMod: Bencode | undefined;

/** bencode 4 ships no types; load it untyped and keep the surface tiny. */
async function bencode(): Promise<Bencode> {
  if (!bencodeMod) {
    const spec: string = 'bencode';
    const mod = (await import(spec)) as { default: Bencode };
    bencodeMod = mod.default;
  }
  return bencodeMod;
}

const td = new TextDecoder('utf-8');

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return td.decode(v);
  throw new Error('bad string in info dict');
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === 'bigint' && v >= 0n) return Number(v);
  throw new Error('bad length in info dict');
}

/** Lists files from a bencoded v1 info dict. Single-file → one entry named after the file. */
export async function filesFromInfo(info: Uint8Array): Promise<FileEntry[]> {
  const dict = (await bencode()).decode(info) as Record<string, unknown>;
  if (!dict || typeof dict !== 'object') throw new Error('bad info dict');
  const name = str(dict['name.utf-8'] ?? dict.name);
  const files = dict.files;
  if (!Array.isArray(files)) return [{ path: name, length: num(dict.length) }];
  const out: FileEntry[] = [];
  for (const f of files as Record<string, unknown>[]) {
    const attr = f.attr === undefined ? '' : str(f.attr);
    if (attr.includes('p')) continue; // BEP 47 padding file
    const segs = f['path.utf-8'] ?? f.path;
    if (!Array.isArray(segs) || segs.length === 0) throw new Error('bad path in info dict');
    out.push({ path: segs.map(str).join('/'), length: num(f.length) });
  }
  return out;
}

export function activeShareCounts(db: Db, now = Date.now()): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT item_id, COUNT(*) AS n FROM shares
       WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) GROUP BY item_id`,
    )
    .all(now) as { item_id: string; n: number }[];
  return new Map(rows.map((r) => [r.item_id, r.n]));
}

export function toItemDto(row: ItemRow, progress: Record<string, number>, activeShares: number): ItemDto {
  const p = progress[row.id];
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    source: row.source,
    status: row.status,
    error: row.error,
    totalBytes: row.total_bytes,
    fileCount: row.file_count,
    createdAt: row.created_at,
    readyAt: row.ready_at,
    progress: typeof p === 'number' && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : null,
    activeShares,
  };
}

export function listItemRows(db: Db): ItemRow[] {
  return db.prepare(`SELECT * FROM items WHERE status != 'deleted' ORDER BY created_at DESC, id`).all() as ItemRow[];
}

export function getItemRow(db: Db, id: string): ItemRow | undefined {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
  return row && row.status !== 'deleted' ? row : undefined;
}

export function listItems(db: Db, progress: Record<string, number>): ItemDto[] {
  const counts = activeShareCounts(db);
  return listItemRows(db).map((r) => toItemDto(r, progress, counts.get(r.id) ?? 0));
}
