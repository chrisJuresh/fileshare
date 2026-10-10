#!/usr/bin/env bash
# Print the exact ufw rules fileshare needs (changes nothing).
#
#   scripts/ufw/plan.sh [--tunnel-subnet CIDR]
#
# The tunnel subnet is detected from the docker network whose gateway is ADMIN_BIND.
# Note: Docker-published ports (Syncthing 22000 on LAN_IP, 8384 on loopback) bypass ufw; they
# are limited by their bind addresses instead. The app uses host networking, so ufw applies.
set -euo pipefail
# shellcheck source=scripts/ufw/rules.sh
source "$(dirname "${BASH_SOURCE[0]}")/rules.sh"

subnet=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --tunnel-subnet)
      subnet=${2-}
      shift
      ;;
    -h | --help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

echo "# fileshare ufw rules (apply with scripts/ufw/apply.sh, remove with scripts/ufw/revert.sh)"
fileshare_rules "$subnet" | sed 's/^/sudo ufw /'
