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
DOGZILLA_NAV2_CONFIG="${DOGZILLA_NAV2_CONFIG:-$REMOTE_ROOT/config/robot-obstacle-avoidance.json}"
DOGZILLA_NAV2_BT_XML="${DOGZILLA_NAV2_BT_XML:-$REMOTE_ROOT/sidecars/dogzilla_navigation/robodoge_navigate_to_pose_corner_recovery.xml}"

if [ ! -s "$DOGZILLA_NAV2_CONFIG" ]; then
  echo "Canonical Nav2 tuning config missing: $DOGZILLA_NAV2_CONFIG" >&2
  exit 2
fi

if [ ! -s "$DOGZILLA_NAV2_BT_XML" ]; then
  echo "NavigateToPose behavior tree missing: $DOGZILLA_NAV2_BT_XML" >&2
  exit 2
fi

if ! nav2_config_env="$(python3 - "$DOGZILLA_NAV2_CONFIG" <<'PY'
import json
import shlex
import sys

config_path = sys.argv[1]
with open(config_path, encoding="utf-8") as config_file:
    config = json.load(config_file)

config_to_env = {
    "nav2RobotRadius": "DOGZILLA_NAV2_ROBOT_RADIUS",
    "nav2FootprintPadding": "DOGZILLA_NAV2_FOOTPRINT_PADDING",
    "nav2InflationRadius": "DOGZILLA_NAV2_INFLATION_RADIUS",
    "nav2CostScalingFactor": "DOGZILLA_NAV2_COST_SCALING_FACTOR",
    "nav2ObstacleMinRange": "DOGZILLA_NAV2_OBSTACLE_MIN_RANGE",
    "nav2ObstacleMaxRange": "DOGZILLA_NAV2_OBSTACLE_MAX_RANGE",
    "nav2RaytraceMaxRange": "DOGZILLA_NAV2_RAYTRACE_MAX_RANGE",
    "yawGoalTolerance": "DOGZILLA_NAV2_YAW_GOAL_TOLERANCE",
    "nav2XyGoalTolerance": "DOGZILLA_NAV2_XY_GOAL_TOLERANCE",
    "nav2ControllerFrequency": "DOGZILLA_NAV2_CONTROLLER_FREQUENCY",
    "nav2BtLoopDurationMs": "DOGZILLA_NAV2_BT_LOOP_DURATION_MS",
    "nav2BtServerTimeoutMs": "DOGZILLA_NAV2_BT_SERVER_TIMEOUT_MS",
    "nav2BtWaitForServiceTimeoutMs": "DOGZILLA_NAV2_BT_WAIT_FOR_SERVICE_TIMEOUT_MS",
    "nav2PlannerFrequency": "DOGZILLA_NAV2_PLANNER_FREQUENCY",
    "nav2SmootherFrequency": "DOGZILLA_NAV2_SMOOTHER_FREQUENCY",
    "nav2RequiredMovementRadius": "DOGZILLA_NAV2_REQUIRED_MOVEMENT_RADIUS",
    "nav2MovementTimeAllowance": "DOGZILLA_NAV2_MOVEMENT_TIME_ALLOWANCE",
    "nav2FailureTolerance": "DOGZILLA_NAV2_FAILURE_TOLERANCE",
    "nav2MinSpeedXy": "DOGZILLA_NAV2_MIN_SPEED_XY",
    "nav2TransStoppedVelocity": "DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY",
    "nav2ScanFilterEnabled": "DOGZILLA_NAV2_SCAN_FILTER_ENABLED",
    "nav2ScanFilterMaskStartDeg": "DOGZILLA_NAV2_SCAN_FILTER_MASK_START_DEG",
    "nav2ScanFilterMaskEndDeg": "DOGZILLA_NAV2_SCAN_FILTER_MASK_END_DEG",
    "nav2ScanFilterMaskRangeM": "DOGZILLA_NAV2_SCAN_FILTER_MASK_RANGE_M",
    "nav2CollisionSourceTimeout": "DOGZILLA_NAV2_COLLISION_SOURCE_TIMEOUT",
    "nav2CollisionStopPolygonPoints": "DOGZILLA_NAV2_COLLISION_STOP_POLYGON_POINTS",
}

