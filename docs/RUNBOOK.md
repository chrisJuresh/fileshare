# Runbook

All commands run on the server from the repository directory, as the user that owns the stack
(`PUID`). Paths are the `.env` defaults; substitute yours. The restic container has
`RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` and `RESTIC_CACHE_DIR` set, so plain `restic …` works
inside it.

Helper used below: reading the Syncthing API key without putting it on a command line.

```bash
st() { curl -fsS -H @<(printf 'X-API-Key: %s\n' "$(cat /srv/appdata/fileshare/secrets/syncthing-api-key)") "http://127.0.0.1:8384$1"; }
```

## Operate

### Status and logs

```bash
docker compose ps                                  # all services "healthy" (ddns has no healthcheck)
docker compose logs -f --since 1h app              # JSON lines; pipe through `jq -c` to read
docker compose logs --since 24h restic | grep -E '"level":(40|50)'   # warnings/errors
docker compose exec restic node dist/backup/main.js status           # snapshot status + latest runs
st /rest/system/connections | jq '.connections[] | {connected, address}'   # PC connected?
```

The dashboard shows the same: items, shares, live swarms, upload cap, disks, snapshot status.
Logs never contain share tokens, passwords, JWTs or peer IP addresses; keep it that way when
adding log lines.

Syncthing GUI (rarely needed): `ssh -L 8384:127.0.0.1:8384 <server>`, then open
http://localhost:8384 locally and log in as **`admin`** with the password in
`${APPDATA}/secrets/syncthing-gui-password` (view it privately: `less <that file>`; never paste it
into chat or tickets). The GUI is published on loopback only, and the app also runs on the host
network, so the password is what keeps other local processes out. `scripts/syncthing-init.sh`
sets it (idempotent; `pair-pc.sh` runs it too) — run it after every deploy. Syncthing stores only a
bcrypt hash; the app and scripts keep using the API key, which is unaffected.

### Restart / apply `.env` changes

```bash
docker compose restart app                 # same config
docker compose up -d                       # after editing .env or compose.yaml (recreates changed services)
```

`restic` bind-mounts `.env` as a single file (`/config/.env`, backed up as app config). A single-file
bind mount follows the inode, so a tool that replaces `.env` with a new file leaves running
containers on the old content until they are recreated. The scripts (`env_set` in
`scripts/lib.sh`, used by `pair-pc.sh`) therefore rewrite `.env` in place, keep it at mode 600 and
put the previous version in `${APPDATA}/host-backups/<timestamp>/env.bak`. After a hand edit,
`docker compose up -d` recreates `app` and `restic` anyway (their `env_file` changed).

The restic runner handles SIGTERM: a running restic job is interrupted cleanly (recorded as
`interrupted`) and its requests are retried later. `stop_grace_period` is 2 minutes.

### Upgrade

Everything is pinned; Watchtower is opted out on purpose. To upgrade:

1. Images: change the tag **and** digest in `compose.yaml` (Syncthing, ddns) or `Dockerfile`
   (Node base, restic). Get the digest with `docker buildx imagetools inspect <image>:<tag>`.
   Read the upstream release notes first (Syncthing major versions change the DB format;
   restic repository format changes are announced).
2. Node dependencies: bump exact versions in `package.json`, `npm install`, `npm run typecheck && npm test`.
3. Deploy: `docker compose pull syncthing && docker compose up -d --build`, then check
   `docker compose ps` and the dashboard.
4. Clean up: `docker image prune` (dangling images only).

## Snapshots

Schedule (local `TZ`): a backup runs when requests are ≥ `SNAPSHOT_DEBOUNCE_SECONDS` old (or the
oldest is ≥ 10 min old), and at least hourly. Forget/prune runs on Sunday 14:00, check
(`--read-data-subset=5%`) on Sunday 15:00. Missed weekly jobs run at the next chance. Nothing starts
in `[pause start − 15 min, pause end)`, and a job still running at pause start is interrupted.

Retention: `--keep-within 48h --keep-daily 30 --keep-weekly 26`, tag `fileshare`.

### Run one now

Dashboard → "Snapshot now", or:

```bash
docker compose exec restic node dist/backup/main.js request
```

