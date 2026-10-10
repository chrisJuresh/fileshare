# shellcheck shell=bash
# Shared by plan.sh / apply.sh: computes the fileshare ufw rules from .env. Source it.
# Every rule carries a comment starting with "fileshare:" — revert.sh deletes exactly those.

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

UFW_COMMENT_PREFIX="fileshare:"

# fileshare_rules [TUNNEL_SUBNET]
# Prints one ufw argument list per line (without the leading "ufw").
fileshare_rules() {
  local subnet=${1-}
  local bt_port webrtc_port admin_port admin_bind
  bt_port=$(env_get BT_PORT 6890)
  webrtc_port=$(env_get WEBRTC_PORT 6891)
  admin_port=$(env_get ADMIN_PORT 8091)
  admin_bind=$(env_get ADMIN_BIND)
  for p in "$bt_port" "$webrtc_port" "$admin_port"; do
    [[ $p =~ ^[0-9]+$ ]] || die "bad port in .env: $p"
  done
  [[ $admin_bind =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "ADMIN_BIND must be an IPv4 address (the tunnel network's bridge gateway)"
  if [[ -z $subnet ]]; then
    subnet=$(detect_subnet "$admin_bind") ||
      die "could not find the docker network whose gateway is $admin_bind; pass --tunnel-subnet CIDR"
  fi
  [[ $subnet =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || die "bad subnet: $subnet"

  echo "allow proto tcp to any port 8443 comment '$UFW_COMMENT_PREFIX public https (caddy)'"
  echo "allow proto tcp to any port $bt_port comment '$UFW_COMMENT_PREFIX bittorrent tcp'"
  echo "allow proto udp to any port $bt_port comment '$UFW_COMMENT_PREFIX bittorrent utp'"
  echo "allow proto udp to any port $webrtc_port comment '$UFW_COMMENT_PREFIX webrtc ice'"
  echo "allow proto tcp from $subnet to $admin_bind port $admin_port comment '$UFW_COMMENT_PREFIX admin from tunnel connector'"
}

# detect_subnet GATEWAY_IP → the subnet of the docker network with that gateway (read-only query).
detect_subnet() {
  local gw=$1 net
  command -v docker >/dev/null || return 1
  while read -r net; do
    docker network inspect "$net" \
      --format '{{range .IPAM.Config}}{{.Gateway}} {{.Subnet}}{{"\n"}}{{end}}' 2>/dev/null |
      awk -v gw="$gw" '$1 == gw { print $2; found = 1 } END { exit !found }' && return 0
  done < <(docker network ls -q)
  return 1
}