missing = [name for name in config_to_env if name not in config]
if missing:
    raise SystemExit(f"Canonical Nav2 tuning config missing keys: {', '.join(missing)}")

for config_name, env_name in config_to_env.items():
    value = config[config_name]
    if isinstance(value, bool):
        value = "1" if value else "0"
    elif isinstance(value, (list, dict)):
        value = json.dumps(value, separators=(",", ":"))
    else:
        value = str(value)
    print(f"{env_name}={shlex.quote(value)}")
PY
)"; then
  exit 2
fi
eval "$nav2_config_env"

DOGZILLA_NAV2_SCAN_FILTER_TOPIC="${DOGZILLA_NAV2_SCAN_FILTER_TOPIC:-/scan_nav2}"
DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED="${DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED:-1}"
DOGZILLA_NAV2_GAIT_ADAPTER_URL="${DOGZILLA_NAV2_GAIT_ADAPTER_URL:-http://127.0.0.1:8893/nav2/cmd_vel}"
DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC="${DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC:-/cmd_vel}"
DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ="${DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ:-8.0}"
DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC="${DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC:-0.45}"
DOGZILLA_NAV2_GAIT_ADAPTER_HTTP_TIMEOUT_SEC="${DOGZILLA_NAV2_GAIT_ADAPTER_HTTP_TIMEOUT_SEC:-0.8}"
DOGZILLA_LOCALIZATION_BACKEND="${DOGZILLA_LOCALIZATION_BACKEND:-amcl}"
DOGZILLA_NAV2_MAPPING_MODE="${DOGZILLA_NAV2_MAPPING_MODE:-0}"
DOGZILLA_NAV2_MAPPING_MIN_SPEED_XY="${DOGZILLA_NAV2_MAPPING_MIN_SPEED_XY:-0.13}"
DOGZILLA_NAV2_MAPPING_PREFER_FORWARD_SCALE="${DOGZILLA_NAV2_MAPPING_PREFER_FORWARD_SCALE:-20.0}"
DOGZILLA_NAV2_READINESS_STARTUP_TIMEOUT_SEC="${DOGZILLA_NAV2_READINESS_STARTUP_TIMEOUT_SEC:-120}"
DOGZILLA_NAV2_READINESS_RECHECK_TIMEOUT_SEC="${DOGZILLA_NAV2_READINESS_RECHECK_TIMEOUT_SEC:-10}"
if [ "$DOGZILLA_NAV2_MAPPING_MODE" = "1" ]; then
  DOGZILLA_NAV2_READINESS_GRACE_SEC="${DOGZILLA_NAV2_MAPPING_READINESS_GRACE_SEC:-120}"
else
  DOGZILLA_NAV2_READINESS_GRACE_SEC="${DOGZILLA_NAV2_READINESS_GRACE_SEC:-20}"
fi
DOGZILLA_NAV2_BRIDGE_HEALTH_URL="${DOGZILLA_NAV2_BRIDGE_HEALTH_URL:-http://127.0.0.1:8893/nav2/cmd_vel/health}"
DOGZILLA_INITIAL_POSE_X="${DOGZILLA_INITIAL_POSE_X:-}"
DOGZILLA_INITIAL_POSE_Y="${DOGZILLA_INITIAL_POSE_Y:-}"
DOGZILLA_INITIAL_POSE_YAW="${DOGZILLA_INITIAL_POSE_YAW:-}"

