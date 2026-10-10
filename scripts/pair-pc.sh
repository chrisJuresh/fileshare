#!/usr/bin/env bash
# Pair the Windows PC with the server's Syncthing and share the outbox folder with it.
# Idempotent: safe to re-run (e.g. after the PC's address changes).
#
#   scripts/pair-pc.sh [--dry-run] [--no-restart] <pc-device-id> [pc-lan-ip]
#
# What it does (Syncthing REST on SYNCTHING_API_URL, default http://127.0.0.1:8384):
#   0. protects the GUI with user + password (scripts/syncthing-init.sh)
#   1. hardens Syncthing options (no usage/crash reporting, no auto-upgrade, no NAT/UPnP,
#      no relays, no global/local announce; listens on tcp+quic :22000)
#   2. adds/updates device "pc" (addresses: dynamic [+ tcp://<pc-lan-ip>:22000])
#   3. creates/updates folder ${SYNCTHING_FOLDER_ID} at /data/outbox (Send & Receive, no
#      versioning, fs watcher on) shared with the PC, and writes its .stignore patterns
#   4. sets SYNCTHING_PC_DEVICE_ID in .env (backup first) and recreates the app container
# The API key is read from ${APPDATA}/secrets/syncthing-api-key and never printed.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  sed -n '2,15p' "$0"
  exit "${1:-0}"
}

dry=false
restart=true
args=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) dry=true ;;
    --no-restart) restart=false ;;
    -h | --help) usage 0 ;;
    -*) die "unknown option: $1" ;;
    *) args+=("$1") ;;
  esac
  shift
