#!/usr/bin/env bash
set -euo pipefail

APP_URL="http://127.0.0.1:7860"
UNIT_NAME="companion-keeper"

if systemctl --user is-active --quiet "$UNIT_NAME"; then
  echo "RUNNING unit=$UNIT_NAME"
else
  echo "STOPPED unit=$UNIT_NAME"
fi

if command -v ss >/dev/null 2>&1; then
  ss -ltnp | rg ":7860" -N || true
fi

if command -v curl >/dev/null 2>&1; then
  if curl -fsS "$APP_URL/" >/dev/null 2>&1; then
    echo "HTTP OK $APP_URL"
  else
    echo "HTTP NOT READY $APP_URL"
  fi
fi

echo "Logs: journalctl --user -u $UNIT_NAME -n 60 --no-pager"
