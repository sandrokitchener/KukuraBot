#!/usr/bin/env bash
set -eo pipefail

REMOTE_ROOT="${REMOTE_ROOT:-/home/pi/robodoge}"
POSE_PORT="${POSE_PORT:-8896}"
ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-16}"
DOGZILLA_MAP_POSE_MODE="${DOGZILLA_MAP_POSE_MODE:-auto}"
DOGZILLA_MAP_METADATA="${DOGZILLA_MAP_METADATA:-$REMOTE_ROOT/maps/robodoge_home_map.json}"
DOGZILLA_MAP_PBSTREAM="${DOGZILLA_MAP_PBSTREAM:-}"
DOGZILLA_IMU_AVAILABLE="${DOGZILLA_IMU_AVAILABLE:-false}"
export ROS_DOMAIN_ID
export REMOTE_ROOT

mkdir -p "$REMOTE_ROOT/maps" "$REMOTE_ROOT/logs"

if command -v flock >/dev/null 2>&1; then
  exec 8>"$REMOTE_ROOT/logs/map-pose-startup.lock"
  if ! flock -w "${DOGZILLA_MAP_POSE_START_LOCK_TIMEOUT_SEC:-300}" 8; then
    echo "Timed out waiting for another DOGZILLA map-pose startup to finish." >&2
    exit 2
  fi
fi

cp "$REMOTE_ROOT/sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only.lua" "$REMOTE_ROOT/maps/robodoge_dogzilla_laser_only.lua"
cp "$REMOTE_ROOT/sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only_localization.lua" "$REMOTE_ROOT/maps/robodoge_dogzilla_laser_only_localization.lua"
cp "$REMOTE_ROOT/sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only_noimu.lua" "$REMOTE_ROOT/maps/robodoge_dogzilla_laser_only_noimu.lua"
cp "$REMOTE_ROOT/sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only_noimu_localization.lua" "$REMOTE_ROOT/maps/robodoge_dogzilla_laser_only_noimu_localization.lua"

# shellcheck disable=SC1091
source /opt/ros/humble/setup.bash
# shellcheck disable=SC1091
source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true

run_apt_get_once() {
  local lock_timeout="${DOGZILLA_APT_LOCK_TIMEOUT_SEC:-300}"
  if command -v flock >/dev/null 2>&1; then
    flock -w "$lock_timeout" /tmp/robodoge-apt.lock bash -c '
      dpkg --configure -a >/dev/null 2>&1 || true
      apt-get "$@"
    ' bash "$@"
    return $?
  fi

  dpkg --configure -a >/dev/null 2>&1 || true
  apt-get "$@"
}

run_apt_get() {
  local attempt=1
  local max_attempts="${DOGZILLA_APT_MAX_ATTEMPTS:-40}"
  local delay_sec="${DOGZILLA_APT_RETRY_DELAY_SEC:-3}"

  while true; do
    if run_apt_get_once "$@"; then
      return 0
    fi

    local status=$?
    if [ "$attempt" -ge "$max_attempts" ]; then
      return "$status"
    fi

    echo "apt-get $* failed (attempt $attempt/$max_attempts); waiting for apt/dpkg lock." >&2
    sleep "$delay_sec"
    attempt=$((attempt + 1))
  done
}

missing_packages=()
if ! ros2 pkg prefix cartographer_ros >/dev/null 2>&1; then
  missing_packages+=(ros-humble-cartographer-ros ros-humble-cartographer-ros-msgs)
fi
if ! python3 - <<'PY' >/dev/null 2>&1
from nav2_msgs.action import NavigateToPose  # noqa: F401
PY
then
  missing_packages+=(ros-humble-nav2-msgs)
fi

if [ "${#missing_packages[@]}" -gt 0 ]; then
  export DEBIAN_FRONTEND=noninteractive
  rm -f /etc/apt/sources.list.d/ros2.list 2>/dev/null || true
  run_apt_get update
  run_apt_get install -y --no-install-recommends curl ca-certificates gnupg >/dev/null
  curl -sSL https://raw.githubusercontent.com/ros/rosdistro/master/ros.key -o /usr/share/keyrings/ros-archive-keyring.gpg
  ubuntu_codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-${VERSION_CODENAME}}")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/ros-archive-keyring.gpg] http://packages.ros.org/ros2/ubuntu ${ubuntu_codename} main" > /etc/apt/sources.list.d/ros2.list
  run_apt_get update
  run_apt_get install -y --no-install-recommends "${missing_packages[@]}"
fi

if [ -z "$DOGZILLA_MAP_PBSTREAM" ] && [ -s "$DOGZILLA_MAP_METADATA" ]; then
  DOGZILLA_MAP_PBSTREAM="$(python3 - "$DOGZILLA_MAP_METADATA" <<'PY'
import json
import sys
from pathlib import Path

metadata_path = Path(sys.argv[1])
try:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
except Exception:
    raise SystemExit(0)

pbstream = str(metadata.get("pbstream") or "").strip()
if not pbstream:
    raise SystemExit(0)
