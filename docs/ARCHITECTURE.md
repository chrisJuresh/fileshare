# Architecture

fileshare is a self-hosted file share. You drop files in on a PC; they sync to the server and are
stored in a **library**, with **deduplicated snapshots** behind them. You can then **share** any
library item as a link. Recipients download in the browser over **peer-to-peer WebTorrent**: the
server seeds, and every recipient's browser shares the pieces it has with the others.

This document is the contract between modules. If code and this document disagree, fix one of them
in the same change.

---

## 1. Components

```
                        ┌───────────────────────── host ─────────────────────────────────┐
 PC (Syncthing) ──LAN──►│ syncthing (bridge)  ──outbox──┐                                 │
                        │                               ▼                                 │
 browser / torrent ────►│ Caddy :8443 (public) ──► app public listener (127.0.0.1)        │
 client  (internet)     │                           │  share pages, /api/s, tracker,      │
                        │                           │  webseed, stats WS                  │
 BitTorrent TCP/uTP ───►│ app :6890 (host network) ─┤  seeder (WebTorrent, node-datachannel)
 WebRTC ICE UDP ───────►│ app :6891 (ICE UDP mux) ──┘                                     │
                        │                                                                 │
 admin (Cloudflare     ►│ cloudflared ──► app admin listener (docker bridge gateway IP)   │
  Access → tunnel)      │                  dashboard, admin API, tus upload, admin WS     │
                        │                                                                 │
                        │ restic runner (same image, no network) ── SQLite queue ── app   │
                        │ ddns (favonia/cloudflare-ddns) – keeps the A record current     │
                        └─────────────────────────────────────────────────────────────────┘
```

| Service     | Image                                  | Network                     | Purpose |
|-------------|----------------------------------------|-----------------------------|---------|
| `app`       | built from `Dockerfile` (node:22-bookworm-slim) | `host` (needed for WebRTC ICE / NAT) | everything HTTP + P2P + ingest |
| `restic`    | same image, `node dist/backup/main.js` | `none`                      | snapshot scheduler / runner |
| `syncthing` | `syncthing/syncthing:2.1.6`            | bridge, ports published to the LAN IP / loopback | PC → server intake |
| `ddns`      | `favonia/cloudflare-ddns:1.17.1`       | bridge (outbound only)      | DNS-only A record |

Why host networking for `app`: the server-side WebRTC peer (libdatachannel) cannot be told a public
address. It learns it from STUN. An extra Docker NAT layer makes the STUN-reflexive candidate and port
mapping unreliable. With host networking, the only NAT is the home router, which forwards 6890/6891
1:1. The app therefore binds each listener to an explicit address (§6), and ufw governs exposure.

## 2. Directory layout

### Repository

```
CLAUDE.md                 agent guide (public)
README.md                 what it is + quickstart
.env.example              every env var, with generic defaults
Dockerfile                app image (also runs the restic runner); bundles the restic binary
compose.yaml              the whole stack
package.json, tsconfig*.json, vitest.config.ts, playwright.config.ts
scripts/
  build-web.mjs           esbuild: web/* → dist/web/*
  gen-secrets.sh          creates the secrets files (mode 600) if missing
  speedtest.sh            one-off upload measurement in a throwaway container
  pair-pc.sh <device-id>  adds the PC's Syncthing device + shares the outbox (run over SSH)
  syncthing-init.sh       sets the Syncthing GUI user/password from the secret file (idempotent)
  gen-testdata.sh         synthetic random test files
  caddy/                  the staged Caddy site block + apply/verify helper
  ufw/                    the ufw plan + apply/revert helper
src/
  main.ts                 app entry: wires modules and starts both listeners
  config.ts               env parsing (zod) → Config
  log.ts                  pino logger (redacts tokens / JWTs)
  context.ts              AppContext type
  db/                     open(), migrations, row types
  core/                   tokens, events, safe paths, ids, time helpers
  server/public.ts        public Fastify instance (no admin routes, ever)
  server/admin.ts         admin Fastify instance
  ingest/                 Syncthing integration, stability, placement, hashing, snapshot hook, tus
  p2p/                    shares, seeder, tracker, webseed, upload limiter, swarm stats
  admin/                  Access JWT, admin API, stats, disks
  backup/                 restic runner (separate process) + queue API used by ingest/admin
  cli.ts                  operator CLI (docker compose exec app node dist/cli.js …)
web/
  recipient/              share page (Preact + WebTorrent)
  admin/                  dashboard (Preact + Uppy)
test/
  helpers/  e2e/  (unit tests live next to code as *.test.ts)
docs/
  ARCHITECTURE.md RUNBOOK.md HOST-CHANGES.md USER-ACTIONS.md pc-setup.md
```

### On the host (defaults; all configurable in `.env`)

