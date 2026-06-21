#!/usr/bin/env bash
set -eo pipefail

REMOTE_ROOT="${REMOTE_ROOT:-/home/pi/robodoge}"
ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-16}"
POSE_PORT="${POSE_PORT:-8896}"
DOGZILLA_MAP_METADATA="${DOGZILLA_MAP_METADATA:-$REMOTE_ROOT/maps/robodoge_home_map.json}"
DOGZILLA_NAV2_MAP="${DOGZILLA_NAV2_MAP:-}"
DOGZILLA_NAV2_BASE_PARAMS="${DOGZILLA_NAV2_BASE_PARAMS:-/opt/ros/humble/share/nav2_bringup/params/nav2_params.yaml}"
DOGZILLA_NAV2_PARAMS="${DOGZILLA_NAV2_PARAMS:-$REMOTE_ROOT/logs/robodoge_nav2_params.yaml}"
DOGZILLA_NAV2_LAUNCH="$REMOTE_ROOT/sidecars/dogzilla_navigation/robodoge_nav2_navigation_launch.py"
DOGZILLA_NAV2_ROBOT_RADIUS="${DOGZILLA_NAV2_ROBOT_RADIUS:-0.16}"
DOGZILLA_NAV2_FOOTPRINT_PADDING="${DOGZILLA_NAV2_FOOTPRINT_PADDING:-0.02}"
DOGZILLA_NAV2_INFLATION_RADIUS="${DOGZILLA_NAV2_INFLATION_RADIUS:-0.28}"
DOGZILLA_NAV2_COST_SCALING_FACTOR="${DOGZILLA_NAV2_COST_SCALING_FACTOR:-8.0}"
DOGZILLA_NAV2_OBSTACLE_MIN_RANGE="${DOGZILLA_NAV2_OBSTACLE_MIN_RANGE:-0.24}"
DOGZILLA_NAV2_OBSTACLE_MAX_RANGE="${DOGZILLA_NAV2_OBSTACLE_MAX_RANGE:-2.5}"
DOGZILLA_NAV2_RAYTRACE_MAX_RANGE="${DOGZILLA_NAV2_RAYTRACE_MAX_RANGE:-3.5}"
DOGZILLA_NAV2_YAW_GOAL_TOLERANCE="${DOGZILLA_NAV2_YAW_GOAL_TOLERANCE:-6.283185307179586}"
DOGZILLA_NAV2_XY_GOAL_TOLERANCE="${DOGZILLA_NAV2_XY_GOAL_TOLERANCE:-0.25}"
DOGZILLA_NAV2_CONTROLLER_FREQUENCY="${DOGZILLA_NAV2_CONTROLLER_FREQUENCY:-5.0}"
DOGZILLA_NAV2_BT_LOOP_DURATION_MS="${DOGZILLA_NAV2_BT_LOOP_DURATION_MS:-200}"
DOGZILLA_NAV2_BT_SERVER_TIMEOUT_MS="${DOGZILLA_NAV2_BT_SERVER_TIMEOUT_MS:-10000}"
DOGZILLA_NAV2_BT_WAIT_FOR_SERVICE_TIMEOUT_MS="${DOGZILLA_NAV2_BT_WAIT_FOR_SERVICE_TIMEOUT_MS:-5000}"
DOGZILLA_NAV2_PLANNER_FREQUENCY="${DOGZILLA_NAV2_PLANNER_FREQUENCY:-1.0}"
DOGZILLA_NAV2_SMOOTHER_FREQUENCY="${DOGZILLA_NAV2_SMOOTHER_FREQUENCY:-5.0}"
DOGZILLA_NAV2_REQUIRED_MOVEMENT_RADIUS="${DOGZILLA_NAV2_REQUIRED_MOVEMENT_RADIUS:-0.08}"
DOGZILLA_NAV2_MOVEMENT_TIME_ALLOWANCE="${DOGZILLA_NAV2_MOVEMENT_TIME_ALLOWANCE:-45.0}"
DOGZILLA_NAV2_FAILURE_TOLERANCE="${DOGZILLA_NAV2_FAILURE_TOLERANCE:-5.0}"
DOGZILLA_NAV2_MIN_SPEED_XY="${DOGZILLA_NAV2_MIN_SPEED_XY:-0.03}"
DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY="${DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY:-0.05}"
DOGZILLA_NAV2_SCAN_FILTER_ENABLED="${DOGZILLA_NAV2_SCAN_FILTER_ENABLED:-1}"
DOGZILLA_NAV2_SCAN_FILTER_TOPIC="${DOGZILLA_NAV2_SCAN_FILTER_TOPIC:-/scan_nav2}"
DOGZILLA_NAV2_SCAN_FILTER_MASK_START_DEG="${DOGZILLA_NAV2_SCAN_FILTER_MASK_START_DEG:-120}"
DOGZILLA_NAV2_SCAN_FILTER_MASK_END_DEG="${DOGZILLA_NAV2_SCAN_FILTER_MASK_END_DEG:-260}"
DOGZILLA_NAV2_SCAN_FILTER_MASK_RANGE_M="${DOGZILLA_NAV2_SCAN_FILTER_MASK_RANGE_M:-0.45}"
DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED="${DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED:-1}"
DOGZILLA_NAV2_GAIT_ADAPTER_URL="${DOGZILLA_NAV2_GAIT_ADAPTER_URL:-http://127.0.0.1:8893/nav2/cmd_vel}"
DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC="${DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC:-/cmd_vel}"
DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ="${DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ:-8.0}"
DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC="${DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC:-0.45}"
DOGZILLA_NAV2_GAIT_ADAPTER_HTTP_TIMEOUT_SEC="${DOGZILLA_NAV2_GAIT_ADAPTER_HTTP_TIMEOUT_SEC:-0.8}"
DOGZILLA_NAV2_SPEED_RAMP_INTERVAL="${DOGZILLA_NAV2_SPEED_RAMP_INTERVAL:-0.5}"
DOGZILLA_NAV2_SPEED_RAMP_BUFFER="${DOGZILLA_NAV2_SPEED_RAMP_BUFFER:-10}"
export ROS_DOMAIN_ID
export DOGZILLA_NAV2_ROBOT_RADIUS DOGZILLA_NAV2_FOOTPRINT_PADDING
export DOGZILLA_NAV2_INFLATION_RADIUS DOGZILLA_NAV2_COST_SCALING_FACTOR
export DOGZILLA_NAV2_OBSTACLE_MIN_RANGE DOGZILLA_NAV2_OBSTACLE_MAX_RANGE DOGZILLA_NAV2_RAYTRACE_MAX_RANGE
export DOGZILLA_NAV2_YAW_GOAL_TOLERANCE DOGZILLA_NAV2_XY_GOAL_TOLERANCE
export DOGZILLA_NAV2_CONTROLLER_FREQUENCY DOGZILLA_NAV2_BT_LOOP_DURATION_MS
export DOGZILLA_NAV2_BT_SERVER_TIMEOUT_MS DOGZILLA_NAV2_BT_WAIT_FOR_SERVICE_TIMEOUT_MS
export DOGZILLA_NAV2_PLANNER_FREQUENCY DOGZILLA_NAV2_SMOOTHER_FREQUENCY
export DOGZILLA_NAV2_REQUIRED_MOVEMENT_RADIUS DOGZILLA_NAV2_MOVEMENT_TIME_ALLOWANCE
export DOGZILLA_NAV2_FAILURE_TOLERANCE
export DOGZILLA_NAV2_MIN_SPEED_XY DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY
export DOGZILLA_NAV2_SCAN_FILTER_ENABLED DOGZILLA_NAV2_SCAN_FILTER_TOPIC
export DOGZILLA_NAV2_GAIT_ADAPTER_URL DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC
export DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC DOGZILLA_NAV2_GAIT_ADAPTER_HTTP_TIMEOUT_SEC
export DOGZILLA_NAV2_SPEED_RAMP_INTERVAL DOGZILLA_NAV2_SPEED_RAMP_BUFFER
export REMOTE_ROOT