path = Path(pbstream)
if not path.is_absolute():
    path = metadata_path.parent / path
print(path)
PY
)"
fi
DOGZILLA_MAP_PBSTREAM="${DOGZILLA_MAP_PBSTREAM:-$REMOTE_ROOT/maps/robodoge_home.pbstream}"

IMU_CONFIG=""
if [ "$DOGZILLA_IMU_AVAILABLE" = "auto" ]; then
  if python3 -c "import rclpy; rclpy.init(); rclpy.shutdown()" 2>/dev/null; then
    DOGZILLA_IMU_AVAILABLE="true"
  else
    DOGZILLA_IMU_AVAILABLE="false"
    echo "rclpy not available; IMU publisher disabled. Falling back to laser-only Cartographer config." >&2
  fi
fi

if [ "$DOGZILLA_IMU_AVAILABLE" = "true" ]; then
  if pgrep -f "[i]mu_publisher.py" >/dev/null 2>&1; then
    echo "DOGZILLA IMU publisher already running"
  else
    (
      exec 8>&- 2>/dev/null || true
      nohup python3 "$REMOTE_ROOT/sidecars/dogzilla_imu_publisher/imu_publisher.py" \
        > "$REMOTE_ROOT/logs/imu-publisher.log" 2>&1 &
      echo "$!" > "$REMOTE_ROOT/logs/imu-publisher.pid"
    )
    IMU_PID="$(cat "$REMOTE_ROOT/logs/imu-publisher.pid" 2>/dev/null || true)"
    echo "DOGZILLA IMU publisher started (PID $IMU_PID)"
    sleep 1
    if ! kill -0 "$IMU_PID" 2>/dev/null; then
      echo "IMU publisher exited immediately; falling back to laser-only config." >&2
      DOGZILLA_IMU_AVAILABLE="false"
    fi
  fi

  # Background IMU health monitor — restart if process dies
  (
    exec 8>&- 2>/dev/null || true
    nohup bash -c '
      while true; do
        sleep 30
        if ! pgrep -f "[i]mu_publisher.py" >/dev/null 2>&1; then
          echo "$(date -Iseconds) IMU publisher not running — restarting" >> "$REMOTE_ROOT/logs/imu-publisher.log"
          nohup python3 "$REMOTE_ROOT/sidecars/dogzilla_imu_publisher/imu_publisher.py" \
            >> "$REMOTE_ROOT/logs/imu-publisher.log" 2>&1 &
          echo "IMU publisher restarted with PID $!" >> "$REMOTE_ROOT/logs/imu-publisher.log"
        fi
      done
    ' > /dev/null 2>&1 &
  )
fi

if [ "$DOGZILLA_IMU_AVAILABLE" = "false" ]; then
  IMU_CONFIG="_noimu"
  echo "Using laser-only Cartographer config (no IMU)"
else
  IMU_CONFIG=""
  echo "Using standard Cartographer config (with IMU)"
fi

mode="$DOGZILLA_MAP_POSE_MODE"
case "$mode" in
  auto)
    if [ -s "$DOGZILLA_MAP_PBSTREAM" ]; then
      mode="localization"
    elif [ "${DOGZILLA_MAP_POSE_ALLOW_MAPPING:-0}" = "1" ]; then
      mode="mapping"
    else
      echo "No saved Cartographer map at $DOGZILLA_MAP_PBSTREAM. Refusing to start fresh mapping without DOGZILLA_MAP_POSE_MODE=mapping." >&2
      exit 2
    fi
    ;;
  localization)
    if [ ! -s "$DOGZILLA_MAP_PBSTREAM" ]; then
      echo "Saved Cartographer map missing: $DOGZILLA_MAP_PBSTREAM" >&2
      exit 2
    fi
    ;;
  mapping)
    ;;
  continue_mapping)
    if [ ! -s "$DOGZILLA_MAP_PBSTREAM" ]; then
      echo "Saved Cartographer map missing: $DOGZILLA_MAP_PBSTREAM. Cannot continue mapping without an existing pbstream." >&2
      exit 2
    fi
    ;;
  *)
    echo "Unknown DOGZILLA_MAP_POSE_MODE=$DOGZILLA_MAP_POSE_MODE. Use auto, localization, mapping, or continue_mapping." >&2
    exit 2
    ;;
esac

MODE_FILE="$REMOTE_ROOT/maps/robodoge_map_pose_mode.json"
SHOULD_RESTART=false

stop_existing_cartographer() {
  pkill -TERM -f "[c]artographer_node.*robodoge_dogzilla_laser_only" 2>/dev/null || true
  pkill -TERM -f "[c]artographer_occupancy_grid_node" 2>/dev/null || true
  pkill -TERM -f "[s]tatic_transform_publisher.*base_link laser_frame" 2>/dev/null || true

  for _ in $(seq 1 10); do
    if ! pgrep -f "[c]artographer_node.*robodoge_dogzilla_laser_only" >/dev/null 2>&1 \
      && ! pgrep -f "[c]artographer_occupancy_grid_node" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done

  pkill -KILL -f "[c]artographer_node.*robodoge_dogzilla_laser_only" 2>/dev/null || true
  pkill -KILL -f "[c]artographer_occupancy_grid_node" 2>/dev/null || true
}

