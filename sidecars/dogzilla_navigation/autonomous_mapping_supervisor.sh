#!/usr/bin/env bash
set -u

REMOTE_ROOT="${REMOTE_ROOT:-/home/pi/robodoge}"
ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-16}"
ROS_CONTAINER="${ROS_CONTAINER:-robodoge-rosbridge}"
STATUS_FILE="$REMOTE_ROOT/maps/autonomous-mapping-status.json"
STOP_FILE="$REMOTE_ROOT/maps/autonomous-mapping.stop"
FINISH_FILE="$REMOTE_ROOT/maps/autonomous-mapping.finish"
RESULT_FILE="$REMOTE_ROOT/maps/autonomous-mapping-result.json"
READY_FILE="$REMOTE_ROOT/maps/autonomous-mapping.ready"
ACTIVE_FILE="$REMOTE_ROOT/maps/autonomous-mapping.active"
EXPLORER="$REMOTE_ROOT/sidecars/dogzilla_navigation/frontier_explorer.py"
MAPPING_NAV2_READY_TIMEOUT_SEC="${DOGZILLA_MAPPING_NAV2_READY_TIMEOUT_SEC:-120}"
MAPPING_ROTATION_TIMEOUT_SEC="${DOGZILLA_MAPPING_ROTATION_TIMEOUT_SEC:-8}"
MAPPING_SCAN_PAUSE_SEC="${DOGZILLA_MAPPING_SCAN_PAUSE_SEC:-2}"
MAPPING_SCAN_TIMEOUT_SEC="${DOGZILLA_MAPPING_SCAN_TIMEOUT_SEC:-120}"
MAPPING_MIN_TRANSLATION_COMMAND_SEC="${DOGZILLA_MAPPING_MIN_TRANSLATION_COMMAND_SEC:-1.0}"
MAPPING_FORWARD_SPEED="${DOGZILLA_MAPPING_FORWARD_SPEED:-0.18}"
MAPPING_TURN_SPEED="${DOGZILLA_MAPPING_TURN_SPEED:-0.75}"
MAPPING_BACKUP_SPEED="${DOGZILLA_MAPPING_BACKUP_SPEED:-0.08}"
MAPPING_BACKUP_DURATION="${DOGZILLA_MAPPING_BACKUP_DURATION:-1.5}"
MAPPING_STOP_DISTANCE="${DOGZILLA_MAPPING_STOP_DISTANCE:-0.55}"
MAPPING_CLEAR_DISTANCE="${DOGZILLA_MAPPING_CLEAR_DISTANCE:-0.75}"
MAPPING_NO_GROWTH_TIMEOUT="${DOGZILLA_MAPPING_NO_GROWTH_TIMEOUT:-60}"
MAPPING_MAX_SESSION_DURATION="${DOGZILLA_MAPPING_MAX_SESSION_DURATION:-600}"
MAPPING_MAP_GROWTH_CELLS="${DOGZILLA_MAPPING_MAP_GROWTH_CELLS:-20}"

write_result() {
  python3 - "$1" "${2:-}" "${3:-}" <<'PY'
import json
import sys
from pathlib import Path

path = Path("/home/pi/robodoge/maps/autonomous-mapping-result.json")
if len(sys.argv) > 1 and sys.argv[1]:
    path = Path(sys.argv[1])
payload = {
    "state": sys.argv[2] if len(sys.argv) > 2 else "failed",
    "detail": sys.argv[3] if len(sys.argv) > 3 else "",
}
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(payload) + "\n", encoding="utf-8")
PY
}

stop_mapping_nav2() {
  docker exec -e REMOTE_ROOT="$REMOTE_ROOT" "$ROS_CONTAINER" bash \
    "$REMOTE_ROOT/sidecars/dogzilla_navigation/stop-navigation-owner-in-container.sh" mapping \
    >/dev/null 2>&1
}

restore_localization() {
  stop_mapping_nav2
  docker rm -f robodoge-map-pose >/dev/null 2>&1 || true
  systemctl reset-failed robodoge-map-pose.service robodoge-navigation.service >/dev/null 2>&1 || true
  systemctl restart robodoge-map-pose.service >/dev/null 2>&1 || return 1
  systemctl restart robodoge-navigation.service >/dev/null 2>&1 || return 1
  return 0
}

