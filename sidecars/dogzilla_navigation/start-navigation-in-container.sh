#!/usr/bin/env bash
set -eo pipefail

REMOTE_ROOT="${REMOTE_ROOT:-/home/pi/robodoge}"
ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-16}"
POSE_PORT="${POSE_PORT:-8896}"
DOGZILLA_NAV2_MAP="${DOGZILLA_NAV2_MAP:-$REMOTE_ROOT/maps/robodoge_home.yaml}"
DOGZILLA_NAV2_BASE_PARAMS="${DOGZILLA_NAV2_BASE_PARAMS:-/opt/ros/humble/share/nav2_bringup/params/nav2_params.yaml}"
DOGZILLA_NAV2_PARAMS="${DOGZILLA_NAV2_PARAMS:-$REMOTE_ROOT/logs/robodoge_nav2_params.yaml}"
DOGZILLA_NAV2_LAUNCH="$REMOTE_ROOT/sidecars/dogzilla_navigation/robodoge_nav2_navigation_launch.py"
DOGZILLA_NAV2_ROBOT_RADIUS="${DOGZILLA_NAV2_ROBOT_RADIUS:-0.16}"
DOGZILLA_NAV2_FOOTPRINT_PADDING="${DOGZILLA_NAV2_FOOTPRINT_PADDING:-0.02}"
DOGZILLA_NAV2_INFLATION_RADIUS="${DOGZILLA_NAV2_INFLATION_RADIUS:-0.28}"
DOGZILLA_NAV2_COST_SCALING_FACTOR="${DOGZILLA_NAV2_COST_SCALING_FACTOR:-8.0}"
DOGZILLA_NAV2_OBSTACLE_MAX_RANGE="${DOGZILLA_NAV2_OBSTACLE_MAX_RANGE:-2.5}"
DOGZILLA_NAV2_RAYTRACE_MAX_RANGE="${DOGZILLA_NAV2_RAYTRACE_MAX_RANGE:-3.5}"
DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED="${DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED:-1}"
DOGZILLA_NAV2_GAIT_ADAPTER_URL="${DOGZILLA_NAV2_GAIT_ADAPTER_URL:-http://127.0.0.1:8893/nav2/cmd_vel}"
DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC="${DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC:-/cmd_vel}"
DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ="${DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ:-8.0}"
DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC="${DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC:-0.45}"
export ROS_DOMAIN_ID
export DOGZILLA_NAV2_ROBOT_RADIUS DOGZILLA_NAV2_FOOTPRINT_PADDING
export DOGZILLA_NAV2_INFLATION_RADIUS DOGZILLA_NAV2_COST_SCALING_FACTOR
export DOGZILLA_NAV2_OBSTACLE_MAX_RANGE DOGZILLA_NAV2_RAYTRACE_MAX_RANGE
export DOGZILLA_NAV2_GAIT_ADAPTER_URL DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC
export DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC

mkdir -p "$REMOTE_ROOT/logs"

# shellcheck disable=SC1091
source /opt/ros/humble/setup.bash
# shellcheck disable=SC1091
source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true

missing_packages=()
for pkg in nav2_bringup nav2_bt_navigator nav2_controller nav2_planner nav2_map_server nav2_lifecycle_manager; do
  if ! ros2 pkg prefix "$pkg" >/dev/null 2>&1; then
    missing_packages+=(ros-humble-navigation2 ros-humble-nav2-bringup)
    break
  fi
done

