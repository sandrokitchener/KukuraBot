from __future__ import annotations

import argparse
import json
import math
import os
import shlex
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


_NAV_MODE_LOCK = threading.Lock()
# idle: direct bridge, audio, camera optional; no Nav2; no Cartographer burn unless UI explicitly localizing.
# localize: one Cartographer localization process only.
# navigate: one Cartographer + Nav2 + scan filter + gait adapter.
# sleep: stop map-pose/Nav2/rosbridge-heavy work.
_NAV_MODE: str = os.environ.get("DOGZILLA_DEFAULT_NAV_MODE", "idle")
_NAV_MODE_HISTORY: deque[dict[str, Any]] = deque(maxlen=20)
_NAV_MODE_TRANSITIONING = False
_NAV_MODE_AUTO_DEMOTE_TIMER: threading.Timer | None = None
_NAV_MODE_IDLE_DELAY_SEC = float(os.environ.get("DOGZILLA_NAV_MODE_IDLE_DELAY_SEC", "300.0"))
CONTAINER_NAME = os.environ.get("DOGZILLA_CONTAINER", "robodoge-rosbridge")
MAP_POSE_CONTAINER = os.environ.get("DOGZILLA_MAP_POSE_CONTAINER", "robodoge-map-pose")
REMOTE_ROOT = os.environ.get("REMOTE_ROOT", "/home/pi/robodoge")
MAP_ORIGIN_FILE = Path(os.environ.get(
    "DOGZILLA_MAP_ORIGIN_FILE",
    f"{REMOTE_ROOT}/output/app-cache/dogzilla-map-origin.json",
))
YOLO_SERVICE = "robodoge-yolo-vision.service"
NAV2_LIFECYCLE_NODE = "lifecycle_manager_navigation"
CARTOGRAPHER_NODE = "cartographer_node"
SCAN_FILTER_PROCESSES = ["scan_filter_supervisor", "scan_self_filter"]


def _run(cmd: str, timeout: float = 15.0) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except subprocess.TimeoutExpired as e:
        return -1, f"timed out after {timeout}s: {e.output or ''} {e.stderr or ''}"
    except OSError as e:
        return -1, str(e)


def _docker_env_args(env: dict[str, Any]) -> str:
    parts: list[str] = []
    for key, value in env.items():
        if value is None:
            continue
        parts.extend(["-e", f"{key}={value}"])
    return " ".join(shlex.quote(part) for part in parts)


def _load_saved_initial_pose_env() -> dict[str, str]:
    env = {
        "DOGZILLA_DOCKER_EXEC": "1",
        "REMOTE_ROOT": REMOTE_ROOT,
        "POSE_PORT": os.environ.get("POSE_PORT", "9090"),
        "ROS_DOMAIN_ID": os.environ.get("ROS_DOMAIN_ID", "16"),
        "DOGZILLA_MAP_POSE_MODE": "localization",
    }
    try:
        origin = json.loads(MAP_ORIGIN_FILE.read_text(encoding="utf-8"))
        x = float(origin["x"])
        y = float(origin["y"])
        yaw = float(origin["yaw"])
        if not all(math.isfinite(value) for value in (x, y, yaw)):
            raise ValueError("saved map origin contains non-finite pose")
        env.update({
            "DOGZILLA_FORCE_RESTART": "1",
            "DOGZILLA_INITIAL_POSE_X": str(x),
            "DOGZILLA_INITIAL_POSE_Y": str(y),
            "DOGZILLA_INITIAL_POSE_YAW": str(yaw),
        })
    except Exception as exc:
        env["DOGZILLA_INITIAL_POSE_SKIP"] = "1"
        env["DOGZILLA_INITIAL_POSE_ERROR"] = str(exc)[:120]
    return env


def _valid_nav_mode(mode: str) -> bool:
    return mode in ("idle", "localize", "navigate", "sleep")


def get_nav_mode() -> str:
    with _NAV_MODE_LOCK:
        return str(_NAV_MODE)


def nav_mode_snapshot() -> dict[str, Any]:
    with _NAV_MODE_LOCK:
        return {
            "mode": _NAV_MODE,
            "transitioning": _NAV_MODE_TRANSITIONING,
            "idleDelaySec": _NAV_MODE_IDLE_DELAY_SEC,
            "history": list(_NAV_MODE_HISTORY),
        }


def _record_nav_mode_transition(previous: str, mode: str, detail: dict[str, Any] | None = None) -> None:
    with _NAV_MODE_LOCK:
        _NAV_MODE_HISTORY.appendleft({
            "at": utc_now(),
            "from": previous,
            "to": mode,
            "detail": detail or {},
        })


def _set_nav_mode(mode: str, detail: dict[str, Any] | None = None) -> None:
    global _NAV_MODE
    with _NAV_MODE_LOCK:
        previous = _NAV_MODE
        _NAV_MODE = mode
    _record_nav_mode_transition(previous, mode, detail)


def set_nav_mode(mode: str) -> dict[str, Any]:
    global _NAV_MODE_TRANSITIONING
    mode = str(mode).lower().strip()
    if not _valid_nav_mode(mode):
        return {"ok": False, "error": f"invalid_nav_mode:{mode}", "validModes": ["idle", "localize", "navigate", "sleep"]}

    with _NAV_MODE_LOCK:
        if _NAV_MODE_TRANSITIONING:
            return {"ok": False, "error": "nav_mode_transition_in_progress", "mode": _NAV_MODE}
        current = _NAV_MODE
        if current == mode:
            return {"ok": True, "mode": mode, "changed": False}
        _NAV_MODE_TRANSITIONING = True

    try:
        if mode == "sleep":
            result = _enter_sleep_mode()
        elif mode == "idle":
            result = _enter_idle_mode()
        elif mode == "localize":
            result = _enter_localize_mode()
        elif mode == "navigate":
            result = _enter_navigate_mode()
        else:
            result = {"ok": False, "error": f"unhandled_nav_mode:{mode}"}

        if result.get("ok"):
            _set_nav_mode(mode, result)
            # After any explicit mode set, schedule demotion to idle after inactivity.
            _schedule_nav_mode_demote(target_mode="idle")
        return {**result, "mode": get_nav_mode(), "previousMode": current, "changed": result.get("ok")}
    finally:
        with _NAV_MODE_LOCK:
            _NAV_MODE_TRANSITIONING = False


def _enter_sleep_mode() -> dict[str, Any]:
    stopped: list[dict[str, Any]] = []

    code, out = _run(f"docker exec {CONTAINER_NAME} pkill -f imu_publisher")
    stopped.append({"service": "imu_publisher", "stopped": code == 0 or code == 1, "output": out.strip()})

    code, out = _run(f"docker exec {CONTAINER_NAME} pkill -f {CARTOGRAPHER_NODE}")
    stopped.append({"service": "cartographer", "stopped": code == 0 or code == 1, "output": out.strip()})

    code, out = _run(f"docker exec {CONTAINER_NAME} pkill -f {NAV2_LIFECYCLE_NODE}")
    stopped.append({"service": "nav2", "stopped": code == 0 or code == 1, "output": out.strip()})

    for proc in SCAN_FILTER_PROCESSES:
        code, out = _run(f"docker exec {CONTAINER_NAME} pkill -f {proc}")
        stopped.append({"service": proc, "stopped": code == 0 or code == 1, "output": out.strip()})

    code, out = _run(f"sudo systemctl stop {YOLO_SERVICE}")
    stopped.append({"service": "yolo-vision", "stopped": code == 0, "output": out.strip()})

    _cancel_nav_mode_demote()
    return {"ok": True, "stopped": stopped, "stoppedCount": len([s for s in stopped if s["stopped"]])}


def _enter_idle_mode() -> dict[str, Any]:
    # Keep direct bridge, audio, camera optional. Stop heavy nav work.
    result = _enter_sleep_mode()
    return {"ok": True, **result, "note": "idle keeps bridge/audio/camera; nav stack stopped"}


def _enter_localize_mode() -> dict[str, Any]:
    # Ensure nav2 is not running, then start cartographer/map-pose only.
    nav2_stop = _stop_nav2()
    scan_stop = _stop_scan_filter()
    carto_start = _start_map_pose()
    yolo_start = _start_yolo()
    return {
        "ok": True,
        "started": [carto_start, yolo_start],
        "stopped": [nav2_stop, scan_stop],
    }