save_candidate() {
  docker exec \
    -e REMOTE_ROOT="$REMOTE_ROOT" \
    -e ROS_DOMAIN_ID="$ROS_DOMAIN_ID" \
    -e DOGZILLA_MAP_SAVE_CANDIDATE=1 \
    robodoge-map-pose bash "$REMOTE_ROOT/sidecars/dogzilla_map_pose/save-map-pose-in-container.sh" \
    >"$REMOTE_ROOT/logs/autonomous-mapping-save.log" 2>&1
}

battery_watchdog() {
  python3 - "$STOP_FILE" "$FINISH_FILE" <<'PY'
import json
import sys
import time
import urllib.request
from pathlib import Path

stop_file = Path(sys.argv[1])
finish_file = Path(sys.argv[2])
while not stop_file.exists():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8893/healthz-lite", timeout=3) as response:
            safety = (json.load(response).get("batterySafety") or {})
        value = float(safety["value"])
        warning = float(safety["warningPercent"])
        if safety.get("motionAllowed") is False or value <= warning:
            finish_file.touch()
            stop_file.touch()
            break
    except (KeyError, TypeError, ValueError, OSError, json.JSONDecodeError):
        pass
    time.sleep(2)
PY
}

wait_for_mapping_motion_stack() {
  docker exec \
    -e REMOTE_ROOT="$REMOTE_ROOT" \
    -e ROS_DOMAIN_ID="$ROS_DOMAIN_ID" \
    "$ROS_CONTAINER" bash "$REMOTE_ROOT/sidecars/dogzilla_navigation/wait-nav2-ready.sh" \
      "$ROS_DOMAIN_ID" \
      "$REMOTE_ROOT" \
      auto \
      "$MAPPING_NAV2_READY_TIMEOUT_SEC" \
      1 \
      cartographer \
      once \
      "http://127.0.0.1:8893/nav2/cmd_vel/health" \
      20 \
      mapping \
    >"$REMOTE_ROOT/logs/autonomous-mapping-nav2-ready.log" 2>&1
}

active_map_has_verified_pbstream() {
  python3 - "$REMOTE_ROOT/maps/robodoge_home_map.json" <<'PY' >/dev/null 2>&1
import hashlib
import json
import sys
from pathlib import Path

metadata_path = Path(sys.argv[1])
metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
artifact = (metadata.get("artifacts") or {}).get("pbstream") or {}
value = str(artifact.get("path") or metadata.get("pbstream") or "").strip()
expected = str(artifact.get("sha256") or "").strip()
path = Path(value)
if not path.is_absolute():
    path = metadata_path.parent / path
raise SystemExit(0 if value and len(expected) == 64 and path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == expected else 1)
PY
}

on_signal() {
  touch "$STOP_FILE"
  docker exec "$ROS_CONTAINER" bash -lc 'pkill -TERM -f "[f]rontier_explorer.py" 2>/dev/null || true' >/dev/null 2>&1 || true
  if restore_localization; then
    write_result "$RESULT_FILE" restored "mapping_supervisor_interrupted"
  else
    stop_mapping_nav2
    write_result "$RESULT_FILE" failed "mapping_supervisor_interrupted_restore_failed"
  fi
  exit 143
}

trap on_signal TERM INT
trap 'rm -f "$ACTIVE_FILE"' EXIT

rm -f "$STOP_FILE" "$FINISH_FILE" "$RESULT_FILE"
mkdir -p "$REMOTE_ROOT/maps" "$REMOTE_ROOT/logs"
printf '%s\n' "$$" > "$ACTIVE_FILE"

for _ in $(seq 1 180); do
  if [ -f "$STOP_FILE" ]; then
    if restore_localization; then
      write_result "$RESULT_FILE" restored "mapping_start_cancelled"
      exit 0
    fi
    write_result "$RESULT_FILE" failed "mapping_start_cancelled_restore_failed"
    exit 1
  fi
  [ -f "$READY_FILE" ] && break
  sleep 1
done
if [ ! -f "$READY_FILE" ]; then
  if restore_localization; then
    write_result "$RESULT_FILE" restored "mapping_start_not_ready"
  else
    write_result "$RESULT_FILE" failed "mapping_start_not_ready_restore_failed"
  fi
  exit 1
fi

if ! wait_for_mapping_motion_stack; then
  if restore_localization; then
    write_result "$RESULT_FILE" failed "mapping_motion_stack_not_ready; no_motion_sent"
  else
    stop_mapping_nav2
    write_result "$RESULT_FILE" failed "mapping_motion_stack_not_ready_restore_failed; no_motion_sent"
  fi
  exit 1
