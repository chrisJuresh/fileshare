# shellcheck shell=bash
# Shared helpers for the fileshare scripts. Source it, don't run it.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env}"

die() {
  echo "error: $*" >&2
  exit 1
}
info() { echo "==> $*"; }
warn() { echo "warning: $*" >&2; }

# env_get KEY [DEFAULT]
# Value of KEY: the process environment wins, then the last KEY= line in $ENV_FILE, then DEFAULT.
# The .env file is parsed, never sourced/executed.
env_get() {
  local key=$1 default=${2-} line val
  if [[ -n "${!key+x}" ]]; then
    printf '%s' "${!key}"
    return
  fi
  if [[ -f $ENV_FILE ]]; then
    line=$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)
    if [[ -n $line ]]; then
      val=${line#*=}
      val=${val%\"}
      val=${val#\"}
      val=${val%\'}
      val=${val#\'}
      printf '%s' "$val"
      return
    fi
  fi
  printf '%s' "$default"
}

# env_set KEY VALUE — set KEY in $ENV_FILE. VALUE must not contain newlines.
# The file is rewritten IN PLACE (same inode): the restic container bind-mounts it as a single
# file, and a replaced file (new inode) would leave the container reading the old content.
# A copy of the previous content goes to ${APPDATA}/host-backups/<timestamp>/env.bak (mode 600),
# never next to the file in the repository.
env_set() {
  local key=$1 value=$2 tmp backup_dir backup n=1
  [[ -f $ENV_FILE ]] || die "$ENV_FILE not found"
  [[ $value != *$'\n'* ]] || die "refusing multi-line value for $key"
  backup_dir="$(env_get APPDATA /srv/appdata/fileshare)/host-backups"
  [[ -d $backup_dir ]] || die "$backup_dir not found (run scripts/init-dirs.sh)"
  backup_dir="$backup_dir/$(timestamp)"
  (umask 077 && mkdir -p "$backup_dir")
  backup="$backup_dir/env.bak"
  while [[ -e $backup ]]; do
    backup="$backup_dir/env.bak.$n"
    n=$((n + 1))
  done
  (umask 077 && cat "$ENV_FILE" >"$backup")
  chmod 600 "$backup"
  tmp=$(mktemp) # mode 600
  if grep -qE "^${key}=" "$ENV_FILE"; then
    KEY="$key" VALUE="$value" awk 'BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"] }
      index($0, k "=") == 1 { print k "=" v; next } { print }' "$ENV_FILE" >"$tmp"
  else
    cat "$ENV_FILE" >"$tmp"
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  # Truncate + write keeps the inode; the backup above covers an interrupted write.
  cat "$tmp" >"$ENV_FILE" || {
    rm -f "$tmp"
    die "writing $ENV_FILE failed; previous content is in $backup"
  }
  rm -f "$tmp"
  chmod 600 "$ENV_FILE"
  info "set $key in $ENV_FILE (backup: $backup)"
}

# Run a command as root (sudo when not already root).
as_root() {
  if [[ $(id -u) -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

timestamp() { date +%Y%m%d-%H%M%S; }
