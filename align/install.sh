#!/bin/sh
# Install sonata-align into a private venv (no system packages, no sudo).
#   ./install.sh             GPU build (CUDA 12.8 wheels; works on CPU too, ~7 GB)
#   ./install.sh --cpu       CPU-only build (~1 GB, much slower)
#   ./install.sh --rebuild   a new venv; the old one is moved aside to venv.old-<date> (rollback: move
#                            it back), the downloaded models in <home>/models stay
#   ./install.sh --dry-run   print the home and the Python it would use; change nothing
#   ./install.sh --uv-python no system Python 3.10-3.13: let uv download Python 3.12 into
#                            <home>/python (Sonata's own folder, never another app's)
# Models download on first use (or: echo '{"cmd":"prepare","id":"p"}' | ./sonata-align).
#
# The venv is always built from a system Python (python3.12, 3.13, 3.11 or 3.10 on PATH, or
# SONATA_ALIGN_PYTHON), never from one inside another app's sandbox or runtime: ~/snap, /snap,
# ~/.var/app (Flatpak) or an AppImage mount. A venv's python is a link to the interpreter it was
# made from; in 2026-10 it pointed into ~/snap/codium/495/ (uv run from the Codium snap's terminal,
# which also sets XDG_DATA_HOME to the snap's folder), and a snap refresh would have broken it.
# Same home rule as align/sonata-align, sonata_align.data_dir and align-helper.js helperPaths.
set -e

CPU=0 REBUILD=0 DRY=0 UVPY=0
for a in "$@"; do
  case "$a" in
    --cpu) CPU=1 ;;
    --rebuild) REBUILD=1 ;;
    --dry-run) DRY=1 ;;
    --uv-python) UVPY=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

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
VENV="$HOME_DIR/venv"
HERE="$(dirname "$(readlink -f "$0")")"

# a Python the venv can be built from: 3.10-3.13 (torch 2.11, demucs and ctranslate2 wheels), outside any sandbox
py_ok() {
  [ -x "$1" ] || return 1
  in_sandbox "$1" && return 1
  "$1" -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)' 2>/dev/null
}
pick_python() {
  if [ -n "$SONATA_ALIGN_PYTHON" ]; then
    if py_ok "$SONATA_ALIGN_PYTHON"; then echo "$SONATA_ALIGN_PYTHON"; return 0; fi
    echo "SONATA_ALIGN_PYTHON=$SONATA_ALIGN_PYTHON is not usable (Python 3.10-3.13, not inside an app sandbox)" >&2
    return 1
  fi
  for v in 3.12 3.13 3.11 3.10 3; do
    IFS=:
    for d in $PATH; do
      unset IFS
      [ -n "$d" ] || continue
      in_sandbox "$d" && continue
      if py_ok "$d/python$v"; then echo "$d/python$v"; return 0; fi
    done
    unset IFS
  done
  return 1
}

venv_state() {
  [ -e "$VENV/bin/python" ] || [ -L "$VENV/bin/python" ] || { echo missing; return; }
  [ -x "$VENV/bin/python" ] || { echo broken; return; }
  if in_sandbox "$VENV/bin/python"; then echo sandboxed; return; fi
  if [ -f "$VENV/pyvenv.cfg" ]; then
    cfg_home="$(sed -n 's/^home *= *//p' "$VENV/pyvenv.cfg" | head -n 1)"
    if [ -n "$cfg_home" ] && in_sandbox "$cfg_home"; then echo sandboxed; return; fi
  fi
  echo ok
}

PY=""
if [ "$UVPY" = 0 ]; then PY="$(pick_python)" || PY=""; fi
STATE="$(venv_state)"
if [ "$DRY" = 1 ]; then
  echo "home: $HOME_DIR"
  echo "python: ${PY:-none}"
  echo "venv: $STATE"
  exit 0
fi

if [ "$STATE" = broken ] || [ "$STATE" = sandboxed ]; then
  if [ "$REBUILD" = 0 ]; then
    echo "the venv in $VENV is $STATE (its python: $(readlink "$VENV/bin/python" 2>/dev/null || echo '?'))." >&2
    echo "rebuild it from a normal terminal: $0 --rebuild   (the models are kept, the old venv is moved aside)" >&2
    exit 1
  fi
fi
if [ -z "$PY" ] && [ "$UVPY" = 0 ]; then
  echo "no system Python 3.10-3.13 found outside app sandboxes." >&2
  echo "install one from your distribution (Ubuntu/Debian: sudo apt install python3.12-venv or python3.13-venv)," >&2
  echo "or set SONATA_ALIGN_PYTHON=/path/to/python3.x, or run $0 --uv-python (uv downloads Python 3.12 into $HOME_DIR/python)" >&2
  exit 1
fi

# uv's cache and Python downloads: never inside an app sandbox either
if [ -n "$XDG_CACHE_HOME" ] && in_sandbox "$XDG_CACHE_HOME"; then export UV_CACHE_DIR="$HOME/.cache/uv"; fi
export UV_PYTHON_INSTALL_DIR="$HOME_DIR/python"
UV="$(command -v uv || true)"
if [ "$UVPY" = 1 ] && [ -z "$UV" ]; then echo "--uv-python needs uv (https://docs.astral.sh/uv/)" >&2; exit 1; fi

INDEX=https://download.pytorch.org/whl/cu128
[ "$CPU" = 1 ] && INDEX=https://download.pytorch.org/whl/cpu
mkdir -p "$HOME_DIR"

OLD=""
if [ "$REBUILD" = 1 ] && [ "$STATE" != missing ]; then
  OLD="$VENV.old-$(date +%Y%m%d-%H%M%S)"
  mv "$VENV" "$OLD"
  echo "moved the old venv to $OLD"
fi
# a failed build puts the old venv back
restore() {
  if [ -n "$OLD" ] && [ -d "$OLD" ]; then
    rm -rf "$VENV"
    mv "$OLD" "$VENV"
    echo "build failed: the old venv is back in $VENV" >&2
  fi
}
trap 'restore' EXIT

if [ ! -x "$VENV/bin/python" ]; then
  if [ "$UVPY" = 1 ]; then
    UV_PYTHON_DOWNLOADS=automatic "$UV" venv --python 3.12 --python-preference only-managed "$VENV"
  elif [ -n "$UV" ]; then
    UV_PYTHON_DOWNLOADS=never "$UV" venv --python "$PY" --python-preference only-system "$VENV"
  else
    "$PY" -m venv "$VENV"
  fi
fi
if [ -n "$UV" ]; then
  "$UV" pip install --python "$VENV/bin/python" --index-url "$INDEX" torch==2.11.0 torchaudio==2.11.0
  "$UV" pip install --python "$VENV/bin/python" -r "$HERE/requirements.txt" --extra-index-url "$INDEX"
else
  "$VENV/bin/python" -m pip install --upgrade pip
  "$VENV/bin/python" -m pip install --index-url "$INDEX" torch==2.11.0 torchaudio==2.11.0
  "$VENV/bin/python" -m pip install -r "$HERE/requirements.txt" --extra-index-url "$INDEX"
fi
"$VENV/bin/python" -c 'import torch, torchaudio, demucs; print("torch", torch.__version__, "cuda" if torch.cuda.is_available() else "cpu")'
trap - EXIT
echo "installed in $VENV (python: $(readlink -f "$VENV/bin/python"))"
[ -n "$OLD" ] && echo "the old venv is in $OLD: once Precise timing works, remove it (rm -rf '$OLD'); to roll back: rm -rf '$VENV' && mv '$OLD' '$VENV'"
exit 0
