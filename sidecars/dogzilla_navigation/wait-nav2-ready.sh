#!/bin/bash
# Run inside robodoge-rosbridge for one-shot readiness or continuous supervision.
# Usage: wait-nav2-ready.sh <domain> <root> <scan> <startup_timeout> <mapping> <backend> [once|watch] [bridge_health_url] [unhealthy_grace] [expected_owner_mode]
set -eo pipefail

export ROS_DOMAIN_ID="${1:-16}"
REMOTE_ROOT="${2:-/home/pi/robodoge}"
SCAN_TOPIC="${3:-/scan}"
TIMEOUT_SEC="${4:-120}"
MAPPING_MODE="${5:-0}"
LOCALIZATION_BACKEND="${6:-cartographer}"
WATCH_MODE="${7:-once}"
BRIDGE_HEALTH_URL="${8:-http://127.0.0.1:8893/nav2/cmd_vel/health}"
UNHEALTHY_GRACE_SEC="${9:-20}"
DEFAULT_OWNER_MODE="normal"
if [ "$MAPPING_MODE" = "1" ]; then
  DEFAULT_OWNER_MODE="mapping"
fi
EXPECTED_OWNER_MODE="${10:-$DEFAULT_OWNER_MODE}"
READINESS_FILE="${DOGZILLA_NAV2_READINESS_FILE:-$REMOTE_ROOT/logs/navigation-readiness.json}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [ "$WATCH_MODE" != "once" ] && [ "$WATCH_MODE" != "watch" ]; then
  echo "Invalid Nav2 readiness mode: $WATCH_MODE" >&2
  exit 2
fi

if [ "$SCAN_TOPIC" = "auto" ]; then
  NAV2_CONFIG="$REMOTE_ROOT/config/robot-obstacle-avoidance.json"
  if [ ! -s "$NAV2_CONFIG" ]; then
    echo "Canonical Nav2 tuning config missing: $NAV2_CONFIG" >&2
    exit 2
  fi
  SCAN_TOPIC="$(python3 - "$NAV2_CONFIG" <<'PY'
import json
import os
import sys

with open(sys.argv[1], encoding="utf-8") as config_file:
    config = json.load(config_file)
print("/scan_nav2" if config.get("nav2ScanFilterEnabled") is True else "/scan")
PY
)"
fi

export LD_LIBRARY_PATH="/opt/ros/humble/lib/aarch64-linux-gnu:/opt/ros/humble/lib"
export PYTHONPATH="/opt/ros/humble/lib/python3.10/site-packages:/opt/ros/humble/local/lib/python3.10/dist-packages"
export PATH="/opt/ros/humble/bin:$PATH"
. /opt/ros/humble/setup.sh 2>/dev/null
. /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true

if python3 - "$SCAN_TOPIC" "$TIMEOUT_SEC" "$MAPPING_MODE" "$LOCALIZATION_BACKEND" "$WATCH_MODE" "$BRIDGE_HEALTH_URL" "$UNHEALTHY_GRACE_SEC" "$SCRIPT_DIR" "$EXPECTED_OWNER_MODE" "$READINESS_FILE" <<'PY'
import json
import os
import sys
import time
import urllib.error
import urllib.request

import rclpy
from lifecycle_msgs.srv import GetState
from nav2_msgs.action import NavigateToPose
from nav_msgs.msg import Odometry
from rclpy.action import ActionClient
from rclpy.qos import qos_profile_sensor_data
from rclpy.time import Time
from sensor_msgs.msg import LaserScan
from tf2_ros import Buffer, TransformListener

sys.path.insert(0, sys.argv[8])
from nav2_readiness_logic import (
    PERMITTED_CMD_VEL_PUBLISHERS,
    PERMITTED_CMD_VEL_RAW_PUBLISHERS,
    PERMITTED_MAPPING_CMD_VEL_CONSUMERS,
    PERMITTED_MAPPING_CMD_VEL_NAV_PUBLISHERS,
    REQUIRED_CMD_VEL_CONSUMERS,
    REQUIRED_CMD_VEL_NAV_CONSUMERS,
    REQUIRED_CMD_VEL_NAV_PUBLISHERS,
    REQUIRED_CMD_VEL_RAW_CONSUMERS,
    REQUIRED_SAFETY_SCAN_CONSUMERS,
    ReadinessHysteresis,
    node_identities_exactly,
    node_names_present,
    single_anonymous_endpoint_matches_live_node,
)

