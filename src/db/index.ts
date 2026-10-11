import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, 'migrations');

export interface ItemRow {
  id: string;
  name: string;
  kind: 'file' | 'dir';
  source: 'outbox' | 'upload';
  source_name: string;
  upload_batch_id: string | null;
  status: import('../types.js').ItemStatus;
  error: string | null;
  total_bytes: number;
  file_count: number;
  piece_length: number | null;
  info: Buffer | null;
  library_at: number | null;
  snapshot_run_id: number | null;
  created_at: number;
  updated_at: number;
  ready_at: number | null;
  deleted_at: number | null;
}

export interface ShareRow {
  id: string;
  item_id: string;
  info_hash: string;
  torrent_name: string;
  info: Buffer;
  password_hash: string | null;
  token_version: number;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ShareStatsRow {
  share_id: string;
  server_bytes_webseed: number;
  server_bytes_p2p: number;
  peer_bytes: number;
  completed_downloads: number;
  peak_swarm: number;
  last_activity_at: number | null;
}

export interface ShareRecipientRow {
  id: string;
  share_id: string;
  name: string;
  created_at: number;
}

export interface BackupRunRow {
  id: number;
  kind: 'backup' | 'forget' | 'check' | 'init';
  trigger: string;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'ok' | 'failed' | 'interrupted';
  snapshot_id: string | null;
  library_entries: string | null;
  error: string | null;
  summary: string | null;
}

export interface BackupRequestRow {
  id: number;
  reason: 'ingest' | 'delete' | 'rename' | 'manual';
  item_id: string | null;
  requested_at: number;
  run_id: number | null;
}

/** Open (and migrate) the database. `file` may be ':memory:' in tests. */
export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    const version = Number(f.slice(0, 3));
    if (applied.has(version)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    db.transaction(() => {
      // Re-check inside the IMMEDIATE transaction: another process may have applied it meanwhile.
      if (db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version)) return;
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, Date.now());
    }).immediate();
  }
}

export function getSetting<T>(db: Db, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), Date.now());
}