mkdir -p "$REMOTE_ROOT/logs"

if command -v flock >/dev/null 2>&1; then
  exec 8>"$REMOTE_ROOT/logs/nav2-startup.lock"
  if ! flock -w "${DOGZILLA_NAV2_START_LOCK_TIMEOUT_SEC:-300}" 8; then
    echo "Timed out waiting for another DOGZILLA Nav2 startup to finish." >&2
    exit 2
  fi
fi

if [ -z "$DOGZILLA_NAV2_MAP" ] && [ -s "$DOGZILLA_MAP_METADATA" ]; then
  DOGZILLA_NAV2_MAP="$(python3 - "$DOGZILLA_MAP_METADATA" <<'PY'
import json
import sys
from pathlib import Path

metadata_path = Path(sys.argv[1])
try:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
except Exception:
    raise SystemExit(0)

yaml_path = str(metadata.get("yaml") or "").strip()
if not yaml_path:
    raise SystemExit(0)
path = Path(yaml_path)
if not path.is_absolute():
    path = metadata_path.parent / path
print(path)
PY
)"
fi
DOGZILLA_NAV2_MAP="${DOGZILLA_NAV2_MAP:-$REMOTE_ROOT/maps/robodoge_home.yaml}"

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
for pkg in nav2_bringup nav2_bt_navigator nav2_controller nav2_planner nav2_map_server nav2_lifecycle_manager; do
  if ! ros2 pkg prefix "$pkg" >/dev/null 2>&1; then
    missing_packages+=(ros-humble-navigation2 ros-humble-nav2-bringup ros-humble-nav2-msgs)
    break
  fi