scan_topic = sys.argv[1]
timeout_sec = max(float(sys.argv[2]), 1.0)
mapping_mode = sys.argv[3] == "1"
backend = sys.argv[4].lower()
watch_mode = sys.argv[5] == "watch"
bridge_health_url = sys.argv[6]
unhealthy_grace_sec = max(float(sys.argv[7]), 1.0)
expected_owner_mode = sys.argv[9]
readiness_file = sys.argv[10]

rclpy.init(args=None)
node = rclpy.create_node("robodoge_nav2_supervisor" if watch_mode else "robodoge_nav2_readiness")
action_client = ActionClient(node, NavigateToPose, "navigate_to_pose")
sample_times = {"odom": None, "scan": None}


def on_odom(_msg):
    sample_times["odom"] = time.monotonic()


def on_scan(_msg):
    sample_times["scan"] = time.monotonic()


odom_subscription = node.create_subscription(Odometry, "/odom", on_odom, qos_profile_sensor_data)
scan_subscription = node.create_subscription(LaserScan, scan_topic, on_scan, qos_profile_sensor_data)
tf_buffer = Buffer()
tf_listener = TransformListener(tf_buffer, node, spin_thread=False)
lifecycle_nodes = ("velocity_smoother", "collision_monitor")
if not mapping_mode:
    lifecycle_nodes = (
        "controller_server",
        "planner_server",
        "behavior_server",
        "bt_navigator",
        *lifecycle_nodes,
        "map_server",
    )
if backend == "amcl" and not mapping_mode:
    lifecycle_nodes += ("amcl",)
lifecycle_clients = {
    name: node.create_client(GetState, f"/{name}/get_state") for name in lifecycle_nodes
}
pending_states = {}
last_state_request = {name: 0.0 for name in lifecycle_nodes}
lifecycle_states = {name: False for name in lifecycle_nodes}
lifecycle_service_ready = {name: False for name in lifecycle_nodes}

SAMPLE_MAX_AGE_SEC = 2.0
TF_MAX_AGE_SEC = 2.0
STABLE_READY_SEC = 2.0
BRIDGE_CHECK_INTERVAL_SEC = 1.0
started_at = time.monotonic()
readiness_gate = ReadinessHysteresis(
    started_at=started_at,
    startup_timeout_sec=timeout_sec,
    unhealthy_grace_sec=unhealthy_grace_sec,
    stable_ready_sec=STABLE_READY_SEC,
)
ready_announced = False
action_ready = False
odom_ready = False
scan_ready = False
tf_ready = False
odom_tf_ready = False
localization_tf_ready = False
scan_subscribers_ready = False
gait_adapter_ready = False
gait_consumer_ready = False
velocity_input_chain_ready = False
bridge_ready = False
last_bridge_check = 0.0


def sample_is_fresh(name, now):
    received_at = sample_times[name]
    return received_at is not None and now - received_at <= SAMPLE_MAX_AGE_SEC


def transform_is_fresh(transform):
    stamp = transform.header.stamp
    stamp_ns = int(stamp.sec) * 1_000_000_000 + int(stamp.nanosec)
    if stamp_ns <= 0:
        return False
    age_sec = (node.get_clock().now().nanoseconds - stamp_ns) / 1_000_000_000.0
    return -0.25 <= age_sec <= TF_MAX_AGE_SEC


def odom_tf_is_fresh():
    try:
        return transform_is_fresh(
            tf_buffer.lookup_transform("odom", "base_link", Time())
        )
    except Exception:
        return False


def localization_tf_is_fresh():
    try:
        map_to_base = tf_buffer.lookup_transform("map", "base_link", Time())
        map_to_odom = tf_buffer.lookup_transform("map", "odom", Time())
        return transform_is_fresh(map_to_base) and transform_is_fresh(map_to_odom)
    except Exception:
        return False


def refresh_bridge(now):
    global bridge_ready, last_bridge_check
    if now - last_bridge_check < BRIDGE_CHECK_INTERVAL_SEC:
        return
    last_bridge_check = now
    try:
        request = urllib.request.Request(bridge_health_url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=0.8) as response:
            payload = json.loads(response.read(65536).decode("utf-8"))
        bridge_ready = (
            response.getcode() == 200
            and payload.get("ok") is True
            and payload.get("mode") == "http-to-dogzillalib"
            and payload.get("endpoint") == "/nav2/cmd_vel"
            and payload.get("sourceTopic") == "/cmd_vel"
            and payload.get("runtimeAvailable") is True
        )
    except (OSError, ValueError, urllib.error.URLError):
        bridge_ready = False


