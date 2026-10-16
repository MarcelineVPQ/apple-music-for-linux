#!/bin/sh
# Install sonata-align into a private venv (no system packages, no sudo).
#   ./install.sh          GPU build (CUDA 12.8 wheels; works on CPU too, ~6.5 GB)
#   ./install.sh --cpu    CPU-only build (~1 GB, much slower)
# Models download on first use (or: echo '{"cmd":"prepare","id":"p"}' | ./sonata-align).
set -e
HOME_DIR="${SONATA_ALIGN_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/sonata-align}"
HERE="$(dirname "$(readlink -f "$0")")"
INDEX=https://download.pytorch.org/whl/cu128
[ "$1" = "--cpu" ] && INDEX=https://download.pytorch.org/whl/cpu
command -v uv >/dev/null || { echo "needs uv (https://docs.astral.sh/uv/)"; exit 1; }
mkdir -p "$HOME_DIR"
[ -x "$HOME_DIR/venv/bin/python" ] || uv venv --python 3.12 "$HOME_DIR/venv"
uv pip install --python "$HOME_DIR/venv/bin/python" --index-url "$INDEX" torch==2.11.0 torchaudio==2.11.0
uv pip install --python "$HOME_DIR/venv/bin/python" -r "$HERE/requirements.txt" --extra-index-url "$INDEX"
echo "installed in $HOME_DIR/venv"