It runs within ~10 s, unless another job is running or the pause window is active. This also
applies after a failed backup: a manual request skips the failure back-off once (fix the cause
first; if it fails again, the next automatic retry follows the back-off).

### List and browse

```bash
docker compose exec restic restic snapshots --tag fileshare
docker compose exec restic restic ls latest /data/library            # top level of the library
docker compose exec restic restic ls <snapshot-id> "/data/library/<item name>"
```

### Restore a single item

Restore with a one-off restic container (no network) into a directory on the data disk, which has
room for the item and is writable by `PUID` (`/srv` itself is root-owned, and a root-created
directory isn't writable by the container). The repository is mounted read-only for the restore;
restic then needs `--no-lock`. Without a lock a concurrent `forget --prune` could remove data the
restore still reads, so don't run it during the weekly forget (Sunday 14:00) or stop the runner
first (`docker compose stop restic`).

```bash
envv() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | tr -d "\"'"; }   # value from .env
DATA_ROOT=$(envv DATA_ROOT); APPDATA=$(envv APPDATA); RESTIC_REPO_HOST=$(envv RESTIC_REPO_HOST)
install -d -m 0750 "$DATA_ROOT/restore"            # must be empty
docker compose run --rm --no-deps \
  -v "$DATA_ROOT/restore:/restore" -v "$RESTIC_REPO_HOST:/restic:ro" restic \
  restic restore latest --no-lock --target /restore --include "/data/library/<item name>"
ls -la "$DATA_ROOT/restore/data/library/<item name>"
```

Then either:

- **Bring it back as a new item:** upload it from the dashboard's Upload tab (copy it to a machine
  with a browser first, e.g. `scp -r`). It goes through the normal ingest (hash, snapshot) and you
  share it again. **Don't** move it into `${DATA_ROOT}/outbox/`: that is a Send & Receive folder,
  so Syncthing would first sync the whole item to the PC (ingest waits for the PC to report 100%),
  and both copies are removed again after the snapshot. There is no CLI to register files placed
  directly in the library.
- **Repair a damaged library entry in place** (the item still exists in the dashboard, same name):
  stop the app (`docker compose stop app`), replace `${DATA_ROOT}/library/<item name>` with the
  restored copy (`cp -a`), then `docker compose start app`. Existing shares keep working, because the
  content (and therefore every piece hash) is identical.

Use `<snapshot-id>` instead of `latest` for an older version (`restic snapshots` lists them).
Delete the restore directory when done: `rm -rf "$DATA_ROOT/restore"`.

### Full restore (lost data disk or new server)

1. Stop the stack: `docker compose --profile public down`.
2. Recreate the directories (`scripts/init-dirs.sh`). Put the restic password from your password
   manager into `${APPDATA}/secrets/restic-password` (mode 600). Mount or copy the repository to
   `${RESTIC_REPO_HOST}`.
3. Restore everything into a staging directory on the data disk (needs free space for the whole
   library; `envv` as in "Restore a single item"; the stack is stopped, so `--no-lock` is safe):
   ```bash
   DATA_ROOT=$(envv DATA_ROOT); APPDATA=$(envv APPDATA); RESTIC_REPO_HOST=$(envv RESTIC_REPO_HOST)
   install -d -m 0750 "$DATA_ROOT/restore"
   docker compose run --rm --no-deps \
     -v "$DATA_ROOT/restore:/restore" -v "$RESTIC_REPO_HOST:/restic:ro" restic \
     restic restore latest --no-lock --target /restore
   ```
4. Put things back (as `PUID`):
   ```bash
   R="$DATA_ROOT/restore"
   cp -a "$R/data/library/." "$DATA_ROOT/library/"
   cp -a "$R/state/backup/fileshare.db" "$APPDATA/app/fileshare.db"
   rm -f "$APPDATA/app/fileshare.db-wal" "$APPDATA/app/fileshare.db-shm"
   cp -a "$R/secrets/." "$APPDATA/secrets/"                 # restic-password is not in it
   cp -a "$R/syncthing-config/." "$APPDATA/syncthing/"
   diff "$R/config/.env" .env                                # reconcile by hand
   ```
   The staging directory is on the same disk, so `mv` instead of `cp -a` for the library avoids
   needing the space twice (at the cost of no second copy until the stack is verified). The
   Syncthing database is not backed up. Syncthing rebuilds it with a
   rescan, and the device identity (`cert.pem`/`key.pem`) is restored, so the PC reconnects without
   re-pairing.