def _enter_navigate_mode() -> dict[str, Any]:
    # Full navigation stack: cartographer + Nav2 + scan filter.
    carto_start = _start_map_pose()
    nav2_start = _start_nav2()
    yolo_start = _start_yolo()
    started = [carto_start, nav2_start, yolo_start]
    required_failures = [
        service
        for service in (carto_start, nav2_start)
        if not service.get("started")
    ]
    result = {"ok": not required_failures, "started": started}
    if required_failures:
        result["error"] = "navigation_stack_start_failed"
        result["failed"] = required_failures
    return result


def _start_map_pose() -> dict[str, Any]:
    env_args = _docker_env_args(_load_saved_initial_pose_env())
    script_path = f"{REMOTE_ROOT}/sidecars/dogzilla_map_pose/start-map-pose-in-container.sh"
    primary_cmd = f"docker exec {env_args} {shlex.quote(MAP_POSE_CONTAINER)} bash {shlex.quote(script_path)}"
    code, out = _run(primary_cmd, timeout=180.0)
    container = MAP_POSE_CONTAINER
    if code != 0 and ("No such container" in out or "is not running" in out):
        fallback_cmd = f"docker exec {env_args} {shlex.quote(CONTAINER_NAME)} bash {shlex.quote(script_path)}"
        code, out = _run(fallback_cmd, timeout=180.0)
        container = CONTAINER_NAME
    return {
        "service": "cartographer",
        "started": code == 0,
        "container": container,
        "originFile": str(MAP_ORIGIN_FILE),
        "output": out.strip()[:200],
    }


def _start_nav2() -> dict[str, Any]:
    code, out = _run(
        f"docker exec {CONTAINER_NAME} bash /home/pi/robodoge/sidecars/dogzilla_navigation/start-navigation-in-container.sh",
        timeout=180.0,
    )
    return {"service": "nav2", "started": code == 0, "output": out.strip()[:200]}


def _start_yolo() -> dict[str, Any]:
    code, out = _run(f"sudo systemctl start {YOLO_SERVICE}")
    return {"service": "yolo-vision", "started": code == 0, "output": out.strip()}


def _stop_nav2() -> dict[str, Any]:
    code, out = _run(f"docker exec {CONTAINER_NAME} pkill -f {NAV2_LIFECYCLE_NODE}")
    return {"service": "nav2", "stopped": code == 0 or code == 1, "output": out.strip()}


def _stop_scan_filter() -> dict[str, Any]:
    stopped: list[dict[str, Any]] = []
    for proc in SCAN_FILTER_PROCESSES:
        code, out = _run(f"docker exec {CONTAINER_NAME} pkill -f {proc}")
        stopped.append({"service": proc, "stopped": code == 0 or code == 1, "output": out.strip()})
    return {"service": "scan-filter", "stopped": all(s["stopped"] for s in stopped), "details": stopped}


def _schedule_nav_mode_demote(target_mode: str = "idle") -> None:
    global _NAV_MODE_AUTO_DEMOTE_TIMER
    _cancel_nav_mode_demote()
    if _NAV_MODE_IDLE_DELAY_SEC > 0:
        _NAV_MODE_AUTO_DEMOTE_TIMER = threading.Timer(_NAV_MODE_IDLE_DELAY_SEC, _nav_mode_demote_callback, args=(target_mode,))
        _NAV_MODE_AUTO_DEMOTE_TIMER.daemon = True
        _NAV_MODE_AUTO_DEMOTE_TIMER.start()


def _cancel_nav_mode_demote() -> None:
    global _NAV_MODE_AUTO_DEMOTE_TIMER
    if _NAV_MODE_AUTO_DEMOTE_TIMER is not None:
        _NAV_MODE_AUTO_DEMOTE_TIMER.cancel()
        _NAV_MODE_AUTO_DEMOTE_TIMER = None


def _nav_mode_demote_callback(target_mode: str) -> None:
    result = set_nav_mode(target_mode)
    print(f"[auto-nav-mode] {json.dumps(result)}")


# Legacy sleep/wake helpers now expressed as mode transitions.
def sleep_pi() -> dict[str, Any]:
    return set_nav_mode("sleep")


def wake_pi() -> dict[str, Any]:
    return set_nav_mode("localize")


def sleep_status() -> dict[str, Any]:
    snap = nav_mode_snapshot()
    return {"ok": True, "sleeping": snap["mode"] == "sleep", "mode": snap["mode"]}


def _schedule_auto_sleep(restart: bool = False) -> None:
    _schedule_nav_mode_demote(target_mode="idle")


def _cancel_auto_sleep() -> None:
    _cancel_nav_mode_demote()


def _auto_sleep_callback() -> None:
    result = sleep_pi()
    print(f"[auto-sleep] {json.dumps(result)}")


ROOT_DIR = Path(__file__).resolve().parents[2]
BRIDGE_DIR = Path(__file__).resolve().parent
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

import map_metadata as map_metadata_module
from lidar_avoidance import (
    DEFAULT_LIDAR_AVOIDANCE_COMMAND,
    DEFAULT_LIDAR_AVOIDANCE_ENABLED,
    DEFAULT_LIDAR_AVOIDANCE_TIMEOUT,
    DEFAULT_LIDAR_SCAN_WAIT_TIMEOUT,
    LIDAR_AVOIDANCE_DOC_COMMAND,
    LIDAR_AVOIDANCE_NODE,
    LIDAR_AVOIDANCE_PACKAGE,
    LIDAR_AVOIDANCE_START_COMMAND,
    NAV2_COSTMAP_LIDAR_MODE,
    LidarAvoidanceSupervisor,
    parse_ros_topic_count,
)
from map_metadata import (
    DEFAULT_MAP_METADATA_FILE,
    DEFAULT_MAP_YAML_FILE,
    file_identity,
    hash_map_identity,
    read_pgm_size,
    read_ros_map_yaml,
    sha256_file,
)

from motion_utils import clamp, normalize_angle, scan_obstacle_counts
from nav2_gait_adapter import (
    DEFAULT_NAV2_GAIT_ALLOW_TROT,
    DEFAULT_NAV2_GAIT_MAX_TURN_RATE,
    get_speed_config,
    nav2_cmd_vel_to_locomotion,
    update_speed_config,
)
import nav2_client as nav2_client_module
from nav2_client import (
    DEFAULT_NAV2_ACTION,
    DEFAULT_NAV2_ALLOWED_FRAMES,
    DEFAULT_NAV2_DOCKER_STATUS_TIMEOUT,
    DEFAULT_NAV2_GOAL_RESPONSE_TIMEOUT,
    DEFAULT_NAV2_ODOM_WAIT_TIMEOUT,
    DEFAULT_NAV2_SCAN_TOPIC,
    DEFAULT_NAV2_SEND_GOAL_DOCKER_ENABLED,
    DEFAULT_NAV2_STATUS_WAIT_TIMEOUT,
    DEFAULT_NAV2_WAIT_TIMEOUT,
    DEFAULT_ODOM_TOPIC,
    Nav2NavigateClient,
)
from process_utils import parse_json_process_output, summarize_process_text

