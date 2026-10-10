#!/usr/bin/env bash
# Protect the Syncthing GUI with a user + password (the REST API keeps using the API key).
# Idempotent: run after every `docker compose up` (pair-pc.sh runs it too).
#
#   scripts/syncthing-init.sh [--dry-run]
#
# GUI user: admin. Password: ${APPDATA}/secrets/syncthing-gui-password (scripts/gen-secrets.sh).
# Syncthing stores it bcrypt-hashed (it hashes a plaintext password set via /rest/config/gui).
# Neither the password nor the API key is printed or put on a command line.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dry=false
case "${1-}" in
  --dry-run) dry=true ;;
  -h | --help)
    sed -n '2,9p' "$0"
    exit 0
    ;;
  "") ;;
  *) die "unknown option: $1" ;;
esac

GUI_USER=admin
APPDATA=$(env_get APPDATA /srv/appdata/fileshare)
API_URL=$(env_get SYNCTHING_API_URL http://127.0.0.1:8384)
KEY_FILE="$APPDATA/secrets/syncthing-api-key"
PW_FILE="$APPDATA/secrets/syncthing-gui-password"
[[ -r $KEY_FILE ]] || die "cannot read $KEY_FILE (run scripts/gen-secrets.sh)"
[[ -s $PW_FILE ]] || die "missing $PW_FILE (run scripts/gen-secrets.sh)"
command -v curl >/dev/null || die "curl is required"
command -v python3 >/dev/null || die "python3 is required"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
umask 077
printf 'X-API-Key: %s\n' "$(tr -d '\r\n' <"$KEY_FILE")" >"$work/hdr"
# Request bodies are built from the secret file by python, never via argv or the environment.
python3 - "$PW_FILE" "$GUI_USER" "$work" <<'PY'
import json, sys
pw_file, user, work = sys.argv[1:4]
pw = open(pw_file).read().strip()
if not pw:
    sys.exit("empty password file")
json.dump({"user": user, "password": pw}, open(f"{work}/gui.json", "w"))
json.dump({"username": user, "password": pw, "stayLoggedIn": False}, open(f"{work}/login.json", "w"))
PY

for _ in $(seq 1 30); do
  curl -fsS --max-time 3 "$API_URL/rest/noauth/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS --max-time 5 "$API_URL/rest/noauth/health" >/dev/null || die "Syncthing is not reachable at $API_URL"

# login_ok → 0 when the GUI accepts admin + the password from the secret file.
login_ok() {
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'Content-Type: application/json' \
    --data-binary "@$work/login.json" "$API_URL/rest/noauth/auth/password")
  [[ $code == 204 ]]
}

user=$(curl -fsS --max-time 10 -H "@$work/hdr" "$API_URL/rest/config/gui" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("user",""))')
if [[ $user == "$GUI_USER" ]] && login_ok; then
  info "Syncthing GUI already protected (user $GUI_USER)"
  exit 0
fi
if $dry; then
  info "[dry-run] would set the Syncthing GUI user ($GUI_USER) and password from $PW_FILE"
  exit 0
fi
curl -fsS --max-time 20 -X PATCH -H "@$work/hdr" -H 'Content-Type: application/json' \
  --data-binary "@$work/gui.json" "$API_URL/rest/config/gui" >/dev/null
for _ in 1 2 3 4 5; do
  login_ok && break
  sleep 1
done
login_ok || die "the GUI password was set but a test login failed"
info "Syncthing GUI protected: user $GUI_USER, password in $PW_FILE (stored hashed by Syncthing)"