done
[[ ${#args[@]} -ge 1 && ${#args[@]} -le 2 ]] || usage 1

PC_ID=$(printf '%s' "${args[0]}" | tr '[:lower:]' '[:upper:]')
PC_IP=${args[1]-}
# Syncthing device IDs: 8 groups of 7 base32 characters.
[[ $PC_ID =~ ^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$ ]] || die "not a Syncthing device ID: $PC_ID"
if [[ -n $PC_IP ]]; then
  [[ $PC_IP =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "pc-lan-ip must be an IPv4 address: $PC_IP"
fi

APPDATA=$(env_get APPDATA /srv/appdata/fileshare)
API_URL=$(env_get SYNCTHING_API_URL http://127.0.0.1:8384)
FOLDER_ID=$(env_get SYNCTHING_FOLDER_ID fileshare-outbox)
FOLDER_PATH=/data/outbox
KEY_FILE="$APPDATA/secrets/syncthing-api-key"
[[ -r $KEY_FILE ]] || die "cannot read $KEY_FILE (run scripts/gen-secrets.sh)"
command -v curl >/dev/null || die "curl is required"
command -v python3 >/dev/null || die "python3 is required"

# Ignore patterns (same list goes on the PC). (?d) lets Syncthing delete these junk files when
# their directory is removed (the server removes ingested entries); *.tmp is deliberately NOT
# (?d) so a real .tmp file is never deleted without having been transferred.
IGNORES=('(?d)desktop.ini' '(?d)Thumbs.db' '(?d).DS_Store' '(?d)~$*' '*.tmp')

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
umask 077
# Header file so the key never appears in a process listing.
printf 'X-API-Key: %s\n' "$(tr -d '\r\n' <"$KEY_FILE")" >"$work/hdr"

# api METHOD PATH [BODY_FILE] → response body on stdout; fails on HTTP errors.
api() {
  local method=$1 path=$2 body=${3-}
  local curl_args=(-fsS --max-time 20 -X "$method" -H "@$work/hdr" "$API_URL$path")
  if [[ -n $body ]]; then
    curl_args+=(-H 'Content-Type: application/json' --data-binary "@$body")
  fi
  curl "${curl_args[@]}"
}
# api_status METHOD PATH → HTTP status code only.
api_status() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X "$1" -H "@$work/hdr" "$API_URL$2"
}
# py SCRIPT [ARGS...] — small JSON helpers (python3 is on every Ubuntu host).
py() { python3 -c "$@"; }

curl -fsS --max-time 10 "$API_URL/rest/noauth/health" >/dev/null || die "Syncthing is not reachable at $API_URL"
api GET /rest/system/status >"$work/status.json"
SERVER_ID=$(py 'import json,sys; print(json.load(open(sys.argv[1]))["myID"])' "$work/status.json")
[[ $PC_ID != "$SERVER_ID" ]] || die "that is the server's own device ID; use the PC's ID"

# 0. GUI password --------------------------------------------------------------------------
if $dry; then
  "$REPO_DIR/scripts/syncthing-init.sh" --dry-run
else
  "$REPO_DIR/scripts/syncthing-init.sh"
fi

apply() { # METHOD PATH BODY_FILE DESCRIPTION
  if $dry; then
    info "[dry-run] would $1 $2 ($4)"
    python3 -m json.tool "$3" | sed 's/^/    /'
  else
    api "$1" "$2" "$3" >/dev/null
    info "$4"
  fi
}

# 1. Options -------------------------------------------------------------------------------
cat >"$work/options.json" <<'EOF'
{
  "listenAddresses": ["tcp://0.0.0.0:22000", "quic://0.0.0.0:22000"],
  "globalAnnounceEnabled": false,
  "localAnnounceEnabled": false,
  "relaysEnabled": false,
  "natEnabled": false,
  "urAccepted": -1,
  "urSeen": 3,
  "crashReportingEnabled": false,
  "autoUpgradeIntervalH": 0,
  "startBrowser": false
}
EOF
apply PATCH /rest/config/options "$work/options.json" "Syncthing options hardened (LAN only, no telemetry)"

# 2. Device --------------------------------------------------------------------------------
code=$(api_status GET "/rest/config/devices/$PC_ID")
if [[ $code == 200 ]]; then
  api GET "/rest/config/devices/$PC_ID" >"$work/device.base.json"
else
  api GET /rest/config/defaults/device >"$work/device.base.json"
fi
py '
import json, sys
base, pc_id, pc_ip, out = sys.argv[1:5]
d = json.load(open(base))
d["deviceID"] = pc_id
d["name"] = "pc"
d["addresses"] = ["dynamic"] + ([f"tcp://{pc_ip}:22000"] if pc_ip else [])
d["introducer"] = False
d["autoAcceptFolders"] = False
d["paused"] = False
json.dump(d, open(out, "w"), indent=2)
' "$work/device.base.json" "$PC_ID" "$PC_IP" "$work/device.json"
apply PUT "/rest/config/devices/$PC_ID" "$work/device.json" "device \"pc\" $([[ $code == 200 ]] && echo updated || echo added)"

# 3. Folder --------------------------------------------------------------------------------
code=$(api_status GET "/rest/config/folders/$FOLDER_ID")
if [[ $code == 200 ]]; then
  api GET "/rest/config/folders/$FOLDER_ID" >"$work/folder.base.json"
else
  api GET /rest/config/defaults/folder >"$work/folder.base.json"
fi
py '
import json, sys
base, folder_id, path, pc_id, out = sys.argv[1:6]
f = json.load(open(base))
f["id"] = folder_id
f["label"] = "Fileshare Outbox"
f["path"] = path
f["type"] = "sendreceive"
f["fsWatcherEnabled"] = True
f["paused"] = False
v = f.get("versioning") or {}
v["type"] = ""
v["params"] = {}
f["versioning"] = v
devices = [d for d in (f.get("devices") or []) if d.get("deviceID")]
if not any(d["deviceID"] == pc_id for d in devices):
    devices.append({"deviceID": pc_id, "introducedBy": "", "encryptionPassword": ""})
f["devices"] = devices
json.dump(f, open(out, "w"), indent=2)
' "$work/folder.base.json" "$FOLDER_ID" "$FOLDER_PATH" "$PC_ID" "$work/folder.json"
apply PUT "/rest/config/folders/$FOLDER_ID" "$work/folder.json" "folder $FOLDER_ID at $FOLDER_PATH $([[ $code == 200 ]] && echo updated || echo created)"

py '
import json, sys
json.dump({"ignore": sys.argv[2:]}, open(sys.argv[1], "w"))
' "$work/ignores.json" "${IGNORES[@]}"
if $dry; then
  info "[dry-run] would set .stignore: ${IGNORES[*]}"
else
  # The folder may take a moment to start after it is created.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if api POST "/rest/db/ignores?folder=$FOLDER_ID" "$work/ignores.json" >/dev/null 2>&1; then
      info ".stignore written"
      break
    fi
    sleep 1
  done || true
  api GET "/rest/db/ignores?folder=$FOLDER_ID" >"$work/ign.json" || die "could not read back .stignore"
  py 'import json,sys; got=json.load(open(sys.argv[1])).get("ignore") or []; sys.exit(0 if got==sys.argv[2:] else 1)' \
    "$work/ign.json" "${IGNORES[@]}" || die ".stignore was not applied (is the folder running?)"
fi

if [[ $(api GET /rest/config/restart-required | py 'import json,sys; print(json.load(sys.stdin).get("requiresRestart", False))') == True ]]; then
  warn "Syncthing reports a restart is required: docker compose restart syncthing"
fi

# 4. .env + app ----------------------------------------------------------------------------
current=$(env_get SYNCTHING_PC_DEVICE_ID "")
if [[ $current == "$PC_ID" ]]; then
  info "SYNCTHING_PC_DEVICE_ID already set"
elif $dry; then
  info "[dry-run] would set SYNCTHING_PC_DEVICE_ID in $ENV_FILE and recreate the app container"
else
  env_set SYNCTHING_PC_DEVICE_ID "$PC_ID"
  if $restart && [[ -n $(docker compose -f "$REPO_DIR/compose.yaml" ps -q app 2>/dev/null) ]]; then
    docker compose -f "$REPO_DIR/compose.yaml" up -d --no-deps app
    info "app recreated with the new device ID"
  else
    info "app not restarted (not running or --no-restart); it picks the ID up on next start"
  fi
fi

cat <<EOF

On the PC, add the server device and accept the folder:
  Server device ID : $SERVER_ID
  Server address   : tcp://$(env_get LAN_IP '<server-lan-ip>'):22000
  Folder ID        : $FOLDER_ID   (Send & Receive, no versioning, watch for changes)
  .stignore        : $(printf '%s  ' "${IGNORES[@]}")
See docs/pc-setup.md.
EOF
