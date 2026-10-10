#!/usr/bin/env bash
# Delete ONLY ufw rules whose comment starts with "fileshare:" (IPv4 and IPv6). Other rules are
# untouched. Backs up /etc/ufw/*.rules first.
#
#   scripts/ufw/revert.sh [--dry-run] [--yes]
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

dry=false
yes=false
for a in "$@"; do
  case $a in
    --dry-run) dry=true ;;
    --yes) yes=true ;;
    -h | --help)
      sed -n '2,6p' "$0"
      exit 0
      ;;
    *) die "unknown option: $a" ;;
  esac
done

# first_fileshare_rule < `ufw status numbered` → number of the first fileshare rule, if any.
first_fileshare_rule() {
  sed -nE 's/^\[ *([0-9]+)\].*# fileshare:.*/\1/p' | head -n 1
}

status=$(as_root ufw status numbered)
matches=$(grep -F '# fileshare:' <<<"$status" || true)
if [[ -z $matches ]]; then
  info "no fileshare ufw rules found"
  exit 0
fi
echo "These rules will be deleted:"
printf '%s\n' "$matches" | sed 's/^/  /'
$dry && exit 0
if ! $yes; then
  read -r -p "Proceed? [y/N] " answer
  [[ $answer == [yY] ]] || die "aborted"
fi

APPDATA=$(env_get APPDATA /srv/appdata/fileshare)
backup_dir="$APPDATA/host-backups/$(timestamp)/ufw"
mkdir -p "$backup_dir"
# shellcheck disable=SC2016 # expanded by the inner sh
as_root sh -c 'cp -p /etc/ufw/*.rules "$1"/ && chown "$2" "$1"/*.rules' sh "$backup_dir" "$(id -u):$(id -g)"
printf '%s\n' "$status" >"$backup_dir/status-before.txt"
info "backed up /etc/ufw/*.rules to $backup_dir"

# Delete one at a time: numbers shift after every deletion.
while n=$(as_root ufw status numbered | first_fileshare_rule) && [[ -n $n ]]; do
  as_root ufw --force delete "$n" >/dev/null
  info "deleted rule $n"
done
as_root ufw status numbered >"$backup_dir/status-after.txt"
info "all fileshare ufw rules removed"