export ROS_DOMAIN_ID
export DOGZILLA_NAV2_MAP_METADATA DOGZILLA_NAV2_MAP DOGZILLA_NAV2_BASE_PARAMS DOGZILLA_NAV2_PARAMS
export DOGZILLA_NAV2_BT_XML
export DOGZILLA_NAV2_ROBOT_RADIUS DOGZILLA_NAV2_FOOTPRINT_PADDING DOGZILLA_NAV2_INFLATION_RADIUS
export DOGZILLA_NAV2_COST_SCALING_FACTOR DOGZILLA_NAV2_OBSTACLE_MIN_RANGE DOGZILLA_NAV2_OBSTACLE_MAX_RANGE
export DOGZILLA_NAV2_RAYTRACE_MAX_RANGE DOGZILLA_NAV2_YAW_GOAL_TOLERANCE DOGZILLA_NAV2_XY_GOAL_TOLERANCE
export DOGZILLA_NAV2_CONTROLLER_FREQUENCY DOGZILLA_NAV2_BT_LOOP_DURATION_MS DOGZILLA_NAV2_BT_SERVER_TIMEOUT_MS
export DOGZILLA_NAV2_BT_WAIT_FOR_SERVICE_TIMEOUT_MS DOGZILLA_NAV2_PLANNER_FREQUENCY DOGZILLA_NAV2_SMOOTHER_FREQUENCY
export DOGZILLA_NAV2_REQUIRED_MOVEMENT_RADIUS DOGZILLA_NAV2_MOVEMENT_TIME_ALLOWANCE DOGZILLA_NAV2_FAILURE_TOLERANCE
export DOGZILLA_NAV2_MIN_SPEED_XY DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY
export DOGZILLA_NAV2_SCAN_FILTER_ENABLED DOGZILLA_NAV2_SCAN_FILTER_TOPIC
export DOGZILLA_NAV2_SCAN_FILTER_MASK_START_DEG DOGZILLA_NAV2_SCAN_FILTER_MASK_END_DEG DOGZILLA_NAV2_SCAN_FILTER_MASK_RANGE_M
export DOGZILLA_NAV2_COLLISION_SOURCE_TIMEOUT DOGZILLA_NAV2_COLLISION_STOP_POLYGON_POINTS
export DOGZILLA_NAV2_GAIT_ADAPTER_URL DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC
export DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC DOGZILLA_NAV2_GAIT_ADAPTER_HTTP_TIMEOUT_SEC
export DOGZILLA_LOCALIZATION_BACKEND DOGZILLA_NAV2_MAPPING_MODE DOGZILLA_NAV2_MAPPING_MIN_SPEED_XY
export DOGZILLA_NAV2_MAPPING_PREFER_FORWARD_SCALE
export DOGZILLA_INITIAL_POSE_X DOGZILLA_INITIAL_POSE_Y DOGZILLA_INITIAL_POSE_YAW
export REMOTE_ROOT

mkdir -p "$REMOTE_ROOT/logs"

DOGZILLA_NAV2_LOCK_FILE="${DOGZILLA_NAV2_LOCK_FILE:-$REMOTE_ROOT/logs/navigation-runtime.lock}"
DOGZILLA_NAV2_OWNER_FILE="${DOGZILLA_NAV2_OWNER_FILE:-$REMOTE_ROOT/logs/navigation-runtime.owner}"
exec 9>"$DOGZILLA_NAV2_LOCK_FILE"
if ! flock -n 9; then
  echo "Another Nav2 launch owns $DOGZILLA_NAV2_LOCK_FILE; refusing competing startup." >&2
  exit 3
fi

read_proc_start_ticks() {
  local process_id="$1"
  local stat_line=""
  local stat_rest=""
  stat_line="$(cat "/proc/$process_id/stat" 2>/dev/null)" || return 1
  stat_rest="${stat_line##*) }"
  set -- $stat_rest
  [ "$#" -ge 20 ] || return 1
  printf '%s' "${20}"
}

OWNER_RECORD_VERSION=2
OWNER_BOOT_ID="$(tr -d '[:space:]' < /proc/sys/kernel/random/boot_id)"
OWNER_TOKEN="$(tr -d '-' < /proc/sys/kernel/random/uuid | tr -d '[:space:]')"
OWNER_PID_START_TICKS="$(read_proc_start_ticks "$$")"
if ! [[ "$OWNER_BOOT_ID" =~ ^[0-9a-fA-F-]{36}$ ]] \
  || ! [[ "$OWNER_TOKEN" =~ ^[0-9a-fA-F]{32}$ ]] \
  || ! [[ "$OWNER_PID_START_TICKS" =~ ^[0-9]+$ ]]; then
  echo "Could not create a validated Nav2 owner generation." >&2
  exit 4
fi
export DOGZILLA_NAV2_OWNER_TOKEN="$OWNER_TOKEN"

