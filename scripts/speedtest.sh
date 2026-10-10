#!/usr/bin/env bash
# One-off upload measurement in a throwaway container, then record it as the upload capacity:
#   docker compose exec app node dist/cli.js speedtest record <Mbps>
#
#   scripts/speedtest.sh [--no-record] [-- <extra librespeed-cli args, e.g. --server 52>]
#
# librespeed-cli v1.0.14 is downloaded inside the container and sha256-verified. Upload only,
# no ICMP, telemetry off. The client block of the result (your public IP / ISP) is not printed.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

IMAGE="alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6"
VERSION=1.0.14
case $(uname -m) in
  x86_64)
    ARCH=amd64
    SHA=89800767ac14085c78a20847ebea23340f6c14a78de0a15c2ac7db8b565c961f
    ;;
  aarch64 | arm64)
    ARCH=arm64
    SHA=75e51a2494d03cb35a92ddbf862b40571a25a1526f3cf3dfa8b1d5d7bc622bd9
    ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac
URL="https://github.com/librespeed/speedtest-cli/releases/download/v${VERSION}/librespeed-cli_${VERSION}_linux_${ARCH}.tar.gz"

record=true
extra=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-record) record=false ;;
    --)
      shift
      extra=("$@")
      break
      ;;
    -h | --help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done
command -v python3 >/dev/null || die "python3 is required"

info "running librespeed-cli $VERSION (upload only) in a throwaway container…"
raw=$(docker run --rm --pull missing --user 65534:65534 --read-only --tmpfs /work:exec,size=32m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges:true --memory 256m \
  -e URL="$URL" -e SHA="$SHA" -w /work "$IMAGE" sh -euc '
    wget -q -O l.tgz "$URL"
    echo "$SHA  l.tgz" | sha256sum -c -s -
    tar -xzf l.tgz librespeed-cli
    ./librespeed-cli --json --no-download --no-icmp --telemetry-level disabled "$@"
  ' sh "${extra[@]}")

# librespeed-cli prints a JSON array (one result) or object; `upload` is in Mbps.
summary=$(python3 -c '
import json, sys
r = json.loads(sys.stdin.read())
if isinstance(r, list):
    r = r[0]
r.pop("client", None)  # public IP / ISP: not needed, not printed
print(json.dumps(r, indent=2))
' <<<"$raw")
echo "$summary"
mbps=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["upload"])' <<<"$summary")
python3 -c 'import sys; v = float(sys.argv[1]); sys.exit(0 if 0.1 <= v <= 100000 else 1)' "$mbps" ||
  die "implausible upload result: $mbps Mbps (not recorded)"
info "upload: $mbps Mbps"

if $record; then
  docker compose -f "$REPO_DIR/compose.yaml" --project-directory "$REPO_DIR" exec -T app \
    node dist/cli.js speedtest record "$mbps"
  info "recorded (the upload cap defaults to 90% of this; change it in the dashboard)"
else
  info "not recorded (--no-record). To record: docker compose exec app node dist/cli.js speedtest record $mbps"
fi
