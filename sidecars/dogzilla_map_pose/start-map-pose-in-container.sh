#!/usr/bin/env bash
set -eo pipefail

REMOTE_ROOT="${REMOTE_ROOT:-/home/pi/robodoge}"
POSE_PORT="${POSE_PORT:-9090}"
ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-16}"
DOGZILLA_MAP_POSE_MODE="${DOGZILLA_MAP_POSE_MODE:-auto}"
DOGZILLA_MAP_POSE_OCCUPANCY_GRID="${DOGZILLA_MAP_POSE_OCCUPANCY_GRID:-auto}"
DOGZILLA_MAP_POSE_SKIP_RELOCALIZATION="${DOGZILLA_MAP_POSE_SKIP_RELOCALIZATION:-0}"
DOGZILLA_MAP_METADATA="${DOGZILLA_MAP_METADATA:-$REMOTE_ROOT/maps/robodoge_home_map.json}"
DOGZILLA_MAP_PBSTREAM="${DOGZILLA_MAP_PBSTREAM:-}"
DOGZILLA_IMU_AVAILABLE="${DOGZILLA_IMU_AVAILABLE:-false}"
export ROS_DOMAIN_ID
export REMOTE_ROOT

mkdir -p "$REMOTE_ROOT/maps" "$REMOTE_ROOT/logs"

# A systemd fallback may need to start the long-lived container without also
# running the caller's explicit relocalization transaction. The SSH launcher
# drops this one-shot marker before starting systemd.
SKIP_RELOCALIZATION_MARKER="$REMOTE_ROOT/maps/robodoge_map_pose_skip_relocalization"
READY_MARKER="$REMOTE_ROOT/maps/robodoge_map_pose_ready"
rm -f "$READY_MARKER"
if [ -f "$SKIP_RELOCALIZATION_MARKER" ]; then
  DOGZILLA_MAP_POSE_SKIP_RELOCALIZATION=1
  rm -f "$SKIP_RELOCALIZATION_MARKER"
fi

# Kill stale ROS2 daemon early; a stuck daemon can make topic/action probes hang.
pkill -9 -f "ros2.*daemon" 2>/dev/null || true

if command -v flock >/dev/null 2>&1; then
  exec 8>"$REMOTE_ROOT/logs/map-pose-startup.lock"
  if ! flock -w "${DOGZILLA_MAP_POSE_START_LOCK_TIMEOUT_SEC:-300}" 8; then
    echo "Timed out waiting for another DOGZILLA map-pose startup to finish." >&2
    exit 2
  fi
fi

# Wait for the rosbridge websocket server to be ready before doing anything.
# This prevents "No such container" errors and apt-before-network races
# when systemd starts this service before the container is fully up.
POSE_HOST="${DOGZILLA_POSE_HOST:-127.0.0.1}"
POSE_PORT="${POSE_PORT:-9090}"
for _ in $(seq 1 30); do
  if python3 - "$POSE_HOST" "$POSE_PORT" <<'PY' >/dev/null 2>&1
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(1)
try:
    s.connect((sys.argv[1], int(sys.argv[2])))
    s.close()
    raise SystemExit(0)
except Exception:
    raise SystemExit(1)
PY
  then
    break
  fi
  sleep 1
done

cp "$REMOTE_ROOT/sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only.lua" "$REMOTE_ROOT/maps/robodoge_dogzilla_laser_only.lua"
cp "$REMOTE_ROOT/sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only_localization.lua" "$REMOTE_ROOT/maps/robodoge_dogzilla_laser_only_localization.lua"
cp "$REMOTE_ROOT/sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only_localization_recovery.lua" "$REMOTE_ROOT/maps/robodoge_dogzilla_laser_only_localization_recovery.lua"
cp "$REMOTE_ROOT/sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only_noimu.lua" "$REMOTE_ROOT/maps/robodoge_dogzilla_laser_only_noimu.lua"
cp "$REMOTE_ROOT/sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only_noimu_localization.lua" "$REMOTE_ROOT/maps/robodoge_dogzilla_laser_only_noimu_localization.lua"
cp "$REMOTE_ROOT/sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only_noimu_localization_recovery.lua" "$REMOTE_ROOT/maps/robodoge_dogzilla_laser_only_noimu_localization_recovery.lua"

