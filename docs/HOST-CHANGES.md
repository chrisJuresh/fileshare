# Host changes

Every change a fileshare deployment makes outside this repository, and how to revert it.
This file is generic. The concrete values (paths, addresses, dates applied) for a particular host
belong in the git-ignored `deploy.local.md`.

Backups taken by the scripts go to `${APPDATA}/host-backups/<timestamp>/`.

## Summary

| # | Change | Made by | Revert |
|---|--------|---------|--------|
| 1 | Data, appdata and restic directories | `scripts/init-dirs.sh` | remove the directories (after copying anything you want to keep) |
| 2 | Secret files in `${APPDATA}/secrets` | `scripts/gen-secrets.sh` | `rm -r ${APPDATA}/secrets` (keep the restic password if you keep the repo) |
| 3 | Docker containers, network, images | `docker compose up` | `docker compose --profile public down`, then remove the images |
| 4 | Host ports in use | the stack | stopping the stack frees them |
| 5 | Caddy site block (append-only) | `scripts/caddy/apply.sh` | `scripts/caddy/revert.sh` |
| 5a | Caddy global `servers` stanza (variant A only) | `scripts/caddy/apply.sh --variant a` | `scripts/caddy/revert.sh` |
| 6 | ufw rules commented `fileshare:` | `scripts/ufw/apply.sh` | `scripts/ufw/revert.sh` |
| 7 | Router port forwards | you (USER-ACTIONS §1) | delete them in the router |
| 8 | Cloudflare: DNS record, API token, tunnel hostname, Access app | you + ddns | delete them in the dashboard |

Nothing else is changed: no system packages, no `/etc` files other than the Caddyfile and ufw's
rule files, no systemd units, no Docker daemon settings, and no other containers or networks.

## Details

### 1. Directories

Defaults (all from `.env`), owned by `${PUID}:${PGID}`, mode 0750:

- `${DATA_ROOT}` with `outbox/`, `library/`, `staging/`, `uploads/`
- `${APPDATA}` with `app/` (DB, DB backup copy, restic cache, seed links), `syncthing/`,
  `secrets/` (0700), `host-backups/`
- `${RESTIC_REPO_HOST}` (the restic repository; ideally on a different disk from `${DATA_ROOT}`)

Revert: stop the stack, then remove them. The library and the restic repository hold real data,
so check before deleting.

### 3. Docker

- Containers `fileshare-app-1`, `fileshare-restic-1`, `fileshare-syncthing-1`, and
  `fileshare-ddns-1` (only with `--profile public`). All are labelled
  `com.centurylinklabs.watchtower.enable=false`, so Watchtower leaves them alone.
- Network `fileshare_default` (bridge, for syncthing and ddns). `app` uses host networking and
  `restic` has no network.
- Images: `fileshare:local` (built here), `syncthing/syncthing:2.1.6`, `favonia/cloudflare-ddns:1.17.1`.
  `scripts/speedtest.sh` pulls `alpine:3.24.2` for its throwaway container.
- Logs: json-file, 10 MB × 5 per container.

```bash
docker compose --profile public down
docker image rm fileshare:local syncthing/syncthing:2.1.6 favonia/cloudflare-ddns:1.17.1 alpine:3.24.2
```

### 4. Ports

| Port | Bound to | By | Reachable from |
|---|---|---|---|
| 8443/tcp | `LAN_IP` | Caddy (system) | internet via router 443→8443 |
| `PUBLIC_PORT` (8090)/tcp | `PUBLIC_BIND` (127.0.0.1) | app | Caddy only |
| `ADMIN_PORT` (8091)/tcp | `ADMIN_BIND` (tunnel network gateway) | app | cloudflared (ufw rule) |
| `BT_PORT` (6890)/tcp+udp | all | app | internet via router + ufw |
| `WEBRTC_PORT` (6891)/udp | all | app | internet via router + ufw |
| 22000/tcp+udp | `LAN_IP` | syncthing (Docker-published) | LAN |
| 8384/tcp | 127.0.0.1 | syncthing (Docker-published) | host only (SSH tunnel for the GUI) |

Docker-published ports bypass ufw; that is why 22000 and 8384 are bound to specific addresses.

### 5. Caddy

`scripts/caddy/apply.sh` appends one site block to `/etc/caddy/Caddyfile`, between
`# >>> fileshare site` and `# <<< fileshare site <<<` markers. Existing blocks are not edited. It
backs up the file first, runs `caddy validate`, reloads, and restores the backup on any failure.

Variant A (`--variant a`) also inserts, inside the global options block (or as a new global
block at the top), between `# >>> fileshare global` / `# <<< fileshare global <<<` markers:

```caddy
servers <LAN_IP>:8443 {
	protocols h1 h2
}
```

This touches the global options block, so it needs explicit approval. Variant B (the default)
is site-local only.

Revert: `scripts/caddy/revert.sh` removes exactly the marked lines (backup, validate, reload,
auto-restore). Manual fallback: copy a backup from `${APPDATA}/host-backups/<ts>/caddy/Caddyfile`
to `/etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`.

Caddy also stores the certificate for the public hostname in its data directory. That is harmless
to leave; it expires on its own.

### 6. ufw

`scripts/ufw/plan.sh` prints the exact rules. Each one has a comment starting `fileshare:`:

```
allow proto tcp to any port 8443                                        # public https (caddy)
allow proto tcp to any port 6890                                        # bittorrent tcp
allow proto udp to any port 6890                                        # bittorrent utp
allow proto udp to any port 6891                                        # webrtc ice
allow proto tcp from <tunnel-subnet> to <bridge-gateway> port 8091      # admin from tunnel connector
```

ufw adds an IPv6 twin for the first four. `scripts/ufw/apply.sh` backs up `/etc/ufw/*.rules` and
a `ufw status numbered` snapshot first.

Revert: `scripts/ufw/revert.sh` deletes only rules whose comment starts with `fileshare:`.
Manual fallback: copy the backed-up `*.rules` to `/etc/ufw/`, then `sudo ufw reload`.

### 7–8. Router and Cloudflare

See [USER-ACTIONS.md](USER-ACTIONS.md). To revert: delete the three port forwards, delete the
DNS record for the public hostname (stop `ddns` first, or it recreates it), roll/delete the API
token, delete the tunnel public hostname and the Access application.

## Applied on this host

Record what was actually applied, with dates and backup paths, in `deploy.local.md`, not here.