if [ "${#missing_packages[@]}" -gt 0 ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends "${missing_packages[@]}"
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
obstacle_max_range = env_float("DOGZILLA_NAV2_OBSTACLE_MAX_RANGE", 2.5)
raytrace_max_range = env_float("DOGZILLA_NAV2_RAYTRACE_MAX_RANGE", 3.5)


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
            layer["obstacle_max_range"] = obstacle_max_range
            layer["raytrace_max_range"] = raytrace_max_range

controller = params.setdefault("controller_server", {}).setdefault("ros__parameters", {})
controller["failure_tolerance"] = max(float(controller.get("failure_tolerance", 0.3) or 0.3), 0.3)
controller["controller_frequency"] = 10.0

bt_navigator = params.setdefault("bt_navigator", {}).setdefault("ros__parameters", {})
bt_navigator["bt_loop_duration"] = 50

planner = params.setdefault("planner_server", {}).setdefault("ros__parameters", {})
planner["expected_planner_frequency"] = 2.0

velocity_smoother = params.setdefault("velocity_smoother", {}).setdefault("ros__parameters", {})
velocity_smoother["smoothing_frequency"] = 10.0

os.makedirs(os.path.dirname(target_path), exist_ok=True)
with open(target_path, "w", encoding="utf-8") as handle:
    yaml.safe_dump(params, handle, sort_keys=False)

print(
    "Generated DOGZILLA Nav2 params: "
    f"robot_radius={robot_radius}, footprint_padding={footprint_padding}, "
    f"inflation_radius={inflation_radius}, cost_scaling_factor={cost_scaling_factor}, "
    f"obstacle_max_range={obstacle_max_range}, raytrace_max_range={raytrace_max_range}"
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

  nohup python3 "$REMOTE_ROOT/sidecars/dogzilla_navigation/cmd_vel_gait_adapter.py" \
    --input-topic "$DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC" \
    --bridge-url "$DOGZILLA_NAV2_GAIT_ADAPTER_URL" \
    --max-rate-hz "$DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ" \
    --stale-stop-sec "$DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC" \
    > "$REMOTE_ROOT/logs/cmd-vel-gait-adapter.log" 2>&1 &
else
  if ! ros2 topic info /cmd_vel 2>/dev/null | grep -q "Subscription count: [1-9]"; then
    pkill -f "[y]ahboom_base.*base" 2>/dev/null || true
    nohup ros2 run yahboom_base base > "$REMOTE_ROOT/logs/yahboom-base.log" 2>&1 &
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

odom_publisher_count() {
  ros2 topic info /odom 2>/dev/null | awk '/Publisher count:/ { print $3; found=1 } END { if (!found) print 0 }'
}

odom_publishers="$(odom_publisher_count)"
if [ "$odom_publishers" -gt 1 ] && pgrep -f "[t]f_odom_publisher.py" >/dev/null 2>&1; then
  echo "/odom has $odom_publishers publishers; restarting Robo-Doge TF odom helper to avoid duplicates." >&2
  pkill -f "[t]f_odom_publisher.py" 2>/dev/null || true
  sleep 2
fi

if ! ros2 topic info /odom 2>/dev/null | grep -q "Publisher count: [1-9]"; then
  echo "No /odom publisher is running. Checking for TF odom->base_link so Nav2 can receive TF-derived odometry." >&2
  tf_probe="$(timeout 8 ros2 run tf2_ros tf2_echo odom base_link 2>&1 || true)"
  if ! printf "%s" "$tf_probe" | grep -q "Translation:"; then
    echo "No usable TF odom->base_link transform is available. Nav2 can accept NavigateToPose goals without it, but DOGZILLA map waypoints are unsafe and can stall in recovery turns." >&2
    echo "$tf_probe" >&2
    echo "Start Yahboom localization/laser odometry first (for example the section-14 localization_imu_odom/rf2o path), then rerun navigation startup." >&2
    exit 2
  fi

  pkill -f "[t]f_odom_publisher.py" 2>/dev/null || true
  nohup python3 "$REMOTE_ROOT/sidecars/dogzilla_navigation/tf_odom_publisher.py" \
    --odom-frame odom \
    --base-frame base_link \
    --topic /odom \
    > "$REMOTE_ROOT/logs/tf-odom-publisher.log" 2>&1 &

  sleep 3
  if ! pgrep -f "[t]f_odom_publisher.py" >/dev/null 2>&1; then
    echo "TF-derived /odom publisher exited. See $REMOTE_ROOT/logs/tf-odom-publisher.log" >&2
    tail -80 "$REMOTE_ROOT/logs/tf-odom-publisher.log" >&2 || true
    exit 2
  fi

  if ! ros2 topic info /odom 2>/dev/null | grep -q "Publisher count: [1-9]"; then
    echo "TF-derived /odom publisher is running, but /odom discovery is not visible yet. Continuing; app readiness will wait before sending waypoints." >&2
  fi
fi

pkill -f "[r]obodoge_nav2_navigation_launch.py" 2>/dev/null || true
pkill -f "[l]ifecycle_manager_navigation" 2>/dev/null || true
pkill -f "[b]t_navigator" 2>/dev/null || true
pkill -f "[c]ontroller_server" 2>/dev/null || true
pkill -f "[p]lanner_server" 2>/dev/null || true
pkill -f "[b]ehavior_server" 2>/dev/null || true
pkill -f "[w]aypoint_follower" 2>/dev/null || true
pkill -f "[v]elocity_smoother" 2>/dev/null || true
pkill -f "[m]ap_server" 2>/dev/null || true

nohup ros2 launch "$DOGZILLA_NAV2_LAUNCH" \
  map:="$DOGZILLA_NAV2_MAP" \
  params_file:="$DOGZILLA_NAV2_PARAMS" \
  use_sim_time:=false \
  autostart:=true \
  use_respawn:=true \
  > "$REMOTE_ROOT/logs/nav2-navigation.log" 2>&1 &

nav_ready=0
for _ in $(seq 1 40); do
  if ros2 action list 2>/dev/null | grep -q "^/navigate_to_pose$"; then
    nav_ready=1
    break
  fi
  sleep 0.5
done

if [ "$nav_ready" != "1" ]; then
  echo "Nav2 NavigateToPose did not appear. Log tail:" >&2
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
