#!/usr/bin/env bash
#
# find-ubuntu-mirror.sh — locate a working Ubuntu ISO mirror during an outage
#
# Usage:
#   scripts/find-ubuntu-mirror.sh [-r RELEASE] [-f FLAVOR] [-a ARCH] [-n TOP_N]
#                                 [-t TIMEOUT] [-s SPEED_BYTES] [-q] [-h]
#
# Defaults: RELEASE=noble, FLAVOR=desktop, ARCH=amd64, TOP_N=10, TIMEOUT=5,
#           SPEED_BYTES=2097152 (2 MiB).
#
# Strategy:
#   1. Probe a curated list of Ubuntu CD mirrors (works even if releases.ubuntu.com is down).
#   2. Best-effort augment from launchpad.net/ubuntu/+cdmirrors.
#   3. For each mirror: HEAD the SHA256SUMS for connectivity, then range-download
#      a few MiB of the ISO to estimate throughput.
#   4. Print working mirrors sorted by speed, fastest first. The output ISO URLs
#      are ready to paste into wget/curl/aria2.
#
# Exit codes: 0 if at least one mirror works, 1 otherwise.

set -euo pipefail

RELEASE="noble"
FLAVOR="desktop"
ARCH="amd64"
TOP_N=10
TIMEOUT=5
SPEED_BYTES=$((2 * 1024 * 1024))
QUIET=0

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while getopts ":r:f:a:n:t:s:qh" opt; do
  case "$opt" in
    r) RELEASE="$OPTARG" ;;
    f) FLAVOR="$OPTARG" ;;
    a) ARCH="$OPTARG" ;;
    n) TOP_N="$OPTARG" ;;
    t) TIMEOUT="$OPTARG" ;;
    s) SPEED_BYTES="$OPTARG" ;;
    q) QUIET=1 ;;
    h) usage 0 ;;
    \?) echo "Unknown option: -$OPTARG" >&2; usage 1 ;;
    :)  echo "Option -$OPTARG requires an argument" >&2; usage 1 ;;
  esac
done

log() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*" >&2; }

ISO_NAME="ubuntu-${RELEASE}-${FLAVOR}-${ARCH}.iso"

# Curated mirrors. Each entry is the parent dir that contains release subdirs
# (e.g. <mirror>/noble/SHA256SUMS, <mirror>/noble/ubuntu-noble-desktop-amd64.iso).
KNOWN_MIRRORS=(
  "https://releases.ubuntu.com"
  "https://cdimage.ubuntu.com/releases"
  "https://mirror.us.leaseweb.net/ubuntu-releases"
  "https://mirror.cogentco.com/pub/linux/ubuntu-releases"
  "https://ftp.acc.umu.se/mirror/cdimage/releases"
  "https://mirrors.edge.kernel.org/ubuntu-releases"
  "https://mirror.pit.teraswitch.com/ubuntu-releases"
  "https://mirror.fcix.net/ubuntu-releases"
  "https://mirrors.kernel.org/ubuntu-releases"
  "https://mirrors.xtom.com/ubuntu-releases"
  "https://mirror.math.princeton.edu/pub/ubuntu-iso"
  "https://mirror.pilotfiber.com/ubuntu-release"
  "https://mirror.us.oneandone.net/linux/distributions/ubuntu/ubuntu-releases"
  "https://mirror.lyrahosting.com/ubuntu-releases"
  "https://mirror.steadfastnet.com/ubuntu-releases"
  "https://mirror.dst.ca/ubuntu-releases"
  "https://mirror.netcologne.de/ubuntu-releases"
  "https://ubuntu.mirror.garr.it/ubuntu-releases"
  "https://ftp.tu-chemnitz.de/pub/linux/ubuntu-releases"
  "https://mirror.aarnet.edu.au/pub/ubuntu/releases"
)

fetch_launchpad_mirrors() {
  curl -fsSL --max-time 10 https://launchpad.net/ubuntu/+cdmirrors 2>/dev/null \
    | grep -oE 'href="https?://[^"]+/"' \
    | sed -E 's/^href="(.*)"$/\1/' \
    | grep -E '(ubuntu-?releases?|ubuntu-?cdimage|cdimage|/releases?/)' \
    | sed -E 's:/$::' \
    | sort -u || true
}

log "Discovering mirrors (curated + Launchpad)…"
LP=()
while IFS= read -r line; do [ -n "$line" ] && LP+=("$line"); done < <(fetch_launchpad_mirrors)
MIRRORS=()
while IFS= read -r line; do [ -n "$line" ] && MIRRORS+=("$line"); done < <(
  printf '%s\n' "${KNOWN_MIRRORS[@]}" "${LP[@]}" | awk 'NF' | sort -u
)

log "Testing ${#MIRRORS[@]} mirror(s) for ${ISO_NAME} (timeout=${TIMEOUT}s, speed sample=${SPEED_BYTES}B)…"
log ""

results_file=$(mktemp)
trap 'rm -f "$results_file"' EXIT

for m in "${MIRRORS[@]}"; do
  base="${m%/}/${RELEASE}"
  sums_url="${base}/SHA256SUMS"
  iso_url="${base}/${ISO_NAME}"

  # Connectivity check
  if ! curl -fsI -L --max-time "$TIMEOUT" "$sums_url" >/dev/null 2>&1; then
    log "  [DOWN]   $m"
    continue
  fi

  # Speed sample: download first SPEED_BYTES of the ISO via HTTP Range.
  # %{size_download} = bytes received; %{time_total} = seconds.
  read -r bytes elapsed http_code < <(
    curl -fsS -L --max-time "$((TIMEOUT * 4))" \
         -r "0-$((SPEED_BYTES - 1))" \
         -o /dev/null \
         -w '%{size_download} %{time_total} %{http_code}\n' \
         "$iso_url" 2>/dev/null || echo "0 0 000"
  )

  if [ "${bytes:-0}" -lt 65536 ]; then
    log "  [NO ISO] $m  (sums OK, iso missing — http=$http_code)"
    continue
  fi

  speed_kbps=$(awk -v b="$bytes" -v t="$elapsed" \
    'BEGIN { if (t+0 > 0) printf "%.0f", (b/1024)/t; else print 0 }')
  log "  [OK]     ${speed_kbps} kB/s  $m"
  printf '%s\t%s\n' "$speed_kbps" "$iso_url" >> "$results_file"
done

log ""
if [ ! -s "$results_file" ]; then
  log "No working mirrors found for ${ISO_NAME}."
  log "Try: -r jammy (22.04) or -r focal (20.04); confirm flavor (-f desktop|live-server|server)."
  exit 1
fi

log "Top ${TOP_N} mirror(s) for ${ISO_NAME} (fastest first):"
sort -t$'\t' -k1 -nr "$results_file" \
  | head -n "$TOP_N" \
  | awk -F'\t' '{ printf "%8s kB/s  %s\n", $1, $2 }'
