#!/usr/bin/env bash
# Add the fileshare ufw rules (see plan.sh). Backs up /etc/ufw/*.rules and a `ufw status
# numbered` snapshot to ${APPDATA}/host-backups/<timestamp>/ufw first. Existing identical rules
# are skipped by ufw, so re-running is safe.
#
#   scripts/ufw/apply.sh [--tunnel-subnet CIDR] [--yes]
set -euo pipefail
# shellcheck source=scripts/ufw/rules.sh
source "$(dirname "${BASH_SOURCE[0]}")/rules.sh"

subnet=""
yes=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --tunnel-subnet)
      subnet=${2-}
      shift
      ;;
    --yes) yes=true ;;
    -h | --help)
      sed -n '2,7p' "$0"
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

mapfile -t rules < <(fileshare_rules "$subnet")
[[ ${#rules[@]} -gt 0 ]] || die "no rules computed"

echo "These rules will be added:"
printf '  ufw %s\n' "${rules[@]}"
if ! $yes; then
  read -r -p "Proceed? [y/N] " answer
  [[ $answer == [yY] ]] || die "aborted"
fi

APPDATA=$(env_get APPDATA /srv/appdata/fileshare)
backup_dir="$APPDATA/host-backups/$(timestamp)/ufw"
mkdir -p "$backup_dir"
# shellcheck disable=SC2016 # expanded by the inner sh
as_root sh -c 'cp -p /etc/ufw/*.rules "$1"/ && chown "$2" "$1"/*.rules' sh "$backup_dir" "$(id -u):$(id -g)"
as_root ufw status numbered >"$backup_dir/status-before.txt"
info "backed up /etc/ufw/*.rules and the current status to $backup_dir"

for r in "${rules[@]}"; do
  # Each line is a fixed, validated argument list; eval splits the quoted comment correctly.
  eval "as_root ufw $r"
done

as_root ufw status numbered >"$backup_dir/status-after.txt"
info "done. Current fileshare rules:"
grep -F "# $UFW_COMMENT_PREFIX" "$backup_dir/status-after.txt" || warn "no fileshare rules visible (is ufw active?)"
echo "Revert: scripts/ufw/revert.sh   (restore everything: copy $backup_dir/*.rules to /etc/ufw/ and 'sudo ufw reload')"
