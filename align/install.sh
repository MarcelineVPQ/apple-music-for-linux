#!/bin/sh
# Installs Precise word timing's helper (the Sonata engine, a separate download) into a private
# folder: no sudo, no system packages. Generic: download -> verify -> licence -> unpack -> venv -> check.
# The one installer: Settings → Precise timing runs this same script (with --progress), and so can a terminal.
#   ./install.sh               GPU build (CUDA 12.8 wheels; works on CPU too, ~7 GB)
#   ./install.sh --cpu         CPU-only build (~1 GB, much slower)
#   ./install.sh --rebuild     a new venv even when the current one fits; the downloaded models in
#                              <home>/models stay
#   ./install.sh --dry-run     print the home, the engine and what is installed; change nothing
#   ./install.sh --accept-licence   accept the helper's licence without the prompt (it is still printed)
#   ./install.sh --from DIR|URL     fetch the engine file from there instead of the release (a mirror,
#                              a local copy): its size, SHA-256 and signature must still match the pin
#   ./install.sh --pin FILE    install the engine FILE describes (same form as engine.json; Sonata writes
#                              it from the signed engine feed) instead of engine.json's. Its key must be
#                              engine.json's, its protocol one this Sonata speaks, its version at least
#                              engine.json's and not older than the active engine (no downgrade)
#   ./install.sh --licence-only     download and check the engine, keep it in <home>/.download, write its
#                              licence to <home>/.download/EULA-X.Y.Z.md and stop (Settings shows it)
#   ./install.sh --licence-sha SHA  accept exactly the licence whose SHA-256 is SHA (what Settings showed);
#                              a different licence text is refused
#   ./install.sh --prune       after a working install, delete the venv it replaced and older engines
#   ./install.sh --remove [--delete-models]   remove the helper (engines, venv, its Python); the
#                              downloaded models stay unless --delete-models
#   ./install.sh --progress    also print machine-readable lines "@@sonata {json}" (Settings reads them)
# The engine Sonata wants at least is pinned in engine.json beside this script (version, file, size,
# SHA-256, the engine's Ed25519 signing key); anything not signed by that key is refused. It is unpacked
# into <home>/engine-X.Y.Z/; the engine's own recipe (setup-venv.sh, on the Python named in its
# ENGINE.json, 3.14) builds a new venv in <home>/.staging, which replaces <home>/venv only after the
# engine answers a ping in it (the old venv comes back if the ping in place fails). Then
# <home>/active-engine names the engine Sonata runs. A failed or cancelled run leaves the working
# install as it was. Models download on first use. The home: SONATA_ALIGN_HOME, else
# $XDG_DATA_HOME/sonata-align (outside app sandboxes), else ~/.local/share/sonata-align; never inside
# another app's sandbox (~/snap, /snap, ~/.var/app, an AppImage mount). Same rule as align-helper.js
# helperPaths.
set -e

# the helper protocols this Sonata installs (align-helper.js INSTALL_PROTOCOLS; test/align-install.test.js
# checks they are the same)
PROTOCOLS="2"

CPU="" REBUILD=0 DRY=0 ACCEPT=0 FROM="" PROGRESS=0 LICENCE_ONLY=0 LICENCE_SHA="" PINFILE="" PRUNE=0 REMOVE=0 DELETE_MODELS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cpu) CPU=--cpu ;;
    --rebuild) REBUILD=1 ;;
    --dry-run) DRY=1 ;;
    --accept-licence|--accept-license) ACCEPT=1 ;;
    --from) FROM="$2"; shift ;;
    --pin) PINFILE="$2"; shift ;;
    --progress) PROGRESS=1 ;;
    --licence-only|--license-only) LICENCE_ONLY=1 ;;
    --licence-sha|--license-sha) LICENCE_SHA="$2"; shift ;;
    --prune) PRUNE=1 ;;
    --remove) REMOVE=1 ;;
    --delete-models) DELETE_MODELS=1 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# --- machine-readable progress (only with --progress): one JSON object per line after "@@sonata " ---
