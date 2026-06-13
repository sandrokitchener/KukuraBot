#!/usr/bin/env bash
set -eo pipefail

REMOTE_ROOT="${REMOTE_ROOT:-/home/pi/robodoge}"
POSE_PORT="${POSE_PORT:-8896}"
ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-16}"
DOGZILLA_MAP_POSE_MODE="${DOGZILLA_MAP_POSE_MODE:-auto}"
DOGZILLA_MAP_PBSTREAM="${DOGZILLA_MAP_PBSTREAM:-$REMOTE_ROOT/maps/robodoge_home.pbstream}"
export ROS_DOMAIN_ID

mkdir -p "$REMOTE_ROOT/maps" "$REMOTE_ROOT/logs"
cp "$REMOTE_ROOT/sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only.lua" "$REMOTE_ROOT/maps/robodoge_dogzilla_laser_only.lua"
cp "$REMOTE_ROOT/sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only_localization.lua" "$REMOTE_ROOT/maps/robodoge_dogzilla_laser_only_localization.lua"

# shellcheck disable=SC1091
source /opt/ros/humble/setup.bash
# shellcheck disable=SC1091
source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true

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
  apt-get update
  apt-get install -y --no-install-recommends curl ca-certificates gnupg >/dev/null
  curl -sSL https://raw.githubusercontent.com/ros/rosdistro/master/ros.key -o /usr/share/keyrings/ros-archive-keyring.gpg
  ubuntu_codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-${VERSION_CODENAME}}")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/ros-archive-keyring.gpg] http://packages.ros.org/ros2/ubuntu ${ubuntu_codename} main" > /etc/apt/sources.list.d/ros2.list
  apt-get update
  apt-get install -y --no-install-recommends "${missing_packages[@]}"
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
  *)
    echo "Unknown DOGZILLA_MAP_POSE_MODE=$DOGZILLA_MAP_POSE_MODE. Use auto, localization, or mapping." >&2
    exit 2
    ;;
esac

pkill -f "[c]artographer_node.*robodoge_dogzilla_laser_only" 2>/dev/null || true
pkill -f "[s]tatic_transform_publisher.*base_link laser_frame" 2>/dev/null || true

nohup ros2 run tf2_ros static_transform_publisher 0 0 0.18 0 0 0 base_link laser_frame > "$REMOTE_ROOT/logs/map-pose-static-tf.log" 2>&1 &

cartographer_args=(
  ros2 run cartographer_ros cartographer_node
  -configuration_directory "$REMOTE_ROOT/maps"
)
if [ "$mode" = "localization" ]; then
  cartographer_args+=(
    -configuration_basename robodoge_dogzilla_laser_only_localization.lua
    -load_state_filename "$DOGZILLA_MAP_PBSTREAM"
    -load_frozen_state true
  )
else
  cartographer_args+=(
    -configuration_basename robodoge_dogzilla_laser_only.lua
  )
fi
cartographer_args+=(
  --ros-args -p use_sim_time:=false -r scan:=/scan
)

printf '{"mode":"%s","pbstream":"%s","startedAt":"%s"}\n' "$mode" "$DOGZILLA_MAP_PBSTREAM" "$(date -Iseconds)" > "$REMOTE_ROOT/maps/robodoge_map_pose_mode.json"
nohup "${cartographer_args[@]}" > "$REMOTE_ROOT/logs/map-pose-cartographer.log" 2>&1 &

python3 - <<'PY'
import json
import os
import time
import urllib.request

url = f"http://127.0.0.1:{os.environ.get('POSE_PORT', '8896')}/pose"
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
            if (
                last.get("ok")
                and last.get("waypointSafe")
                and (last.get("mapPose") or {}).get("frame") == "map"
                and int(tf_publishers) > 0
            ):
                print(json.dumps({
                    "status": "ok",
                    "mapPose": last.get("mapPose"),
                    "tfPublishers": tf_publishers,
                    "waypointSafe": last.get("waypointSafe"),
                }, sort_keys=True))
                raise SystemExit(0)
    except Exception as error:
        last = {"error": str(error)}

print(json.dumps({"status": "error", "last": last}, sort_keys=True))
raise SystemExit(1)
PY
