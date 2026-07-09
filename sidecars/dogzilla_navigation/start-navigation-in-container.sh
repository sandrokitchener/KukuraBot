#!/usr/bin/env bash
set -eo pipefail

REMOTE_ROOT="${REMOTE_ROOT:-/home/pi/robodoge}"
ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-16}"
POSE_PORT="${POSE_PORT:-9090}"
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
DOGZILLA_LOCALIZATION_BACKEND="${DOGZILLA_LOCALIZATION_BACKEND:-amcl}"
DOGZILLA_INITIAL_POSE_X="${DOGZILLA_INITIAL_POSE_X:-}"
DOGZILLA_INITIAL_POSE_Y="${DOGZILLA_INITIAL_POSE_Y:-}"
DOGZILLA_INITIAL_POSE_YAW="${DOGZILLA_INITIAL_POSE_YAW:-}"

if [ "${DOGZILLA_NAV2_GAIT_SMOOTHER_BYPASS:-0}" = "1" ]; then
  DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC="/cmd_vel_nav"
fi

export ROS_DOMAIN_ID
export DOGZILLA_NAV2_MAP_METADATA DOGZILLA_NAV2_MAP DOGZILLA_NAV2_BASE_PARAMS DOGZILLA_NAV2_PARAMS
export DOGZILLA_NAV2_ROBOT_RADIUS DOGZILLA_NAV2_FOOTPRINT_PADDING DOGZILLA_NAV2_INFLATION_RADIUS
export DOGZILLA_NAV2_COST_SCALING_FACTOR DOGZILLA_NAV2_OBSTACLE_MIN_RANGE DOGZILLA_NAV2_OBSTACLE_MAX_RANGE
export DOGZILLA_NAV2_RAYTRACE_MAX_RANGE DOGZILLA_NAV2_YAW_GOAL_TOLERANCE DOGZILLA_NAV2_XY_GOAL_TOLERANCE
export DOGZILLA_NAV2_CONTROLLER_FREQUENCY DOGZILLA_NAV2_BT_LOOP_DURATION_MS DOGZILLA_NAV2_BT_SERVER_TIMEOUT_MS
export DOGZILLA_NAV2_BT_WAIT_FOR_SERVICE_TIMEOUT_MS DOGZILLA_NAV2_PLANNER_FREQUENCY DOGZILLA_NAV2_SMOOTHER_FREQUENCY
export DOGZILLA_NAV2_REQUIRED_MOVEMENT_RADIUS DOGZILLA_NAV2_MOVEMENT_TIME_ALLOWANCE DOGZILLA_NAV2_FAILURE_TOLERANCE
export DOGZILLA_NAV2_MIN_SPEED_XY DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY
export DOGZILLA_NAV2_SCAN_FILTER_ENABLED DOGZILLA_NAV2_SCAN_FILTER_TOPIC
export DOGZILLA_NAV2_SCAN_FILTER_MASK_START_DEG DOGZILLA_NAV2_SCAN_FILTER_MASK_END_DEG DOGZILLA_NAV2_SCAN_FILTER_MASK_RANGE_M
export DOGZILLA_NAV2_GAIT_ADAPTER_URL DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC
export DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC DOGZILLA_NAV2_GAIT_ADAPTER_HTTP_TIMEOUT_SEC
export DOGZILLA_NAV2_SPEED_RAMP_INTERVAL DOGZILLA_NAV2_SPEED_RAMP_BUFFER
export DOGZILLA_LOCALIZATION_BACKEND DOGZILLA_INITIAL_POSE_X DOGZILLA_INITIAL_POSE_Y DOGZILLA_INITIAL_POSE_YAW
export REMOTE_ROOT

mkdir -p "$REMOTE_ROOT/logs"

pkill -9 -f "ros2.*daemon" 2>/dev/null || true