# shellcheck disable=SC1091
source /opt/ros/humble/setup.bash
# shellcheck disable=SC1091
source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true

missing_packages=()
if ! ros2 pkg prefix cartographer_ros >/dev/null 2>&1; then
  missing_packages+=(cartographer_ros)
fi
if ! python3 - <<'PY' >/dev/null 2>&1
from nav2_msgs.action import NavigateToPose # noqa: F401
PY
then
  missing_packages+=(nav2_msgs)
fi

if [ "${#missing_packages[@]}" -gt 0 ]; then
  echo "Required map-pose/SLAM ROS packages missing in Pi-owned runtime: ${missing_packages[*]}." >&2
  echo "Refusing startup-time install. Rebuild/deploy the pre-baked DOGZILLA ROS image or run an explicit operator setup step." >&2
  exit 2
fi

if [ "$DOGZILLA_MAP_POSE_MODE" != "mapping" ]; then
  requested_pbstream="$DOGZILLA_MAP_PBSTREAM"
  if ! manifest_pbstream="$(python3 - "$DOGZILLA_MAP_METADATA" "$REMOTE_ROOT/sidecars/dogzilla_lib_bridge" <<'PY'
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[2])
from map_metadata import read_active_map_metadata

metadata = read_active_map_metadata(Path(sys.argv[1]))
if metadata.get("available") is not True:
    print(
        f"Active map validation failed: {metadata.get('error') or 'unknown_error'}",
        file=sys.stderr,
    )
    raise SystemExit(1)
pbstream = str(metadata.get("pbstream") or "").strip()
if not pbstream:
    print("Active map validation failed: verified pbstream missing", file=sys.stderr)
    raise SystemExit(1)
print(pbstream)
PY
)"; then
    echo "Active map manifest missing, invalid, or overridden: $DOGZILLA_MAP_METADATA" >&2
    exit 2
  fi
  if [ -n "$requested_pbstream" ] && [ "$requested_pbstream" != "$manifest_pbstream" ]; then
    echo "Active map manifest missing, invalid, or overridden: $DOGZILLA_MAP_METADATA" >&2
    exit 2
  fi
  DOGZILLA_MAP_PBSTREAM="$manifest_pbstream"
fi

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

case "$DOGZILLA_MAP_POSE_OCCUPANCY_GRID" in
  auto|"")
    if [ "$mode" = "mapping" ] || [ "$mode" = "continue_mapping" ]; then
      START_OCCUPANCY_GRID=true
    else
      START_OCCUPANCY_GRID=false
    fi
    ;;
  1|true|TRUE|yes|YES|on|ON)
    START_OCCUPANCY_GRID=true
    ;;
  0|false|FALSE|no|NO|off|OFF)
    START_OCCUPANCY_GRID=false
    ;;
  *)
    echo "Unknown DOGZILLA_MAP_POSE_OCCUPANCY_GRID=$DOGZILLA_MAP_POSE_OCCUPANCY_GRID. Use auto, true, or false." >&2
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

if [ "$mode" = "continue_mapping" ]; then
  # The relocalizer owns the localization-to-mapping handoff. Keep the current
  # localization process alive until frozen-map matching succeeds.
  SHOULD_RESTART=false
elif [ "${DOGZILLA_FORCE_RESTART:-0}" = "1" ]; then
  echo "DOGZILLA_FORCE_RESTART=1 requested; forcing Cartographer restart." >&2
  SHOULD_RESTART=true
elif pgrep -f "[c]artographer_node.*robodoge_dogzilla_laser_only" >/dev/null 2>&1; then
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
  if [ "$mode" = "localization" ] && [ "$DOGZILLA_MAP_POSE_SKIP_RELOCALIZATION" != "1" ]; then
    rm -f "$REMOTE_ROOT/maps/robodoge_localization_status.json"
  fi

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