done

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

if [ ! -s "$DOGZILLA_NAV2_BASE_PARAMS" ]; then
  echo "Nav2 base params missing: $DOGZILLA_NAV2_BASE_PARAMS" >&2
  exit 2
fi

python3 - "$DOGZILLA_NAV2_BASE_PARAMS" "$DOGZILLA_NAV2_PARAMS" <<'PY'
import os
import sys

try:
    import yaml
except Exception as error:
    print(f"PyYAML unavailable; cannot generate DOGZILLA Nav2 params: {error}", file=sys.stderr)
    raise SystemExit(2)

source_path, target_path = sys.argv[1:3]


def env_float(name, default):
    try:
        value = float(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return value if value > 0 else default


with open(source_path, "r", encoding="utf-8") as handle:
    params = yaml.safe_load(handle) or {}

robot_radius = env_float("DOGZILLA_NAV2_ROBOT_RADIUS", 0.16)
footprint_padding = env_float("DOGZILLA_NAV2_FOOTPRINT_PADDING", 0.02)
inflation_radius = env_float("DOGZILLA_NAV2_INFLATION_RADIUS", 0.28)
cost_scaling_factor = env_float("DOGZILLA_NAV2_COST_SCALING_FACTOR", 8.0)
obstacle_min_range = env_float("DOGZILLA_NAV2_OBSTACLE_MIN_RANGE", 0.24)
obstacle_max_range = env_float("DOGZILLA_NAV2_OBSTACLE_MAX_RANGE", 2.5)
raytrace_max_range = env_float("DOGZILLA_NAV2_RAYTRACE_MAX_RANGE", 3.5)
yaw_goal_tolerance = env_float("DOGZILLA_NAV2_YAW_GOAL_TOLERANCE", 6.283185307179586)
xy_goal_tolerance = env_float("DOGZILLA_NAV2_XY_GOAL_TOLERANCE", 0.25)
controller_frequency = env_float("DOGZILLA_NAV2_CONTROLLER_FREQUENCY", 3.0)
bt_loop_duration_ms = int(env_float("DOGZILLA_NAV2_BT_LOOP_DURATION_MS", 500.0))
bt_server_timeout_ms = int(env_float("DOGZILLA_NAV2_BT_SERVER_TIMEOUT_MS", 10000.0))
bt_wait_for_service_timeout_ms = int(env_float("DOGZILLA_NAV2_BT_WAIT_FOR_SERVICE_TIMEOUT_MS", 5000.0))
planner_frequency = env_float("DOGZILLA_NAV2_PLANNER_FREQUENCY", 1.0)
smoother_frequency = env_float("DOGZILLA_NAV2_SMOOTHER_FREQUENCY", 2.0)
required_movement_radius = env_float("DOGZILLA_NAV2_REQUIRED_MOVEMENT_RADIUS", 0.08)
movement_time_allowance = env_float("DOGZILLA_NAV2_MOVEMENT_TIME_ALLOWANCE", 45.0)
failure_tolerance = env_float("DOGZILLA_NAV2_FAILURE_TOLERANCE", 5.0)
min_speed_xy = env_float("DOGZILLA_NAV2_MIN_SPEED_XY", 0.03)
trans_stopped_velocity = env_float("DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY", 0.05)
scan_topic = os.environ.get("DOGZILLA_NAV2_SCAN_FILTER_TOPIC", "/scan_nav2")
scan_filter_enabled = os.environ.get("DOGZILLA_NAV2_SCAN_FILTER_ENABLED", "1") == "1"


def costmap_ros_params(name):
    section = params.setdefault(name, {})
    nested = section.setdefault(name, {})
    return nested.setdefault("ros__parameters", {})


for costmap_name in ("local_costmap", "global_costmap"):
    ros_params = costmap_ros_params(costmap_name)
    ros_params["robot_radius"] = robot_radius
    ros_params["footprint_padding"] = footprint_padding

    inflation = ros_params.get("inflation_layer")
    if isinstance(inflation, dict):
        inflation["inflation_radius"] = inflation_radius
        inflation["cost_scaling_factor"] = cost_scaling_factor

    for layer_name in ("obstacle_layer", "voxel_layer"):
        layer = ros_params.get(layer_name)
        if isinstance(layer, dict):
            layer["obstacle_min_range"] = obstacle_min_range
            layer["obstacle_max_range"] = obstacle_max_range
            layer["raytrace_min_range"] = obstacle_min_range
            layer["raytrace_max_range"] = raytrace_max_range
            if scan_filter_enabled:
                for source_name in str(layer.get("observation_sources", "")).split():
                    source = layer.get(source_name)
                    if isinstance(source, dict) and source.get("topic") == "/scan":
                        source["topic"] = scan_topic
                    if isinstance(source, dict):
                        source["obstacle_min_range"] = obstacle_min_range
                        source["obstacle_max_range"] = obstacle_max_range
                        source["raytrace_min_range"] = obstacle_min_range
                        source["raytrace_max_range"] = raytrace_max_range
                        if scan_filter_enabled and str(source.get("data_type", "")).lower() == "laserscan":
                            source["inf_is_valid"] = True

controller = params.setdefault("controller_server", {}).setdefault("ros__parameters", {})
controller["failure_tolerance"] = max(float(controller.get("failure_tolerance", 0.3) or 0.3), failure_tolerance)
controller["controller_frequency"] = controller_frequency
controller.setdefault("goal_checker_plugins", ["general_goal_checker"])
progress_checker = controller.setdefault("progress_checker", {})
progress_checker.setdefault("plugin", "nav2_controller::SimpleProgressChecker")
progress_checker["required_movement_radius"] = required_movement_radius
progress_checker["movement_time_allowance"] = movement_time_allowance
goal_checker = controller.setdefault("general_goal_checker", {})
goal_checker.setdefault("plugin", "nav2_controller::SimpleGoalChecker")
goal_checker["yaw_goal_tolerance"] = yaw_goal_tolerance
goal_checker["xy_goal_tolerance"] = xy_goal_tolerance

follow_path = controller.get("FollowPath")
if isinstance(follow_path, dict):
    follow_path["min_speed_xy"] = min_speed_xy
    follow_path["trans_stopped_velocity"] = trans_stopped_velocity

bt_navigator = params.setdefault("bt_navigator", {}).setdefault("ros__parameters", {})
bt_navigator["bt_loop_duration"] = bt_loop_duration_ms
bt_navigator["default_server_timeout"] = bt_server_timeout_ms
bt_navigator["wait_for_service_timeout"] = bt_wait_for_service_timeout_ms

planner = params.setdefault("planner_server", {}).setdefault("ros__parameters", {})
planner["expected_planner_frequency"] = planner_frequency

velocity_smoother = params.setdefault("velocity_smoother", {}).setdefault("ros__parameters", {})
velocity_smoother["smoothing_frequency"] = smoother_frequency

os.makedirs(os.path.dirname(target_path), exist_ok=True)
with open(target_path, "w", encoding="utf-8") as handle:
    yaml.safe_dump(params, handle, sort_keys=False)

print(
    "Generated DOGZILLA Nav2 params: "
    f"robot_radius={robot_radius}, footprint_padding={footprint_padding}, "
    f"inflation_radius={inflation_radius}, cost_scaling_factor={cost_scaling_factor}, "
    f"obstacle_min_range={obstacle_min_range}, obstacle_max_range={obstacle_max_range}, "
    f"raytrace_max_range={raytrace_max_range}, "
    f"yaw_goal_tolerance={yaw_goal_tolerance}, xy_goal_tolerance={xy_goal_tolerance}, "
    f"controller_frequency={controller_frequency} Hz, "
    f"bt_loop_duration_ms={bt_loop_duration_ms}, "
    f"bt_server_timeout_ms={bt_server_timeout_ms}, "
    f"required_movement_radius={required_movement_radius}, "
    f"movement_time_allowance={movement_time_allowance}, "
    f"failure_tolerance={failure_tolerance}, "
    f"min_speed_xy={min_speed_xy}, "
    f"trans_stopped_velocity={trans_stopped_velocity}, "
    f"scan_topic={scan_topic if scan_filter_enabled else '/scan'}, "
    f"scan_inf_is_valid={scan_filter_enabled}"
)
PY

if [ ! -s "$DOGZILLA_NAV2_MAP" ]; then
  echo "Nav2 map yaml missing: $DOGZILLA_NAV2_MAP" >&2
  exit 2
fi

map_image="$(python3 - "$DOGZILLA_NAV2_MAP" <<'PY'
import os
import sys

yaml_path = sys.argv[1]
image = ""
with open(yaml_path, "r", encoding="utf-8") as handle:
    for line in handle:
        if line.strip().startswith("image:"):
            image = line.split(":", 1)[1].strip()
            break

if image and not os.path.isabs(image):
    image = os.path.join(os.path.dirname(yaml_path), image)
print(image)
PY
)"
if [ -n "$map_image" ] && [ ! -s "$map_image" ]; then
  echo "Nav2 map image missing: $map_image" >&2
  exit 2
