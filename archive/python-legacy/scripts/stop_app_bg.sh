#!/usr/bin/env bash
set -euo pipefail

UNIT_NAME="gptdataexport-app"

if systemctl --user is-active --quiet "$UNIT_NAME"; then
  systemctl --user stop "$UNIT_NAME"
  echo "Stopped app (unit=$UNIT_NAME)"
else
  echo "App is not running (unit=$UNIT_NAME)"
fi
systemctl --user reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true