if [ -z "$DOGZILLA_NAV2_MAP" ] && [ -s "$DOGZILLA_MAP_METADATA" ]; then
  DOGZILLA_NAV2_MAP="$(python3 - "$DOGZILLA_MAP_METADATA" <<'PY'
import json
import pathlib
import sys

md = pathlib.Path(sys.argv[1])
try:
    m = json.loads(md.read_text(encoding="utf-8"))
    y = (m.get("yaml") or "").strip()
    if y:
        p = pathlib.Path(y)
        print(p if p.is_absolute() else md.parent / p)
except Exception:
    pass
PY
)"
fi
DOGZILLA_NAV2_MAP="${DOGZILLA_NAV2_MAP:-$REMOTE_ROOT/maps/robodoge_home.yaml}"

if [ -z "$DOGZILLA_INITIAL_POSE_X" ] || [ -z "$DOGZILLA_INITIAL_POSE_Y" ] || [ -z "$DOGZILLA_INITIAL_POSE_YAW" ]; then
  origin_file="$REMOTE_ROOT/output/app-cache/dogzilla-map-origin.json"
  if [ -s "$origin_file" ]; then
    eval "$(python3 - "$origin_file" <<'PY'
import json
import shlex
import sys

try:
    origin = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    raise SystemExit(0)

for name in ("x", "y", "yaw"):
    value = origin.get(name)
    if value is not None:
        print(f"DOGZILLA_INITIAL_POSE_{name.upper()}={shlex.quote(str(value))}")
PY
)"
  fi
fi
DOGZILLA_INITIAL_POSE_X="${DOGZILLA_INITIAL_POSE_X:-0}"
DOGZILLA_INITIAL_POSE_Y="${DOGZILLA_INITIAL_POSE_Y:-0}"
DOGZILLA_INITIAL_POSE_YAW="${DOGZILLA_INITIAL_POSE_YAW:-0}"
export DOGZILLA_INITIAL_POSE_X DOGZILLA_INITIAL_POSE_Y DOGZILLA_INITIAL_POSE_YAW

source /opt/ros/humble/setup.bash
source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true

missing=()
for pkg in nav2_bringup nav2_bt_navigator nav2_controller nav2_planner nav2_map_server nav2_amcl; do
  if ! ros2 pkg prefix "$pkg" >/dev/null 2>&1; then
    missing+=("$pkg")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Required Nav2 ROS packages missing: ${missing[*]}." >&2
  exit 2
fi

if [ ! -s "$DOGZILLA_NAV2_BASE_PARAMS" ]; then
  echo "Nav2 base params missing: $DOGZILLA_NAV2_BASE_PARAMS" >&2
  exit 2
fi

python3 - "$DOGZILLA_NAV2_BASE_PARAMS" "$DOGZILLA_NAV2_PARAMS" <<'PY'
import os
import sys
import yaml

src, tgt = sys.argv[1:3]

def env_f(name, default):
    try:
        return float(os.environ.get(name, str(default)))
    except Exception:
        return default

with open(src, encoding="utf-8") as f:
    p = yaml.safe_load(f) or {}