fi

python3 - <<'PY'
import json
import os
import sys
import urllib.request

url = f"http://127.0.0.1:{os.environ.get('POSE_PORT', '8896')}/pose"
try:
    with urllib.request.urlopen(url, timeout=3) as response:
        pose = json.loads(response.read().decode("utf-8"))
except Exception as error:
    print(f"Map pose bridge unavailable: {error}", file=sys.stderr)
    raise SystemExit(2)

if not pose.get("ok") or not pose.get("waypointSafe"):
    print(f"Map pose not waypoint-safe: {json.dumps(pose, sort_keys=True)[:1000]}", file=sys.stderr)
    raise SystemExit(2)
PY

if [ "$DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED" = "1" ]; then
  pkill -f "[c]md_vel_gait_adapter.py" 2>/dev/null || true
  pkill -f "[y]ahboom_base.*base" 2>/dev/null || true

  python3 - <<'PY'
import json
import os
import sys
import urllib.request

url = os.environ.get("DOGZILLA_NAV2_GAIT_ADAPTER_URL", "http://127.0.0.1:8893/nav2/cmd_vel")
zero = json.dumps({
    "linear": {"x": 0.0, "y": 0.0, "z": 0.0},
    "angular": {"x": 0.0, "y": 0.0, "z": 0.0},
    "source": "startup-probe",
}).encode("utf-8")
request = urllib.request.Request(
    url,
    data=zero,
    headers={"Content-Type": "application/json; charset=utf-8"},
    method="POST",
)
try:
    with urllib.request.urlopen(request, timeout=3) as response:
        payload = json.loads(response.read().decode("utf-8"))
