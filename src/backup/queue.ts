// Shared snapshot queue API (docs/ARCHITECTURE.md §5). Used by ingest/admin; the restic runner
// consumes backup_requests and writes backup_runs.
import type { BackupRunRow, Db } from '../db/index.js';

export type SnapshotReason = 'ingest' | 'delete' | 'rename' | 'manual';

export function requestSnapshot(db: Db, reason: SnapshotReason, itemId?: string): number {
  const r = db
    .prepare('INSERT INTO backup_requests (reason, item_id, requested_at) VALUES (?, ?, ?)')
    .run(reason, itemId ?? null, Date.now());
  return Number(r.lastInsertRowid);
}

/** A successful backup that started at/after `sinceMs` and listed `itemName` in /data/library. */
export function findCoveringBackup(db: Db, itemName: string, sinceMs: number): BackupRunRow | undefined {
  const rows = db
    .prepare(
      `SELECT * FROM backup_runs WHERE kind = 'backup' AND status = 'ok' AND started_at >= ?
       ORDER BY started_at ASC`,
    )
    .all(sinceMs) as BackupRunRow[];
  return rows.find((r) => {
    if (!r.library_entries) return false;
    try {
      return (JSON.parse(r.library_entries) as string[]).includes(itemName);
    } catch {
      return false;
    }
  });
}

export function latestRuns(db: Db): { backup?: BackupRunRow; forget?: BackupRunRow; check?: BackupRunRow } {
  const q = db.prepare(`SELECT * FROM backup_runs WHERE kind = ? ORDER BY started_at DESC LIMIT 1`);
  return {
    backup: q.get('backup') as BackupRunRow | undefined,
    forget: q.get('forget') as BackupRunRow | undefined,
    check: q.get('check') as BackupRunRow | undefined,
  };
}

export function pendingRequestCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM backup_requests WHERE run_id IS NULL').get() as { n: number }).n;
}