5. `docker compose up -d`, then check the dashboard: active shares seeding (the app recreates
   `/state/seedlinks` for active shares) and items `ready`, with one expected exception. The DB copy
   in a snapshot is taken just before that backup runs, so items whose ingest that same backup
   completed come back as **`snapshotting`**. No action is needed: the restic runner marks the
   restored `running` backup row as failed ("runner restarted while running") and re-queues its
   requests; because they are old, the next backup starts as soon as the runner is up (outside the
   pause window). It lists those items in the library, and the app then marks them `ready` (their
   outbox entries are already gone, which counts as handled). They can be shared once `ready`.
   Other states after a restore:
   - `stabilising` items whose outbox entry is gone are marked deleted ("outbox entry disappeared
     before ingest"). Anything still in the PC's outbox syncs back and is ingested as a new item.
   - If the PC still has a copy of a `snapshotting` item, that item goes to `error` ("outbox copy
     changed after ingest; not removed"): delete the copy on the PC, then **Retry** the item.
6. Remove the staging directory when done: `rm -rf "$DATA_ROOT/restore"`.

### Check, locks, repair

```bash
docker compose exec restic restic check                        # metadata only, fast
docker compose exec restic restic check --read-data-subset=10%
docker compose exec restic restic list locks
```

The runner never removes locks. If a crash left a stale lock (restic reports "repository is
already locked"): stop the runner, then `docker compose run --rm --no-deps restic restic unlock`
(removes stale locks only), then start it again.

## Rotate secrets

All secrets are files in `${APPDATA}/secrets/` (mode 600). Never paste them into chat, tickets or
logs.

### Share HMAC key (`share-hmac-key`)

Rotating it **invalidates every issued share token**. Share links (`/s/<id>`) keep working, because
share IDs don't depend on the key, but:

- open share pages lose their tracker and webseed connections, and recipients must reload and
  unlock again (re-enter the password if there is one);
- downloaded `.torrent` files and magnets contain the old token and stop working for torrent clients.

```bash
docker compose stop app
mv /srv/appdata/fileshare/secrets/share-hmac-key{,.old}
scripts/gen-secrets.sh                      # creates a new one (keeps the others)
docker compose up -d app
shred -u /srv/appdata/fileshare/secrets/share-hmac-key.old
```

To end access for a single share, revoke the share instead. That is immediate and doesn't affect
other shares.

### Syncthing API key (`syncthing-api-key`)

```bash
mv /srv/appdata/fileshare/secrets/syncthing-api-key{,.old}
scripts/gen-secrets.sh
docker compose up -d --force-recreate syncthing app
shred -u /srv/appdata/fileshare/secrets/syncthing-api-key.old
```

### Syncthing GUI password (`syncthing-gui-password`)

```bash
mv /srv/appdata/fileshare/secrets/syncthing-gui-password{,.old}
scripts/gen-secrets.sh
scripts/syncthing-init.sh                   # sets the new password (the old login stops working)
shred -u /srv/appdata/fileshare/secrets/syncthing-gui-password.old
```

### restic password (`restic-password`)

Add a new key, switch to it, then remove the old key:

```bash
S=/srv/appdata/fileshare/secrets
(umask 077; head -c 32 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '=' > "$S/restic-password.new")
docker compose run --rm --no-deps restic restic key add --new-password-file /secrets/restic-password.new
docker compose run --rm --no-deps restic restic key list        # note the old key's ID (not "*")
docker compose stop restic
mv "$S/restic-password" "$S/restic-password.old"; mv "$S/restic-password.new" "$S/restic-password"
docker compose run --rm --no-deps restic restic key remove <old-key-id>
docker compose up -d restic
shred -u "$S/restic-password.old"
```

Update the password manager entry before shredding the old file.

### Cloudflare API token (`cloudflare-api-token`)

Roll the token in the Cloudflare dashboard (My Profile → API Tokens → Roll), then:

```bash
rm /srv/appdata/fileshare/secrets/cloudflare-api-token
scripts/gen-secrets.sh --cloudflare-token
docker compose --profile public up -d --force-recreate ddns
docker compose logs --since 5m ddns
```

## Troubleshooting

### Ingest stuck in "stabilising"

An entry moves on only when **all** of these hold for `INGEST_QUIET_SECONDS` (120 s): Syncthing
needs nothing under it, there are no `.syncthing.*.tmp` files, the PC reports 100% completion, its
file tree is unchanged, and the folder is `idle`.

```bash
st "/rest/db/status?folder=fileshare-outbox" | jq '{state, needFiles, needBytes, errors}'
st "/rest/db/completion?folder=fileshare-outbox&device=$(grep ^SYNCTHING_PC_DEVICE_ID= .env | cut -d= -f2)" | jq
st "/rest/db/need?folder=fileshare-outbox" | jq '[.progress[], .queued[], .rest[]] | length'
find /srv/fileshare-data/outbox -name '.syncthing.*.tmp'
```

Common causes: the PC went to sleep or lost Wi-Fi mid-transfer (completion < 100%); a program on
the PC keeps writing into the folder; `SYNCTHING_PC_DEVICE_ID` is empty or wrong (re-run
`scripts/pair-pc.sh`); a file is ignored on one side only (the `.stignore` lists must match).

### Adding files to a folder that is already shared

Dashboard → Library → **Add files** on a ready folder item, then upload the new files there. Only
the new files are uploaded. They are appended to the item's torrent after a BEP 47 pad file
(ARCHITECTURE §4 "add files"), and every share link of the item stays the same and shows them once
hashing is done. Things to tell recipients:

- **Torrent app:** download the `.torrent` from the link again and save it to the **same folder** as
  before. The app rechecks what it has and fetches only the new files (and at most one old piece).
  The old torrent stops getting peers, so a client still running it shows tracker errors.
- **Browser:** an open page reloads its file list by itself and shows a notice. A download that was
  running in the browser starts again.

A new file can't have the same name as something already in the folder: rename it and upload
again. Single-file items can't have files added. Put the file in a folder and share that instead.
If an add fails (status Error), **Retry** picks up where it stopped.

**Files already in the library** (e.g. uploaded as separate items, or synced from the PC outbox)
don't need uploading again: drag the item's row onto the folder's row in **Library**, or onto the
share's row in **Shares** (hover over the Shares tab while dragging to switch to it). Keyboard:
**Add from library** on the folder row (Library) or the share row (Shares). The added items are
**moved** into the folder: they disappear from the library as separate items, unless they have an
active link of their own, in which case they stay so that link keeps working (the files are hard
links, so keeping them costs no disk space). Recipients see the same as for **Add files** above.

### Recipient locked out of a password share

Wrong passwords are limited to 5 per 10 minutes per recipient and 50 per hour per share (§7.1 in
ARCHITECTURE). Someone guessing can therefore lock out the real recipient for up to an hour. If
that happens: Dashboard → Shares → **Reset limits** on that share (or `POST
/api/admin/shares/<id>/reset-limits`). It clears the counters for every recipient of that share.
If the guessing continues, change the password (Edit) or revoke the link and create a new one —
a new link has a new id.

### Syncthing not connected

- `st /rest/system/connections` shows the PC with `connected: false`.
- Device IDs: the server's ID on the PC and `SYNCTHING_PC_DEVICE_ID` here must match exactly.
- Addresses: the PC must have the server as `tcp://<LAN_IP>:22000` (relays and global discovery
  are off, so there is no fallback). Check the port is published: `ss -ltnu | grep 22000`.
- The PC's firewall must allow Syncthing (Windows asks on first run; allow on Private networks).
- `docker compose logs --since 30m syncthing | grep -iE 'connect|error'`.

### Syncthing restarts / OOM-killed during large transfers

`docker inspect fileshare-syncthing-1 --format '{{.State.OOMKilled}} {{.RestartCount}}'` shows
`true` / a rising count, and transfers restart from the last completed block. The container has
`mem_limit: 2g` and `GOMEMLIMIT=1536MiB` (Go's GC works to stay under it; 1 GiB was OOM-killed
while receiving a 1 GiB file). If it still happens, the documented low-memory settings
(docs.syncthing.net → "Tuning for Low Resources") can be set over the REST API or GUI
(Actions → Advanced): folder `hashers` and `copiers` = 1, folder `pullerMaxPendingKiB` = 16384,
option `maxConcurrentIncomingRequestKiB` = 32768. They trade throughput for memory, so raise
`mem_limit`/`GOMEMLIMIT` first if the host has RAM to spare (keep `GOMEMLIMIT` ~25% below the
limit). `docker stats fileshare-syncthing-1` shows the live usage.

### Certificate not issued

- `journalctl -u caddy --since -1h | grep -iE 'acme|certificate|challenge|error'`
- DNS: `dig +short files.example.com` must return the current public IPv4. The record must be
  **DNS only**, and the ddns container must be running (`--profile public`).
- Router: external 443 → server 8443. Only TLS-ALPN-01 is used (port 80 is not needed), and
  `alt_tlsalpn_port 8443` makes Caddy answer the challenge on 8443.
- Repeated failures hit Let's Encrypt rate limits; Caddy backs off and retries by itself. Fix the
  cause, then `sudo systemctl reload caddy`.
- `sudo caddy adapt --config /etc/caddy/Caddyfile | jq '.apps.tls.automation.policies'`: the
  public hostname's policy must show `"http": {"disabled": true}` and
  `"tls-alpn": {"alternate_port": 8443}`.

### WebRTC (browser ↔ server) not connecting

Symptoms: browsers only get data from the webseed, or from each other but never from "Server".

- UDP `WEBRTC_PORT` (6891) must be forwarded by the router **and** allowed by ufw
  (`sudo ufw status | grep 6891`).
- The server learns its public address from STUN (`STUN_URLS`, outbound UDP 3478/19302). Check the
  app logs for ICE/STUN errors.
- If STUN-derived candidates don't work through the router, set `WEBRTC_ANNOUNCE_IP=<public IPv4>`
  in `.env` and `docker compose up -d app`. The tracker then adds `<ip> 6891 typ host` to the
  server's offers. Remember to update it if the public IP changes.
- CGNAT on the home connection makes inbound WebRTC impossible. Recipients still get data from
  each other and from the webseed.
- Recipient-side symmetric NAT or strict corporate networks: expect webseed fallback.

### WebRTC outcome

_To be filled in after the go-live tests (USER-ACTIONS §6): which networks were tested, whether
browser↔server WebRTC worked with STUN only, and whether `WEBRTC_ANNOUNCE_IP` was needed._

### Disk full

- Dashboard → Status shows the data and restic disks. On the host: `df -h /srv/fileshare-data /srv/fileshare-restic`.
- Data disk: delete library items you no longer share (old snapshots keep them until retention
  removes them). Look for abandoned uploads in `${DATA_ROOT}/uploads`.
- Restic disk: tighten retention only deliberately. A manual
  `docker compose exec restic restic forget --tag fileshare --keep-within 48h --keep-daily 30 --keep-weekly 26 --prune`
  runs the normal policy now.
- Container logs are capped (10 MB × 5 per container); `docker system df` shows image/build-cache use.

### Snapshots not running / "paused"

- `docker compose exec restic node dist/backup/main.js status`: `paused: true` means the pause
  window is active (`SNAPSHOT_PAUSE_WINDOW`, local `TZ`, plus 15 minutes before it). Requests
  queue up and run after it ends.
- A failed backup is retried after 5, 10, 20, 40, then every 60 minutes. The error is in
  `status.error` and in the dashboard. After fixing the cause, "Snapshot now" retries at once.
- Exit code 3 ("some files could not be read") outside the library is accepted with a warning;
  inside the library it fails the run, and ingest waits. Fix permissions (everything must be
  readable by `PUID`).
- Wrong password (exit 12) or repository missing: check `${APPDATA}/secrets/restic-password` and
  that `${RESTIC_REPO_HOST}` is mounted. The runner only runs `init` when the repository is
  completely absent.
