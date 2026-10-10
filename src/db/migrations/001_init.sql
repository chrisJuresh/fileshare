CREATE TABLE items (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('file','dir')),
  source        TEXT NOT NULL CHECK (source IN ('outbox','upload')),
  source_name   TEXT NOT NULL,
  upload_batch_id TEXT,
  status        TEXT NOT NULL CHECK (status IN
                ('incoming','stabilising','hashing','snapshotting','ready','error','deleted')),
  error         TEXT,
  total_bytes   INTEGER NOT NULL DEFAULT 0,
  file_count    INTEGER NOT NULL DEFAULT 0,
  piece_length  INTEGER,
  info          BLOB,
  library_at    INTEGER,
  snapshot_run_id INTEGER REFERENCES backup_runs(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  ready_at      INTEGER,
  deleted_at    INTEGER
);
CREATE INDEX items_status ON items(status);
CREATE UNIQUE INDEX items_active_source ON items(source, source_name, COALESCE(upload_batch_id,''))
  WHERE status NOT IN ('ready','deleted');

CREATE TABLE shares (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES items(id),
  info_hash     TEXT NOT NULL UNIQUE,
  torrent_name  TEXT NOT NULL,
  info          BLOB NOT NULL,
  password_hash TEXT,
  token_version INTEGER NOT NULL DEFAULT 1,
  expires_at    INTEGER,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX shares_item ON shares(item_id);

CREATE TABLE share_stats (
  share_id              TEXT PRIMARY KEY REFERENCES shares(id),
  server_bytes_webseed  INTEGER NOT NULL DEFAULT 0,
  server_bytes_p2p      INTEGER NOT NULL DEFAULT 0,
  peer_bytes            INTEGER NOT NULL DEFAULT 0,
  completed_downloads   INTEGER NOT NULL DEFAULT 0,
  peak_swarm            INTEGER NOT NULL DEFAULT 0,
  last_activity_at      INTEGER
);

CREATE TABLE share_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id  TEXT NOT NULL REFERENCES shares(id),
  at        INTEGER NOT NULL,
  type      TEXT NOT NULL CHECK (type IN
            ('created','updated','revoked','expired','unlocked','unlock_failed','completed')),
  detail    TEXT
);
CREATE INDEX share_events_share ON share_events(share_id, at);

CREATE TABLE upload_batches (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL CHECK (status IN ('open','complete','failed','ingested')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE backup_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('backup','forget','check','init')),
  trigger     TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL CHECK (status IN ('running','ok','failed','interrupted')),
  snapshot_id TEXT,
  library_entries TEXT,
  error       TEXT,
  summary     TEXT
);
CREATE INDEX backup_runs_kind ON backup_runs(kind, started_at);

CREATE TABLE backup_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  reason       TEXT NOT NULL CHECK (reason IN ('ingest','delete','rename','manual')),
  item_id      TEXT,
  requested_at INTEGER NOT NULL,
  run_id       INTEGER REFERENCES backup_runs(id)
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
