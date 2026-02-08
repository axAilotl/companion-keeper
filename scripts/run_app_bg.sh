#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_URL="http://127.0.0.1:7860"
UNIT_NAME="companion-keeper"
PYTHON_BIN="$ROOT_DIR/.venv/bin/python"

cd "$ROOT_DIR"

if systemctl --user is-active --quiet "$UNIT_NAME"; then
  echo "App already running (unit=$UNIT_NAME)"
  echo "URL: $APP_URL"
  exit 0
fi

if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python3 || command -v python)"
fi

systemctl --user stop "$UNIT_NAME" >/dev/null 2>&1 || true
systemctl --user reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true

systemd-run --user \
  --unit "$UNIT_NAME" \
  --property=WorkingDirectory="$ROOT_DIR" \
  --property=Restart=on-failure \
  --property=RestartSec=2 \
  --property=Environment=PYTHONUNBUFFERED=1 \
  "$PYTHON_BIN" -m toolkit.cli ui >/dev/null

sleep 1
if systemctl --user is-active --quiet "$UNIT_NAME"; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "$APP_URL/" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  echo "Started app in background (unit=$UNIT_NAME)"
  echo "URL: $APP_URL"
  echo "Logs: journalctl --user -u $UNIT_NAME -n 80 --no-pager"
else
  echo "Failed to start app."
  echo "Logs: journalctl --user -u $UNIT_NAME -n 120 --no-pager"
  exit 1
fi