write_navigation_owner() {
  local owner_mode="$1"
  local owner_pgid="${2:-}"
  local owner_pgid_start_ticks="${3:-}"
  local temporary_owner="$DOGZILLA_NAV2_OWNER_FILE.$$"
  umask 077
  printf 'version=%s\nmode=%s\ntoken=%s\nboot_id=%s\npid=%s\npid_start_ticks=%s\npgid=%s\npgid_start_ticks=%s\n' \
    "$OWNER_RECORD_VERSION" "$owner_mode" "$OWNER_TOKEN" "$OWNER_BOOT_ID" "$$" \
    "$OWNER_PID_START_TICKS" "$owner_pgid" "$owner_pgid_start_ticks" > "$temporary_owner"
  chmod 600 "$temporary_owner"
  mv -f "$temporary_owner" "$DOGZILLA_NAV2_OWNER_FILE"
}

clear_navigation_owner() {
  local recorded_pid=""
  if [ -s "$DOGZILLA_NAV2_OWNER_FILE" ]; then
    recorded_pid="$(sed -n 's/^pid=//p' "$DOGZILLA_NAV2_OWNER_FILE" | head -1)"
  fi
  if [ "$recorded_pid" = "$$" ]; then
    rm -f "$DOGZILLA_NAV2_OWNER_FILE"
  fi
}

NAV2_OWNER_MODE="normal"
if [ "$DOGZILLA_NAV2_MAPPING_MODE" = "1" ]; then
  NAV2_OWNER_MODE="mapping"
fi
write_navigation_owner "$NAV2_OWNER_MODE"

pkill -9 -f "ros2.*daemon" 2>/dev/null || true

if [ "$DOGZILLA_NAV2_MAPPING_MODE" != "1" ]; then
  requested_nav2_map="$DOGZILLA_NAV2_MAP"
  if ! manifest_nav2_map="$(python3 - "$DOGZILLA_MAP_METADATA" "$REMOTE_ROOT/sidecars/dogzilla_lib_bridge" <<'PY'
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
yaml_path = str(metadata.get("yaml") or "").strip()
if not yaml_path:
    print("Active map validation failed: yaml path missing", file=sys.stderr)
    raise SystemExit(1)
print(yaml_path)
PY
)"; then
    echo "Active map manifest missing, invalid, or overridden: $DOGZILLA_MAP_METADATA" >&2
    exit 2
  fi
  if [ -n "$requested_nav2_map" ] && [ "$requested_nav2_map" != "$manifest_nav2_map" ]; then
    echo "Active map manifest missing, invalid, or overridden: $DOGZILLA_MAP_METADATA" >&2
    exit 2
  fi
  DOGZILLA_NAV2_MAP="$manifest_nav2_map"
else
  DOGZILLA_NAV2_MAP="${DOGZILLA_NAV2_MAP:-/dev/null}"
fi

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
import json
import os
import sys
import yaml

src, tgt = sys.argv[1:3]

def env_f(name, default):
    try:
        return float(os.environ.get(name, str(default)))
    except Exception:
        return default

def env_f_required(name):
    try:
        return float(os.environ[name])
    except (KeyError, TypeError, ValueError) as exc:
        raise SystemExit(f"Required Nav2 tuning value is invalid: {name}") from exc

with open(src, encoding="utf-8") as f:
    p = yaml.safe_load(f) or {}

