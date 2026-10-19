#!/usr/bin/env bash
# Builds the look-ahead delay helper (npm run build:lookahead; npm run dist runs it first):
#   native/lookahead/build.sh [OUT_DIR] [--sdk DIR]          -> OUT_DIR/sonata-lookahead (default native/lookahead/build)
# Needs gcc and the PipeWire/SPA headers, taken from, in order: --sdk DIR (an unpacked libpipewire-0.3-dev +
# libspa-0.2-dev), the system (/usr/include/pipewire-0.3), or a copy fetched without root into
# ~/.cache/sonata-build/pipewire-sdk (`apt-get download` + `dpkg-deb -x`, Debian/Ubuntu). Links the system's
# libpipewire-0.3.so.0: no copy is bundled, the library must match the user's PipeWire.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/build"; SDK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sdk) SDK=$(realpath "$2"); shift 2 ;;
    *) OUT="$1"; shift ;;
  esac
done
if [ -n "$SDK" ]; then I="$SDK/usr/include"
elif [ -d /usr/include/pipewire-0.3 ] && [ -d /usr/include/spa-0.2 ]; then I=/usr/include
else
  C="${XDG_CACHE_HOME:-$HOME/.cache}/sonata-build/pipewire-sdk"
  if [ ! -d "$C/usr/include/pipewire-0.3" ]; then
    command -v apt-get >/dev/null || { echo "PipeWire headers not found: install libpipewire-0.3-dev and libspa-0.2-dev, or pass --sdk DIR" >&2; exit 1; }
    mkdir -p "$C/debs"
    (cd "$C/debs" && apt-get download libpipewire-0.3-dev libspa-0.2-dev)
    for f in "$C"/debs/*.deb; do dpkg-deb -x "$f" "$C"; done
  fi
  I="$C/usr/include"
fi
LIB=$(ls /usr/lib/*/libpipewire-0.3.so.0 /usr/lib64/libpipewire-0.3.so.0 /usr/lib/libpipewire-0.3.so.0 2>/dev/null | head -1 || true)
[ -n "$LIB" ] || { echo "libpipewire-0.3.so.0 not found (PipeWire not installed)" >&2; exit 1; }
mkdir -p "$OUT"
gcc -O2 -Wall -Wextra -Werror -std=gnu11 -o "$OUT/sonata-lookahead" "$HERE/sonata-lookahead.c" \
  -I"$I/pipewire-0.3" -I"$I/spa-0.2" -D_REENTRANT "$LIB" -lm -lpthread
echo "built $OUT/sonata-lookahead"
