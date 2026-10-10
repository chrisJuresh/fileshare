# Steps only a human can do

These need router or Cloudflare dashboard access. Values are examples: `files.example.com`
(public), `files-admin.example.com` (admin), server LAN address `192.0.2.10`. Use your own.

## 1. Router port forwards (at public go-live)

Forward to the server's LAN address:

| External port | Protocol | To (server) | Purpose |
|---|---|---|---|
| 443  | TCP     | 8443 | public share site (Caddy) |
| 6890 | TCP+UDP | 6890 | BitTorrent TCP + uTP (seeder) |
| 6891 | UDP     | 6891 | WebRTC ICE (browsers ↔ server) |

Do **not** forward 80, 8090, 8091, 8384 or 22000. Prefer a DHCP reservation for the server so
its LAN address never changes.

## 2. Cloudflare API token for DDNS

Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit zone DNS" template:

- Permissions: **Zone → DNS → Edit**
- Zone resources: **Include → Specific zone →** your zone only
- Optional: client IP filtering, TTL/expiry

Store it on the server (prompted, input hidden; written to
`${APPDATA}/secrets/cloudflare-api-token`, mode 600):

```bash
scripts/gen-secrets.sh --cloudflare-token
```

The DNS record for the public hostname must stay **DNS only** (grey cloud). TLS-ALPN certificate
issuance and BitTorrent/WebRTC need the real address. The ddns service keeps it unproxied.

## 3. Admin hostname on the Cloudflare Tunnel

Zero Trust → Networks → Tunnels → (your tunnel) → Public Hostname → Add:

- Subdomain/domain: `files-admin.example.com`
- Service: `http://<bridge-gateway>:<ADMIN_PORT>`, where `<bridge-gateway>` is the gateway of
  the Docker network your `cloudflared` container is on
  (`docker network inspect <network> --format '{{(index .IPAM.Config 0).Gateway}}'`) and is also
  `ADMIN_BIND` in `.env`. `ADMIN_PORT` defaults to 8091.
- Additional settings: leave "No TLS Verify" off (plain HTTP to the gateway).

## 4. Cloudflare Access application for the admin hostname

Zero Trust → Access → Applications → Add → Self-hosted:

- Application domain: `files-admin.example.com`
- Session duration: e.g. 24h
- Policy: **Allow**, Include → **Emails →** your email address only
- After saving, copy the **Application Audience (AUD) tag** (application → Overview)

Put them in `.env` and recreate the app:

```bash
# .env
CF_ACCESS_TEAM_DOMAIN=<yourteam>.cloudflareaccess.com
CF_ACCESS_AUD=<the AUD tag>
ADMIN_EMAILS=<your email>        # optional extra allow-list checked by the app
docker compose up -d app
```

## 5. Store the restic password

`scripts/gen-secrets.sh` creates `${APPDATA}/secrets/restic-password`. Copy it into your password
manager now. It is **not** included in the snapshots; without it they cannot be read.

## 6. External tests (at go-live)

From **mobile data** (Wi-Fi off) and from **a friend's network**, not from your own LAN:

- Open a share link: the page loads with a valid certificate, and the download starts.
- Watch the swarm panel: the server and other recipients appear as peers.
- With two devices on different networks, both downloading: data flows between them (peer bytes > 0).
- A torrent client using the `.torrent` connects to the server on 6890.
- The admin hostname asks for Cloudflare Access login and rejects other emails.
- `https://files.example.com:8443` and the raw IP are not useful entry points (only 443 is forwarded).

Record the WebRTC result in docs/RUNBOOK.md ("WebRTC outcome").
