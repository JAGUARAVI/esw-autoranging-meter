#!/usr/bin/env bash
# Launch the ESWCap web dashboard. Creates the uv venv on first run.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "[run.sh] creating venv with uv (python 3.13)…"
  uv venv .venv --python 3.13
  uv pip install --python .venv -r requirements.txt
fi

exec .venv/bin/python server.py "$@"