rr = env_f("DOGZILLA_NAV2_ROBOT_RADIUS", 0.16)
fp = env_f("DOGZILLA_NAV2_FOOTPRINT_PADDING", 0.02)
ir = env_f("DOGZILLA_NAV2_INFLATION_RADIUS", 0.28)
csf = env_f("DOGZILLA_NAV2_COST_SCALING_FACTOR", 8.0)
omin = env_f("DOGZILLA_NAV2_OBSTACLE_MIN_RANGE", 0.24)
omax = env_f("DOGZILLA_NAV2_OBSTACLE_MAX_RANGE", 2.5)
rtmax = env_f("DOGZILLA_NAV2_RAYTRACE_MAX_RANGE", 3.5)
yaw = env_f("DOGZILLA_NAV2_YAW_GOAL_TOLERANCE", 6.283185307179586)
xy = env_f("DOGZILLA_NAV2_XY_GOAL_TOLERANCE", 0.25)
cf = env_f("DOGZILLA_NAV2_CONTROLLER_FREQUENCY", 3.0)
bld = int(env_f("DOGZILLA_NAV2_BT_LOOP_DURATION_MS", 500.0))
bst = int(env_f("DOGZILLA_NAV2_BT_SERVER_TIMEOUT_MS", 10000.0))
bws = int(env_f("DOGZILLA_NAV2_BT_WAIT_FOR_SERVICE_TIMEOUT_MS", 5000.0))
pf = env_f("DOGZILLA_NAV2_PLANNER_FREQUENCY", 1.0)
sf = env_f("DOGZILLA_NAV2_SMOOTHER_FREQUENCY", 2.0)
rmr = env_f("DOGZILLA_NAV2_REQUIRED_MOVEMENT_RADIUS", 0.08)
mta = env_f("DOGZILLA_NAV2_MOVEMENT_TIME_ALLOWANCE", 45.0)
ft = env_f("DOGZILLA_NAV2_FAILURE_TOLERANCE", 5.0)
msx = env_f("DOGZILLA_NAV2_MIN_SPEED_XY", 0.03)
tsv = env_f("DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY", 0.05)
st = os.environ.get("DOGZILLA_NAV2_SCAN_FILTER_TOPIC", "/scan_nav2")
sfe = os.environ.get("DOGZILLA_NAV2_SCAN_FILTER_ENABLED", "1") == "1"

def costmap_ros(name):
    return p.setdefault(name, {}).setdefault(name, {}).setdefault("ros__parameters", {})

for cname in ("local_costmap", "global_costmap"):
    rp = costmap_ros(cname)
    rp["robot_radius"] = rr
    rp["footprint_padding"] = fp
    inf = rp.get("inflation_layer")
    if isinstance(inf, dict):
        inf["inflation_radius"] = ir
        inf["cost_scaling_factor"] = csf
    for lname in ("obstacle_layer", "voxel_layer"):
        l = rp.get(lname)
        if isinstance(l, dict):
            l["obstacle_min_range"] = omin
            l["obstacle_max_range"] = omax
            l["raytrace_min_range"] = omin
            l["raytrace_max_range"] = rtmax
            if sfe:
                for sname in str(l.get("observation_sources", "")).split():
                    src_cfg = l.get(sname)
                    if isinstance(src_cfg, dict):
                        src_cfg["topic"] = st
                        src_cfg["obstacle_min_range"] = omin
                        src_cfg["obstacle_max_range"] = omax
                        src_cfg["raytrace_min_range"] = omin
                        src_cfg["raytrace_max_range"] = rtmax
                        if str(src_cfg.get("data_type", "")).lower() == "laserscan":
                            src_cfg["inf_is_valid"] = True

ctrl = p.setdefault("controller_server", {}).setdefault("ros__parameters", {})
ctrl["controller_frequency"] = cf
ctrl["failure_tolerance"] = max(ft, 0.0)
for name in ctrl.get("controller_plugins", []):
    fp2 = ctrl.get(name)
    if isinstance(fp2, dict):
        fp2["xy_goal_tolerance"] = xy
        fp2["yaw_goal_tolerance"] = yaw
        fp2["min_speed_xy"] = msx
        fp2["trans_stopped_velocity"] = tsv

pc = p.setdefault("controller_server", {}).setdefault("ros__parameters", {}).setdefault("progress_checker", {})
pc["required_movement_radius"] = rmr
pc["movement_time_allowance"] = mta

btn = p.setdefault("bt_navigator", {}).setdefault("ros__parameters", {})
btn["bt_loop_duration"] = bld
btn["default_server_timeout"] = bst
btn["wait_for_service_timeout"] = bws

pln = p.setdefault("planner_server", {}).setdefault("ros__parameters", {})
pln["expected_planner_frequency"] = pf

vs = p.setdefault("velocity_smoother", {}).setdefault("ros__parameters", {})
vs["smoothing_frequency"] = sf