LOG_FILE = Path(__file__).resolve().with_name("command_log.ndjson")
ROBOT_ID_FILE = ROOT_DIR / "robot_id.txt"
ROBOT_NAME_FILE = ROOT_DIR / "robot_name.txt"
DEFAULT_ROBOT_NAME = "Questing Beast"
DEFAULT_HOST = os.environ.get("DOGZILLA_LIB_BRIDGE_HOST", "0.0.0.0")
DEFAULT_PORT = int(os.environ.get("DOGZILLA_LIB_BRIDGE_PORT", "8893"))
DEFAULT_SERIAL_PORT = os.environ.get(
    "DOGZILLA_ROBOT_SERIAL_PORT",
    os.environ.get("DOGZILLA_SERIAL_PORT", "/dev/ttyAMA0"),
)
DEFAULT_DRY_RUN = os.environ.get("DOGZILLA_DIRECT_DRY_RUN", "1") != "0"
DEFAULT_EXPECTED_ROS_DOMAIN_ID = os.environ.get("DOGZILLA_EXPECTED_ROS_DOMAIN_ID", "16")
DEFAULT_INCLUDE_ATTITUDE_STATE = os.environ.get("DOGZILLA_INCLUDE_ATTITUDE_STATE", "0") == "1"
DEFAULT_INCLUDE_SLOW_STATE = os.environ.get("DOGZILLA_INCLUDE_SLOW_STATE", "0") == "1"
DEFAULT_ASYNC_HTTP_GOTO = os.environ.get("DOGZILLA_ASYNC_HTTP_GOTO", "1") == "1"
DEFAULT_NAV2_MIN_BATTERY_PCT = float(os.environ.get("DOGZILLA_NAV2_MIN_BATTERY_PCT", "5"))
DEFAULT_NO_MOTION_WINDOW_SEC = float(os.environ.get("DOGZILLA_NO_MOTION_WINDOW_SEC", "10.0"))
DEFAULT_NAV2_PROMOTE_TIMEOUT_SEC = float(os.environ.get("DOGZILLA_NAV2_PROMOTE_TIMEOUT_SEC", "45.0"))
DEFAULT_NAV2_PROMOTE_POLL_SEC = float(os.environ.get("DOGZILLA_NAV2_PROMOTE_POLL_SEC", "2.0"))

MAX_RECENT_COMMANDS = int(os.environ.get("DOGZILLA_LIB_BRIDGE_HISTORY", "20"))
ROS_SETUP_COMMAND = (
    "source /opt/ros/humble/setup.bash 2>/dev/null || true; "
    "source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || "
    "source /home/pi/yahboomcar_ws/install/setup.bash 2>/dev/null || "
    "source /home/yahboom/yahboomcar_ws/install/setup.bash 2>/dev/null || true"
)
VENDOR_PATHS = [
    ROOT_DIR / "vendor" / "DOGZILLALib",
    ROOT_DIR / "vendor" / "DOGZILLA",
    Path("/home/pi/DOGZILLA"),
    Path("/home/pi/DOGZILLA/DOGZILLALib"),
    Path("/home/yahboom/DOGZILLA"),
    Path("/home/yahboom/DOGZILLA/DOGZILLALib"),
]
VENDOR_MODULE_CANDIDATES = [
    "DOGZILLALib.DOGZILLALib",
    "DOGZILLALib",
    "dogzilla",
]
VENDOR_FACTORY_CANDIDATES = ["DOGZILLA", "Dogzilla", "dogzilla"]
STUDY_HINTS = {
    "expectedRosDomainId": DEFAULT_EXPECTED_ROS_DOMAIN_ID,
    "pi5DockerEntry": "./run_humble.sh",
    "bringupLaunch": "ros2 launch bringup Navigation_bringup.launch.py",
    "lidarAvoidance": LIDAR_AVOIDANCE_DOC_COMMAND,
    "cameraTopicFromAppDocs": "/usb_cam/imge_raw/compress",
    "knownConflict": "Yahboom APP/control startup can occupy camera/control resources; stop it before direct bridge live tests.",
}

ACTION_ALIASES = {
    "lie_down": 1,
    "lie": 1,
    "stand_up": 2,
    "stand": 2,
    "sit_down": 12,
    "sit": 12,
    "reset": 255,
    "reset_pose": 255,
    "stop": 255,
    "startup_stretch": 14,
    "stretch": 14,
    "three_axis": 10,
    "3_axis": 10,
    "swing": 16,
    "shake": 19,
    "handshake": 19,
    "paw_shake": 19,
    "shake_paw": 19,
    "give_paw": 19,
    "pee": 11,
    "crawl": 3,
    "pray": 17,
}


def read_active_map_metadata() -> dict[str, Any]:
    return map_metadata_module.read_active_map_metadata(DEFAULT_MAP_METADATA_FILE, DEFAULT_MAP_YAML_FILE)


def validate_goal_inside_active_map(frame: str, x: float, y: float, source_frame: str = "") -> dict[str, Any]:
    return map_metadata_module.validate_goal_inside_active_map(
        frame,
        x,
        y,
        source_frame,
        DEFAULT_MAP_METADATA_FILE,
        DEFAULT_MAP_YAML_FILE,
    )


def get_nav2_waypoint_prerequisites(nav2_client: Any) -> dict[str, Any]:
    snapshot_fn = getattr(nav2_client, "snapshot", None)
    if not callable(snapshot_fn):
        return {"ok": True, "checked": False, "reason": "nav2_snapshot_unavailable"}

    snapshot = snapshot_fn()
    if snapshot.get("waypointReady") is True:
        return {"ok": True, "checked": True, "nav2": snapshot}

    blockers = snapshot.get("blockers") if isinstance(snapshot.get("blockers"), list) else []
    odom = snapshot.get("odom") if isinstance(snapshot.get("odom"), dict) else {}
    if blockers:
        message = "; ".join(str(blocker) for blocker in blockers)
    elif snapshot.get("available") is not True:
        message = snapshot.get("importError") or snapshot.get("serverError") or "Nav2 NavigateToPose action server is not available"
    elif odom and odom.get("available") is not True:
        message = odom.get("error") or f"No publishers on {odom.get('topic') or DEFAULT_ODOM_TOPIC}"
    else:
        message = "Nav2 waypoint prerequisites are not ready"

    return {
        "ok": False,
        "checked": True,
        "message": message,
        "nav2": snapshot,
    }