except Exception as error:
    print(f"DOGZILLA gait adapter zero-command probe failed at {url}: {error}. Restart/sync the DOGZILLA Direct Bridge first.", file=sys.stderr)
    raise SystemExit(2)

if "result" not in payload:
    print(f"DOGZILLA gait adapter endpoint returned unexpected payload: {json.dumps(payload, sort_keys=True)[:1000]}", file=sys.stderr)
    raise SystemExit(2)
PY

  (
    exec 8>&- 2>/dev/null || true
    nohup python3 "$REMOTE_ROOT/sidecars/dogzilla_navigation/cmd_vel_gait_adapter.py" \
      --input-topic "$DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC" \
      --bridge-url "$DOGZILLA_NAV2_GAIT_ADAPTER_URL" \
      --max-rate-hz "$DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ" \
      --stale-stop-sec "$DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC" \
      --http-timeout-sec "$DOGZILLA_NAV2_GAIT_ADAPTER_HTTP_TIMEOUT_SEC" \
      --speed-ramp-interval "$DOGZILLA_NAV2_SPEED_RAMP_INTERVAL" \
      --speed-ramp-buffer "$DOGZILLA_NAV2_SPEED_RAMP_BUFFER" \
      > "$REMOTE_ROOT/logs/cmd-vel-gait-adapter.log" 2>&1 &
  )