jstr() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r\t')"; }
ev() { if [ "$PROGRESS" = 1 ]; then printf '@@sonata {%s}\n' "$1"; fi; }
step() { ev "\"ev\":\"step\",\"step\":\"$1\""; }
CLEANUP=""
# fail CODE MESSAGE: the message on stderr (a person reads it), the code for Settings
fail() {
  echo "$2" >&2
  ev "\"ev\":\"fail\",\"code\":\"$1\",\"message\":$(jstr "$2")"
  exit 1
}

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
case "$HOME_DIR" in /*) ;; *) fail home "the helper's folder must be an absolute path: $HOME_DIR" ;; esac
if in_sandbox "$HOME_DIR"; then
  fail sandbox "refusing to install into $HOME_DIR: it is inside another app's sandbox (set SONATA_ALIGN_HOME elsewhere)"
fi
[ "$(readlink -f "$HOME_DIR" 2>/dev/null || echo "$HOME_DIR")" != "$REAL_HOME" ] && [ "$HOME_DIR" != / ] || fail home "refusing to use $HOME_DIR as the helper's folder"

# --- remove: the helper's own files only (bench songs or anything else in the folder stay) ---
if [ "$REMOVE" = 1 ]; then
  step remove
  if [ -d "$HOME_DIR" ]; then
    rm -rf "$HOME_DIR"/engine-* "$HOME_DIR/venv" "$HOME_DIR"/venv.old-* "$HOME_DIR/python" "$HOME_DIR/.staging" \
      "$HOME_DIR/.download" "$HOME_DIR"/.download.* "$HOME_DIR/active-engine" "$HOME_DIR/.active-engine.tmp"
    if [ "$DELETE_MODELS" = 1 ]; then rm -rf "$HOME_DIR/models"; fi
    rmdir "$HOME_DIR" 2>/dev/null || true
  fi
  echo "the Precise timing helper is removed from $HOME_DIR$([ "$DELETE_MODELS" = 1 ] || echo ' (the downloaded models stay in models/)')"
  ev "\"ev\":\"done\",\"removed\":true"
  exit 0
fi

# the pin: one "key": value per line (written by tools/pin-engine.js)
pinv() { sed -n 's/^ *"'"$1"'": *"\{0,1\}\([^",]*\)"\{0,1\},\{0,1\} *$/\1/p' "$2" | head -n 1; }
[ -f "$PIN" ] || fail pin "no engine.json beside $0"
MIN_VERSION="$(pinv version "$PIN")" KEY="$(pinv key "$PIN")"
[ -n "$MIN_VERSION" ] && [ -n "$KEY" ] || fail pin "engine.json has no version or key"
SRC_PIN="$PIN"
if [ -n "$PINFILE" ]; then
  [ -f "$PINFILE" ] || fail pin "no pin file $PINFILE"
  SRC_PIN="$PINFILE"
  k="$(pinv key "$PINFILE")"
  [ -z "$k" ] || [ "$k" = "$KEY" ] || fail pin "refused: $PINFILE names another signing key than engine.json"
fi
VERSION="$(pinv version "$SRC_PIN")" FILE="$(pinv file "$SRC_PIN")" URL="$(pinv url "$SRC_PIN")" SIZE="$(pinv size "$SRC_PIN")" SHA="$(pinv sha256 "$SRC_PIN")" PROTO="$(pinv protocol "$SRC_PIN")"
for v in VERSION FILE URL SIZE SHA; do
  eval "[ -n \"\$$v\" ]" || fail pin "the pin has no $(echo $v | tr A-Z a-z)"
done
echo "$VERSION" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+(-dev\.[0-9]+)?' || fail pin "the pin: bad version $VERSION"
[ "$FILE" = "sonata-engine-$VERSION-linux-x86_64.tar.gz" ] || case "$FILE" in */*|.*) fail pin "engine.json: bad file name $FILE" ;; *) fail pin "the pin: bad file name $FILE" ;; esac
echo "$SIZE" | grep -Eqx '[0-9]+' || fail pin "the pin: bad size $SIZE"
echo "$SHA" | grep -Eqx '[0-9a-f]{64}' || fail pin "the pin: bad sha256"
case "$URL" in https://*) ;; *) fail pin "refused: the engine's address is not https ($URL)" ;; esac
proto_ok() { for p in $PROTOCOLS; do [ "$p" = "$1" ] && return 0; done; return 1; }
[ -z "$PROTO" ] || proto_ok "$PROTO" || fail protocol "refused: engine $VERSION speaks protocol $PROTO; this Sonata installs protocol $PROTOCOLS"
# a <= b (X.Y.Z or X.Y.Z-dev.N; a release sorts after its development builds)
ver_le() {
  awk -v a="$1" -v b="$2" 'function k(v, p, n) { n = split(v, p, /[.-]/); return sprintf("%09d%09d%09d%09d", p[1], p[2], p[3], (p[4] == "dev") ? p[5] : 999999999) } BEGIN { exit !(k(a) <= k(b)) }'
}
ver_le "$MIN_VERSION" "$VERSION" || fail downgrade "refused: engine $VERSION is older than $MIN_VERSION, the oldest this Sonata runs"
ACTIVE="$(sed -n '1p' "$HOME_DIR/active-engine" 2>/dev/null | tr -d ' \r')" || ACTIVE=""
echo "$ACTIVE" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+(-dev\.[0-9]+)?' || ACTIVE=""
if [ -n "$ACTIVE" ] && [ "$DRY" = 0 ]; then
  ver_le "$ACTIVE" "$VERSION" || fail downgrade "refused: engine $VERSION is older than the installed $ACTIVE (no downgrade)"
