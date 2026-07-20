#!/bin/bash
# Report who holds the shared Nav2 runtime lock without changing that owner.
set -euo pipefail

REMOTE_ROOT="${REMOTE_ROOT:-/home/pi/robodoge}"
LOCK_FILE="${DOGZILLA_NAV2_LOCK_FILE:-$REMOTE_ROOT/logs/navigation-runtime.lock}"
OWNER_FILE="${DOGZILLA_NAV2_OWNER_FILE:-$REMOTE_ROOT/logs/navigation-runtime.owner}"

mkdir -p "$(dirname "$LOCK_FILE")"
if flock -n "$LOCK_FILE" -c true; then
  echo "free"
  exit 0
fi

owner_mode=""
if [ -s "$OWNER_FILE" ]; then
  owner_mode="$(sed -n 's/^mode=//p' "$OWNER_FILE" | head -1)"
fi
if [ "$owner_mode" = "mapping" ]; then
  echo "mapping"
  exit 42
fi
if [ "$owner_mode" = "normal" ]; then
  echo "normal"
  exit 0
fi
echo "unknown"
exit 43