amcl = p.setdefault("amcl", {}).setdefault("ros__parameters", {})
amcl["use_sim_time"] = False
amcl["base_frame_id"] = "base_link"
amcl["global_frame_id"] = "map"
amcl["odom_frame_id"] = "odom"
amcl["scan_topic"] = st
amcl["tf_broadcast"] = True
amcl["set_initial_pose"] = True
amcl["robot_model_type"] = "nav2_amcl::DifferentialMotionModel"
amcl["min_particles"] = int(env_f("DOGZILLA_AMCL_MIN_PARTICLES", 300))
amcl["max_particles"] = int(env_f("DOGZILLA_AMCL_MAX_PARTICLES", 2000))
amcl["initial_pose"] = {
    "x": env_f("DOGZILLA_INITIAL_POSE_X", 0.0),
    "y": env_f("DOGZILLA_INITIAL_POSE_Y", 0.0),
    "yaw": env_f("DOGZILLA_INITIAL_POSE_YAW", 0.0),
}

os.makedirs(os.path.dirname(tgt), exist_ok=True)
with open(tgt, "w", encoding="utf-8") as f:
    yaml.safe_dump(p, f, sort_keys=False)

print(f"Generated params: robot_radius={rr} inflation_radius={ir} scan_topic={st if sfe else '/scan'}")
PY

if [ ! -s "$DOGZILLA_NAV2_MAP" ]; then
  echo "Nav2 map yaml missing: $DOGZILLA_NAV2_MAP" >&2
  exit 2
fi

map_image="$(python3 - "$DOGZILLA_NAV2_MAP" <<'PY'
import os
import sys

img = ""
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        if line.strip().startswith("image:"):
            img = line.split(":", 1)[1].strip()
            break
if img and not os.path.isabs(img):
    img = os.path.join(os.path.dirname(sys.argv[1]), img)
print(img)
PY
)"

if [ -n "$map_image" ] && [ ! -s "$map_image" ]; then
  echo "Nav2 map image missing: $map_image" >&2
  exit 2
fi

pkill -TERM -f "[s]can_self_filter.py" 2>/dev/null || true
pkill -TERM -f "[t]f_odom_publisher.py" 2>/dev/null || true
pkill -TERM -f "[c]md_vel_odom_publisher.py" 2>/dev/null || true
pkill -TERM -f "[c]md_vel_gait_adapter.py" 2>/dev/null || true
pkill -TERM -f "[r]os2 launch .*robodoge_nav2_navigation_launch.py" 2>/dev/null || true
pkill -TERM -f "/opt/ros/.*/lib/nav2_" 2>/dev/null || true
pkill -TERM -f "/opt/ros/.*/lib/nav2_amcl/amcl" 2>/dev/null || true
sleep 1
pkill -KILL -f "[s]can_self_filter.py" 2>/dev/null || true
pkill -KILL -f "[t]f_odom_publisher.py" 2>/dev/null || true
pkill -KILL -f "[c]md_vel_odom_publisher.py" 2>/dev/null || true
pkill -KILL -f "[c]md_vel_gait_adapter.py" 2>/dev/null || true
pkill -KILL -f "[r]os2 launch .*robodoge_nav2_navigation_launch.py" 2>/dev/null || true
pkill -KILL -f "/opt/ros/.*/lib/nav2_" 2>/dev/null || true
pkill -KILL -f "/opt/ros/.*/lib/nav2_amcl/amcl" 2>/dev/null || true

if [ "$DOGZILLA_NAV2_SCAN_FILTER_ENABLED" = "1" ]; then
  nohup python3 "$REMOTE_ROOT/sidecars/dogzilla_navigation/scan_self_filter.py" \
    --input-topic /scan \
    --output-topic "$DOGZILLA_NAV2_SCAN_FILTER_TOPIC" \
    --mask-start-deg "$DOGZILLA_NAV2_SCAN_FILTER_MASK_START_DEG" \
    --mask-end-deg "$DOGZILLA_NAV2_SCAN_FILTER_MASK_END_DEG" \
    --mask-range-m "$DOGZILLA_NAV2_SCAN_FILTER_MASK_RANGE_M" \
    > "$REMOTE_ROOT/logs/scan-self-filter.log" 2>&1 &
