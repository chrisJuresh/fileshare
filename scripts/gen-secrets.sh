#!/usr/bin/env bash
# Create the secret files under ${APPDATA}/secrets (mode 600) if they are missing.
# Existing files are never overwritten. Secret values are never printed.
#
#   scripts/gen-secrets.sh                     # share-hmac-key, syncthing-api-key, syncthing-gui-password, restic-password
#   scripts/gen-secrets.sh --cloudflare-token  # also store the Cloudflare API token (prompted, hidden)
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

want_cf=false
case "${1-}" in
  --cloudflare-token) want_cf=true ;;
  -h | --help)
    sed -n '2,7p' "$0"
    exit 0
    ;;
  "") ;;
  *) die "unknown option: $1" ;;
esac

APPDATA=$(env_get APPDATA /srv/appdata/fileshare)
dir="$APPDATA/secrets"
umask 077
mkdir -p "$dir"
chmod 700 "$dir"

# gen NAME BYTES — BYTES random bytes, base64url without padding.
gen() {
  local f="$dir/$1" bytes=$2
  if [[ -s $f ]]; then
    info "kept existing $f"
    return
  fi
  head -c "$bytes" /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '=' >"$f.tmp"
  chmod 600 "$f.tmp"
  mv "$f.tmp" "$f"
  info "created $f"
}

gen share-hmac-key 32
gen syncthing-api-key 24
gen syncthing-gui-password 18
gen restic-password 32

cf="$dir/cloudflare-api-token"
if $want_cf; then
  if [[ -s $cf ]]; then
    info "kept existing $cf (delete it first to replace)"
  else
    read -r -s -p "Cloudflare API token (Zone:DNS:Edit, one zone; input hidden): " token
    echo
    [[ -n $token ]] || die "empty token"
    printf '%s\n' "$token" >"$cf.tmp"
    unset token
    chmod 600 "$cf.tmp"
    mv "$cf.tmp" "$cf"
    info "created $cf"
  fi
elif [[ ! -s $cf ]]; then
  info "no $cf yet — only needed for the ddns service at public go-live (re-run with --cloudflare-token)"
fi

cat <<EOF

Secrets directory: $dir (mode 700, files 600)

IMPORTANT: the restic repository password is in
    $dir/restic-password
Store a copy in your password manager now. Without it the snapshots cannot be read, and it is
deliberately NOT included in the snapshots. View it privately with:  less "$dir/restic-password"
EOF
