#!/usr/bin/env bash
# Generate synthetic test files of real random data (from /dev/urandom; never sparse or zero
# files, which would dedupe/compress and make hashing tests meaningless). Writes SHA256SUMS.
#
#   scripts/gen-testdata.sh [-o DIR] [-n COUNT] [-s SIZE] [--nested DEPTH] [--big SIZE] [--prefix P]
#
#   -o DIR        output directory (default ./tmp/testdata; created; must not exist unless --force)
#   -n COUNT      files per directory (default 5)
#   -s SIZE       size of each file, IEC suffixes: 512K, 10M, 1G (default 1M)
#   --nested D    also create D levels of sub-directories, COUNT files in each (default 0)
#   --big SIZE    add one large file, e.g. --big 10G (checks free space first)
#   --prefix P    file name prefix (default "sample")
#   --force       allow writing into an existing directory
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

out="$REPO_DIR/tmp/testdata"
count=5
size=1M
depth=0
big=""
prefix=sample
force=false
while [[ $# -gt 0 ]]; do
  case $1 in
    -o)
      out=${2-}
      shift
      ;;
    -n)
      count=${2-}
      shift
      ;;
    -s)
      size=${2-}
      shift
      ;;
    --nested)
      depth=${2-}
      shift
      ;;
    --big)
      big=${2-}
      shift
      ;;
    --prefix)
      prefix=${2-}
      shift
      ;;
    --force) force=true ;;
    -h | --help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[[ $count =~ ^[0-9]+$ ]] || die "-n must be a number"
[[ $depth =~ ^[0-9]+$ ]] || die "--nested must be a number"
[[ $prefix =~ ^[A-Za-z0-9._-]+$ ]] || die "--prefix: letters, digits, . _ - only"
bytes() { numfmt --from=iec "$1" 2>/dev/null || die "bad size: $1"; }
file_bytes=$(bytes "$size")
big_bytes=0
[[ -n $big ]] && big_bytes=$(bytes "$big")

if [[ -e $out ]] && ! $force; then
  die "$out exists (use --force to add to it)"
fi
mkdir -p "$out"

total=$((count * file_bytes * (depth + 1) + big_bytes))
avail=$(($(df -Pk "$out" | awk 'NR == 2 { print $4 }') * 1024))
((total < avail - 512 * 1024 * 1024)) || die "not enough free space: need $(numfmt --to=iec "$total"), have $(numfmt --to=iec "$avail")"

random_file() { # PATH BYTES
  head -c "$2" /dev/urandom >"$1.part"
  mv "$1.part" "$1"
}

dir=$out
for ((level = 0; level <= depth; level++)); do
  for ((i = 1; i <= count; i++)); do
    random_file "$dir/$(printf '%s-%03d.bin' "$prefix" "$i")" "$file_bytes"
  done
  dir="$dir/level-$((level + 1))"
  if ((level < depth)); then mkdir -p "$dir"; fi
done
if ((big_bytes > 0)); then
  info "writing $(numfmt --to=iec "$big_bytes") of random data…"
  random_file "$out/$prefix-big.bin" "$big_bytes"
fi

sums=$(cd "$out" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum)
printf '%s\n' "$sums" >"$out/SHA256SUMS"
info "wrote $(($(wc -l <"$out/SHA256SUMS"))) files ($(numfmt --to=iec "$total")) to $out; checksums in $out/SHA256SUMS"