if [ "$mode" = "continue_mapping" ]; then
  if ! pgrep -f "[s]tatic_transform_publisher.*base_link laser_frame" >/dev/null 2>&1; then
    (
      exec 8>&- 2>/dev/null || true
      nohup ros2 run tf2_ros static_transform_publisher 0 0 0.18 0 0 0 base_link laser_frame > "$REMOTE_ROOT/logs/map-pose-static-tf.log" 2>&1 &
    )
    sleep 1
  fi
  recovery_args=(
    python3 "$REMOTE_ROOT/sidecars/dogzilla_map_pose/relocalize_on_frozen_map.py"
    --remote-root "$REMOTE_ROOT"
    --normal-config "robodoge_dogzilla_laser_only${IMU_CONFIG}_localization.lua"
    --handoff-config "robodoge_dogzilla_laser_only${IMU_CONFIG}.lua"
  )
  if [ "${DOGZILLA_NAV2_PROVEN_INACTIVE:-0}" = "1" ]; then
    recovery_args+=(--no-pause-nav2)
  fi
  if "${recovery_args[@]}"; then
    printf '{"mode":"%s","pbstream":"%s","startedAt":"%s"}\n' "$mode" "$DOGZILLA_MAP_PBSTREAM" "$(date -Iseconds)" > "$MODE_FILE"
    echo "Continue mapping anchored at the globally recovered current pose" >&2
  else
    echo "Continue mapping could not prove and preserve the robot pose; normal localization was restored." >&2
    exit 3
  fi
elif [ "$mode" = "localization" ] && [ "$DOGZILLA_MAP_POSE_SKIP_RELOCALIZATION" != "1" ]; then
  recovery_args=(
    python3 "$REMOTE_ROOT/sidecars/dogzilla_map_pose/relocalize_on_frozen_map.py"
    --remote-root "$REMOTE_ROOT"
  )
  recovery_args+=(--no-pause-nav2)
  if "${recovery_args[@]}"; then
    echo "Cartographer global relocalization proved against the frozen map." >&2
  else
    echo "Cartographer global relocalization was not proved; navigation remains blocked." >&2
  fi
fi

if [ "$START_OCCUPANCY_GRID" = "true" ]; then
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
else
  pkill -TERM -f "[c]artographer_occupancy_grid_node" 2>/dev/null || true
fi

if ! python3 - <<'PY'
import json
import math
import time

import rclpy
from rclpy.node import Node
from tf2_ros import Buffer, TransformListener

rclpy.init(args=None)
node = Node("robodoge_map_pose_ready_check")
tf_buffer = Buffer(cache_time=rclpy.duration.Duration(seconds=5.0))
TransformListener(tf_buffer, node)

last = None
for _ in range(40):
    time.sleep(0.75)
    rclpy.spin_once(node, timeout_sec=0.1)
    try:
        transform = tf_buffer.lookup_transform("map", "base_link", rclpy.time.Time())
        translation = transform.transform.translation
        rotation = transform.transform.rotation
        yaw = math.atan2(2.0 * (rotation.w * rotation.z + rotation.x * rotation.y),
                         1.0 - 2.0 * (rotation.y * rotation.y + rotation.z * rotation.z))
        map_pose = {
            "frame": "map",
            "x": translation.x,
            "y": translation.y,
            "yaw": yaw,
            "receivedAt": time.time(),
            "ageSec": 0.0,
        }
        print(json.dumps({
            "status": "ok",
            "mapPose": map_pose,
            "tfPublishers": 1,
            "waypointSafe": True,
        }, sort_keys=True))
        node.destroy_node()
        rclpy.shutdown()
        raise SystemExit(0)
    except Exception as error:
        last = {"error": str(error)}

node.destroy_node()
rclpy.shutdown()
print(json.dumps({"status": "error", "last": last}, sort_keys=True))
raise SystemExit(1)
PY
then
  echo "Map-pose TF not ready after startup probe; refusing to publish the ready marker." >&2
  rm -f "$READY_MARKER"
  exit 4
fi

touch "$READY_MARKER"
echo "Map-pose startup complete; monitoring Cartographer..."
while pgrep -f "[c]artographer_node" >/dev/null 2>&1; do
  sleep 2
done
echo "Cartographer process not found; exiting so systemd can restart." >&2
pkill -9 -f "ros2.*daemon" 2>/dev/null || true
exit 1
