#!/usr/bin/env bash
# Create the host directories the stack mounts (compose never creates them), owned by
# ${PUID}:${PGID} with mode 0750. Uses sudo only if a parent directory isn't writable.
#
#   scripts/init-dirs.sh [--dry-run]
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dry=false
[[ ${1-} == --dry-run ]] && dry=true

PUID=$(env_get PUID 1000)
PGID=$(env_get PGID 1000)
DATA_ROOT=$(env_get DATA_ROOT /srv/fileshare-data)
APPDATA=$(env_get APPDATA /srv/appdata/fileshare)
RESTIC_REPO_HOST=$(env_get RESTIC_REPO_HOST /srv/fileshare-restic)

dirs=(
  "$DATA_ROOT" "$DATA_ROOT/outbox" "$DATA_ROOT/library" "$DATA_ROOT/staging" "$DATA_ROOT/uploads"
  "$APPDATA" "$APPDATA/app" "$APPDATA/syncthing" "$APPDATA/host-backups"
  "$RESTIC_REPO_HOST"
)

for d in "${dirs[@]}"; do
  if [[ -d $d ]]; then
    owner=$(stat -c '%u:%g' "$d")
    [[ $owner == "$PUID:$PGID" ]] || warn "$d is owned by $owner, expected $PUID:$PGID"
    continue
  fi
  if $dry; then
    echo "would create $d ($PUID:$PGID, 0750)"
    continue
  fi
  parent=$(dirname "$d")
  if [[ -w $parent && $(id -u) -eq $PUID ]]; then
    install -d -m 0750 "$d"
  else
    as_root install -d -m 0750 -o "$PUID" -g "$PGID" "$d"
  fi
  info "created $d"
done
# The secrets directory is created (0700) by scripts/gen-secrets.sh.
