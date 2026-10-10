#!/usr/bin/env bash
# Stage the fileshare public site into the system Caddy (append-only; existing site blocks are
# never edited). Backs up the Caddyfile, validates, reloads, and restores the backup on failure.
#
#   scripts/caddy/apply.sh [--variant b|a] [--render-only] [--output FILE] [--caddyfile PATH]
#
#   --variant b      (default) site-local: strips Alt-Svc in the site block. Append-only.
#   --variant a      also inserts `servers <LAN_IP>:8443 { protocols h1 h2 }` into the GLOBAL
#                    options block (or prepends one). Touches the global block: needs approval.
#   --render-only    print the rendered fileshare block(s) and exit
#   --output FILE    write the complete new Caddyfile to FILE; no backup, no reload
#   --caddyfile P    default /etc/caddy/Caddyfile
#
# Values come from .env: PUBLIC_BASE_URL (host), LAN_IP, PUBLIC_BIND, PUBLIC_PORT, APPDATA.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$here/../lib.sh"

variant=b
render_only=false
output=""
caddyfile=/etc/caddy/Caddyfile
while [[ $# -gt 0 ]]; do
  case $1 in
    --variant)
      variant=${2-}
      shift
      ;;
    --render-only) render_only=true ;;
    --output)
      output=${2-}
      shift
      ;;
    --caddyfile)
      caddyfile=${2-}
      shift
      ;;
    -h | --help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done
[[ $variant == a || $variant == b ]] || die "--variant must be a or b"

PUBLIC_BASE_URL=$(env_get PUBLIC_BASE_URL)
PUBLIC_HOST=${PUBLIC_BASE_URL#https://}
PUBLIC_HOST=${PUBLIC_HOST%%/*}
PUBLIC_HOST=${PUBLIC_HOST%%:*}
LAN_IP=$(env_get LAN_IP)
PUBLIC_BIND=$(env_get PUBLIC_BIND 127.0.0.1)
PUBLIC_PORT=$(env_get PUBLIC_PORT 8090)
APPDATA=$(env_get APPDATA /srv/appdata/fileshare)
CADDY_BIN=${CADDY_BIN:-caddy}

[[ $PUBLIC_BASE_URL == https://* ]] || die "PUBLIC_BASE_URL must start with https://"
[[ $PUBLIC_HOST =~ ^[A-Za-z0-9.-]+$ ]] || die "bad public host: $PUBLIC_HOST"
[[ $LAN_IP =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "LAN_IP must be an IPv4 address"
[[ $PUBLIC_BIND =~ ^[0-9.]+$ ]] || die "PUBLIC_BIND must be an IPv4 address"
[[ $PUBLIC_PORT =~ ^[0-9]+$ ]] || die "PUBLIC_PORT must be a number"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# render TEMPLATE → stdout, substituting ${VAR}s; fails if any placeholder is left.
render() {
  PUBLIC_HOST=$PUBLIC_HOST LAN_IP=$LAN_IP PUBLIC_BIND=$PUBLIC_BIND PUBLIC_PORT=$PUBLIC_PORT \
    python3 -c '
import os, re, string, sys
text = string.Template(open(sys.argv[1]).read()).safe_substitute(
    {k: os.environ[k] for k in ("PUBLIC_HOST", "LAN_IP", "PUBLIC_BIND", "PUBLIC_PORT")})
left = re.findall(r"\$\{[A-Z_]+\}", text)
if left:
    sys.exit("unrendered placeholders: " + ", ".join(sorted(set(left))))
sys.stdout.write(text)
' "$1"
}

render "$here/files-$variant.caddy.template" >"$work/site.caddy"
[[ $variant == a ]] && render "$here/global-a.caddy.template" >"$work/global.caddy"

if $render_only; then
  [[ $variant == a ]] && {
    echo "# --- inserted into the global options block ---"
    cat "$work/global.caddy"
    echo "# --- appended ---"
  }
  cat "$work/site.caddy"
  exit 0
fi

# Read the current Caddyfile (may need root).
if [[ -r $caddyfile ]]; then
  cat "$caddyfile" >"$work/current"
else
  as_root cat "$caddyfile" >"$work/current"
fi
if grep -qE '^[[:space:]]*# >>> fileshare (site|global)' "$work/current"; then
  info "fileshare block already present in $caddyfile; run scripts/caddy/revert.sh first to re-apply"
  exit 0
fi

# Compose the new file: [global insert] + existing content + blank line + site block.
if [[ $variant == a ]]; then
  python3 - "$work/current" "$work/global.caddy" >"$work/new" <<'PY'
import sys
lines = open(sys.argv[1]).read().splitlines(keepends=True)
insert = open(sys.argv[2]).read()
# The global options block, if any, is the first non-blank, non-comment token and is a bare "{".
for i, line in enumerate(lines):
    s = line.strip()
    if not s or s.startswith("#"):
        continue
    if s == "{":
        sys.stdout.write("".join(lines[: i + 1]) + insert + "".join(lines[i + 1 :]))
    else:
        # No global block yet: prepend one (markers included, so revert.sh removes it whole).
        dedented = "".join(l[1:] if l.startswith("\t") else l for l in insert.splitlines(keepends=True))
        marker_open, *body, marker_close = dedented.splitlines(keepends=True)
        sys.stdout.write(marker_open + "{\n" + "".join("\t" + l if l.strip() else l for l in body) + "}\n" + marker_close + "".join(lines))
    break
else:
    sys.stdout.write("".join(lines))
PY
else
  cat "$work/current" >"$work/new"
fi
last_char=$(tail -c1 "$work/new")
{
  [[ -n $last_char ]] && echo # file didn't end with a newline
  echo
  cat "$work/site.caddy"
} >>"$work/new"

if [[ -n $output ]]; then
  cp "$work/new" "$output"
  info "wrote $output (not installed)"
  exit 0
fi

# Backup → install → validate → reload; restore on any failure.
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
  # As the caddy user when it exists, so validation can't leave root-owned files in its storage.
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

as_root cp "$work/new" "$caddyfile" # cp onto the existing file keeps its owner and mode
if ! validate; then
  restore
  die "caddy validate failed; nothing was reloaded"
fi
if ! as_root systemctl reload caddy; then
  restore
  as_root systemctl reload caddy || true
  die "caddy reload failed; previous Caddyfile restored"
fi
info "Caddy reloaded with the fileshare site ($PUBLIC_HOST:8443 on $LAN_IP, variant $variant)"
cat <<EOF
Check:  curl -sS -o /dev/null -w '%{http_code}\n' --resolve $PUBLIC_HOST:8443:$LAN_IP https://$PUBLIC_HOST:8443/healthz
        journalctl -u caddy --since -10min | grep -i -E 'certificate|acme|error'
Revert: scripts/caddy/revert.sh
EOF
