#!/bin/sh
# Installs Precise word timing's helper (the Sonata engine, a separate download) into a private
# folder: no sudo, no system packages. Generic: download -> verify -> licence -> unpack -> venv.
#   ./install.sh               GPU build (CUDA 12.8 wheels; works on CPU too, ~7 GB)
#   ./install.sh --cpu         CPU-only build (~1 GB, much slower)
#   ./install.sh --rebuild     a new venv; the old one is moved aside to venv.old-<date> (rollback: move
#                              it back), the downloaded models in <home>/models stay
#   ./install.sh --dry-run     print the home, the pinned engine and what is installed; change nothing
#   ./install.sh --accept-licence   accept the helper's licence without the prompt (it is still printed)
#   ./install.sh --from DIR|URL     fetch the pinned file from there instead of the release (a mirror,
#                              a local copy): its size, SHA-256 and signature must still match the pin
# The engine Sonata wants is pinned in engine.json beside this script (version, file, size, SHA-256,
# the engine's Ed25519 signing key); anything else is refused. It is unpacked into
# <home>/engine-X.Y.Z/, which builds the venv in <home>/venv from its own recipe (setup-venv.sh,
# on the Python named in engine.json, 3.14). Models download on first use. The home: SONATA_ALIGN_HOME, else
# $XDG_DATA_HOME/sonata-align (outside app sandboxes), else ~/.local/share/sonata-align; never inside
# another app's sandbox (~/snap, /snap, ~/.var/app, an AppImage mount). Same rule as align-helper.js
# helperPaths. Removing it: delete the home (the models are in it too).
set -e

CPU="" REBUILD="" DRY=0 ACCEPT=0 FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cpu) CPU=--cpu ;;
    --rebuild) REBUILD=--rebuild ;;
    --dry-run) DRY=1 ;;
    --accept-licence|--accept-license) ACCEPT=1 ;;
    --from) FROM="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

HERE="$(dirname "$(readlink -f "$0")")"
PIN="$HERE/engine.json"
REAL_HOME="$(readlink -f "$HOME" 2>/dev/null || echo "$HOME")"
# true for a path inside another app's sandbox or runtime (resolved, so links count where they lead)
in_sandbox() {
  p="$(readlink -f "$1" 2>/dev/null || echo "$1")"
  case "$p" in
    /snap|/snap/*|/var/snap/*|/var/lib/snapd/*|"$REAL_HOME"/snap|"$REAL_HOME"/snap/*|"$REAL_HOME"/.var/app/*|/tmp/.mount_*) return 0 ;;
  esac
  return 1
}
if [ -n "$SONATA_ALIGN_HOME" ]; then
  HOME_DIR="$SONATA_ALIGN_HOME"
elif [ -n "$XDG_DATA_HOME" ] && [ "${XDG_DATA_HOME#/}" != "$XDG_DATA_HOME" ] && ! in_sandbox "$XDG_DATA_HOME"; then
  HOME_DIR="$XDG_DATA_HOME/sonata-align"
else
  HOME_DIR="$HOME/.local/share/sonata-align"
fi
if in_sandbox "$HOME_DIR"; then
  echo "refusing to install into $HOME_DIR: it is inside another app's sandbox (set SONATA_ALIGN_HOME elsewhere)" >&2
  exit 1
fi

# the pin: one "key": value per line (written by tools/pin-engine.js)
pin() { sed -n 's/^ *"'"$1"'": *"\{0,1\}\([^",]*\)"\{0,1\},\{0,1\} *$/\1/p' "$PIN" | head -n 1; }
[ -f "$PIN" ] || { echo "no engine.json beside $0" >&2; exit 1; }
VERSION="$(pin version)" FILE="$(pin file)" URL="$(pin url)" SIZE="$(pin size)" SHA="$(pin sha256)" KEY="$(pin key)"
for v in VERSION FILE URL SIZE SHA KEY; do
  eval "[ -n \"\$$v\" ]" || { echo "engine.json has no $(echo $v | tr A-Z a-z)" >&2; exit 1; }
done
case "$FILE" in */*|.*) echo "engine.json: bad file name $FILE" >&2; exit 1 ;; esac
ENGINE="$HOME_DIR/engine-$VERSION"
if [ -n "$FROM" ]; then URL="${FROM%/}/$FILE"; fi

if [ "$DRY" = 1 ]; then
  echo "home: $HOME_DIR"
  echo "engine: $VERSION ($FILE, $SIZE bytes, sha256 $SHA)"
  echo "from: $URL"
  if [ -f "$ENGINE/.installed" ]; then echo "installed: yes ($ENGINE)"; else echo "installed: no"; fi
  [ -x "$ENGINE/setup-venv.sh" ] && sh "$ENGINE/setup-venv.sh" --home "$HOME_DIR" --dry-run $CPU
  exit 0
