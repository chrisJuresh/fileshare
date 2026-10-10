#!/usr/bin/env bash
# Remove ONLY the fileshare-marked blocks (site and, for variant A, global) from the system
# Caddyfile. Backs up first, validates, reloads, and restores the backup on failure.
#
#   scripts/caddy/revert.sh [--output FILE] [--caddyfile PATH]
#
#   --output FILE    write the reverted Caddyfile to FILE; no backup, no reload
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$here/../lib.sh"

output=""
caddyfile=/etc/caddy/Caddyfile
while [[ $# -gt 0 ]]; do
  case $1 in
    --output)
      output=${2-}
      shift
      ;;
    --caddyfile)
      caddyfile=${2-}
      shift
      ;;
    -h | --help)
      sed -n '2,7p' "$0"
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done
APPDATA=$(env_get APPDATA /srv/appdata/fileshare)
CADDY_BIN=${CADDY_BIN:-caddy}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [[ -r $caddyfile ]]; then
  cat "$caddyfile" >"$work/current"
else
  as_root cat "$caddyfile" >"$work/current"
fi
if ! grep -qE '^[[:space:]]*# >>> fileshare (site|global)' "$work/current"; then
  info "no fileshare block in $caddyfile; nothing to do"
  exit 0
fi

# Drop everything from each opening marker to its closing marker (inclusive), plus at most one
# blank line directly before a removed site block (apply.sh added it).
python3 - "$work/current" >"$work/new" <<'PY'
import re, sys
lines = open(sys.argv[1]).read().splitlines(keepends=True)
out, skip = [], None
for line in lines:
    m_open = re.match(r"^\s*# >>> fileshare (site|global)\b", line)
    if skip is None and m_open:
        skip = m_open.group(1)
        if skip == "site" and out and not out[-1].strip():
            out.pop()
        continue
    if skip is not None:
        if re.match(r"^\s*# <<< fileshare " + skip + r" <<<", line):
            skip = None
        continue
    out.append(line)
if skip is not None:
    sys.exit(f"unterminated fileshare {skip} block; not changing anything")
sys.stdout.write("".join(out))
PY

if [[ -n $output ]]; then
  cp "$work/new" "$output"
  info "wrote $output (not installed)"
  exit 0
fi

backup_dir="$APPDATA/host-backups/$(timestamp)/caddy"
mkdir -p "$backup_dir"
cp "$work/current" "$backup_dir/Caddyfile"
chmod 600 "$backup_dir/Caddyfile"
info "backed up $caddyfile to $backup_dir/Caddyfile"

restore() {
  warn "restoring $caddyfile from backup"
  as_root cp "$backup_dir/Caddyfile" "$caddyfile"
}
validate() {
  if id caddy >/dev/null 2>&1; then
    if [[ $(id -u) -eq 0 ]]; then
      runuser -u caddy -- "$CADDY_BIN" validate --config "$caddyfile" --adapter caddyfile
    else
      sudo -u caddy "$CADDY_BIN" validate --config "$caddyfile" --adapter caddyfile
    fi
  else
    as_root "$CADDY_BIN" validate --config "$caddyfile" --adapter caddyfile
  fi
}

as_root cp "$work/new" "$caddyfile"
if ! validate; then
  restore
  die "caddy validate failed after removing the block; restored"
fi
if ! as_root systemctl reload caddy; then
  restore
  as_root systemctl reload caddy || true
  die "caddy reload failed; previous Caddyfile restored"
fi
info "fileshare block(s) removed and Caddy reloaded"