else
  if ! ros2 topic info /cmd_vel 2>/dev/null | grep -q "Subscription count: [1-9]"; then
    pkill -f "[y]ahboom_base.*base" 2>/dev/null || true
    (
      exec 8>&- 2>/dev/null || true
      nohup ros2 run yahboom_base base > "$REMOTE_ROOT/logs/yahboom-base.log" 2>&1 &
    )
  fi
fi

for _ in $(seq 1 60); do
  if ros2 topic info /cmd_vel 2>/dev/null | grep -q "Subscription count: [1-9]"; then
    break
  fi
  sleep 0.5
done

if ! ros2 topic info /cmd_vel 2>/dev/null | grep -q "Subscription count: [1-9]"; then
  if [ "$DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED" = "1" ]; then
    echo "DOGZILLA cmd_vel gait adapter did not subscribe to /cmd_vel. See $REMOTE_ROOT/logs/cmd-vel-gait-adapter.log" >&2
  else
    echo "Yahboom base did not subscribe to /cmd_vel. See $REMOTE_ROOT/logs/yahboom-base.log" >&2
  fi
  exit 2
fi

if [ "$DOGZILLA_NAV2_SCAN_FILTER_ENABLED" = "1" ]; then
  pkill -f "[s]can_self_filter.py" 2>/dev/null || true
  (
    exec 8>&- 2>/dev/null || true
    nohup python3 "$REMOTE_ROOT/sidecars/dogzilla_navigation/scan_self_filter.py" \
      --input-topic /scan \
      --output-topic "$DOGZILLA_NAV2_SCAN_FILTER_TOPIC" \
      --mask-start-deg "$DOGZILLA_NAV2_SCAN_FILTER_MASK_START_DEG" \
      --mask-end-deg "$DOGZILLA_NAV2_SCAN_FILTER_MASK_END_DEG" \
      --mask-range-m "$DOGZILLA_NAV2_SCAN_FILTER_MASK_RANGE_M" \
      > "$REMOTE_ROOT/logs/scan-self-filter.log" 2>&1 &
  )

  for _ in $(seq 1 30); do
    if ros2 topic info "$DOGZILLA_NAV2_SCAN_FILTER_TOPIC" 2>/dev/null | grep -q "Publisher count: [1-9]"; then
      break
    fi
    sleep 0.5
  done
fi

odom_publisher_count() {
  ros2 topic info /odom 2>/dev/null | awk '/Publisher count:/ { print $3; found=1 } END { if (!found) print 0 }'
}

odom_has_live_sample() {
  timeout --kill-after=2 6 python3 - <<'PY' >/tmp/robodoge-odom-sample.txt 2>/tmp/robodoge-odom-sample.err
import json
import time

import rclpy
from nav_msgs.msg import Odometry

sample = {}


def on_message(message):
    global sample
    sample = {
        "frame_id": message.header.frame_id,
        "child_frame_id": message.child_frame_id,
        "stamp": {
            "sec": int(message.header.stamp.sec),
            "nanosec": int(message.header.stamp.nanosec),
        },
    }


rclpy.init()
node = rclpy.create_node("robodoge_odom_startup_probe")
subscription = node.create_subscription(Odometry, "/odom", on_message, 10)
deadline = time.monotonic() + 4.0
try:
    while not sample and time.monotonic() < deadline:
        rclpy.spin_once(node, timeout_sec=0.1)
    if sample:
        print(json.dumps(sample, sort_keys=True))
        raise SystemExit(0)
    print("No Odometry sample received on /odom before timeout")
    raise SystemExit(1)
finally:
    node.destroy_subscription(subscription)
    node.destroy_node()
    if rclpy.ok():
        rclpy.shutdown()
PY
}

wait_for_odom_sample() {
  local attempts="${1:-12}"
  local delay_sec="${2:-1}"
  for _ in $(seq 1 "$attempts"); do
    if odom_has_live_sample; then
      return 0
    fi
    sleep "$delay_sec"
  done
  return 1
}