fi

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }
fetch() {   # fetch URL-or-path DEST
  case "$1" in
    http://*|https://*)
      if command -v curl >/dev/null 2>&1; then curl -fL# --retry 3 --proto '=https,http' -o "$2" "$1"
      elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
      else echo "needs curl or wget to download the engine" >&2; return 1; fi ;;
    file://*) cp "${1#file://}" "$2" ;;
    *) cp "$1" "$2" ;;
  esac
}
# Ed25519 over the exact bytes (base64 signature, the key as base64 SPKI DER), with OpenSSL 3
verify_sig() {   # verify_sig FILE SIGFILE
  command -v openssl >/dev/null 2>&1 || { echo "needs openssl (3.0 or newer) to check the engine's signature" >&2; return 1; }
  printf -- '-----BEGIN PUBLIC KEY-----\n%s\n-----END PUBLIC KEY-----\n' "$KEY" > "$TMPD/key.pem"
  base64 -d "$2" > "$TMPD/sig.bin" 2>/dev/null || { echo "the signature file is not base64" >&2; return 1; }
  openssl pkeyutl -verify -pubin -inkey "$TMPD/key.pem" -rawin -in "$1" -sigfile "$TMPD/sig.bin" >/dev/null 2>&1
}

mkdir -p "$HOME_DIR"
TMPD="$(mktemp -d "$HOME_DIR/.download.XXXXXX")"
trap 'rm -rf "$TMPD"' EXIT

if [ -f "$ENGINE/.installed" ] && [ "$(sed -n 's/^sha256=//p' "$ENGINE/.installed")" = "$SHA" ]; then
  echo "engine $VERSION is already installed in $ENGINE"
else
  echo "downloading the Sonata engine $VERSION ($SIZE bytes) from $URL"
  fetch "$URL" "$TMPD/$FILE"
  fetch "$URL.sig" "$TMPD/$FILE.sig"
  got="$(wc -c < "$TMPD/$FILE" | tr -d ' ')"
  [ "$got" = "$SIZE" ] || { echo "refused: the download is $got bytes, the pin says $SIZE" >&2; exit 1; }
  [ "$(sha256 "$TMPD/$FILE")" = "$SHA" ] || { echo "refused: the download's SHA-256 is not the pinned one" >&2; exit 1; }
  verify_sig "$TMPD/$FILE" "$TMPD/$FILE.sig" || { echo "refused: the engine's signature does not check out" >&2; exit 1; }
  echo "checked: size, SHA-256 and signature match the pin"
  mkdir -p "$TMPD/x"
  tar -xzf "$TMPD/$FILE" -C "$TMPD/x" --no-same-owner
  SRC="$TMPD/x/sonata-engine-$VERSION"
  [ -f "$SRC/ENGINE.json" ] && [ -x "$SRC/setup-venv.sh" ] || { echo "refused: the archive is not an engine $VERSION" >&2; exit 1; }
  # the licence, before anything is installed
  echo
  echo "================ Licence of the Precise timing helper ================"
  cat "$SRC/EULA.md"
  echo "====================================================================="
  echo
  if [ "$ACCEPT" = 1 ]; then
    echo "licence accepted (--accept-licence)"
  elif [ -r /dev/tty ] && (: < /dev/tty) 2>/dev/null; then
    printf 'Type "yes" to accept the licence and install: '
    read -r answer < /dev/tty || answer=""
    [ "$answer" = yes ] || { echo "not accepted: nothing installed"; exit 1; }
  else
    echo "no terminal to ask: run it again with --accept-licence once you have read the licence above" >&2
    exit 1
  fi
  rm -rf "$ENGINE.new"
  mv "$SRC" "$ENGINE.new"
  printf 'version=%s\nsha256=%s\nlicence_accepted=%s\n' "$VERSION" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ENGINE.new/.installed"
  rm -rf "$ENGINE"
  mv "$ENGINE.new" "$ENGINE"
  echo "engine $VERSION unpacked into $ENGINE"
fi

sh "$ENGINE/setup-venv.sh" --home "$HOME_DIR" $CPU $REBUILD
"$ENGINE/sonata-align" --check >/dev/null || { echo "the engine does not start in the venv: run $0 --rebuild" >&2; exit 1; }
echo "Precise word timing's helper is installed (engine $VERSION in $HOME_DIR). Sonata notices it in Settings → Word timing."
# older engines stay beside it (a few MB each) until removed by hand
for d in "$HOME_DIR"/engine-*; do
  [ -d "$d" ] && [ "$d" != "$ENGINE" ] && case "$d" in *.new) ;; *) echo "an older engine is still in $d (remove it with rm -rf '$d' once this one works)" ;; esac
done
exit 0