rr = env_f_required("DOGZILLA_NAV2_ROBOT_RADIUS")
fp = env_f_required("DOGZILLA_NAV2_FOOTPRINT_PADDING")
ir = env_f_required("DOGZILLA_NAV2_INFLATION_RADIUS")
csf = env_f_required("DOGZILLA_NAV2_COST_SCALING_FACTOR")
omin = env_f_required("DOGZILLA_NAV2_OBSTACLE_MIN_RANGE")
omax = env_f_required("DOGZILLA_NAV2_OBSTACLE_MAX_RANGE")
rtmax = env_f_required("DOGZILLA_NAV2_RAYTRACE_MAX_RANGE")
yaw = env_f_required("DOGZILLA_NAV2_YAW_GOAL_TOLERANCE")
xy = env_f_required("DOGZILLA_NAV2_XY_GOAL_TOLERANCE")
cf = env_f_required("DOGZILLA_NAV2_CONTROLLER_FREQUENCY")
bld = int(env_f_required("DOGZILLA_NAV2_BT_LOOP_DURATION_MS"))
bst = int(env_f_required("DOGZILLA_NAV2_BT_SERVER_TIMEOUT_MS"))
bws = int(env_f_required("DOGZILLA_NAV2_BT_WAIT_FOR_SERVICE_TIMEOUT_MS"))
pf = env_f_required("DOGZILLA_NAV2_PLANNER_FREQUENCY")
sf = env_f_required("DOGZILLA_NAV2_SMOOTHER_FREQUENCY")
rmr = env_f_required("DOGZILLA_NAV2_REQUIRED_MOVEMENT_RADIUS")
mta = env_f_required("DOGZILLA_NAV2_MOVEMENT_TIME_ALLOWANCE")
ft = env_f_required("DOGZILLA_NAV2_FAILURE_TOLERANCE")
msx = env_f_required("DOGZILLA_NAV2_MIN_SPEED_XY")
tsv = env_f_required("DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY")
mapping_msx = max(env_f_required("DOGZILLA_NAV2_MAPPING_MIN_SPEED_XY"), 0.0)
mapping_prefer_forward_scale = max(
    env_f_required("DOGZILLA_NAV2_MAPPING_PREFER_FORWARD_SCALE"),
    0.0,
)
try:
    collision_stop_points = json.loads(os.environ["DOGZILLA_NAV2_COLLISION_STOP_POLYGON_POINTS"])
    if len(collision_stop_points) < 6 or len(collision_stop_points) % 2:
        raise ValueError("polygon requires at least three x/y pairs")
    collision_stop_points = [float(value) for value in collision_stop_points]
except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
    raise SystemExit("Required Nav2 collision stop polygon is invalid") from exc
mvy = 0.0
lay = 0.0
vys = 1
st = os.environ.get("DOGZILLA_NAV2_SCAN_FILTER_TOPIC", "/scan_nav2")
sfe = os.environ["DOGZILLA_NAV2_SCAN_FILTER_ENABLED"] == "1"
scan_source_topic = st if sfe else "/scan"
mapping_mode = os.environ.get("DOGZILLA_NAV2_MAPPING_MODE", "0") == "1"

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

if mapping_mode:
    global_costmap = costmap_ros("global_costmap")
    plugins = list(global_costmap.get("plugins", []))
    if "static_layer" not in plugins:
        plugins.insert(0, "static_layer")
    global_costmap["plugins"] = plugins
    static_layer = global_costmap.setdefault("static_layer", {})
    static_layer.update({
        "plugin": "nav2_costmap_2d::StaticLayer",
        "map_topic": "/map_cartographer",
        "map_subscribe_transient_local": False,
        "subscribe_to_updates": True,
        "track_unknown_space": True,
        "transform_tolerance": 0.5,
    })

ctrl = p.setdefault("controller_server", {}).setdefault("ros__parameters", {})
ctrl["controller_frequency"] = cf
ctrl["failure_tolerance"] = max(ft, 0.0)
for name in ctrl.get("controller_plugins", []):
    fp2 = ctrl.get(name)
    if isinstance(fp2, dict):
        fp2["xy_goal_tolerance"] = xy
        fp2["yaw_goal_tolerance"] = yaw
        fp2["min_vel_x"] = 0.0
        fp2["min_speed_xy"] = max(msx, mapping_msx) if mapping_mode else msx
        fp2["trans_stopped_velocity"] = tsv
        fp2["min_vel_y"] = -mvy
        fp2["max_vel_y"] = mvy
        fp2["acc_lim_y"] = lay
        fp2["decel_lim_y"] = -lay
        fp2["vy_samples"] = vys
        if mapping_mode and mapping_prefer_forward_scale > 0.0:
            critics = fp2.get("critics")
            if isinstance(critics, list) and "PreferForward" not in critics:
                insert_at = critics.index("BaseObstacle") + 1 if "BaseObstacle" in critics else 0
                critics.insert(insert_at, "PreferForward")
            fp2["PreferForward.scale"] = mapping_prefer_forward_scale
for name in ctrl.get("goal_checker_plugins", []):
    goal_checker = ctrl.get(name)
    if isinstance(goal_checker, dict):
        goal_checker["xy_goal_tolerance"] = xy
        goal_checker["yaw_goal_tolerance"] = yaw