probe_odom_tf() {
  local base_frame
  for base_frame in base_link base_footprint; do
    timeout 5 ros2 run tf2_ros tf2_echo odom "$base_frame" > /tmp/robodoge-odom-tf-probe.txt 2>&1 || true
    if grep -q "Translation:" /tmp/robodoge-odom-tf-probe.txt; then
      echo "$base_frame"
      return 0
    fi
  done
  return 1
}

wait_for_odom_tf() {
  local tf_target
  local attempts="${1:-12}"
  local delay_sec="${2:-2}"
  for _ in $(seq 1 "$attempts"); do
    if tf_target="$(probe_odom_tf)"; then
      echo "$tf_target"
      return 0
    fi
    sleep "$delay_sec"
  done
  return 1
}

start_tf_odom_helper() {
  local base_frame="${1:-base_link}"
  pkill -f "[t]f_odom_publisher.py" 2>/dev/null || true
  sleep 1
  (
    exec 8>&- 2>/dev/null || true
    nohup python3 "$REMOTE_ROOT/sidecars/dogzilla_navigation/tf_odom_publisher.py" \
      --odom-frame odom \
      --base-frame "$base_frame" \
      --topic /odom \
      > "$REMOTE_ROOT/logs/tf-odom-publisher.log" 2>&1 &
  )
}

start_map_pose_localization() {
  local map_pose_script="$REMOTE_ROOT/sidecars/dogzilla_map_pose/start-map-pose-in-container.sh"
  if [ ! -s "$map_pose_script" ]; then
    echo "DOGZILLA map-pose startup script is not present at $map_pose_script." >&2
    return 1
  fi

  echo "Starting DOGZILLA Cartographer map-pose localization to provide odom->base TF." >&2
  REMOTE_ROOT="$REMOTE_ROOT" \
    POSE_PORT="$POSE_PORT" \
    ROS_DOMAIN_ID="$ROS_DOMAIN_ID" \
    DOGZILLA_MAP_POSE_MODE="${DOGZILLA_MAP_POSE_MODE:-auto}" \
    bash "$map_pose_script" >&2
}

ensure_odom_tf() {
  local tf_target
  if tf_target="$(wait_for_odom_tf 2 1)"; then
    echo "$tf_target"
    return 0
  fi

  echo "No usable TF odom->base_link/base_footprint transform is available. Nav2 can accept NavigateToPose goals without it, but DOGZILLA map waypoints are unsafe and can stall in recovery turns." >&2
  cat /tmp/robodoge-odom-tf-probe.txt >&2 2>/dev/null || true

  if start_map_pose_localization; then
    if tf_target="$(wait_for_odom_tf 30 2)"; then
      echo "$tf_target"
      return 0
    fi
    echo "Cartographer map-pose startup ran, but odom->base_link/base_footprint TF still did not become available." >&2
    cat /tmp/robodoge-odom-tf-probe.txt >&2 2>/dev/null || true
  fi

  echo "Start Yahboom localization/laser odometry first (for example the section-14 localization_imu_odom/rf2o path), then rerun navigation startup." >&2
  exit 2
}

odom_publishers="$(odom_publisher_count)"
if [ "$odom_publishers" -gt 1 ] && pgrep -f "[t]f_odom_publisher.py" >/dev/null 2>&1; then
  echo "/odom has $odom_publishers publishers; restarting Robo-Doge TF odom helper to avoid duplicates." >&2
  pkill -f "[t]f_odom_publisher.py" 2>/dev/null || true
  sleep 2
fi

odom_publishers="$(odom_publisher_count)"
if [ "$odom_publishers" -gt 0 ] && ! odom_has_live_sample; then
  echo "/odom has $odom_publishers publisher(s), but no live Odometry sample arrived. Treating the publisher as stale." >&2
  cat /tmp/robodoge-odom-sample.err >&2 2>/dev/null || true
  if pgrep -f "[t]f_odom_publisher.py" >/dev/null 2>&1; then
    echo "Repo-owned TF odom helper is running; waiting for discovery before restart." >&2
    if wait_for_odom_sample 20 1; then
      echo "Live /odom sample arrived; keeping the existing TF odom helper." >&2
    else
      echo "Repo-owned TF odom helper did not emit during startup probe; keeping it running and letting app readiness wait." >&2
    fi
  fi

  if ! odom_has_live_sample && ! pgrep -f "[t]f_odom_publisher.py" >/dev/null 2>&1; then
    tf_target="$(ensure_odom_tf)"
    start_tf_odom_helper "$tf_target"
    wait_for_odom_sample 20 1 || true
  fi
