#!/usr/bin/env bash
set -euo pipefail

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required but not found in PATH."
  exit 1
fi

uv venv .venv
source .venv/bin/activate
uv pip install -r requirements.txt

echo "Environment ready."
echo "Activate with: source .venv/bin/activate"