fi
ENGINE="$HOME_DIR/engine-$VERSION"
KEEP="$HOME_DIR/.download"
if [ -n "$FROM" ]; then
  case "$FROM" in
    https://*|/*|file:///*) ;;
    http://127.0.0.1[:/]*|http://localhost[:/]*) ;;
    *) fail pin "refused: --from must be https, a local folder or a loopback address" ;;
  esac
  URL="${FROM%/}/$FILE"
elif [ -f "$KEEP/$FILE" ] && [ -f "$KEEP/$FILE.sig" ]; then
  URL="$KEEP/$FILE"   # the copy --licence-only kept: checked again below like any download
fi

if [ "$DRY" = 1 ]; then
  echo "home: $HOME_DIR"
  echo "engine: $VERSION ($FILE, $SIZE bytes, sha256 $SHA)"
  echo "from: $URL"
  if [ -f "$ENGINE/.installed" ]; then echo "installed: yes ($ENGINE)"; else echo "installed: no"; fi
  echo "active: ${ACTIVE:-none}"
  [ -x "$ENGINE/setup-venv.sh" ] && sh "$ENGINE/setup-venv.sh" --home "$HOME_DIR" --dry-run $CPU
  exit 0
fi

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }
fetch() {   # fetch URL-or-path DEST
  case "$1" in
    https://*|http://127.0.0.1[:/]*|http://localhost[:/]*)
      if command -v curl >/dev/null 2>&1; then
        if [ "$PROGRESS" = 1 ]; then curl -fsSL --retry 3 --proto '=https,http' --proto-redir '=https' -o "$2" "$1"
        else curl -fL# --retry 3 --proto '=https,http' --proto-redir '=https' -o "$2" "$1"; fi
      elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
      else echo "needs curl or wget to download the engine" >&2; return 1; fi ;;
    file://*) cp "${1#file://}" "$2" ;;
    *) cp "$1" "$2" ;;
  esac
}
# the download with its bytes reported (--progress): the file's size, read twice a second
fetch_counted() {   # fetch_counted URL DEST TOTAL
  if [ "$PROGRESS" = 0 ]; then fetch "$1" "$2"; return; fi
  fetch "$1" "$2" &
  fpid=$!
  while kill -0 "$fpid" 2>/dev/null; do
    g="$( (wc -c < "$2") 2>/dev/null | tr -d ' ')"
    ev "\"ev\":\"bytes\",\"step\":\"download\",\"got\":${g:-0},\"total\":$3"
    sleep 0.5
  done
  wait "$fpid"
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
STAGE="$HOME_DIR/.staging"
NEW_ENGINE=0 OLD="" WATCH=""
# leaves the working install as it was: the staging venv, an engine unpacked by this run that never
# became active, and a venv moved aside but not yet replaced
cleanup() {
  [ -z "$WATCH" ] || kill "$WATCH" 2>/dev/null || true
  rm -rf "$TMPD" "$STAGE" "$ENGINE.new"
  if [ -n "$OLD" ] && [ -d "$OLD" ]; then rm -rf "$HOME_DIR/venv"; mv "$OLD" "$HOME_DIR/venv"; echo "the previous venv is back in $HOME_DIR/venv" >&2; fi
  if [ "$NEW_ENGINE" = 1 ]; then rm -rf "$ENGINE"; fi
  # the download kept for the install that follows the licence goes with any other ending of an install
  [ "$LICENCE_ONLY" = 1 ] || rm -rf "$KEEP"
  rmdir "$HOME_DIR/python" 2>/dev/null || true   # made for uv's Python; empty when the system's was used
}
trap 'cleanup' EXIT
trap 'ev "\"ev\":\"cancelled\""; exit 130' INT TERM HUP

if [ -f "$ENGINE/.installed" ] && [ "$(sed -n 's/^sha256=//p' "$ENGINE/.installed")" = "$SHA" ] && [ "$LICENCE_ONLY" = 0 ]; then
  echo "engine $VERSION is already installed in $ENGINE"
  step download; step verify
else
  step download
  echo "downloading the Sonata engine $VERSION ($SIZE bytes) from $URL"
  fetch_counted "$URL" "$TMPD/$FILE" "$SIZE" || fail download "the engine could not be downloaded from $URL"
  fetch "$URL.sig" "$TMPD/$FILE.sig" || fail download "the engine's signature could not be downloaded from $URL.sig"
  ev "\"ev\":\"bytes\",\"step\":\"download\",\"got\":$(wc -c < "$TMPD/$FILE" | tr -d ' '),\"total\":$SIZE"
  step verify
  got="$(wc -c < "$TMPD/$FILE" | tr -d ' ')"
  [ "$got" = "$SIZE" ] || fail verify "refused: the download is $got bytes, the pin says $SIZE"
  [ "$(sha256 "$TMPD/$FILE")" = "$SHA" ] || fail verify "refused: the download's SHA-256 is not the pinned one"
  verify_sig "$TMPD/$FILE" "$TMPD/$FILE.sig" || fail verify "refused: the engine's signature does not check out"
  echo "checked: size, SHA-256 and signature match the pin"
  mkdir -p "$TMPD/x"
  tar -xzf "$TMPD/$FILE" -C "$TMPD/x" --no-same-owner
  SRC="$TMPD/x/sonata-engine-$VERSION"
  [ -f "$SRC/ENGINE.json" ] && [ -x "$SRC/setup-venv.sh" ] || fail verify "refused: the archive is not an engine $VERSION"
  [ "$(pinv version "$SRC/ENGINE.json")" = "$VERSION" ] || fail verify "refused: the archive's ENGINE.json is not version $VERSION"
  EP="$(pinv protocol "$SRC/ENGINE.json")"
  proto_ok "$EP" || fail protocol "refused: engine $VERSION speaks protocol ${EP:-unknown}; this Sonata installs protocol $PROTOCOLS"
  [ -f "$SRC/EULA.md" ] || fail verify "refused: the engine has no licence (EULA.md)"
  LSHA="$(sha256 "$SRC/EULA.md")"
  if [ "$LICENCE_ONLY" = 1 ]; then
    # keep the checked download for the install that follows the licence, and the licence for Settings
    rm -rf "$KEEP"; mkdir -p "$KEEP"
    cp "$TMPD/$FILE" "$TMPD/$FILE.sig" "$KEEP/"
    cp "$SRC/EULA.md" "$KEEP/EULA-$VERSION.md"
    ev "\"ev\":\"licence\",\"version\":\"$VERSION\",\"sha\":\"$LSHA\",\"path\":$(jstr "$KEEP/EULA-$VERSION.md")"
    echo "the licence of engine $VERSION is in $KEEP/EULA-$VERSION.md (sha256 $LSHA)"
    exit 0
  fi
  # the licence, before anything is installed
  echo
  echo "================ Licence of the Precise timing helper ================"
  cat "$SRC/EULA.md"
  echo "====================================================================="
  echo
  if [ -n "$LICENCE_SHA" ]; then
    [ "$LICENCE_SHA" = "$LSHA" ] || fail licence "not installed: the helper's licence is not the one that was accepted (it changed); read and accept it again"
    echo "licence accepted (sha256 $LSHA)"
  elif [ "$ACCEPT" = 1 ]; then
    echo "licence accepted (--accept-licence)"
  elif [ -r /dev/tty ] && (: < /dev/tty) 2>/dev/null; then
    printf 'Type "yes" to accept the licence and install: '
    read -r answer < /dev/tty || answer=""
    [ "$answer" = yes ] || { echo "not accepted: nothing installed"; exit 1; }
  else
    fail licence "no terminal to ask: run it again with --accept-licence once you have read the licence above"
  fi
  rm -rf "$ENGINE.new"
  mv "$SRC" "$ENGINE.new"
  printf 'version=%s\nsha256=%s\nlicence_sha256=%s\nlicence_accepted=%s\n' "$VERSION" "$SHA" "$LSHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ENGINE.new/.installed"
  [ "$VERSION" = "$ACTIVE" ] || [ -d "$ENGINE" ] || NEW_ENGINE=1
  rm -rf "$ENGINE"
  mv "$ENGINE.new" "$ENGINE"
  echo "engine $VERSION unpacked into $ENGINE"
fi
[ "$LICENCE_ONLY" = 0 ] || { ev "\"ev\":\"licence\",\"version\":\"$VERSION\",\"installed\":true"; exit 0; }

# --- the venv: reused when the engine's recipe says it is up to date, else built aside and switched ---
export SONATA_ALIGN_HOME="$HOME_DIR"
if [ "$REBUILD" = 0 ] && sh "$ENGINE/setup-venv.sh" --home "$HOME_DIR" --dry-run $CPU 2>/dev/null | grep -qx 'packages: up to date'; then
  echo "venv up to date ($HOME_DIR/venv)"
  ev "\"ev\":\"skip\",\"step\":\"venv\""
else
  # the variant the venv has (CPU or GPU wheels), unless --cpu asks
  VARIANT="$CPU"
  if [ -z "$VARIANT" ]; then
    case "$(sed -n 's/^variant=//p' "$HOME_DIR/venv/.sonata-engine-venv" 2>/dev/null | head -n 1)" in cpu) VARIANT=--cpu ;; *) VARIANT=--gpu ;; esac
  fi
  # room for the new venv beside the old one (the old one goes only once the new one works)
  if [ "$VARIANT" = --cpu ]; then NEED_GB=3; else NEED_GB=12; fi   # the venv plus pip's downloaded wheels
  AVAIL_KB="$(df -Pk "$HOME_DIR" 2>/dev/null | awk 'NR==2 { print $4 }')"
  if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt $((NEED_GB * 1024 * 1024)) ]; then
    fail space "not enough free space for the helper: it needs about $NEED_GB GB in $HOME_DIR, $((AVAIL_KB / 1024 / 1024)) GB are free"
  fi
  rm -rf "$STAGE"
  mkdir -p "$STAGE" "$HOME_DIR/python"
  ln -s "$HOME_DIR/python" "$STAGE/python"   # uv's own Python (when there is no system one) lands in the real home
  # pip's and uv's temporary files (the wheels, ~4 GB) on the venv's disk, not in /tmp (often RAM)
  mkdir -p "$STAGE/tmp"
  export TMPDIR="$STAGE/tmp"
  ev "\"ev\":\"step\",\"step\":\"venv\",\"variant\":\"${VARIANT#--}\""
  if [ "$PROGRESS" = 1 ]; then
    # the new venv's size on disk every 2 s: real progress whatever pip or uv print
    ( while :; do kb="$(du -sk "$STAGE/venv" 2>/dev/null | cut -f1)"; ev "\"ev\":\"size\",\"bytes\":$(( ${kb:-0} * 1024 ))"; sleep 2; done ) &
    WATCH=$!
    export PIP_PROGRESS_BAR=raw   # pip prints "Progress N of M" per download (uv prints a line per big package)
  fi
  sh "$ENGINE/setup-venv.sh" --home "$STAGE" $VARIANT || { unset TMPDIR; fail venv "the helper's Python packages could not be installed (see the lines above)"; }
  unset TMPDIR
  rm -rf "$STAGE/tmp"
  [ -z "$WATCH" ] || { kill "$WATCH" 2>/dev/null || true; WATCH=""; }
  # the venv was made in .staging: its links, pyvenv.cfg and scripts name that path; point them at the home
  for f in "$STAGE/venv/bin"/*; do
    if [ -L "$f" ]; then
      t="$(readlink "$f")"
      case "$t" in "$STAGE"/*) ln -sfn "$HOME_DIR${t#"$STAGE"}" "$f" ;; esac
    elif [ -f "$f" ] && grep -qF "$STAGE" "$f" 2>/dev/null; then
      sed -i "s|$STAGE/|$HOME_DIR/|g" "$f"
    fi
  done
  [ ! -f "$STAGE/venv/pyvenv.cfg" ] || sed -i "s|$STAGE/|$HOME_DIR/|g" "$STAGE/venv/pyvenv.cfg"
  step check
  SONATA_ALIGN_HOME="$STAGE" "$ENGINE/sonata-align" --check >/dev/null || fail check "the engine does not start in the new venv; the installed one is unchanged"
  if [ -e "$HOME_DIR/venv" ] || [ -L "$HOME_DIR/venv" ]; then
    OLD="$HOME_DIR/venv.old-$(date +%Y%m%d-%H%M%S)"
    [ ! -e "$OLD" ] || OLD="$OLD-$$"   # two runs in one second: never mv into an existing folder
    mv "$HOME_DIR/venv" "$OLD"
  fi
  mv "$STAGE/venv" "$HOME_DIR/venv"
  rm -rf "$STAGE"
fi
step check
"$ENGINE/sonata-align" --check >/dev/null || fail check "the engine does not start in the venv: run $0 --rebuild"
# the switch: from here on Sonata runs this engine
printf '%s\n' "$VERSION" > "$HOME_DIR/.active-engine.tmp"
mv "$HOME_DIR/.active-engine.tmp" "$HOME_DIR/active-engine"
NEW_ENGINE=0
REPLACED="$OLD"
OLD=""
rm -rf "$KEEP"
echo "Precise word timing's helper is installed (engine $VERSION in $HOME_DIR). Sonata notices it in Settings → Precise timing."
if [ "$PRUNE" = 1 ]; then
  [ -z "$REPLACED" ] || rm -rf "$REPLACED"
  for d in "$HOME_DIR"/engine-*; do
    [ -d "$d" ] && [ "$d" != "$ENGINE" ] && case "$d" in *.new) ;; *) rm -rf "$d" ;; esac
  done
else
  [ -z "$REPLACED" ] || echo "the old venv is in $REPLACED: once Precise timing works, remove it (rm -rf '$REPLACED')"
  # older engines stay beside it (a few MB each) until removed by hand
  for d in "$HOME_DIR"/engine-*; do
    [ -d "$d" ] && [ "$d" != "$ENGINE" ] && case "$d" in *.new) ;; *) echo "an older engine is still in $d (remove it with rm -rf '$d' once this one works)" ;; esac
  done
fi
ev "\"ev\":\"done\",\"version\":\"$VERSION\""
exit 0