fi

if ! ros2 topic info /odom 2>/dev/null | grep -q "Publisher count: [1-9]"; then
  echo "No /odom publisher is running. Checking for TF odom->base_link so Nav2 can receive TF-derived odometry." >&2
  tf_target="$(ensure_odom_tf)"

  start_tf_odom_helper "$tf_target"

  wait_for_odom_sample 20 1 || true
  if ! pgrep -f "[t]f_odom_publisher.py" >/dev/null 2>&1; then
    echo "TF-derived /odom publisher exited. See $REMOTE_ROOT/logs/tf-odom-publisher.log" >&2
    tail -80 "$REMOTE_ROOT/logs/tf-odom-publisher.log" >&2 || true
    exit 2
  fi

  if ! ros2 topic info /odom 2>/dev/null | grep -q "Publisher count: [1-9]"; then
    echo "TF-derived /odom publisher is running, but /odom discovery is not visible yet. Continuing; app readiness will wait before sending waypoints." >&2
  fi
fi

if ! odom_has_live_sample; then
  if pgrep -f "[t]f_odom_publisher.py" >/dev/null 2>&1; then
    echo "/odom is advertised, but no live Odometry sample arrived during startup. Continuing; app readiness will block waypoint dispatch until /odom is live." >&2
  else
    echo "/odom is advertised, but no live Odometry sample arrived. Nav2 waypoint startup is blocked because controller progress feedback would be unsafe." >&2
    cat /tmp/robodoge-odom-sample.err >&2 2>/dev/null || true
    tail -80 "$REMOTE_ROOT/logs/tf-odom-publisher.log" >&2 2>/dev/null || true
    exit 2
  fi
fi

if odom_has_live_sample; then
  ensure_odom_tf >/dev/null
else
  cat /tmp/robodoge-odom-sample.err >&2 2>/dev/null || true
  tail -80 "$REMOTE_ROOT/logs/tf-odom-publisher.log" >&2 2>/dev/null || true
fi

pkill -f "[r]obodoge_nav2_navigation_launch.py" 2>/dev/null || true
pkill -f "[l]ifecycle_manager_navigation" 2>/dev/null || true
pkill -f "[b]t_navigator" 2>/dev/null || true
pkill -f "[c]ontroller_server" 2>/dev/null || true
pkill -f "[s]moother_server" 2>/dev/null || true
pkill -f "[p]lanner_server" 2>/dev/null || true
pkill -f "[b]ehavior_server" 2>/dev/null || true
pkill -f "[w]aypoint_follower" 2>/dev/null || true
pkill -f "[v]elocity_smoother" 2>/dev/null || true
pkill -f "[m]ap_server" 2>/dev/null || true

(
  exec 8>&- 2>/dev/null || true
  nohup ros2 launch "$DOGZILLA_NAV2_LAUNCH" \
    map:="$DOGZILLA_NAV2_MAP" \
    params_file:="$DOGZILLA_NAV2_PARAMS" \
    use_sim_time:=false \
    autostart:=true \
    use_respawn:=true \
    > "$REMOTE_ROOT/logs/nav2-navigation.log" 2>&1 &
)

nav_ready=0
for _ in $(seq 1 120); do
  if ros2 action list 2>/dev/null | grep -q "^/navigate_to_pose$" \
    && grep -q "Managed nodes are active" "$REMOTE_ROOT/logs/nav2-navigation.log" 2>/dev/null; then
    nav_ready=1
    break
  fi
  sleep 1
done

if [ "$nav_ready" != "1" ]; then
  echo "Nav2 NavigateToPose did not become fully active. Log tail:" >&2
  tail -120 "$REMOTE_ROOT/logs/nav2-navigation.log" >&2 || true
  exit 1
fi

python3 - <<'PY'
import json
import subprocess

def run(args):
    return subprocess.run(args, capture_output=True, text=True, check=False).stdout.strip()

print(json.dumps({
    "ok": True,
    "actionList": run(["ros2", "action", "list", "-t"]).splitlines(),
    "cmdVel": run(["ros2", "topic", "info", "/cmd_vel"]),
    "map": run(["ros2", "topic", "info", "/map"]),
}, sort_keys=True))
PY