| Host path (default)                  | In `app`         | In `restic`        | In `syncthing` | Contents |
|--------------------------------------|------------------|--------------------|----------------|----------|
| `${DATA_ROOT}` e.g. `/srv/fileshare-data` | `/data` (rw)  | `/data/library` (ro) only | `/data/outbox` (rw) only | see below |
| `${APPDATA}/app`                      | `/state` (rw)    | `/state` (rw)      | –              | `fileshare.db`, `backup/`, `seedlinks/` |
| `${APPDATA}/secrets`                  | `/secrets` (ro)  | `/secrets` (ro)    | –              | secret files (mode 600) |
| `${APPDATA}/syncthing`                | –                | `/syncthing-config` (ro) | `/var/syncthing/config` | Syncthing config + DB |
| `${RESTIC_REPO_HOST}`                 | –                | `/restic` (rw)     | –              | restic repository |
| repo `.env`                           | –                | `/config/.env` (ro)| –              | backed up as "app config" |

`/data` layout:

```
/data/outbox/            Syncthing folder (Send & Receive). Top-level entries = future items.
/data/library/<name>     library items (a file or a directory); <name> is unique
/data/staging/<batch>/   finished web uploads, grouped by upload batch
/data/uploads/           tus in-progress uploads (+ .json metadata)
/data/.ingest-trash/     outbox entries quarantined during verified removal (ingest; normally empty)
```

`/state/seedlinks/<shareId>/<torrentName>` is a symlink to `/data/library/<item name>`. The seeder
uses `path: /state/seedlinks/<shareId>`, so a share's frozen torrent name keeps working after the
item is renamed on disk.

Ownership: everything is owned by `${PUID}:${PGID}`, and data dirs are `0750` (no group/other
write). All containers run as `${PUID}:${PGID}`. At startup, before p2p or ingest start, the app
creates any missing `library/`, `outbox/`, `staging/`, `uploads/` and `/state/seedlinks/` (mode
`0750`; `src/core/dirs.ts`).

## 3. SQLite schema

The DB is `/state/fileshare.db`, opened with `better-sqlite3`, `journal_mode=WAL`, `foreign_keys=ON`
and `busy_timeout=5000`. Two processes use it (`app`, `restic`) on the same host. Migrations live in
`src/db/migrations/NNN_*.sql`, are applied in order by `openDb()`, and are recorded in
`schema_migrations`. All times are **integer milliseconds since the epoch (UTC)**. IDs are opaque
strings.

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);