def update_lifecycle_states(now):
    for name, client in lifecycle_clients.items():
        service_ready = client.service_is_ready()
        lifecycle_service_ready[name] = service_ready
        pending = pending_states.get(name)
        if pending is not None and pending[0].done():
            pending_states.pop(name)
            try:
                state = pending[0].result().current_state
                state_id = int(getattr(state, "id", 0) or 0)
                label = str(getattr(state, "label", "") or "").lower()
                active = state_id == 3 or label == "active"
                lifecycle_states[name] = active
            except Exception:
                lifecycle_states[name] = False
        elif pending is not None and now - pending[1] >= 2.0:
            pending[0].cancel()
            pending_states.pop(name)
            lifecycle_states[name] = False
        if (
            name not in pending_states
            and now - last_state_request[name] >= 1.0
            and service_ready
        ):
            pending_states[name] = (client.call_async(GetState.Request()), now)
            last_state_request[name] = now
        elif name not in pending_states and not service_ready:
            lifecycle_states[name] = False


def has_gait_consumer():
    endpoints = node.get_subscriptions_info_by_topic("/cmd_vel")
    exact_consumers = (REQUIRED_CMD_VEL_CONSUMERS,)
    if mapping_mode:
        exact_consumers += (PERMITTED_MAPPING_CMD_VEL_CONSUMERS,)
    return any(node_identities_exactly(endpoints, consumers) for consumers in exact_consumers) or (
        single_anonymous_endpoint_matches_live_node(
            endpoints,
            node.get_node_names_and_namespaces(),
            next(iter(REQUIRED_CMD_VEL_CONSUMERS)),
        )
    )


def has_exclusive_collision_monitor_publisher():
    return node_identities_exactly(
        node.get_publishers_info_by_topic("/cmd_vel"),
        PERMITTED_CMD_VEL_PUBLISHERS,
    )


def velocity_input_chain_is_ready():
    nav_publishers = node.get_publishers_info_by_topic("/cmd_vel_nav")
    nav_publishers_ready = node_identities_exactly(
        nav_publishers,
        REQUIRED_CMD_VEL_NAV_PUBLISHERS,
    )
    if mapping_mode:
        nav_publishers_ready = (
            not nav_publishers
            or node_identities_exactly(
                nav_publishers,
                PERMITTED_MAPPING_CMD_VEL_NAV_PUBLISHERS,
            )
        )
    return all(
        (
            nav_publishers_ready,
            node_identities_exactly(
                node.get_subscriptions_info_by_topic("/cmd_vel_nav"),
                REQUIRED_CMD_VEL_NAV_CONSUMERS,
            ),
            node_identities_exactly(
                node.get_publishers_info_by_topic("/cmd_vel_raw"),
                PERMITTED_CMD_VEL_RAW_PUBLISHERS,
            ),
            node_identities_exactly(
                node.get_subscriptions_info_by_topic("/cmd_vel_raw"),
                REQUIRED_CMD_VEL_RAW_CONSUMERS,
            ),
        )
    )



def publish_readiness():
    blockers = []
    gates = (
        ("action_server", action_ready),
        ("odom", odom_ready),
        ("scan", scan_ready),
        ("tf", tf_ready),
        ("scan_subscribers", scan_subscribers_ready),
        ("velocity_input", velocity_input_chain_ready),
        ("gait_adapter", gait_adapter_ready),
        ("gait_consumer", gait_consumer_ready),
        ("bridge", bridge_ready),
        ("lifecycle", lifecycle_ready),
        ("lifecycle_services", lifecycle_services_ready),
    )
    blockers.extend(name for name, ready in gates if not ready)
    payload = {
        "schemaVersion": 2,
        "checkedAt": time.time(),
        "ownerMode": expected_owner_mode,
        "readinessState": readiness_state,
        "blockers": blockers,
        "actionServerAvailable": bool(action_ready),
        "stackActive": bool(lifecycle_ready),
        "lifecycleServicesReady": bool(lifecycle_services_ready),
        "missingLifecycleNodes": [name for name, active in lifecycle_states.items() if not active],
        "missingLifecycleServices": [name for name, ready in lifecycle_service_ready.items() if not ready],
        "odomFresh": bool(odom_ready),
        "odomTfFresh": bool(odom_tf_ready),
        "localizationTfFresh": bool(localization_tf_ready),
        "tfFresh": bool(tf_ready),
        "scanFresh": bool(scan_ready),
        "scanSubscribersReady": bool(scan_subscribers_ready),
        "velocityInputReady": bool(velocity_input_chain_ready),
        "gaitAdapterReady": bool(gait_adapter_ready),
        "gaitConsumerReady": bool(gait_consumer_ready),
        "bridgeReady": bool(bridge_ready),
        "waypointReady": bool(full_ready and expected_owner_mode == "normal"),
    }
    os.makedirs(os.path.dirname(readiness_file) or ".", exist_ok=True)
    temporary = f"{readiness_file}.tmp.{os.getpid()}"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":")); handle.write("\n")
    os.replace(temporary, readiness_file)
    # The direct bridge runs as pi while this watcher runs as container root;
    # readiness is diagnostics-only, so its atomic snapshot must be readable
    # across that boundary. The owner-generation record remains 0600.
    os.chmod(readiness_file, 0o644)