pc = p.setdefault("controller_server", {}).setdefault("ros__parameters", {}).setdefault("progress_checker", {})
pc["required_movement_radius"] = rmr
pc["movement_time_allowance"] = mta

btn = p.setdefault("bt_navigator", {}).setdefault("ros__parameters", {})
btn["bt_loop_duration"] = bld
btn["default_server_timeout"] = bst
btn["wait_for_service_timeout"] = bws
bt_xml = os.environ.get("DOGZILLA_NAV2_BT_XML")
if bt_xml:
    btn["default_nav_to_pose_bt_xml"] = bt_xml

pln = p.setdefault("planner_server", {}).setdefault("ros__parameters", {})
pln["expected_planner_frequency"] = pf

vs = p.setdefault("velocity_smoother", {}).setdefault("ros__parameters", {})
vs["smoothing_frequency"] = sf
for key in ("max_velocity", "min_velocity", "max_accel", "max_decel"):
    vector = list(vs.get(key) or [0.0, 0.0, 0.0])
    vector.extend([0.0] * max(0, 3 - len(vector)))
    vs[key] = vector
vs["max_velocity"][1] = mvy
vs["min_velocity"][1] = -mvy
vs["max_accel"][1] = lay
vs["max_decel"][1] = -lay

collision = p.setdefault("collision_monitor", {}).setdefault("ros__parameters", {})
collision.update({
    "use_sim_time": False,
    "base_frame_id": "base_link",
    "odom_frame_id": "odom",
    "cmd_vel_in_topic": "cmd_vel_raw",
    "cmd_vel_out_topic": "cmd_vel",
    "transform_tolerance": 0.5,
    "source_timeout": env_f_required("DOGZILLA_NAV2_COLLISION_SOURCE_TIMEOUT"),
    "base_shift_correction": False,
    "stop_pub_timeout": 1.0,
    "polygons": ["PolygonStop"],
    "PolygonStop": {
        "type": "polygon",
        "points": collision_stop_points,
        "action_type": "stop",
        "max_points": 3,
        "visualize": True,
        "polygon_pub_topic": "polygon_stop",
        "enabled": True,
    },
    "observation_sources": ["scan"],
    "scan": {
        "type": "scan",
        "topic": scan_source_topic,
        "enabled": True,
    },
})

amcl = p.setdefault("amcl", {}).setdefault("ros__parameters", {})
amcl["use_sim_time"] = False
amcl["base_frame_id"] = "base_link"
amcl["global_frame_id"] = "map"
amcl["odom_frame_id"] = "odom"
amcl["scan_topic"] = scan_source_topic
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

print(f"Generated params: robot_radius={rr} inflation_radius={ir} scan_topic={scan_source_topic}")
PY

if [ "$DOGZILLA_NAV2_MAPPING_MODE" != "1" ] && [ ! -s "$DOGZILLA_NAV2_MAP" ]; then
  echo "Nav2 map yaml missing: $DOGZILLA_NAV2_MAP" >&2
  exit 2
fi

map_image=""
if [ "$DOGZILLA_NAV2_MAPPING_MODE" != "1" ]; then
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
fi

if [ "$DOGZILLA_NAV2_MAPPING_MODE" != "1" ] && [ -n "$map_image" ] && [ ! -s "$map_image" ]; then
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

# SIGKILL is asynchronous from the ROS graph's point of view. Do not launch a
# replacement lifecycle manager while the previous Nav2 graph is still
# unwinding, or it can observe already-active nodes and fail activation.
for _ in $(seq 1 20); do
  if ! pgrep -f "[r]os2 launch .*robodoge_nav2_navigation_launch.py" >/dev/null 2>&1 \
    && ! pgrep -f "/opt/ros/.*/lib/nav2_" >/dev/null 2>&1 \
    && ! pgrep -f "[l]ifecycle_manager_navigation" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

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
fi

echo "Starting Pi-owned Nav2." >&2
: > "$REMOTE_ROOT/logs/nav2-navigation.log"