CREATE TABLE items (
  id            TEXT PRIMARY KEY,               -- newId()
  name          TEXT NOT NULL UNIQUE,           -- entry name under /data/library (also display name);
                                                -- deleted rows: '<name> [deleted <id>]' (005), so names are reusable
  kind          TEXT NOT NULL CHECK (kind IN ('file','dir')),
  source        TEXT NOT NULL CHECK (source IN ('outbox','upload')),
  source_name   TEXT NOT NULL,                  -- top-level entry name in outbox or staging/<batch>
  upload_batch_id TEXT,                         -- for source='upload'
  status        TEXT NOT NULL CHECK (status IN
                ('incoming','stabilising','hashing','snapshotting','ready','error','deleted')),
  error         TEXT,                           -- human-readable, no secrets
  total_bytes   INTEGER NOT NULL DEFAULT 0,
  file_count    INTEGER NOT NULL DEFAULT 0,
  piece_length  INTEGER,
  info          BLOB,                           -- bencoded torrent info dict (private=1, NO 'source' key)
  library_at    INTEGER,                        -- when contents were placed in /data/library
  snapshot_run_id INTEGER REFERENCES backup_runs(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  ready_at      INTEGER,
  deleted_at    INTEGER
);
CREATE INDEX items_status ON items(status);
-- At most one live (non-deleted, non-ready) item per outbox entry:
CREATE UNIQUE INDEX items_active_source ON items(source, source_name, COALESCE(upload_batch_id,''))
  WHERE status NOT IN ('ready','deleted');

CREATE TABLE shares (
  id            TEXT PRIMARY KEY,               -- newShareId(): 22 chars base64url (128 bits)
  item_id       TEXT NOT NULL REFERENCES items(id),
  info_hash     TEXT NOT NULL UNIQUE,           -- lowercase hex v1 infohash of the share's info dict
  torrent_name  TEXT NOT NULL,                  -- info.name, frozen at creation
  info          BLOB NOT NULL,                  -- bencoded info dict = item.info + source:'fileshare-<shareId>'
  password_hash TEXT,                           -- argon2id PHC string, NULL = no password
  token_version INTEGER NOT NULL DEFAULT 1,     -- bump to invalidate issued tokens
  expires_at    INTEGER,                        -- NULL = never
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX shares_item ON shares(item_id);

CREATE TABLE share_stats (
  share_id              TEXT PRIMARY KEY REFERENCES shares(id),
  server_bytes_webseed  INTEGER NOT NULL DEFAULT 0,
  server_bytes_p2p      INTEGER NOT NULL DEFAULT 0, -- seeder upload (TCP/uTP/WebRTC)
  peer_bytes            INTEGER NOT NULL DEFAULT 0, -- bytes peers uploaded to other peers (reported)
  completed_downloads   INTEGER NOT NULL DEFAULT 0,
  peak_swarm            INTEGER NOT NULL DEFAULT 0, -- max simultaneous peers incl. server
  last_activity_at      INTEGER
);

CREATE TABLE share_events (                        -- history; NEVER store IPs or user agents
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id  TEXT NOT NULL REFERENCES shares(id),
  at        INTEGER NOT NULL,
  type      TEXT NOT NULL CHECK (type IN
            ('created','updated','revoked','expired','unlocked','unlock_failed','completed')),
  detail    TEXT                                   -- small JSON, e.g. {"kind":"browser"}
);
CREATE INDEX share_events_share ON share_events(share_id, at);

CREATE TABLE upload_batches (
  id          TEXT PRIMARY KEY,                    -- newId()
  status      TEXT NOT NULL CHECK (status IN ('open','complete','failed','ingested')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE backup_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  reason       TEXT NOT NULL CHECK (reason IN ('ingest','delete','rename','manual')),
  item_id      TEXT,
  requested_at INTEGER NOT NULL,
  run_id       INTEGER REFERENCES backup_runs(id)   -- set when a backup run consumed it
);

CREATE TABLE backup_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('backup','forget','check','init')),
  trigger     TEXT NOT NULL,                       -- 'debounce','hourly','schedule','manual'
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL CHECK (status IN ('running','ok','failed','interrupted')),
  snapshot_id TEXT,                                -- restic short id (backup only)
  library_entries TEXT,                            -- JSON array of top-level /data/library names
                                                   -- listed immediately BEFORE the backup started
  error       TEXT,
  summary     TEXT                                 -- JSON (restic summary / check result)
);
CREATE INDEX backup_runs_kind ON backup_runs(kind, started_at);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
```

**`settings` keys** (values are JSON):

| key                    | writer          | meaning |
|------------------------|-----------------|---------|
| `upload.capacity_bps`  | speedtest/admin | measured upload capacity, bytes/s |
| `upload.cap_bps`       | admin           | cap for all server upload; default `floor(0.9 × capacity)` |
| `upload.measured_at`   | speedtest       | ms epoch |
| `status.disk.restic`   | restic runner   | `{total,free,used,path,at}` for the restic repo filesystem |
| `status.restic`        | restic runner   | `{repoInitialised, lastBackupAt, lastSnapshotId, lastCheckAt, lastCheckOk, lastForgetAt, paused}` |

## 4. Ingest state machine

```
             outbox entry seen                     upload batch completed
                    │                                        │
                    ▼                                        │
               incoming ──► stabilising ─┐                   │
                                 ▲  │    │ stable 2 min      │
              (changed again)────┘  │    ▼                   ▼
                                    │  hashing  ◄────────────┘
                                    │    │ info built, stored
                                    │    ▼
                                    │  snapshotting ── backup ok & covers item ──► (outbox source:
                                    │    │                                         verify + remove
                                    │    │                                         outbox entry) ──► ready
           any step fails ─────────►└──► error   (admin "retry" → back to the failed step)
                                         ready ──(delete)──► deleted
```

* **incoming**: the entry exists in `/data/outbox` (found by a scan on start, by Syncthing events and
  by a periodic rescan every 30 s) and has an item row.
* **stabilising** means waiting until **all** of these hold:
  1. Syncthing `GET /rest/db/need?folder=<id>` lists no needed files under the entry.
  2. No `.syncthing.*.tmp` files are under the entry.
  3. `GET /rest/db/completion?folder=<id>&device=<PC device id>` reports `completion == 100`.
  4. The entry's tree fingerprint (path, size and mtime of every file) is unchanged for
     `INGEST_QUIET_SECONDS` (default 120).
  5. Syncthing reports the folder `state` as `idle`.

  If any of these fails, the stability timer restarts.
* **hashing** (outbox source):
  1. **Hard-link** the entry tree into `/data/library/<name>` (`<name>` = the entry name; if it is
     taken, add a ` (YYYY-MM-DD HHmm)` suffix, then ` (n)`).
  2. Set `library_at`.
  3. Build the torrent info dict from the library copy in a worker thread (no announce, private=1,
     `pieceLength = 4 MiB` default; ≤ 64 MiB items use 1 MiB) and store `info`, `piece_length`,
     `total_bytes` and `file_count`.

  Hard links mean the outbox entry is **not** removed by this step. Upload source: `rename` from
  staging into the library (staging is not synced).
* **snapshotting**:
  1. `requestSnapshot('ingest', itemId)`.
  2. Wait until `findCoveringBackup(itemName, library_at)` returns a run. A covering run has
     `status='ok'`, `started_at >= library_at`, and `library_entries` containing the item name.
     Record it in `snapshot_run_id`.
* **outbox removal** (outbox source only, still in `snapshotting`):
  1. Re-walk the outbox entry and verify that every file is the **same inode** as its library
     counterpart, with no extra and no missing files.
  2. Only then remove the outbox entry (`rm -r`). Syncthing propagates the delete to the PC.
     (Implementation: the entry is first renamed to `/data/.ingest-trash/<itemId>`, verified again
     there, and only then deleted; on a late mismatch it is renamed back.)
  3. If verification fails, do **not** delete. Set `error` to "outbox copy changed after ingest;
     not removed". The library copy stays (status `error`, retry re-verifies).
* **ready**: shareable.
* **Invariant (tested): an outbox file is never deleted unless it is verified in the library and
  covered by a successful snapshot.**
* **delete**:
  0. Outbox items that are not `ready` still have their outbox entry, so deleting only the library
     copy would re-ingest it on the next scan (and an un-snapshotted outbox entry is never deleted).
     Such a delete is a **409** "still in the PC outbox — remove it there, or wait until it's ready".
     Exception: an `error` item whose outbox entry is already gone can be deleted. The dashboard
     hides Delete for outbox items in `incoming`/`stabilising`/`hashing`/`snapshotting`.
  1. Revoke all shares (stops seeding).
  2. `rm -r` the library entry.
  3. Set status `deleted`, `deleted_at`, and the tombstone name `<name> [deleted <id>]`, so the name
     can be used again (also when an outbox entry disappears before ingest).
  4. `requestSnapshot('delete')`.

  Old snapshots keep the data until retention removes it.
* **rename**:
  1. Validate the new name (§9).
  2. Renaming to a name that is taken is a 409. "Taken" has one definition for ingest and the admin
     API (`isNameTaken`, `ingest/naming.ts`): another item row has it, or something exists at
     `/data/library/<name>`. Deleted rows hold tombstone names and never block.
  3. `rename()` on disk, update `items.name`.
  4. Re-point seedlinks for the item's active shares.
  5. `requestSnapshot('rename')`.

  Existing shares keep their frozen `torrent_name`. New shares use the new name (the info dict is
  re-encoded with the new `name`; pieces are unchanged, so nothing is re-hashed).

## 5. Snapshots (restic runner)

The `restic` service runs `node dist/backup/main.js`. It talks to the app **only through SQLite**
(`backup_requests`, `backup_runs`, `settings`). It has no network.

* **Backup paths:**
  - `/data/library`
  - `/state/backup/fileshare.db` (a fresh `db.backup()` copy taken by the runner just before each
    backup)
  - `/config/.env`
  - `/secrets` (excluding `restic-password`)
  - `/syncthing-config` (excluding `index-*`/DB files)

  Tag: `fileshare`. Restic env: `RESTIC_REPOSITORY=/restic`, `RESTIC_PASSWORD_FILE=/secrets/restic-password`,
  `RESTIC_CACHE_DIR=/state/restic-cache`. Compression: default (auto).
* **Debounce:** run a backup when there are unconsumed requests and the newest one is ≥
  `SNAPSHOT_DEBOUNCE_SECONDS` (120) old, or the oldest one is ≥ 10 min old.
* **Hourly:** run a backup if the last successful backup started more than 60 min ago (and anything
  changed, or always; restic dedups).
* **Failure back-off:** after a failed backup, the next one waits 5, 10, 20, 40, then 60 min. A
  `manual` request made after the last failed backup started bypasses the back-off once (if that
  run fails too, the request is older than the new failure and waits like the others).
* **Pause window `SNAPSHOT_PAUSE_WINDOW` = `03:45-05:15` (local `TZ`):**
  - No job starts in `[pause_start − 15 min, pause_end)`.
  - A job still running at `pause_start` gets SIGINT (status `interrupted`).
  - Requests queue up and run after the window.
* **Forget/prune:** Sunday 14:00 local, `forget --tag fileshare --keep-within 48h --keep-daily 30
  --keep-weekly 26 --prune`.
* **Check:** Sunday 15:00 local (or after prune), `check --read-data-subset=5%`. The result goes to
  `status.restic`, and a failure shows on the dashboard.
* **Missed schedules:** if the container was down, a missed weekly job runs at the next opportunity
  outside the pause window.
* The runner `init`s the repo if it is missing. It never deletes or rewrites restic locks belonging
  to other processes. It holds an exclusive lock in-process; there is only one runner.

Shared API (`src/backup/queue.ts`, used by ingest/admin):

```ts
requestSnapshot(db, reason: 'ingest'|'delete'|'rename'|'manual', itemId?: string): number
findCoveringBackup(db, itemName: string, sinceMs: number): BackupRunRow | undefined
latestRuns(db): { backup?: BackupRunRow; forget?: BackupRunRow; check?: BackupRunRow }
```

## 6. Ports and listeners

| Listener                    | Bind (default)               | Who reaches it |
|-----------------------------|------------------------------|----------------|
| public HTTP                 | `PUBLIC_BIND=127.0.0.1`, `PUBLIC_PORT=8090` | system Caddy (`files.<domain>:8443` → here) |
| admin HTTP                  | `ADMIN_BIND` (docker bridge gateway of the tunnel's network), `ADMIN_PORT=8091` | cloudflared only (+ ufw allow from that bridge subnet) |
| BitTorrent TCP + uTP        | `0.0.0.0:6890` (`BT_PORT`)   | internet (router forward + ufw) |
| WebRTC ICE (UDP mux)        | `0.0.0.0:6891` (`WEBRTC_PORT`) | internet (router forward + ufw) |
| Syncthing sync              | `${LAN_IP}:22000` tcp+udp (published) | the PC on the LAN |
| Syncthing GUI/REST          | `127.0.0.1:8384` (published) | `app` (host network, API key) + operator via SSH tunnel (GUI login `admin` + `syncthing-gui-password`) |

Caddy's public site is on **port 8443 only** (router: external 443 → server 8443). Every URL the app
emits is built from `PUBLIC_BASE_URL` (e.g. `https://files.example.com`), **never** from the request's
Host/port. The admin listener **must not** bind a public interface; `config.ts` refuses `0.0.0.0` and
`::` for `ADMIN_BIND`.

## 7. HTTP routes

### 7.1 Public listener (`src/server/public.ts`). No `/api/admin`, no tus, no admin static, ever

| Method | Path | Owner | Notes |
|---|---|---|---|
| GET | `/healthz` | server | `{ok:true}` |
| GET | `/s/:shareId` | server | Serves `dist/web/recipient/index.html` for **any** id (constant shell, no data, `Cache-Control: no-store`). An unknown id must look identical. |
| GET | `/assets/*` | server | static files from `dist/web/recipient/` (hashed names, long cache) |
| GET | `/sw.min.js` | server | WebTorrent service worker at root scope (`Service-Worker-Allowed: /`) |
| GET | `/vendor/*` | server | `webtorrent.min.js` (ESM) etc. copied by `build-web.mjs` |
| GET | `/api/s/:shareId` | p2p | `{status:'locked'|'open'|'gone', passwordRequired:boolean}`. `gone` = unknown, revoked or expired (no distinction). No names. |
| POST | `/api/s/:shareId/unlock` | p2p | body `{password?: string}` → 200 `UnlockResponse` (§7.3) / 401 `{error:'bad_password'}` / 404 `{error:'gone'}` / 429 `{error:'rate_limited', retryAfter}`. Rate limit: 5 failures per 10 min per (share, client IP) and 50 failures per hour per share; IPs live in memory only. An `unlocked` share event is written at most once per (share, client) per 10 min. |
| GET | `/api/s/:shareId/torrent?t=<token>` | p2p | `.torrent` (`application/x-bittorrent`, `Content-Disposition: attachment`) |
| GET | `/tr/:token/announce` | p2p | HTTP tracker announce (torrent clients). `/tr/:token/scrape` → 404. Limited to 60 announces per minute per client IP (429 + bencoded `failure reason: rate limited`; IPs HMAC'd in memory only). |
| GET (WS) | `/tr/:token` | p2p | WebSocket tracker (browsers). At most 500 sockets per share and 5000 in total; beyond that the socket is closed with 1013. |
| GET/HEAD | `/ws/:token/*` | p2p | webseed: `/<torrent_name>/<file path>` (or `/<torrent_name>` for single-file). Range support, throttled by the shared upload limiter, CORS `*` for GET/HEAD only, no cookies. |
| GET (WS) | `/api/s/:shareId/live` | p2p | swarm stats socket (§8) |

Security headers (all public responses):
- strict CSP: `default-src 'self'; connect-src 'self' wss://<public host>; img-src 'self' data:;
  worker-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none';
  form-action 'self'`
- `Referrer-Policy: no-referrer`
- `X-Content-Type-Options: nosniff`
- `Cross-Origin-Opener-Policy: same-origin`
- `Permissions-Policy` minimal

HSTS is set by Caddy. Request logging: Fastify's built-in request lines (full URL + client IP) are
off on both listeners (`server/log-controller.ts`, a `LogController` with request logging disabled;
5xx errors are still logged, without URL or IP). Each listener logs one line per response itself.
On the public listener the URL goes through `redactUrl()` (`log.ts`): the `/tr/` and `/ws/` token
segment becomes `[token]`, `/tr/` query strings are dropped, every `t=` value becomes `[token]`,
share ids in `/s/<id>` and `/api/s/<id>/…` are cut to their first 4 characters plus `…`, and
unmatched paths are logged as `[unmatched]`. Client IPs are never logged.

### 7.2 Admin listener (`src/server/admin.ts`)

Every request except `/healthz` passes `accessJwt` middleware:
1. Verify `Cf-Access-Jwt-Assertion` with `jose` (RS256) against `https://${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`,
   `issuer = https://${CF_ACCESS_TEAM_DOMAIN}` and `audience = CF_ACCESS_AUD`. `CF_ACCESS_TEAM_DOMAIN`
   must be a bare host name ending in `.cloudflareaccess.com` (otherwise every request is refused and
   the reason is logged at startup).
2. A token without an `email` claim (Access service token) is refused unless `ADMIN_EMAILS` lists its
   client id (`common_name` claim) explicitly.
3. If `ADMIN_EMAILS` is set, require the `email` claim to be in it. If it is empty, any identity the
   Access policy admits is allowed, and a warning is logged at startup (outside tests).
4. Otherwise 403. (`CF_ACCESS_CERTS_URL` overrides the certs URL **only with `NODE_ENV=test`**; in any
   other mode it is ignored with a startup warning. In tests the team domain may be any host name.)

Mutating requests must also be `Content-Type: application/json` (except tus) and carry an `Origin`
equal to `ADMIN_BASE_URL`.

| Method | Path | Owner | Notes |
|---|---|---|---|
| GET | `/healthz` | server | no auth (used by Docker healthcheck on loopback… see compose) |
| GET | `/`, `/assets/*` | server | dashboard static (`dist/web/admin/`) |
| GET | `/api/admin/items` | admin | `ItemDto[]` |
| PATCH | `/api/admin/items/:id` | admin→ingest | `{name}` rename |
| DELETE | `/api/admin/items/:id` | admin→ingest | delete item (revokes shares). 409 for an outbox item that is not ready (an `error` one: while its outbox entry exists), see §4 |
| POST | `/api/admin/items/:id/retry` | admin→ingest | retry after error |
| GET | `/api/admin/items/:id/files` | admin | `{path,length}[]` |
| GET | `/api/admin/shares` | admin | `ShareDto[]` (incl. stats) |
| POST | `/api/admin/shares` | admin→p2p | `{itemId, password?: string, expiresAt?: number}` → `ShareDto` (incl. `url`) |
| PATCH | `/api/admin/shares/:id` | admin→p2p | `{password?: string|null, expiresAt?: number|null}`. `null` clears; absent = unchanged. Changing the password bumps `token_version`. |
| POST | `/api/admin/shares/:id/revoke` | admin→p2p | |
| POST | `/api/admin/shares/:id/reset-limits` | admin→p2p | clears the share's unlock failure counters (per share and per client); 404 for unknown ids |
| GET | `/api/admin/shares/:id/events` | admin | history |
| GET | `/api/admin/stats` | admin | `StatsDto`: totals, per share, upload now vs cap, peak swarm |
| GET | `/api/admin/status` | admin | disks, restic status, Syncthing connection, versions |
| GET/PUT | `/api/admin/settings` | admin | `{uploadCapBps, uploadCapacityBps}` |
| POST | `/api/admin/snapshots` | admin | manual snapshot request |
| POST | `/api/admin/uploads/batches` | ingest | → `{id}` |
| GET | `/api/admin/uploads/batches/:id` | ingest | → `{id, status}` (404 unknown). The dashboard keeps its batch id in `localStorage` until `complete` succeeds and reuses it after a reload while it is `open`: a resumed tus upload keeps the metadata it was **created** with, so it always finishes into its original batch. |
| POST | `/api/admin/uploads/batches/:id/complete` | ingest | the batch's top-level entries become items. Errors carry `{error, message}`: 400 `batch_empty` (no finished file yet), 409 `batch_not_open` (already completed/failed; start a new upload). A tus upload finishing into a batch that is no longer open gets 409 "…already finished; remove the file and add it again". |
| * | `/api/admin/uploads/tus/*` | ingest | tus 1.0 (`@tus/server` + `@tus/file-store`). Metadata: `batchId`, `relativePath`, `filename`. Clients use 50 MiB chunks. |
| GET (WS) | `/api/admin/live` | admin | §8 admin stream |

### 7.3 DTOs (`src/types.ts`)

```ts
interface UnlockResponse {
  token: string;                       // share access token (§9)
  infoHash: string;
  name: string;                        // torrent_name
  totalBytes: number;
  pieceLength: number;
  files: { path: string; length: number }[];   // path relative to torrent root, '/' separators
  torrentUrl: string;                  // `${PUBLIC_BASE_URL}/api/s/<id>/torrent?t=<token>`
  magnet: string;                      // xt, dn, tr=wss + https announce, ws=webseed
  announce: { ws: string; http: string };  // wss://…/tr/<token>, https://…/tr/<token>/announce
  webseed: string;                     // `${PUBLIC_BASE_URL}/ws/<token>/`
  iceServers: { urls: string }[];      // STUN only
  expiresAt: number | null;
}
```

The full `ItemDto`, `ShareDto` and `StatsDto` are defined in `src/types.ts`.

## 8. WebSocket stats protocol (JSON text frames)

**Recipient: `wss://<public>/api/s/:shareId/live`**

client → server:
```jsonc
{"t":"hello","token":"<share token>","peerId":"<40 hex, the WebTorrent peerId>","nick":"optional ≤24 chars"}
{"t":"stats","progress":0.42,"down":123456,"up":65432,"uploaded":104857600,"downloaded":2147483648,"done":false}
{"t":"nick","nick":"Sam"}
```
* `hello` must come first, within 10 s. If the token is invalid, the socket closes with code 4401.
  If the share is gone, code 4404.
* `stats` comes every 1–2 s. The server ignores more than 2 per second, and ignores values that are
  non-finite or negative.
* Nicknames are trimmed, have control characters removed, and are ≤ 24 chars. They are rendered
  with `textContent` only.

server → client (every ~1.5 s, and on change):
```jsonc
{"t":"swarm",
 "you":"p3",
 "peers":[
   {"id":"srv","label":"Server","kind":"server","progress":1,"down":0,"up":5242880,"uploaded":9876543210},
   {"id":"p3","label":"Sam","kind":"browser","progress":0.42,"down":123456,"up":65432,"uploaded":104857600},
   {"id":"p7","label":"Torrent client","kind":"client","progress":0.1,"down":0,"up":0,"uploaded":0}],
 "totals":{"peers":3,"serverBytes":123,"peerBytes":456,"completed":1}}
```
* `id` is an opaque per-share counter, never an IP and never the peerId.
* Browser rows without a nick are labelled "Friend N".
* Torrent-client rows take progress from the seeder's `wire.peerPieces` bitfield when connected,
  otherwise from the tracker announce's `left`.
* Peers that disconnect are removed after 30 s.
* Accounting: `peer_bytes` counts the increase of each peer's reported cumulative `uploaded`, and a
  completion counts once per peer id. The per-peer ledger is kept while the share is active (also
  across idle periods) and dropped when it becomes inactive. A tracker `completed` event counts
  only if that peer announced `started`/an update before. Bounds per share: at most 1000
  remembered peers per map (oldest evicted) and at most 200 counted completions per rolling hour.
* **No IPs anywhere in any message, log line at info level or DB row.**
* **Privacy, inherent to P2P:** recipients in the same swarm see each other's IP addresses (WebRTC
  ICE candidates relayed by the tracker; HTTP tracker peer lists for torrent clients). The app never
  stores or displays them. README and the share page (under the swarm table) say so.

**Admin: `wss://<admin>/api/admin/live`** (JWT checked on upgrade), server → client every ~2 s:
```jsonc
{"t":"live","upload":{"capBps":1,"currentBps":1},"shares":{"<shareId>":{ ...same "peers"/"totals" as above ... }},
 "items":[{"id":"…","status":"hashing","progress":0.3}]}
```

## 9. Tokens, ids, names

* `newId()`: 16 random bytes as base32 lowercase (26 chars). `newShareId()`: 16 random bytes as
  base64url (22 chars).
* **Share token**: `<shareId>.<tokenVersion>.<mac>`, where
  `mac = base64url(HMAC-SHA256(SHARE_HMAC_KEY, "fileshare/share/v1\n" + shareId + "\n" + tokenVersion))[0..22]`.
  - Verify by parsing, recomputing, and comparing with `crypto.timingSafeEqual`.
  - **Then** load the share and require: it exists, `token_version` matches, it is not revoked, and
    it is not expired.
  - Tokens carry no expiry of their own; share state is checked on **every** use (unlock is the
    only issuer).
  - Tokens are path-safe (`[A-Za-z0-9_.-]`).
* The tracker `filter` accepts an announce only if the token is valid **and** `info_hash ===
  share.info_hash`.
* Webseed: the token must be valid, `torrent_name` must match, and the file path must exist in that
  share's file list. The server resolves `/data/library/<item.name>/<file path>` through `safeJoin`
  (§core/paths) and refuses symlinks.
* **Names** (item rename and upload `relativePath` segments):
  - NFC-normalised, 1–200 bytes per segment.
  - None of `/ \ \0`, control characters, or `. ..`.
  - No leading/trailing spaces.
  - Not starting with `.syncthing.`.
  - For web uploads, reject `#`, `?` and `%` in names (WebTorrent does not URL-encode webseed paths).
* **Share info dict** = item `info` with `source: "fileshare-<shareId>"` added. That gives each share
  its own infohash (its own swarm) without re-hashing. `private: 1`. Each share's `.torrent` carries:
  - `announce` = the https tracker
  - `announce-list` = [[https], [wss]]
  - `url-list` = [webseed]
  - no `nodes`

## 10. Upload limiter

There is one process-wide token bucket (`p2p/limiter.ts`) for **all** server upload:
- webseed responses
- seeder (TCP, uTP, WebRTC)

The seeder uses WebTorrent's upload throttle group. The webseed pipes through a throttle from the
**same** group. The rate is the **effective cap** from `core/upload-cap.ts` (the one definition,
also used by the dashboard/stats/live): `upload.cap_bps` if set, else `floor(0.9 × upload.capacity_bps)`
if a capacity is known, else unlimited. It is re-applied live on `settings.changed` for either key.
`currentBps()` is a 2 s moving average used by stats.

## 11. P2P settings (verified against webtorrent 3.0.21)

**Server client:**
- `dht:false`, `lsd:false`, `utPex:false`, `natUpnp:false`, `natPmp:false`, `torrentPort: BT_PORT`
- `tracker.rtcConfig: { iceServers: STUN, portRangeBegin: WEBRTC_PORT, portRangeEnd: WEBRTC_PORT,
  enableIceUdpMux: true, bindAddress: '0.0.0.0' }`
- `tracker.getAnnounceOpts: () => ({ numwant: 0 })`
- `uploads` raised (e.g. 64)
- `storeCacheSlots` 0–4
- `secure` per measurement (see notes)

Torrents are added from stored metainfo with `{ path: /state/seedlinks/<shareId>, skipVerify: true }`.
Only **active** shares are seeded. They are added and removed on `share.changed`, and an expiry
sweep runs every 30 s. The same reconcile step ends live access: when a share stops being active it
is unseeded, its tracker swarm and WebSockets are dropped, and its **in-flight webseed responses are
destroyed**; when its `token_version` changes (new password), sockets and webseed responses
authorised with the old version are closed. `revokeAllForItem` (item delete) also ends every
in-flight webseed response for the item's shares before the files are removed.

**Browser client:**
- `client.add(torrent, { strategy:'rarest', deselect:true, maxWebConns: 2 })` with the tracker's
  `rtcConfig.iceServers` from the unlock response
- `webSeeds: false` initially: add the webseed only when no peer has delivered data for ~10 s or no
  peer has the needed pieces, and remove it when peers return
- Then `file.select()` for each ticked file

If browser↔server WebRTC can't be made reliable through NAT, set `WEBRTC_ANNOUNCE_IP` to make the
tracker append a host candidate `<ip> <WEBRTC_PORT> typ host` to SDPs it relays from the server's
peer. The outcome is recorded in `docs/RUNBOOK.md`.

## 12. Configuration (`.env`)

See `.env.example` for every variable and its default. The main groups are:
- public/admin base URLs and binds
- data and appdata paths
- `PUID`/`PGID`/`TZ`
- the ports
- STUN servers
- Syncthing folder id and API URL
- Cloudflare Access team domain and AUD
- the snapshot debounce and pause window

**Secrets are never env vars in git.** They live in files under `${APPDATA}/secrets/` (mode 600),
created by `scripts/gen-secrets.sh`:

| file                    | used by        |
|-------------------------|----------------|
| `share-hmac-key`        | app            |
| `syncthing-api-key`     | app, syncthing (`STGUIAPIKEY` via entrypoint from file) |
| `syncthing-gui-password`| operator: Syncthing GUI user `admin`; set via REST by `scripts/syncthing-init.sh` (Syncthing stores a bcrypt hash) |
| `restic-password`       | restic runner  |
| `cloudflare-api-token`  | ddns (created by the user) |

## 13. Module interfaces (TypeScript, see `src/**/index.ts`)

```ts
interface AppContext { config: Config; db: Db; log: Logger; events: AppEvents }

// src/core/events.ts — typed in-process bus
type AppEventMap = {
  'item.status':      { itemId: string; status: ItemStatus };
  'item.renamed':     { itemId: string; oldName: string; newName: string };
  'item.deleted':     { itemId: string };
  'share.changed':    { shareId: string; reason: 'created'|'updated'|'revoked'|'expired' };
  'settings.changed': { key: string };
};

// src/ingest/index.ts
interface IngestService {
  start(): Promise<void>; stop(): Promise<void>;
  retry(itemId: string): Promise<void>;
  renameItem(itemId: string, newName: string): Promise<void>;
  deleteItem(itemId: string): Promise<void>;          // calls p2p.revokeAllForItem first
  registerAdminRoutes(app: FastifyInstance): Promise<void>; // tus + upload batch routes
  progress(): Record<string, number>;                  // itemId → 0..1 while hashing
}
createIngest(ctx: AppContext, deps: { p2p: Pick<P2PService,'revokeAllForItem'|'repointItem'> }): IngestService

// src/p2p/index.ts
interface P2PService {
  start(): Promise<void>; stop(): Promise<void>;
  registerPublicRoutes(app: FastifyInstance): Promise<void>;
  createShare(input: { itemId: string; password?: string; expiresAt?: number }): Promise<ShareDto>;
  updateShare(id: string, patch: { password?: string | null; expiresAt?: number | null }): Promise<ShareDto>;
  revokeShare(id: string): Promise<void>;
  revokeAllForItem(itemId: string): Promise<void>;
  repointItem(itemId: string): Promise<void>;          // after rename: fix seedlinks
  resetUnlockLimits(id: string): void;                 // admin "reset limits"
  swarm(shareId: string): SwarmSnapshot | undefined;
  allSwarms(): Record<string, SwarmSnapshot>;
  limiter: UploadLimiter;
}
interface UploadLimiter { setRate(bytesPerSec: number): void; throttle(): import('node:stream').Transform; currentBps(): number }

// src/admin/index.ts
registerAdminApi(app: FastifyInstance, ctx: AppContext, deps: { ingest: IngestService; p2p: P2PService }): Promise<void>
```

## 14. Testing

* **Unit:** `vitest`, `*.test.ts` next to the code, with temp dirs and in-memory or temp SQLite.
* **Integration:** `test/integration/*.test.ts`. The real app runs in-process on ephemeral ports,
  with a fake Syncthing REST server and a local JWKS for Access. `full-stack.test.ts` wires the real
  admin listener + ingest + p2p + public listener together (tus upload → ready → share → unlock →
  webseed → revoke → delete); only Syncthing, the restic runner and the Access key server are fakes.
* **E2E:** Playwright (`test/e2e/`). The app runs via `scripts/test-stack.sh` on non-default ports.
  It covers 6 Chromium peers, Firefox fallback, enforcement and the upload cap.
* **Test data is always synthetic:** random bytes from `scripts/gen-testdata.sh`.