def state_line(prefix):
    missing_lifecycle = ",".join(name for name, active in lifecycle_states.items() if not active)
    missing_lifecycle_services = ",".join(
        name for name, ready in lifecycle_service_ready.items() if not ready
    )
    return (
        f"{prefix} action={action_ready} odom={odom_ready} scan={scan_ready} "
        f"lifecycle={missing_lifecycle} lifecycle_services={missing_lifecycle_services} "
        f"tf={tf_ready} odom_tf={odom_tf_ready} localization_tf={localization_tf_ready} "
        f"scan_subscribers={scan_subscribers_ready} velocity_input={velocity_input_chain_ready} "
        f"gait_adapter={gait_adapter_ready} gait_consumer={gait_consumer_ready} "
        f"bridge={bridge_ready}"
    )


try:
    while True:
        rclpy.spin_once(node, timeout_sec=0.2)
        now = time.monotonic()
        action_ready = mapping_mode or action_client.wait_for_server(timeout_sec=0.0)
        odom_ready = sample_is_fresh("odom", now)
        scan_ready = sample_is_fresh("scan", now)
        odom_tf_ready = odom_tf_is_fresh()
        localization_tf_ready = localization_tf_is_fresh()
        tf_ready = odom_tf_ready and localization_tf_ready
        scan_subscribers_ready = node_names_present(
            node.get_subscriptions_info_by_topic(scan_topic),
            REQUIRED_SAFETY_SCAN_CONSUMERS,
        )
        # The adapter must always consume /cmd_vel. Navigate mode additionally
        # requires collision_monitor to exclusively own the publisher side.
        gait_adapter_ready = node.count_subscribers("/cmd_vel") > 0 and has_gait_consumer()
        gait_consumer_ready = gait_adapter_ready and has_exclusive_collision_monitor_publisher()
        velocity_input_chain_ready = velocity_input_chain_is_ready()
        refresh_bridge(now)
        update_lifecycle_states(now)
        lifecycle_ready = all(lifecycle_states.values())
        lifecycle_services_ready = all(lifecycle_service_ready.values())
        full_ready = (
            action_ready
            and odom_ready
            and scan_ready
            and tf_ready
            and scan_subscribers_ready
            and velocity_input_chain_ready
            and gait_consumer_ready
            and bridge_ready
            and lifecycle_ready
            and lifecycle_services_ready
        )
        readiness_state = readiness_gate.update(now, expected_ready=full_ready)

        publish_readiness()

        if readiness_state == "ready" and not ready_announced:
            print("READY", flush=True)
            if not watch_mode:
                raise SystemExit(0)
            ready_announced = True
        elif readiness_state == "recovered":
            print(state_line("RECOVERED"), flush=True)
        elif readiness_state == "degraded":
            print(state_line("DEGRADED"), flush=True)
        elif readiness_state == "unhealthy":
            print(
                f"UNHEALTHY action={action_ready} odom={odom_ready} scan={scan_ready} "
                f"lifecycle={lifecycle_ready} lifecycle_services={lifecycle_services_ready} "
                f"tf={tf_ready} odom_tf={odom_tf_ready} localization_tf={localization_tf_ready} "
                f"scan_subscribers={scan_subscribers_ready} velocity_input={velocity_input_chain_ready} "
                f"gait_adapter={gait_adapter_ready} gait_consumer={gait_consumer_ready} bridge={bridge_ready}",
                flush=True,
            )
            raise SystemExit(1)
        elif readiness_state == "timeout":
            print(state_line("TIMEOUT"), flush=True)
            raise SystemExit(1)
finally:
    for pending, _started_at in pending_states.values():
        pending.cancel()
    action_client.destroy()
    node.destroy_node()
    rclpy.shutdown()
PY
then
  exit 0
else
  status=$?
fi

tail -80 "$REMOTE_ROOT/logs/nav2-navigation.log" 2>/dev/null || true
exit "$status"