fi

if [ "$DOGZILLA_LOCALIZATION_BACKEND" = "cartographer" ]; then
  echo "Waiting Pi-owned Cartographer map->base_link TF..." >&2
  python3 - <<'PY'
import os
import sys
import time

os.environ.setdefault("PYTHONUNBUFFERED", "1")

import rclpy
from rclpy.duration import Duration
from rclpy.node import Node
from tf2_ros import Buffer, TransformListener

rclpy.init(args=None)
node = Node("robodoge_nav_carto_ready")
buf = Buffer(cache_time=Duration(seconds=5.0))
TransformListener(buf, node)
deadline = time.monotonic() + 35.0
found = False
while time.monotonic() < deadline:
    try:
        transform = buf.lookup_transform("map", "base_link", rclpy.time.Time())
        translation = transform.transform.translation
        print(
            f"map->base_link TF available: ({translation.x:.3f}, {translation.y:.3f})",
            file=sys.stderr,
        )
        found = True
        break
    except Exception:
        pass
    rclpy.spin_once(node, timeout_sec=0.2)
node.destroy_node()
rclpy.shutdown()
if not found:
    print(
        "map->base_link TF not available after 35s; robodoge-map-pose.service must be healthy before Nav2 starts.",
        file=sys.stderr,
    )
    raise SystemExit(2)
PY

  nohup python3 "$REMOTE_ROOT/sidecars/dogzilla_navigation/tf_odom_publisher.py" \
    --odom-frame odom \
    --base-frame base_link \
    --fallback-source-frame map \
    --topic /odom \
    --rate 10 \
    > "$REMOTE_ROOT/logs/tf-odom-publisher.log" 2>&1 &
else
  nohup python3 "$REMOTE_ROOT/sidecars/dogzilla_navigation/cmd_vel_odom_publisher.py" \
    --input-topic "$DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC" \
    --topic /odom \
    --odom-frame odom \
    --base-frame base_link \
    --rate 15 \
    --stale-stop-sec "$DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC" \
    > "$REMOTE_ROOT/logs/cmd-vel-odom-publisher.log" 2>&1 &
fi

if [ "$DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED" = "1" ]; then
  nohup python3 "$REMOTE_ROOT/sidecars/dogzilla_navigation/cmd_vel_gait_adapter.py" \
    --input-topic "$DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC" \
    --bridge-url "$DOGZILLA_NAV2_GAIT_ADAPTER_URL" \
    --max-rate-hz "$DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ" \
    --stale-stop-sec "$DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC" \
    --http-timeout-sec "$DOGZILLA_NAV2_GAIT_ADAPTER_HTTP_TIMEOUT_SEC" \
    --speed-ramp-interval "$DOGZILLA_NAV2_SPEED_RAMP_INTERVAL" \
    --speed-ramp-buffer "$DOGZILLA_NAV2_SPEED_RAMP_BUFFER" \
    > "$REMOTE_ROOT/logs/cmd-vel-gait-adapter.log" 2>&1 &
fi

echo "Starting Pi-owned Nav2." >&2
: > "$REMOTE_ROOT/logs/nav2-navigation.log"
exec ros2 launch "$DOGZILLA_NAV2_LAUNCH" \
  map:="$DOGZILLA_NAV2_MAP" \
  params_file:="$DOGZILLA_NAV2_PARAMS" \
  use_sim_time:=false \
  autostart:=true \
  use_respawn:=true \
  localization_backend:="$DOGZILLA_LOCALIZATION_BACKEND" \
  >> "$REMOTE_ROOT/logs/nav2-navigation.log" 2>&1