class DogzillaRuntime:
    def __init__(self, serial_port: str, dry_run: bool):
        self.serial_port = serial_port
        self.dry_run = dry_run
        self.import_error: str | None = None
        self.robot_error: str | None = None
        self.robot = None
        self._lock = threading.Lock()
        self.vendor_paths = load_vendor_paths()
        self.import_attempts: list[dict[str, str]] = []
        self.nav2_client = Nav2NavigateClient(DEFAULT_NAV2_ACTION)
        self.lidar_avoidance = LidarAvoidanceSupervisor()
        self.navigation_cancel = threading.Event()
        self.navigation_event_lock = threading.Lock()
        self.last_locomotion_gait: str | None = None
        self.last_locomotion_pace: str | None = None
        self.nav2_gait_adapter_count = 0
        self.last_nav2_gait_command: dict[str, Any] | None = None
        self.nav2_cmd_vel_blocked = False
        self.nav2_cmd_vel_blocked_reason: str | None = None

        for vendor_path in self.vendor_paths:
            if vendor_path.exists():
                sys.path.insert(0, str(vendor_path))

        self.DOGZILLA = self._load_factory()

    @property
    def available(self) -> bool:
        return self.import_error is None

    def snapshot(self) -> dict[str, Any]:
        nav2 = self.nav2_client.snapshot()
        return {
            **identity_payload(),
            "available": self.available,
            "dryRun": self.dry_run,
            "serialPort": self.serial_port,
            "vendorPaths": [str(path) for path in self.vendor_paths],
            "vendorImportAttempts": self.import_attempts,
            "logFile": str(LOG_FILE),
            "knownActions": ACTION_ALIASES,
            "studyHints": STUDY_HINTS,
            "map": read_active_map_metadata(),
            "nav2": nav2,
            "navigation": self.navigation_snapshot(nav2),
            "lidarAvoidance": self.lidar_avoidance.snapshot() if hasattr(self, "lidar_avoidance") else None,
            "navMode": get_nav_mode(),
            "nav2GaitAdapter": {
                "receivedCount": int(getattr(self, "nav2_gait_adapter_count", 0) or 0),
                "lastCommand": getattr(self, "last_nav2_gait_command", None),
                "blocked": self._nav2_cmd_vel_is_blocked(),
                "blockedReason": getattr(self, "nav2_cmd_vel_blocked_reason", None),
                "endpoint": "/nav2/cmd_vel",
                "sourceTopic": "/cmd_vel",
            },
            "rosDomainId": os.environ.get("ROS_DOMAIN_ID"),
            "expectedRosDomainId": DEFAULT_EXPECTED_ROS_DOMAIN_ID,
            "importError": self.import_error,
            "robotError": self.robot_error,
        }

    def navigation_snapshot(self, nav2: dict[str, Any] | None = None) -> dict[str, Any]:
        nav2 = nav2 if isinstance(nav2, dict) else self.nav2_client.snapshot()
        nav2_available = nav2.get("available") is True
        waypoint_ready = nav2.get("waypointReady") is True
        return {
            "available": waypoint_ready,
            "primary": "nav2" if waypoint_ready else "unavailable",
            "actionServerAvailable": nav2_available,
            "waypointReady": waypoint_ready,
            "blockers": nav2.get("blockers") or [],
            "nav2": nav2,
        }

    def execute(self, canonical_plan: dict[str, Any]) -> dict[str, Any]:
        kind = canonical_plan.get("kind")
        params = canonical_plan.get("params") or {}

        if kind == "state.read":
            return self.read_state()

        if self.dry_run:
            return {"executed": False, "delivery": "dry-run", "kind": kind, "params": params}

        if kind == "noop" and params.get("reason") == "emergency_stop":
            return self._execute_emergency_stop(reason="emergency_stop")

        if kind == "noop" and params.get("reason") == "command_preempt":
            return self._execute_command_preempt()

        if kind == "locomotion.goto":
            cancel_event = self._replace_navigation_cancel_event()
            return self._execute_goto(params, cancel_event=cancel_event)

        if not self.available:
            return {"executed": False, "error": self.import_error or "DOGZILLALib unavailable"}

        if kind != "state.read":
            self.cancel_active_navigation()

        with self._lock:
            robot = self._robot()
            if robot is None:
                return {"executed": False, "error": self.robot_error or "robot unavailable"}

            try:
                if kind == "noop":
                    performance_stopped = stop_performance_mode(robot)
                    robot.stop()
                    return {"executed": True, "delivery": "stop", "performanceStopped": performance_stopped}

                if kind == "locomotion.relative":
                    return self._execute_locomotion(robot, params)

                if kind == "action.once":
                    action_id = resolve_action_id(params)
                    if action_id is None:
                        return {
                            "executed": False,
                            "error": "action.once missing actionId or known action name",
                            "knownActions": ACTION_ALIASES,
                        }
                    performance_stopped = stop_performance_mode(robot)
                    robot.action(action_id)
                    return {
                        "executed": True,
                        "delivery": "DOGZILLALib",
                        "kind": kind,
                        "actionId": action_id,
                        "performanceStopped": performance_stopped,
                    }

                if kind == "action.loop":
                    enabled = bool(params.get("enabled"))
                    robot.perform(1 if enabled else 0)
                    return {
                        "executed": True,
                        "delivery": "DOGZILLALib",
                        "kind": kind,
                        "enabled": enabled,
                    }

                if kind == "stabilize.set":
                    robot.imu(1 if params.get("enabled") else 0)
                    return {"executed": True, "delivery": "DOGZILLALib", "kind": kind}

                if kind == "pose.body":
                    return self._execute_body_pose(robot, params)

                return {"executed": False, "error": f"unsupported_kind:{kind}"}
            except Exception as error:
                self.robot_error = str(error)
                return {"executed": False, "error": str(error)}

    def execute_nav2_cmd_vel(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        params = nav2_cmd_vel_to_locomotion(payload or {})
        self.nav2_gait_adapter_count = int(getattr(self, "nav2_gait_adapter_count", 0) or 0) + 1

        if self._nav2_cmd_vel_is_blocked() and locomotion_params_have_motion(params):
            result = {
                "executed": False,
                "delivery": "nav2-gait-adapter-blocked",
                "kind": "nav2.cmd_vel.gait_adapter",
                "error": "emergency_stop_active",
                "blocked": True,
                "blockedReason": getattr(self, "nav2_cmd_vel_blocked_reason", None) or "emergency_stop",
                "params": params,
            }
            self.last_nav2_gait_command = {
                "receivedAt": utc_now(),
                "result": result,
            }
            return result

        if self.dry_run:
            result = {
                "executed": False,
                "delivery": "dry-run",
                "kind": "nav2.cmd_vel.gait_adapter",
                "params": params,
            }
            self.last_nav2_gait_command = {
                "receivedAt": utc_now(),
                "result": result,
            }
            return result

        if not self.available:
            result = {
                "executed": False,
                "delivery": "nav2-gait-adapter-unavailable",
                "error": self.import_error or "DOGZILLALib unavailable",
                "params": params,
            }
            self.last_nav2_gait_command = {
                "receivedAt": utc_now(),
                "result": result,
            }
            return result

        with self._lock:
            robot = self._robot()
            if robot is None:
                result = {
                    "executed": False,
                    "delivery": "nav2-gait-adapter-unavailable",
                    "error": self.robot_error or "robot unavailable",
                    "params": params,
                }
                self.last_nav2_gait_command = {
                    "receivedAt": utc_now(),
                    "result": result,
                }
                return result

            try:
                locomotion = self._execute_locomotion(robot, params)
                result = {
                    **locomotion,
                    "delivery": "DOGZILLALib nav2 gait adapter",
                    "kind": "nav2.cmd_vel.gait_adapter",
                    "params": params,
                }
            except Exception as error:
                self.robot_error = str(error)
                result = {
                    "executed": False,
                    "delivery": "nav2-gait-adapter-error",
                    "error": str(error),
                    "params": params,
                }

        self.last_nav2_gait_command = {
            "receivedAt": utc_now(),
            "result": result,
        }
        return result

    def read_state(self) -> dict[str, Any]:
        if not self.available:
            return {**identity_payload(), "executed": False, "error": self.import_error or "DOGZILLALib unavailable"}

        with self._lock:
            robot = self._robot()
            if robot is None:
                return {**identity_payload(), "executed": False, "error": self.robot_error or "robot unavailable"}

            result = {
                **identity_payload(),
                "executed": True,
                "delivery": "DOGZILLALib",
                "dryRun": self.dry_run,
                "battery": None,
                "motors": None,
                "roll": None,
                "pitch": None,
                "yaw": None,
                "imuRaw": None,
                "readErrors": {},
                "readAt": utc_now(),
            }

            # Keep the default state path light. Some vendor serial reads can block
            # when the controller or robot battery is unhealthy.
            state_fields = [
                ("battery", ["read_Battery", "read_battery"]),
            ]
            if DEFAULT_INCLUDE_ATTITUDE_STATE:
                state_fields.extend(
                    [
                        ("roll", ["read_roll", "read_Roll"]),
                        ("pitch", ["read_pitch", "read_Pitch"]),
                        ("yaw", ["read_yaw", "read_Yaw"]),
                    ]
                )
            if DEFAULT_INCLUDE_SLOW_STATE:
                state_fields.extend(
                    [
                        ("motors", ["read_Motor", "read_motor"]),
                        ("imuRaw", ["read_imu_raw", "read_imu"]),
                    ]
                )

            for field, names in state_fields:
                try:
                    result[field] = call_first(robot, names)
                    if field == "battery" and result[field] == 0:
                        result[field] = None
                        result["readErrors"][field] = "read_Battery returned failure sentinel 0"
                except Exception as error:
                    result["readErrors"][field] = str(error)

            if not result["readErrors"]:
                del result["readErrors"]
            return result

    def read_imu(self) -> dict[str, Any]:
        if not self.available:
            return {**identity_payload(), "executed": False, "error": self.import_error or "DOGZILLALib unavailable"}

        result = {
            **identity_payload(),
            "executed": True,
            "delivery": "DOGZILLALib",
            "dryRun": self.dry_run,
            "roll": None,
            "pitch": None,
            "yaw": None,
            "imuRaw": None,
            "readErrors": {},
            "readAt": utc_now(),
        }

        with self._lock:
            robot = self._robot()
            if robot is None:
                return {**identity_payload(), "executed": False, "error": self.robot_error or "robot unavailable"}

            imu_fields = [
                ("roll", ["read_roll", "read_Roll"]),
                ("pitch", ["read_pitch", "read_Pitch"]),
                ("yaw", ["read_yaw", "read_Yaw"]),
                ("imuRaw", ["read_imu_raw", "read_imu"]),
            ]

            for field, names in imu_fields:
                try:
                    result[field] = call_first(robot, names)
                except Exception as error:
                    result["readErrors"][field] = str(error)

            if not result["readErrors"]:
                del result["readErrors"]

        return result

    def _execute_locomotion(self, robot, params: dict[str, Any]) -> dict[str, Any]:
        x_step = clamp(float(params.get("x_step") or 0), -25, 25)
        y_step = clamp(float(params.get("y_step") or 0), -18, 18)
        turn_rate = clamp(float(params.get("turn_rate") or 0), -100, 100)
        pace = params.get("pace")
        gait = params.get("gait")

        if pace in ("normal", "slow", "high") and pace != getattr(self, "last_locomotion_pace", None):
            robot.pace(pace)
            self.last_locomotion_pace = pace
        if gait in ("trot", "walk", "high_walk") and gait != getattr(self, "last_locomotion_gait", None) and hasattr(robot, "gait_type"):
            robot.gait_type(gait)
            self.last_locomotion_gait = gait

        robot.move("x", x_step)
        robot.move("y", y_step)
        robot.turn(turn_rate)
        if x_step == 0 and y_step == 0 and turn_rate == 0:
            robot.stop()
        return {"executed": True, "delivery": "DOGZILLALib", "kind": "locomotion.relative"}

    def _execute_body_pose(self, robot, params: dict[str, Any]) -> dict[str, Any]:
        if "height" in params:
            robot.translation("z", clamp(float(params["height"]), 75, 115))
        for axis, key, low, high in (
            ("x", "body_x", -35, 35),
            ("y", "body_y", -18, 18),
        ):
            if key in params:
                robot.translation(axis, clamp(float(params[key]), low, high))
        for axis, key, low, high in (
            ("r", "roll", -20, 20),
            ("p", "pitch", -15, 15),
            ("y", "yaw", -11, 11),
        ):
            if key in params:
                robot.attitude(axis, clamp(float(params[key]), low, high))
        return {"executed": True, "delivery": "DOGZILLALib", "kind": "pose.body"}

    def _wait_for_nav2_readiness(self, timeout_sec: float, poll_sec: float) -> dict[str, Any]:
        """Poll nav2 snapshot until waypointReady or timeout. Return latest blockers dict."""
        deadline = time.monotonic() + timeout_sec
        latest: dict[str, Any] = {}
        while time.monotonic() < deadline:
            snapshot = self.nav2_client.snapshot()
            latest = snapshot
            if snapshot.get("waypointReady") is True:
                return {"ok": True, "snapshot": snapshot}
            time.sleep(poll_sec)
        return {"ok": False, "snapshot": latest, "blockers": latest.get("blockers", [])}

    def _execute_goto(self, params: dict[str, Any], cancel_event: threading.Event | None = None) -> dict[str, Any]:
        # A fresh goto replaces any previous navigation cancel signal and drops a
        # stale command_preempt gate, but never silently overrides a latched
        # emergency_stop safety block. Clear preempt BEFORE readiness checks so
        # a stale block cannot mask a fresh navigation attempt.
        self._clear_command_preempt_nav2_cmd_vel_block()

        current_mode = get_nav_mode()
        mode_transition: dict[str, Any] | None = None
        if current_mode == "sleep":
            # Sleep requires explicit wake; do not auto-promote.
            return {
                "executed": False,
                "delivery": "rejected",
                "kind": "locomotion.goto",
                "waypoint": params.get("waypoint") or "",
                "waypointSafe": False,
                "error": "Nav mode is sleep; call POST /mode navigate first",
                "navMode": current_mode,
            }
        if current_mode not in ("navigate", "localize"):
            # Auto-promote from idle/localize to navigate, then wait for readiness.
            mode_result = set_nav_mode("navigate")
            if not mode_result.get("ok"):
                return {
                    "executed": False,
                    "delivery": "rejected",
                    "kind": "locomotion.goto",
                    "waypoint": params.get("waypoint") or "",
                    "waypointSafe": False,
                    "error": mode_result.get("error") or "failed to enter navigate mode",
                    "navMode": current_mode,
                    "modeResult": mode_result,
                }
            mode_transition = {
                "from": current_mode,
                "to": "navigate",
                "started": True,
            }
            # Bounded readiness wait with latest blockers.
            readiness = self._wait_for_nav2_readiness(
                DEFAULT_NAV2_PROMOTE_TIMEOUT_SEC, DEFAULT_NAV2_PROMOTE_POLL_SEC
            )
            if not readiness.get("ok"):
                blockers = readiness.get("blockers") or []
                return {
                    "executed": False,
                    "delivery": "rejected",
                    "kind": "locomotion.goto",
                    "waypoint": params.get("waypoint") or "",
                    "waypointSafe": False,
                    "error": "Nav2 promotion timed out; latest blockers: "
                    + ("; ".join(str(b) for b in blockers) if blockers else "unknown"),
                    "navMode": get_nav_mode(),
                    "modeTransition": mode_transition,
                    "blockers": blockers,
                    "snapshot": readiness.get("snapshot"),
                }

        frame = str(params.get("frame") or "map")
        if frame not in DEFAULT_NAV2_ALLOWED_FRAMES:
            return {"executed": False, "error": f"unsupported_navigation_frame:{frame}"}

        try:
            x = float(params.get("x"))
            y = float(params.get("y"))
            yaw = normalize_angle(float(params.get("yaw") or 0.0))
        except (TypeError, ValueError) as error:
            return {"executed": False, "error": f"invalid_navigation_pose:{error}"}

        if not all(math.isfinite(value) for value in (x, y, yaw)):
            return {"executed": False, "error": "invalid_navigation_pose:non_finite"}

        source_frame = str(params.get("sourceFrame") or "")
        map_validation = validate_goal_inside_active_map(frame, x, y, source_frame=source_frame)
        if not map_validation.get("ok"):
            return {
                "executed": False,
                "delivery": "waypoint-map-blocked",
                "kind": "locomotion.goto",
                "waypoint": params.get("waypoint") or "",
                "waypointSafe": False,
                "error": map_validation.get("message") or "waypoint target is not valid for active map",
                "mapValidation": map_validation,
            }

        nav_prerequisites = get_nav2_waypoint_prerequisites(self.nav2_client)
        if not nav_prerequisites.get("ok"):
            return {
                "executed": False,
                "delivery": "rejected",
                "kind": "locomotion.goto",
                "waypoint": params.get("waypoint") or "",
                "waypointSafe": frame == "map",
                "error": nav_prerequisites.get("message") or "Nav2 waypoint prerequisites are not ready",
                "nav2Prerequisites": nav_prerequisites,
                "fallback": "disabled",
                "fallbackError": "Refusing DOGZILLALib map-pose movement fallback; Nav2 with live odometry is required for waypoint navigation.",
                **({"modeTransition": mode_transition} if mode_transition else {}),
            }

        battery_state = self.read_state()
        battery_pct = battery_state.get("battery") if isinstance(battery_state, dict) else None
        min_battery = DEFAULT_NAV2_MIN_BATTERY_PCT
        if isinstance(battery_pct, (int, float)) and battery_pct >= 0 and battery_pct < min_battery:
            return {
                "executed": False,
                "delivery": "battery-too-low",
                "kind": "locomotion.goto",
                "waypoint": params.get("waypoint") or "",
                "waypointSafe": frame == "map",
                "error": f"Battery {battery_pct}% below minimum {min_battery}% for navigation",
                "battery": battery_pct,
                "minimumBatteryPercent": min_battery,
            }

        avoidance_request = get_lidar_avoidance_request(params)
        avoidance_result = {"required": False, "ok": True}
        if avoidance_request.get("required"):
            supervisor = getattr(self, "lidar_avoidance", None)
            if supervisor is None:
                return {
                    "executed": False,
                    "delivery": "lidar-avoidance-unavailable",
                    "kind": "locomotion.goto",
                    "waypoint": params.get("waypoint") or "",
                    "waypointSafe": frame == "map",
                    "error": "LiDAR avoidance supervisor not configured",
                    "lidarAvoidance": {
                        "required": True,
                        "ok": False,
                        "error": "LiDAR avoidance supervisor not configured",
                    },
                }

            avoidance_result = supervisor.ensure_running(avoidance_request)
            if not avoidance_result.get("ok"):
                return {
                    "executed": False,
                    "delivery": "lidar-avoidance-unavailable",
                    "kind": "locomotion.goto",
                    "waypoint": params.get("waypoint") or "",
                    "waypointSafe": frame == "map",
                    "error": avoidance_result.get("error") or "LiDAR obstacle avoidance unavailable",
                    "lidarAvoidance": avoidance_result,
                }

        result = self.nav2_client.send_goal(frame=frame, x=x, y=y, yaw=yaw)
        if not result.get("executed"):
            if result.get("delivery") == "nav2-unavailable":
                return {
                    **result,
                    "delivery": "rejected",
                    "lidarAvoidance": avoidance_result,
                    "fallback": "disabled",
                    "fallbackError": "Refusing DOGZILLALib map-pose movement fallback; Nav2 NavigateToPose is required for waypoint navigation.",
                }

            return {**result, "delivery": "rejected", "lidarAvoidance": avoidance_result}

        self._clear_command_preempt_nav2_cmd_vel_block()
        # Normalize the app-facing delivery contract: async goto returns
        # exactly "accepted" — never "Nav2 NavigateToPose" or
        # "navigation-accepted". The original delivery is preserved under
        # deliveryDetail for diagnostics.
        original_delivery = result.get("delivery")
        response = {
            **result,
            "delivery": "accepted",
            "deliveryDetail": original_delivery,
            "kind": "locomotion.goto",
            "waypoint": params.get("waypoint") or "",
            "waypointSafe": frame == "map",
            "arrivalToleranceMeters": params.get("arrivalToleranceMeters", params.get("arrival_tolerance_meters")),
            "lidarAvoidance": avoidance_result,
        }
        if mode_transition is not None:
            response["modeTransition"] = mode_transition
            response["warning"] = "Nav2 was started from idle; first command may have startup latency."
        return response

    def _robot(self):
        if self.robot is not None:
            return self.robot
        try:
            try:
                self.robot = self.DOGZILLA(self.serial_port)
            except TypeError:
                self.robot = self.DOGZILLA()
        except Exception as error:
            self.robot_error = str(error)
            return None
        return self.robot

    def _navigation_cancel_event(self) -> threading.Event:
        event = getattr(self, "navigation_cancel", None)
        if event is None:
            event = threading.Event()
            self.navigation_cancel = event
        return event

    def _replace_navigation_cancel_event(self) -> threading.Event:
        lock = getattr(self, "navigation_event_lock", None)
        if lock is None:
            lock = threading.Lock()
            self.navigation_event_lock = lock

        with lock:
            previous = getattr(self, "navigation_cancel", None)
            if previous is not None:
                previous.set()
            event = threading.Event()
            self.navigation_cancel = event
            return event

    def cancel_active_navigation(self) -> None:
        self._navigation_cancel_event().set()

    def _execute_emergency_stop(self, *, reason: str = "emergency_stop") -> dict[str, Any]:
        self.cancel_active_navigation()
        self._block_nav2_cmd_vel(reason)

        performance_stopped = False
        stop_error: str | None = None
        if not self.available:
            stop_error = self.import_error or "DOGZILLALib unavailable"
        else:
            with self._lock:
                robot = self._robot()
                if robot is None:
                    stop_error = self.robot_error or "robot unavailable"
                else:
                    try:
                        performance_stopped = stop_performance_mode(robot)
                        robot.stop()
                    except Exception as error:
                        self.robot_error = str(error)
                        stop_error = str(error)

        nav2_cancel = self._cancel_nav2_active_goal()
        result = {
            "executed": stop_error is None,
            "delivery": "stop" if stop_error is None else "stop-error",
            "performanceStopped": performance_stopped,
            "nav2CmdVelBlocked": True,
            "nav2Cancel": nav2_cancel,
        }
        if stop_error is not None:
            result["error"] = stop_error
        return result

    def _execute_command_preempt(self) -> dict[str, Any]:
        self.cancel_active_navigation()
        # Preempt cancels prior motion before a new command; unlike emergency_stop
        # it must not latch /nav2/cmd_vel blocked.

        performance_stopped = False
        stop_error: str | None = None
        if not self.available:
            stop_error = self.import_error or "DOGZILLALib unavailable"
        else:
            with self._lock:
                robot = self._robot()
                if robot is None:
                    stop_error = self.robot_error or "robot unavailable"
                else:
                    try:
                        performance_stopped = stop_performance_mode(robot)
                        robot.stop()
                    except Exception as error:
                        self.robot_error = str(error)
                        stop_error = str(error)

        nav2_cancel = self._cancel_nav2_active_goal()
        # Defensive: even though _execute_command_preempt never sets a block,
        # clear any stale command_preempt block before returning so preempt
        # can never latch across commands.
        self._clear_command_preempt_nav2_cmd_vel_block()
        result = {
            "executed": stop_error is None,
            "delivery": "stop" if stop_error is None else "stop-error",
            "performanceStopped": performance_stopped,
            "nav2CmdVelBlocked": False,
            "nav2Cancel": nav2_cancel,
        }
        if stop_error is not None:
            result["error"] = stop_error
        return result

    def _cancel_nav2_active_goal(self) -> dict[str, Any]:
        nav2_client = getattr(self, "nav2_client", None)
        cancel_goal = getattr(nav2_client, "cancel_active_goal", None)
        if not callable(cancel_goal):
            return {"attempted": False, "status": "unsupported"}

        try:
            return {"attempted": True, **cancel_goal()}
        except Exception as error:
            return {
                "attempted": True,
                "executed": False,
                "delivery": "nav2-cancel-error",
                "error": str(error),
            }

    def _block_nav2_cmd_vel(self, reason: str) -> None:
        self.nav2_cmd_vel_blocked = True
        self.nav2_cmd_vel_blocked_reason = reason

    def _clear_nav2_cmd_vel_block(self) -> None:
        self.nav2_cmd_vel_blocked = False
        self.nav2_cmd_vel_blocked_reason = None

    def _clear_command_preempt_nav2_cmd_vel_block(self) -> None:
        if getattr(self, "nav2_cmd_vel_blocked_reason", None) == "command_preempt":
            self.nav2_cmd_vel_blocked = False
            self.nav2_cmd_vel_blocked_reason = None

    def _nav2_cmd_vel_is_blocked(self) -> bool:
        return bool(getattr(self, "nav2_cmd_vel_blocked", False))

    def _load_factory(self):
        for module_name in load_module_candidates():
            try:
                module = __import__(module_name, fromlist=["*"])
            except Exception as error:
                self.import_attempts.append({"module": module_name, "error": str(error)})
                continue

            for factory_name in VENDOR_FACTORY_CANDIDATES:
                factory = getattr(module, factory_name, None)
                if factory is not None:
                    self.import_attempts.append({"module": module_name, "factory": factory_name})
                    self.import_error = None
                    return factory

            self.import_attempts.append({"module": module_name, "error": "no DOGZILLA factory found"})

        self.import_error = "No DOGZILLA Python control factory found"
        return None


def _get_load_average() -> list[str] | None:
    try:
        with open("/proc/loadavg") as handle:
            return handle.read().strip().split()[:3]
    except Exception:
        return None


class BridgeServer(ThreadingHTTPServer):
    def __init__(self, server_address, handler_class, runtime: DogzillaRuntime):
        super().__init__(server_address, handler_class)
        self.runtime = runtime
        self.received_count = 0
        self.recent_commands: deque[dict[str, Any]] = deque(maxlen=MAX_RECENT_COMMANDS)


class Handler(BaseHTTPRequestHandler):
    server_version = "DogzillaLibBridge/0.2"

    def do_GET(self):
        if self.path == "/healthz":
            runtime = self.server.runtime.snapshot()
            self._send_json(
                200,
                {
                    "ok": runtime["available"],
                    "mode": "http-to-dogzillalib",
                    "receivedCount": self.server.received_count,
                    "loadAverage": _get_load_average(),
                    "navMode": get_nav_mode(),
                    "gaitBlocked": self.server.runtime._nav2_cmd_vel_is_blocked(),
                    "gaitBlockedReason": getattr(self.server.runtime, "nav2_cmd_vel_blocked_reason", None),
                    "runtime": runtime,
                },
            )
            return
        if self.path == "/healthz-lite":
            # Lightweight endpoint: uses cached nav2 state only (no forced
            # Docker probes). Exposes nav mode, gait block, and nav2 readiness
            # so operators can check dispatch readiness without /healthz load.
            nav2 = self.server.runtime.nav2_client
            try:
                nav2_snapshot = nav2.snapshot()
            except Exception as exc:
                nav2_snapshot = {"error": str(exc), "waypointReady": False, "canSendGoal": False, "backend": "unknown"}
            self._send_json(
                200,
                {
                    "ok": True,
                    "mode": "http-to-dogzillalib",
                    "receivedCount": self.server.received_count,
                    "loadAverage": _get_load_average(),
                    "navMode": get_nav_mode(),
                    "gaitBlocked": self.server.runtime._nav2_cmd_vel_is_blocked(),
                    "gaitBlockedReason": getattr(self.server.runtime, "nav2_cmd_vel_blocked_reason", None),
                    "nav2Ready": bool(nav2_snapshot.get("waypointReady")),
                    "waypointReady": bool(nav2_snapshot.get("waypointReady")),
                    "nav2Backend": nav2_snapshot.get("backend", "unknown"),
                    "canSendGoal": bool(nav2_snapshot.get("canSendGoal")),
                    "runtimeSnapshot": False,
                },
            )
            return
        if self.path == "/feedback":
            self._send_json(
                200,
                {
                    "recentCommands": list(self.server.recent_commands),
                    "receivedCount": self.server.received_count,
                    "runtime": self.server.runtime.snapshot(),
                    "logFile": str(LOG_FILE),
                },
            )
            return
        if self.path == "/state":
            result = self.server.runtime.read_state()
            self._send_json(200 if result.get("executed") else 503, result)
            return
        if self.path == "/imu":
            result = self.server.runtime.read_imu()
            self._send_json(200, result)
            return
        if self.path == "/actions":
            self._send_json(200, {"actions": ACTION_ALIASES})
            return
        if self.path == "/preflight":
            self._send_json(200, {"runtime": self.server.runtime.snapshot(), "checks": build_preflight_checks()})
            return
        if self.path == "/nav2/speed_config":
            self._send_json(200, {"ok": True, "config": get_speed_config()})
            return
        if self.path == "/nav2/scan_info":
            nav2 = self.server.runtime.nav2_client
            refresh_error = None
            if hasattr(nav2, "_refresh_status"):
                try:
                    nav2._refresh_status(force=True)
                except Exception as exc:
                    refresh_error = str(exc)
            scan = nav2._scan_snapshot() if hasattr(nav2, "_scan_snapshot") else {}
            checked_at = scan.get("checkedAt")
            age_sec = None
            if checked_at is not None:
                try:
                    age_sec = max(0.0, time.time() - float(checked_at))
                except (TypeError, ValueError):
                    age_sec = None
            self._send_json(200, {
                "ok": True,
                "topic": scan.get("topic", DEFAULT_NAV2_SCAN_TOPIC),
                "publisherCount": scan.get("publisherCount", 0),
                "subscriptionCount": scan.get("subscriptionCount", 0),
                "available": scan.get("available", False),
                "checkedAt": checked_at,
                "ageSec": age_sec,
                "error": scan.get("error") or refresh_error,
            })
            return
        if self.path == "/mode":
            self._send_json(200, {"ok": True, "navMode": get_nav_mode(), **nav_mode_snapshot()})
            return
        if self.path == "/sleep":
            self._send_json(200, sleep_status())
            return
        if self.path == "/wake":
            self._send_json(200, sleep_status())
            return
        self._send_json(404, {"error": "Not found"})


    def do_POST(self):
        if self.path == "/nav2/cmd_vel":
            payload = self._read_json_body()
            if payload is None:
                self._send_json(400, {"error": "Expected JSON cmd_vel payload"})
                return

            _schedule_auto_sleep(restart=True)
            result = self.server.runtime.execute_nav2_cmd_vel(payload)
            accepted = result.get("executed") or result.get("delivery") in ("dry-run", "nav2-gait-adapter-blocked")
            self._send_json(
                202 if accepted else 422,
                {
                    "accepted": bool(accepted),
                    "result": result,
                    **identity_payload(),
                },
            )
            return

        if self.path == "/sleep":
            result = sleep_pi()
            self._send_json(200, result)
            _schedule_auto_sleep(restart=True)
            return

        if self.path == "/wake":
            result = wake_pi()
            self._send_json(200, result)
            _schedule_auto_sleep(restart=True)
            return

        if self.path == "/mode":
            payload = self._read_json_body()
            mode = payload.get("mode") if isinstance(payload, dict) else None
            if not mode:
                self._send_json(400, {"ok": False, "error": "Expected JSON object with 'mode' key"})
                return
            result = set_nav_mode(mode)
            self._send_json(200 if result.get("ok") else 400, result)
            return

        if self.path == "/nav2/speed_config":

            payload = self._read_json_body()
            if not isinstance(payload, dict):
                self._send_json(400, {"error": "Expected JSON object with speed config overrides"})
                return
            updated = update_speed_config(payload)
            self._send_json(200, {"ok": True, "config": updated})
            return

        if self.path != "/commands":
            self._send_json(404, {"error": "Not found"})
            return

        payload = self._read_json_body()
        envelope = payload.get("envelope") if isinstance(payload, dict) else None
        if not isinstance(envelope, dict):
            self._send_json(400, {"error": 'Expected JSON object with top-level key "envelope"'})
            return

        canonical_plan = envelope.get("canonicalPlan") or envelope.get("payload", {}).get("canonicalPlan")
        if not isinstance(canonical_plan, dict):
            self._send_json(400, {"error": "Missing canonicalPlan"})
            return

        self.server.received_count += 1
        command_id = f"dogzilla-lib-{self.server.received_count:04d}"
        _schedule_auto_sleep(restart=True)
        if canonical_plan.get("kind") == "locomotion.goto" and DEFAULT_ASYNC_HTTP_GOTO:
            # Synchronous phase: pre-check, promote if needed, send goal
            # exactly once, wait for acceptance. The background thread only
            # monitors motion — it must NOT call runtime.execute() or
            # send_goal() again (that was the double-send bug).
            result = self.server.runtime.execute(canonical_plan)
            command_accepted = bool(result.get("executed")) and result.get("delivery") == "accepted"

            if command_accepted:
                # Goal was accepted by Nav2. Start background motion monitor.
                start_gait_count = int(getattr(self.server.runtime, "nav2_gait_adapter_count", 0) or 0)
                started_at = time.monotonic()
                result["async"] = True
                result["status"] = "running"
                record = {
                    "commandId": command_id,
                    "receivedAt": utc_now(),
                    "envelope": envelope,
                    "canonicalPlan": canonical_plan,
                    "result": result,
                }
                self.server.recent_commands.appendleft(record)
                append_log_record(record)
                threading.Thread(
                    target=self._monitor_background_motion,
                    args=(command_id, envelope, canonical_plan, start_gait_count, started_at),
                    daemon=True,
                ).start()
                self._send_json(
                    202,
                    {
                        "accepted": True,
                        "commandId": command_id,
                        "result": result,
                        **identity_payload(),
                    },
                )
                return
            else:
                # Goal was rejected or failed. Return immediately.
                status_code = 422
                record = {
                    "commandId": command_id,
                    "receivedAt": utc_now(),
                    "envelope": envelope,
                    "canonicalPlan": canonical_plan,
                    "result": result,
                    "completedAt": utc_now(),
                    "motionStatus": "failed" if result.get("error") else "rejected",
                }
                self.server.recent_commands.appendleft(record)
                append_log_record(record)
                self._send_json(
                    status_code,
                    {
                        "accepted": False,
                        "commandId": command_id,
                        "result": result,
                        **identity_payload(),
                    },
                )
                return

        _schedule_auto_sleep(restart=True)
        result = self.server.runtime.execute(canonical_plan)
        record = {
            "commandId": command_id,
            "receivedAt": utc_now(),
            "envelope": envelope,
            "canonicalPlan": canonical_plan,
            "result": result,
        }
        self.server.recent_commands.appendleft(record)
        append_log_record(record)

        status = 202 if result.get("executed") or result.get("delivery") == "dry-run" else 422
        self._send_json(
            status,
            {
                "accepted": status == 202,
                "commandId": command_id,
                "result": result,
                **identity_payload(),
            },
        )

    def log_message(self, fmt, *args):
        return

    def _monitor_background_motion(
        self,
        command_id: str,
        envelope: dict[str, Any],
        canonical_plan: dict[str, Any],
        start_gait_count: int,
        started_at: float,
    ) -> None:
        """Background motion monitor for an accepted async goto.

        CRITICAL: This method must NOT call runtime.execute() or
        nav2_client.send_goal() — the goal was already sent synchronously
        in the handler. This thread only monitors for physical motion.
        """
        runtime = self.server.runtime
        motion_status: str = "no-motion"
        error_detail: str | None = None

        try:
            motion_status = self._monitor_navigation_motion(
                runtime,
                start_gait_count=start_gait_count,
                started_at=started_at,
                window_sec=DEFAULT_NO_MOTION_WINDOW_SEC,
            )
        except Exception as exc:
            motion_status = "failed"
            error_detail = str(exc)

        completed_at = utc_now()

        # Fetch the result from the existing record (set by the handler).
        result: dict[str, Any] = {}
        updated = False
        for record in self.server.recent_commands:
            if record.get("commandId") == command_id:
                result = dict(record.get("result") or {})
                result["motionStatus"] = motion_status
                if error_detail:
                    result["monitorError"] = error_detail
                record["completedAt"] = completed_at
                record["result"] = result
                record["background"] = True
                record["motionStatus"] = motion_status
                updated = True
                break

        if not updated:
            result = {
                "executed": True,
                "delivery": "accepted",
                "motionStatus": motion_status,
            }
            if error_detail:
                result["monitorError"] = error_detail
            self.server.recent_commands.appendleft({
                "commandId": command_id,
                "completedAt": completed_at,
                "envelope": envelope,
                "canonicalPlan": canonical_plan,
                "result": result,
                "background": True,
                "motionStatus": motion_status,
            })

        append_log_record({
            "commandId": command_id,
            "completedAt": completed_at,
            "envelope": envelope,
            "canonicalPlan": canonical_plan,
            "result": result,
            "background": True,
            "motionStatus": motion_status,
        })

    def _monitor_navigation_motion(
        self,
        runtime: DogzillaRuntime,
        *,
        start_gait_count: int,
        started_at: float,
        window_sec: float,
    ) -> str:
        """Monitor for physical motion using lightweight cached state only.

        Does NOT call full /healthz-style Docker probes or
        nav2_client._refresh_status(force=True) in a loop. Uses:
          - runtime.nav2_gait_adapter_count (in-memory counter)
          - nav2_client._odom_snapshot() (reads cached fields, no Docker probe)

        Returns one of: "moving", "no-motion", "cancelled", "failed".
        "moving" requires observed motion (gait count increase or odom
        timestamp advancing). Goal acceptance alone is NOT "moving".
        """
        deadline = started_at + window_sec
        nav2_client = getattr(runtime, "nav2_client", None)
        start_odom_ts = None
        if nav2_client is not None:
            try:
                start_odom_ts = nav2_client._odom_snapshot().get("lastMessageAt")
            except Exception:
                start_odom_ts = None

        while time.monotonic() < deadline:
            if runtime._navigation_cancel_event().is_set():
                return "cancelled"

            # Primary signal: gait adapter count (in-memory, no Docker call)
            current_gait_count = int(getattr(runtime, "nav2_gait_adapter_count", 0) or 0)
            if current_gait_count > start_gait_count:
                return "moving"

            # Secondary signal: odom timestamp advancing (cached, no Docker probe)
            if nav2_client is not None and start_odom_ts is not None:
                try:
                    current_odom_ts = nav2_client._odom_snapshot().get("lastMessageAt")
                    if current_odom_ts is not None and current_odom_ts != start_odom_ts:
                        return "moving"
                except Exception:
                    pass

            time.sleep(0.5)

        return "no-motion"

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return None

    def _send_json(self, status_code: int, payload: dict[str, Any]):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def resolve_action_id(params: dict[str, Any]) -> int | None:
    raw_action_id = params.get("actionId", params.get("action_id"))
    if raw_action_id is not None:
        return clamp_int(int(raw_action_id), 1, 255)

    for key in ("trick", "actionName", "action_name", "name"):
        raw_name = params.get(key)
        if not isinstance(raw_name, str):
            continue
        action_id = ACTION_ALIASES.get(normalize_action_name(raw_name))
        if action_id is not None:
            return action_id

    return None


def normalize_action_name(value: str) -> str:
    return value.strip().lower().replace("-", "_").replace(" ", "_")


def load_vendor_paths() -> list[Path]:
    raw = os.environ.get("DOGZILLA_VENDOR_PATHS", "")
    configured = [Path(item) for item in raw.split(os.pathsep) if item.strip()]
    return configured + VENDOR_PATHS


def load_module_candidates() -> list[str]:
    raw = os.environ.get("DOGZILLA_VENDOR_MODULES", "")
    configured = [item.strip() for item in raw.split(",") if item.strip()]
    return configured + VENDOR_MODULE_CANDIDATES


def call_first(target: Any, names: list[str]) -> Any:
    for name in names:
        method = getattr(target, name, None)
        if method is not None:
            return method()
    raise AttributeError(f"Missing DOGZILLA method. Tried: {', '.join(names)}")


def stop_robot(robot: Any) -> None:
    try:
        robot.move("x", 0)
        robot.move("y", 0)
        robot.turn(0)
    except Exception:
        pass

    try:
        robot.stop()
    except Exception:
        pass


def locomotion_params_have_motion(params: dict[str, Any]) -> bool:
    for key in ("x_step", "y_step", "turn_rate"):
        try:
            if abs(float(params.get(key) or 0.0)) > 1e-6:
                return True
        except (TypeError, ValueError):
            continue
    return False


def stop_performance_mode(robot: Any) -> bool:
    method = getattr(robot, "perform", None)
    if method is None:
        return False

    try:
        method(0)
    except Exception:
        return False

    return True


def get_lidar_avoidance_request(params: dict[str, Any]) -> dict[str, Any]:
    raw = params.get("obstacleAvoidance", params.get("obstacle_avoidance"))
    if raw is True:
        return {"required": True}
    if not isinstance(raw, dict):
        return {"required": False}
    return {**raw, "required": raw.get("required") is True}


def build_preflight_checks() -> list[dict[str, Any]]:
    return [
        {"name": "same_lan", "expect": "desktop and DOGZILLA on same LAN"},
        {"name": "ros_domain", "expect": f"ROS_DOMAIN_ID={DEFAULT_EXPECTED_ROS_DOMAIN_ID} for Yahboom default image"},
        {"name": "pi5_docker", "command": STUDY_HINTS["pi5DockerEntry"]},
        {"name": "bringup", "command": STUDY_HINTS["bringupLaunch"]},
        {"name": "lidar_avoidance", "command": STUDY_HINTS["lidarAvoidance"]},
        {"name": "app_conflict", "expect": STUDY_HINTS["knownConflict"]},
    ]


def append_log_record(record: dict[str, Any]) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")


def identity_payload() -> dict[str, str]:
    robot_id = read_first_line(ROBOT_ID_FILE)
    robot_name = read_first_line(ROBOT_NAME_FILE) or DEFAULT_ROBOT_NAME
    return {
        "robot_id": robot_id,
        "robot_name": robot_name,
        "robotId": robot_id,
        "robotName": robot_name,
    }


def read_first_line(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").splitlines()[0].strip()
    except (OSError, IndexError):
        return ""


def clamp_int(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    parser = argparse.ArgumentParser(description="Robo-Doge direct DOGZILLALib bridge")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--serial-port", default=DEFAULT_SERIAL_PORT)
    parser.add_argument("--live", action="store_true", help="Send commands to hardware. Default is dry-run.")
    args = parser.parse_args()

    runtime = DogzillaRuntime(serial_port=args.serial_port, dry_run=DEFAULT_DRY_RUN and not args.live)
    server = BridgeServer((args.host, args.port), Handler, runtime)
    _schedule_auto_sleep()
    print(f"DOGZILLALib bridge listening on http://{args.host}:{args.port}")
    print(json.dumps(runtime.snapshot()))
    server.serve_forever()


if __name__ == "__main__":
    main()