fi

set +e
battery_watchdog &
battery_watchdog_pid=$!
docker exec \
  -e REMOTE_ROOT="$REMOTE_ROOT" \
  -e ROS_DOMAIN_ID="$ROS_DOMAIN_ID" \
  "$ROS_CONTAINER" bash -lc \
  "source /opt/ros/humble/setup.bash; source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true; exec python3 -u '$EXPLORER' --status-file '$STATUS_FILE' --stop-file '$STOP_FILE' --lock-file '$REMOTE_ROOT/maps/autonomous-mapping.lock' --map-timeout 15 --scan-pause-after '$MAPPING_SCAN_PAUSE_SEC' --scan-timeout '$MAPPING_SCAN_TIMEOUT_SEC' --pose-timeout 20 --rotation-timeout '$MAPPING_ROTATION_TIMEOUT_SEC' --forward-speed '$MAPPING_FORWARD_SPEED' --turn-speed '$MAPPING_TURN_SPEED' --backup-speed '$MAPPING_BACKUP_SPEED' --backup-duration '$MAPPING_BACKUP_DURATION' --stop-distance '$MAPPING_STOP_DISTANCE' --clear-distance '$MAPPING_CLEAR_DISTANCE' --map-growth-cells '$MAPPING_MAP_GROWTH_CELLS' --no-growth-timeout '$MAPPING_NO_GROWTH_TIMEOUT' --max-session-duration '$MAPPING_MAX_SESSION_DURATION'" \
  >"$REMOTE_ROOT/logs/frontier-explorer.log" 2>&1
explorer_exit=$?
kill "$battery_watchdog_pid" >/dev/null 2>&1 || true
wait "$battery_watchdog_pid" 2>/dev/null || true
cp "$REMOTE_ROOT/logs/nav2-navigation.log" "$REMOTE_ROOT/logs/autonomous-mapping-nav2-last.log" 2>/dev/null || true
set -e

finish_requested=false
[ -f "$FINISH_FILE" ] && finish_requested=true
explorer_state=""
if [ -s "$STATUS_FILE" ]; then
  explorer_state="$(python3 - "$STATUS_FILE" <<'PY'
import json
import sys
try:
    print(json.load(open(sys.argv[1], encoding="utf-8")).get("state", ""))
except Exception:
    print("")
PY
)"
fi

motion_proven=false
if [ -s "$STATUS_FILE" ]; then
  motion_proven="$(python3 - "$STATUS_FILE" "$MAPPING_MIN_TRANSLATION_COMMAND_SEC" <<'PY'
import json
import sys
try:
    status = json.load(open(sys.argv[1], encoding="utf-8"))
    displacement = float(status.get("sessionMaxGoalDisplacement") or 0.0)
    translation_command_sec = float(status.get("sessionTranslationCommandSec") or 0.0)
except Exception:
    displacement = 0.0
    translation_command_sec = 0.0
print(
    "true"
    if displacement >= 0.05 and translation_command_sec >= float(sys.argv[2])
    else "false"
)
PY
)"
fi

candidate_saved=false
if [ "$motion_proven" = true ] && { [ "$finish_requested" = true ] || [ "$explorer_exit" -eq 0 ]; }; then
  if save_candidate; then
    candidate_saved=true
  fi
fi

if [ "$candidate_saved" = true ] && ! active_map_has_verified_pbstream; then
  stop_mapping_nav2
  docker rm -f robodoge-map-pose >/dev/null 2>&1 || true
  write_result "$RESULT_FILE" candidate-ready "active_map_has_no_verified_pbstream; promote_candidate_to_resume_navigation explorer=$explorer_state exit=$explorer_exit"
elif restore_localization; then
  if [ "$motion_proven" != true ]; then
    write_result "$RESULT_FILE" failed "explorer=$explorer_state exit=$explorer_exit candidate=false no_verified_motion"
  else
    write_result "$RESULT_FILE" restored "explorer=$explorer_state exit=$explorer_exit candidate=$candidate_saved"
  fi
else
  stop_mapping_nav2
  write_result "$RESULT_FILE" failed "localization_restore_failed explorer=$explorer_state exit=$explorer_exit candidate=$candidate_saved"
  exit 1
fi