setsid ros2 launch "$DOGZILLA_NAV2_LAUNCH" \
  map:="$DOGZILLA_NAV2_MAP" \
  params_file:="$DOGZILLA_NAV2_PARAMS" \
  use_sim_time:=false \
  autostart:=true \
  use_respawn:=true \
  localization_backend:="$DOGZILLA_LOCALIZATION_BACKEND" \
  mapping_mode:="$DOGZILLA_NAV2_MAPPING_MODE" \
  >> "$REMOTE_ROOT/logs/nav2-navigation.log" 2>&1 &
nav2_launch_pid=$!
nav2_launch_pgid=""
nav2_launch_pgid_start_ticks=""
for _ in $(seq 1 20); do
  nav2_launch_pgid="$(ps -o pgid= -p "$nav2_launch_pid" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$nav2_launch_pgid" ] && break
  sleep 0.1
done
if ! [[ "$nav2_launch_pgid" =~ ^[0-9]+$ ]] || [ "$nav2_launch_pgid" != "$nav2_launch_pid" ]; then
  echo "Nav2 launch did not acquire an isolated process group." >&2
  kill -TERM "$nav2_launch_pid" 2>/dev/null || true
  wait "$nav2_launch_pid" 2>/dev/null || true
  clear_navigation_owner
  exit 4
fi
nav2_launch_pgid_start_ticks="$(read_proc_start_ticks "$nav2_launch_pgid")"
if ! [[ "$nav2_launch_pgid_start_ticks" =~ ^[0-9]+$ ]]; then
  echo "Nav2 launch process group identity could not be recorded." >&2
  kill -TERM -- "-$nav2_launch_pgid" 2>/dev/null || true
  wait "$nav2_launch_pid" 2>/dev/null || true
  clear_navigation_owner
  exit 4
fi
write_navigation_owner "$NAV2_OWNER_MODE" "$nav2_launch_pgid" "$nav2_launch_pgid_start_ticks"

stop_nav2_launch() {
  if kill -0 -- "-$nav2_launch_pgid" 2>/dev/null; then
    kill -TERM -- "-$nav2_launch_pgid" 2>/dev/null || true
  fi
  for _ in $(seq 1 10); do
    kill -0 -- "-$nav2_launch_pgid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 -- "-$nav2_launch_pgid" 2>/dev/null; then
    kill -KILL -- "-$nav2_launch_pgid" 2>/dev/null || true
  fi
  wait "$nav2_launch_pid" 2>/dev/null || true
}

handle_navigation_stop() {
  stop_nav2_launch
  clear_navigation_owner
  exit 0
}
trap handle_navigation_stop TERM INT

run_nav2_readiness() {
  local probe_mode="$1"
  local probe_timeout="$2"
  bash "$REMOTE_ROOT/sidecars/dogzilla_navigation/wait-nav2-ready.sh" \
    "$ROS_DOMAIN_ID" \
    "$REMOTE_ROOT" \
    auto \
    "$probe_timeout" \
    "$DOGZILLA_NAV2_MAPPING_MODE" \
    "$DOGZILLA_LOCALIZATION_BACKEND" \
    "$probe_mode" \
    "$DOGZILLA_NAV2_BRIDGE_HEALTH_URL" \
    "$DOGZILLA_NAV2_READINESS_GRACE_SEC" \
    "$NAV2_OWNER_MODE"
}

set +e
readiness_status=0
while true; do
  run_nav2_readiness watch "$DOGZILLA_NAV2_READINESS_STARTUP_TIMEOUT_SEC"
  readiness_status=$?
  if [ "$readiness_status" -eq 0 ]; then
    break
  fi

  echo "Nav2 readiness watcher exited with status $readiness_status; requiring a fresh independent confirmation before stopping Nav2." >&2
  run_nav2_readiness once "$DOGZILLA_NAV2_READINESS_RECHECK_TIMEOUT_SEC"
  recheck_status=$?
  if [ "$recheck_status" -ne 0 ]; then
    echo "Fresh Nav2 readiness recheck confirmed the failure with status $recheck_status." >&2
    break
  fi
  echo "Fresh Nav2 readiness recheck passed; replacing the stale watcher without interrupting Nav2." >&2
done
set -e

trap - TERM INT
stop_nav2_launch
clear_navigation_owner
echo "Nav2 readiness supervisor exited with status $readiness_status; failing the launch for systemd recovery." >&2
exit "$readiness_status"
