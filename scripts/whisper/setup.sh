#!/usr/bin/env bash
# Whisper venv bootstrap (POSIX). Creates vendor/python-venv and installs
# faster-whisper + torch (CPU by default; pass --cuda 12.4 to install a CUDA
# wheel build matching your driver).
#
# Run from the repo root:
#   bash scripts/whisper/setup.sh
#   bash scripts/whisper/setup.sh --cuda 12.4

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VENV_DIR="$REPO_ROOT/vendor/python-venv"
REQUIREMENTS_FILE="$REPO_ROOT/scripts/whisper/requirements.txt"
CUDA_VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cuda)
      CUDA_VERSION="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required on PATH (3.10–3.12)." >&2
  exit 1
fi

if [[ ! -d "$VENV_DIR" ]]; then
  echo "Creating venv at $VENV_DIR"
  python3 -m venv "$VENV_DIR"
else
  echo "Using existing venv at $VENV_DIR"
fi

PIP="$VENV_DIR/bin/pip"
echo "Upgrading pip"
"$PIP" install --upgrade pip

# torch bound matches requirements.txt: 2.2 is the earliest version
# validated against faster-whisper, and there is no upper bound below the
# next major because torch < 2.6 has no Python 3.13 wheels. faster-whisper
# and ctranslate2 come from requirements.txt, which pins them.
if [[ -n "$CUDA_VERSION" ]]; then
  TAG="cu${CUDA_VERSION//./}"
  echo "Installing CUDA torch ($TAG)"
  "$PIP" install --index-url "https://download.pytorch.org/whl/$TAG" 'torch>=2.2,<3'
else
  echo "Installing CPU-only torch"
  "$PIP" install --index-url 'https://download.pytorch.org/whl/cpu' 'torch>=2.2,<3'
fi

"$PIP" install -r "$REQUIREMENTS_FILE"

echo "Whisper venv ready at $VENV_DIR"
