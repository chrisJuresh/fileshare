# fileshare

A self-hosted file share. Drop files into a folder on your PC; they sync to a home server,
land in a **library** with deduplicated **snapshots** behind them, and can be **shared** as a link.
Recipients download in the browser over **peer-to-peer WebTorrent**: the server seeds, and every
recipient's browser passes pieces on to the others, so a popular link doesn't cost the server's
upload once per person.

## How it works

- **Intake:** a Syncthing folder ("Fileshare Outbox") on the PC syncs over the LAN to the server.
  Web upload (resumable, tus) from the admin dashboard works too.
- **Ingest:** once an entry has been stable for 2 minutes it is hard-linked into the library,
  hashed into a private torrent, and snapshotted with restic. Only then is it removed from the
  outbox (and so from the PC).
- **Snapshots:** a separate restic runner (no network) takes debounced and hourly snapshots,
  prunes weekly and checks a 5% sample of the data. It pauses during a configurable nightly window.
- **Sharing:** each share is its own private torrent with an optional password and expiry. Links
  carry an HMAC-signed token that is re-checked on every use, so revoking is instant.
- **Downloading:** the share page uses WebTorrent (WebRTC) between recipients and the server.
  An HTTP webseed is a capped fallback. Desktop torrent clients can use the `.torrent` or magnet.
- **Admin:** a dashboard behind Cloudflare Access (via a Cloudflare Tunnel) for items, shares,
  live swarm stats, upload cap, disks and snapshot status. The public site never serves admin routes.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Quickstart

Requirements: Linux host with Docker + Compose v2, a reverse proxy for TLS (the scripts target a
system Caddy), and a domain on Cloudflare. All values below are examples.

```bash
git clone https://github.com/<you>/fileshare.git && cd fileshare
cp .env.example .env          # edit: hostnames, LAN_IP, paths, PUID/PGID, ADMIN_BIND, TZ …
scripts/init-dirs.sh          # data, appdata and restic directories (0750, owned by PUID:PGID)
scripts/gen-secrets.sh        # secret files under ${APPDATA}/secrets; store the restic password!
docker compose up -d --build  # app, restic runner, syncthing
docker compose ps             # all healthy?
scripts/speedtest.sh          # measure upload once; sets the default upload cap
```

Then:

1. **PC:** follow [docs/pc-setup.md](docs/pc-setup.md), which ends with
   `ssh <server> 'cd <repo dir> && ./scripts/pair-pc.sh <PC-device-ID> [pc-lan-ip]'`.
2. **Admin access:** create the Cloudflare Tunnel hostname and Access application, then put the
   team domain and AUD in `.env` ([docs/USER-ACTIONS.md](docs/USER-ACTIONS.md)).
3. **Public site (go-live):** `scripts/ufw/plan.sh` → `scripts/ufw/apply.sh`;
   `scripts/caddy/apply.sh --render-only` → `scripts/caddy/apply.sh`; router port forwards;
   `scripts/gen-secrets.sh --cloudflare-token`; `docker compose --profile public up -d ddns`.

Every change made outside this repository, and how to undo it, is listed in
[docs/HOST-CHANGES.md](docs/HOST-CHANGES.md). Day-to-day operation, restores and secret rotation
are in [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Development

```bash
npm ci
npm run typecheck
npm test                       # unit + integration (the restic test downloads restic 0.19.1 once)
npm run build
scripts/gen-testdata.sh -n 5 -s 10M --nested 2   # synthetic random files for manual tests
```