if pgrep -f "[c]artographer_node.*robodoge_dogzilla_laser_only" >/dev/null 2>&1; then
  CURRENT_MODE="$(python3 -c "import json; print(json.load(open('$MODE_FILE')).get('mode',''))" 2>/dev/null || true)"
  CARTOGRAPHER_COUNT="$(pgrep -f "[c]artographer_node.*robodoge_dogzilla_laser_only" | wc -l | tr -d ' ')"
  if [ "$CURRENT_MODE" != "$mode" ]; then
    echo "Cartographer running in '${CURRENT_MODE:-unknown}' mode, '$mode' requested. Forcing restart." >&2
    SHOULD_RESTART=true
  elif [ "${CARTOGRAPHER_COUNT:-0}" -gt 1 ]; then
    echo "Cartographer has $CARTOGRAPHER_COUNT matching processes in '$mode' mode. Forcing clean restart." >&2
    SHOULD_RESTART=true
  else
    echo "Cartographer already running in '$mode' mode. Skipping restart." >&2
  fi
else
  SHOULD_RESTART=true
fi

if [ "$SHOULD_RESTART" = "true" ]; then
  stop_existing_cartographer

  (
    exec 8>&- 2>/dev/null || true
    nohup ros2 run tf2_ros static_transform_publisher 0 0 0.18 0 0 0 base_link laser_frame > "$REMOTE_ROOT/logs/map-pose-static-tf.log" 2>&1 &
  )

  cartographer_args=(
    ros2 run cartographer_ros cartographer_node
    -configuration_directory "$REMOTE_ROOT/maps"
  )
  if [ "$mode" = "localization" ]; then
    cartographer_args+=(
      -configuration_basename "robodoge_dogzilla_laser_only${IMU_CONFIG}_localization.lua"
      -load_state_filename "$DOGZILLA_MAP_PBSTREAM"
      -load_frozen_state true
    )
  elif [ "$mode" = "continue_mapping" ]; then
    cartographer_args+=(
      -configuration_basename "robodoge_dogzilla_laser_only${IMU_CONFIG}.lua"
      -load_state_filename "$DOGZILLA_MAP_PBSTREAM"
      -load_frozen_state false
    )
  else
    cartographer_args+=(
      -configuration_basename "robodoge_dogzilla_laser_only${IMU_CONFIG}.lua"
    )
  fi
  cartographer_args+=(
    --ros-args -p use_sim_time:=false -r scan:=/scan
  )

  printf '{"mode":"%s","pbstream":"%s","startedAt":"%s"}\n' "$mode" "$DOGZILLA_MAP_PBSTREAM" "$(date -Iseconds)" > "$MODE_FILE"
  (
    exec 8>&- 2>/dev/null || true
    nohup "${cartographer_args[@]}" > "$REMOTE_ROOT/logs/map-pose-cartographer.log" 2>&1 &
  )

  sleep 2
fi

if ! pgrep -f "[c]artographer_occupancy_grid_node" >/dev/null 2>&1; then
  (
    exec 8>&- 2>/dev/null || true
    nohup ros2 run cartographer_ros cartographer_occupancy_grid_node \
      -resolution "${DOGZILLA_MAP_POSE_RESOLUTION:-0.05}" \
      -publish_period_sec "${DOGZILLA_MAP_POSE_PUBLISH_PERIOD:-2.0}" \
      --ros-args -r /map:=/map_cartographer \
      > "$REMOTE_ROOT/logs/map-occupancy-grid.log" 2>&1 &
  )
fi

python3 - <<'PY'
import json
import os
import time
import urllib.request

url = f"http://127.0.0.1:{os.environ.get('POSE_PORT', '8896')}/pose"
started_at = time.time()
last = None
for _ in range(24):
    time.sleep(0.75)
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            last = json.loads(response.read().decode("utf-8"))
            tf_publishers = (
                last.get("rosGraph", {})
                .get("topics", {})
                .get("/tf", {})
                .get("publisherCount", 0)
            )
            map_pose = last.get("mapPose") or {}
            received_at = float(map_pose.get("receivedAt") or last.get("receivedAt") or 0.0)
            age_sec = float(map_pose.get("ageSec") or last.get("ageSec") or 999.0)
            if (
                last.get("ok")
                and last.get("waypointSafe")
                and map_pose.get("frame") == "map"
                and received_at >= started_at - 1.0
                and age_sec <= 2.0
                and int(tf_publishers) > 0
            ):
                print(json.dumps({
                    "status": "ok",
                    "mapPose": map_pose,
                    "tfPublishers": tf_publishers,
                    "waypointSafe": last.get("waypointSafe"),
                }, sort_keys=True))
                raise SystemExit(0)
    except Exception as error:
        last = {"error": str(error)}

print(json.dumps({"status": "error", "last": last}, sort_keys=True))
raise SystemExit(1)
PY
