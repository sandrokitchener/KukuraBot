from __future__ import annotations

import argparse
import json
import math
import os
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
_NAV_MODE: str = os.environ.get("DOGZILLA_DEFAULT_NAV_MODE", "navigate")
_NAV_MODE_HISTORY: deque[dict[str, Any]] = deque(maxlen=20)
_NAV_MODE_TRANSITIONING = False
_NAV_MODE_AUTO_DEMOTE_TIMER: threading.Timer | None = None
_NAV_MODE_IDLE_DELAY_SEC = float(os.environ.get("DOGZILLA_NAV_MODE_IDLE_DELAY_SEC", "300.0"))
_NAV2_STANDBY_ENABLED = os.environ.get("DOGZILLA_NAV2_STANDBY_ENABLED", "0") == "1"
CONTAINER_NAME = os.environ.get("DOGZILLA_CONTAINER", "robodoge-rosbridge")
REMOTE_ROOT = os.environ.get("REMOTE_ROOT", "/home/pi/robodoge")
AUTONOMOUS_MAPPING_DIR = Path(REMOTE_ROOT) / "maps"
LOCALIZATION_STATUS_FILE = AUTONOMOUS_MAPPING_DIR / "robodoge_localization_status.json"
MAP_POSE_MODE_FILE = AUTONOMOUS_MAPPING_DIR / "robodoge_map_pose_mode.json"
VALID_NAV_MODES = {"idle", "localize", "navigate", "sleep"}


def _run(cmd: str, timeout: float = 15.0) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except subprocess.TimeoutExpired as e:
        return -1, f"timed out after {timeout}s: {e.output or ''} {e.stderr or ''}"
    except OSError as e:
        return -1, str(e)


def _valid_nav_mode(mode: str) -> bool:
    return mode in VALID_NAV_MODES


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
            _cancel_nav_mode_demote()
            return {"ok": True, "mode": mode, "changed": False}
        _NAV_MODE_TRANSITIONING = True
    _cancel_nav_mode_demote()

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
        return {**result, "mode": get_nav_mode(), "previousMode": current, "changed": result.get("ok")}
    finally:
        with _NAV_MODE_LOCK:
            _NAV_MODE_TRANSITIONING = False


def _enter_sleep_mode() -> dict[str, Any]:
    _cancel_nav_mode_demote()
    lifecycle = _manage_nav2_lifecycle(1)
    if not lifecycle["ok"]:
        return lifecycle
    return {
        "ok": True,
        "note": "Nav2 paused; Cartographer and Pi-owned services remain running",
        "piOwnedNav2": True,
        "navStandby": True,
    }


def _enter_idle_mode() -> dict[str, Any]:
    lifecycle = _manage_nav2_lifecycle(1)
    if not lifecycle["ok"]:
        return lifecycle
    return {
        "ok": True,
        "note": "Nav2 paused; Cartographer and Pi-owned services remain running",
        "piOwnedNav2": True,
        "navStandby": True,
    }


def _enter_localize_mode() -> dict[str, Any]:
    lifecycle = _manage_nav2_lifecycle(1)
    if not lifecycle["ok"]:
        return lifecycle
    return {
        "ok": True,
        "note": "Nav2 paused while Cartographer localization and Pi-owned services remain active",
        "piOwnedNav2": True,
        "navStandby": True,
    }


def _enter_navigate_mode() -> dict[str, Any]:
    lifecycle = _manage_nav2_lifecycle(2)
    if not lifecycle["ok"]:
        return lifecycle
    return {
        "ok": True,
        "note": "Nav2 resumed through Pi-owned lifecycle manager",
        "piOwnedNav2": True,
        "navStandby": False,
    }


def _schedule_nav_mode_demote(target_mode: str = "idle") -> None:
    global _NAV_MODE_AUTO_DEMOTE_TIMER
    _cancel_nav_mode_demote()
    if get_nav_mode() != "navigate":
        return
    _NAV_MODE_AUTO_DEMOTE_TIMER = threading.Timer(
        max(30.0, _NAV_MODE_IDLE_DELAY_SEC),
        _nav_mode_demote_callback,
        args=(target_mode,),
    )
    _NAV_MODE_AUTO_DEMOTE_TIMER.daemon = True
    _NAV_MODE_AUTO_DEMOTE_TIMER.start()


def _cancel_nav_mode_demote() -> None:
    global _NAV_MODE_AUTO_DEMOTE_TIMER
    if _NAV_MODE_AUTO_DEMOTE_TIMER is not None:
        _NAV_MODE_AUTO_DEMOTE_TIMER.cancel()
        _NAV_MODE_AUTO_DEMOTE_TIMER = None


def _nav_mode_demote_callback(target_mode: str) -> None:
    if get_nav_mode() == "navigate":
        set_nav_mode(target_mode)


def _manage_nav2_lifecycle(command: int) -> dict[str, Any]:
    if not _NAV2_STANDBY_ENABLED:
        return {"ok": True, "navStandby": command == 1, "standbyEnabled": False}
    if command not in (1, 2):
        return {"ok": False, "error": f"unsupported_nav2_lifecycle_command:{command}"}
    command_text = f"{{command: {command}}}"
    shell = (
        f"docker exec {CONTAINER_NAME} bash -lc "
        f"'source /opt/ros/humble/setup.bash; "
        f"ros2 service call /lifecycle_manager_navigation/manage_nodes "
        f"nav2_msgs/srv/ManageLifecycleNodes \"{command_text}\"'"
    )
    code, output = _run(shell, timeout=12.0)
    if code != 0:
        return {"ok": False, "error": "Nav2 lifecycle transition failed", "detail": output[-1200:]}
    return {"ok": True, "navStandby": command == 1, "standbyEnabled": True}


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


def _env_number(name: str, default: float, *, minimum: float = 0.0, maximum: float = 100.0) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return min(maximum, max(minimum, value))


DOGZILLA_LOCOMOTION_MAX_LATERAL_STEP = max(
    0.0,
    float(os.environ.get("DOGZILLA_LOCOMOTION_MAX_LATERAL_STEP", "0")),
)
DOGZILLA_MANUAL_MAX_LATERAL_STEP = max(
    0.0,
    float(os.environ.get("DOGZILLA_MANUAL_MAX_LATERAL_STEP", "1")),
)

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
DEFAULT_BATTERY_CUTOFF_PCT = _env_number(
    "DOGZILLA_BATTERY_CUTOFF_PERCENT",
    _env_number("DOGZILLA_NAV2_MIN_BATTERY_PCT", 10.0),
    minimum=1.0,
)
DEFAULT_BATTERY_WARNING_PCT = max(
    DEFAULT_BATTERY_CUTOFF_PCT,
    _env_number("DOGZILLA_BATTERY_WARNING_PERCENT", 20.0, minimum=1.0),
)
DEFAULT_BATTERY_RECOVERY_PCT = max(
    DEFAULT_BATTERY_CUTOFF_PCT,
    _env_number("DOGZILLA_BATTERY_RECOVERY_PERCENT", 15.0, minimum=1.0),
)
DEFAULT_BATTERY_MAX_AGE_SEC = _env_number(
    "DOGZILLA_BATTERY_MAX_AGE_SEC", 15.0, minimum=1.0, maximum=300.0
)
DEFAULT_BATTERY_REFRESH_INTERVAL_SEC = _env_number(
    "DOGZILLA_BATTERY_REFRESH_INTERVAL_SEC", 2.0, minimum=0.2, maximum=30.0
)
DEFAULT_BATTERY_READ_TIMEOUT_SEC = _env_number(
    "DOGZILLA_BATTERY_READ_TIMEOUT_SEC", 1.0, minimum=0.1, maximum=5.0
)
# Backward-compatible name used by older tests/configuration.
DEFAULT_NAV2_MIN_BATTERY_PCT = DEFAULT_BATTERY_CUTOFF_PCT
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

_BATTERY_UNSET = object()


def canonical_plan_has_motion(kind: str, params: dict[str, Any] | None = None) -> bool:
    params = params or {}
    if kind == "locomotion.relative":
        return locomotion_params_have_motion(params)
    if kind == "locomotion.goto" or kind == "pose.body":
        return True
    if kind == "action.once":
        return resolve_action_id(params) != ACTION_ALIASES["stop"]
    if kind == "action.loop":
        return bool(params.get("enabled"))
    return False


def read_active_map_metadata() -> dict[str, Any]:
    return map_metadata_module.read_active_map_metadata(DEFAULT_MAP_METADATA_FILE, DEFAULT_MAP_YAML_FILE)


def read_localization_status() -> dict[str, Any]:
    try:
        mode_payload = json.loads(MAP_POSE_MODE_FILE.read_text(encoding="utf-8"))
    except Exception:
        mode_payload = {}
    mode = str(mode_payload.get("mode") or "").strip()
    if mode in {"mapping", "continue_mapping"}:
        return {
            "trusted": True,
            "required": False,
            "phase": mode,
            "mode": mode,
            "source": str(MAP_POSE_MODE_FILE),
        }

    try:
        payload = json.loads(LOCALIZATION_STATUS_FILE.read_text(encoding="utf-8"))
    except Exception as error:
        return {
            "trusted": False,
            "required": True,
            "phase": "unknown",
            "mode": mode or "unknown",
            "error": f"Localization proof unavailable: {error}",
            "source": str(LOCALIZATION_STATUS_FILE),
        }

    return {
        **payload,
        "trusted": payload.get("trusted") is True,
        "required": True,
        "mode": mode or str(payload.get("mode") or "localization"),
        "source": str(LOCALIZATION_STATUS_FILE),
    }


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
    localization = read_localization_status()
    if localization.get("trusted") is not True:
        return {
            "ok": False,
            "checked": True,
            "message": localization.get("error") or "Robot location is untrusted; run map relocalization before navigation",
            "localization": localization,
        }

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
        self.battery_safety_enforced = True
        self.battery_last_valid_percent: float | None = None
        self.battery_last_valid_monotonic: float | None = None
        self.battery_last_valid_at: str | None = None
        self.battery_last_read_monotonic: float | None = None
        self.battery_motion_block_reason: str | None = None
        self.battery_stop_reason: str | None = None

        for vendor_path in self.vendor_paths:
            if vendor_path.exists():
                sys.path.insert(0, str(vendor_path))

        self.DOGZILLA = self._load_factory()

    @property
    def available(self) -> bool:
        return self.import_error is None

    def snapshot(self) -> dict[str, Any]:
        nav2 = self.nav2_client.snapshot()
        localization = read_localization_status()
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
            "localization": localization,
            "nav2": nav2,
            "navigation": self.navigation_snapshot(nav2, localization),
            "lidarAvoidance": self.lidar_avoidance.snapshot() if hasattr(self, "lidar_avoidance") else None,
            "navMode": get_nav_mode(),
            "batterySafety": self._battery_safety_snapshot(refresh=False),
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

    def navigation_snapshot(
        self,
        nav2: dict[str, Any] | None = None,
        localization: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        nav2 = nav2 if isinstance(nav2, dict) else self.nav2_client.snapshot()
        localization = localization if isinstance(localization, dict) else read_localization_status()
        nav2_available = nav2.get("available") is True
        localization_trusted = localization.get("trusted") is True
        waypoint_ready = nav2.get("waypointReady") is True and localization_trusted
        blockers = list(nav2.get("blockers") or [])
        if not localization_trusted:
            blockers.insert(0, localization.get("error") or "Robot location is untrusted; relocalization required")
        return {
            "available": waypoint_ready,
            "primary": "nav2" if waypoint_ready else "unavailable",
            "actionServerAvailable": nav2_available,
            "waypointReady": waypoint_ready,
            "blockers": blockers,
            "localization": localization,
            "nav2": nav2,
        }

    def _battery_safety_snapshot(
        self,
        *,
        refresh: bool = False,
        robot: Any | None = None,
        raw: Any = _BATTERY_UNSET,
    ) -> dict[str, Any]:
        if not getattr(self, "battery_safety_enforced", False):
            if raw is _BATTERY_UNSET and refresh and robot is not None:
                raw, _ = self._read_battery_with_timeout(robot)
            valid_percent = (
                isinstance(raw, (int, float))
                and not isinstance(raw, bool)
                and math.isfinite(float(raw))
                and 1 <= float(raw) <= 100
                and float(raw).is_integer()
            )
            return {
                "status": "disabled",
                "motionAllowed": True,
                "value": float(raw) if valid_percent else None,
                "raw": None if raw is _BATTERY_UNSET else raw,
                "unit": "percent" if valid_percent else "unknown",
                "readStatus": "ok" if valid_percent else "read-failed" if raw in (None, 0) else "invalid-percent",
                "fresh": valid_percent,
                "warningPercent": DEFAULT_BATTERY_WARNING_PCT,
                "cutoffPercent": DEFAULT_BATTERY_CUTOFF_PCT,
                "recoveryPercent": DEFAULT_BATTERY_RECOVERY_PCT,
                "maxAgeSec": DEFAULT_BATTERY_MAX_AGE_SEC,
            }

        now = time.monotonic()
        read_error = ""
        sample_supplied = raw is not _BATTERY_UNSET
        last_read = getattr(self, "battery_last_read_monotonic", None)
        should_refresh = refresh and (
            last_read is None or now - float(last_read) >= DEFAULT_BATTERY_REFRESH_INTERVAL_SEC
        )

        if not sample_supplied and should_refresh:
            if robot is None:
                robot = getattr(self, "robot", None)
            if robot is None and self.available:
                acquired = self._lock.acquire(timeout=0.25)
                if acquired:
                    try:
                        robot = self._robot()
                    finally:
                        self._lock.release()
            if robot is None:
                raw = None
                read_error = "robot unavailable"
            else:
                raw, read_error = self._read_battery_with_timeout(robot)
            sample_supplied = True

        if sample_supplied:
            self.battery_last_read_monotonic = now

        valid_percent = (
            sample_supplied
            and isinstance(raw, (int, float))
            and not isinstance(raw, bool)
            and math.isfinite(float(raw))
            and 1 <= float(raw) <= 100
            and float(raw).is_integer()
        )
        if valid_percent:
            self.battery_last_valid_percent = float(raw)
            self.battery_last_valid_monotonic = now
            self.battery_last_valid_at = utc_now()

        value = getattr(self, "battery_last_valid_percent", None)
        valid_at = getattr(self, "battery_last_valid_monotonic", None)
        age_sec = max(0.0, now - float(valid_at)) if valid_at is not None else None
        prior_reason = getattr(self, "battery_motion_block_reason", None)
        read_status = (
            "ok"
            if valid_percent
            else "cached"
            if not sample_supplied and value is not None and age_sec is not None and age_sec <= DEFAULT_BATTERY_MAX_AGE_SEC
            else "read-failed"
            if raw is None or raw == 0
            else "invalid-percent"
        )

        blocked_reason: str | None = None
        status = "unavailable"
        cause = "Fresh DOGZILLA battery percentage is unavailable."
        recovery = "Restore fresh DOGZILLALib battery telemetry before motion."

        if value is not None and age_sec is not None and age_sec <= DEFAULT_BATTERY_MAX_AGE_SEC:
            if value <= DEFAULT_BATTERY_CUTOFF_PCT:
                blocked_reason = "battery_cutoff"
                status = "cutoff"
                cause = f"Battery {value:g}% is at or below the {DEFAULT_BATTERY_CUTOFF_PCT:g}% motion cutoff."
                recovery = f"Charge until a fresh reading is at least {DEFAULT_BATTERY_RECOVERY_PCT:g}%."
            elif prior_reason and prior_reason.startswith("battery_") and value < DEFAULT_BATTERY_RECOVERY_PCT:
                blocked_reason = "battery_recovering"
                status = "recovering"
                cause = f"Battery recovered to {value:g}% but remains below the {DEFAULT_BATTERY_RECOVERY_PCT:g}% restart threshold."
                recovery = f"Charge until a fresh reading is at least {DEFAULT_BATTERY_RECOVERY_PCT:g}%."
            elif value <= DEFAULT_BATTERY_WARNING_PCT:
                status = "warning" if valid_percent or read_status == "cached" else "last-known"
                cause = f"Battery {value:g}% is at or below the {DEFAULT_BATTERY_WARNING_PCT:g}% warning threshold."
                recovery = f"Charge before battery reaches the {DEFAULT_BATTERY_CUTOFF_PCT:g}% motion cutoff."
            else:
                status = "ok" if valid_percent or read_status == "cached" else "last-known"
                cause = "Battery is above the configured warning threshold."
                recovery = ""
        elif value is not None:
            blocked_reason = "battery_stale"
            status = "stale"
            cause = f"Battery reading is older than {DEFAULT_BATTERY_MAX_AGE_SEC:g} seconds."
        else:
            blocked_reason = "battery_invalid" if read_status == "invalid-percent" else "battery_unavailable"
            status = "invalid" if read_status == "invalid-percent" else "unavailable"
            if read_status == "invalid-percent":
                cause = "DOGZILLA battery reading was not an integer percentage from 1 to 100."

        if blocked_reason:
            self.battery_motion_block_reason = blocked_reason
            self._block_nav2_cmd_vel(blocked_reason)
        else:
            self.battery_motion_block_reason = None
            self.battery_stop_reason = None
            if getattr(self, "nav2_cmd_vel_blocked_reason", None) in {
                "battery_cutoff", "battery_recovering", "battery_stale", "battery_unavailable", "battery_invalid"
            }:
                self._clear_nav2_cmd_vel_block()

        return {
            "status": status,
            "motionAllowed": blocked_reason is None,
            "blockedReason": blocked_reason,
            "cause": cause,
            "recovery": recovery,
            "value": value,
            "raw": None if raw is _BATTERY_UNSET else raw,
            "unit": "percent" if valid_percent or value is not None else "unknown",
            "readStatus": read_status,
            "readError": read_error,
            "fresh": valid_percent,
            "lastKnownAt": getattr(self, "battery_last_valid_at", None),
            "ageSec": round(age_sec, 3) if age_sec is not None else None,
            "warningPercent": DEFAULT_BATTERY_WARNING_PCT,
            "cutoffPercent": DEFAULT_BATTERY_CUTOFF_PCT,
            "recoveryPercent": DEFAULT_BATTERY_RECOVERY_PCT,
            "maxAgeSec": DEFAULT_BATTERY_MAX_AGE_SEC,
        }

    def _read_battery_with_timeout(self, robot: Any) -> tuple[Any, str]:
        if not self._lock.acquire(blocking=False):
            return None, "robot serial busy"

        raw = None
        read_error = ""
        serial_port = None
        original_timeout = _BATTERY_UNSET
        timeout_changed = False
        try:
            serial_port = getattr(robot, "ser", None)
            original_timeout = getattr(serial_port, "timeout", _BATTERY_UNSET)
            if original_timeout is not _BATTERY_UNSET:
                bounded_timeout = (
                    DEFAULT_BATTERY_READ_TIMEOUT_SEC
                    if original_timeout is None
                    else min(float(original_timeout), DEFAULT_BATTERY_READ_TIMEOUT_SEC)
                )
                serial_port.timeout = bounded_timeout
                timeout_changed = True
            # DOGZILLALib 3.1.9 bounds read_battery with its own one-second
            # wall loop. Keep that UART call synchronous under the shared lock.
            raw = call_first(robot, ["read_Battery", "read_battery"])
        except Exception as error:
            read_error = str(error)
        finally:
            try:
                if timeout_changed:
                    serial_port.timeout = original_timeout
            except Exception as error:
                raw = None
                read_error = str(error)
            self._lock.release()

        return raw, read_error

    def _battery_motion_rejection(self, kind: str, params: dict[str, Any]) -> dict[str, Any] | None:
        if not canonical_plan_has_motion(kind, params):
            return None
        safety = self._battery_safety_snapshot(refresh=True)
        if safety.get("motionAllowed") is True:
            return None

        stop = self._execute_emergency_stop(reason=safety.get("blockedReason") or "battery_safety")
        return {
            "executed": False,
            "delivery": "battery-safety-blocked",
            "kind": kind,
            "error": safety.get("cause") or "Battery safety blocked motion.",
            "operatorMessage": safety.get("recovery") or "Restore fresh, safe battery telemetry before motion.",
            "batterySafety": safety,
            "safeStop": stop,
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

        if kind == "noop" and params.get("reason") == "clear_emergency_stop":
            self.cancel_active_navigation()
            safety = self._battery_safety_snapshot(refresh=True)
            if safety.get("motionAllowed") is not True:
                return {
                    "executed": False,
                    "delivery": "battery-safety-blocked",
                    "error": safety.get("cause"),
                    "operatorMessage": safety.get("recovery"),
                    "batterySafety": safety,
                }
            self._clear_nav2_cmd_vel_block()
            return {
                "executed": True,
                "delivery": "emergency-stop-cleared",
                "nav2CmdVelBlocked": False,
            }

        if kind == "noop" and params.get("reason") == "command_preempt":
            return self._execute_command_preempt()

        battery_rejection = self._battery_motion_rejection(str(kind or ""), params)
        if battery_rejection is not None:
            return battery_rejection

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

        battery_rejection = self._battery_motion_rejection("locomotion.relative", params)
        if battery_rejection is not None:
            result = {
                **battery_rejection,
                "delivery": "nav2-gait-adapter-blocked",
                "kind": "nav2.cmd_vel.gait_adapter",
                "blocked": True,
                "params": params,
            }
            self.last_nav2_gait_command = {
                "receivedAt": utc_now(),
                "result": result,
            }
            return result

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
                "batteryUnit": "unknown",
                "batteryReadStatus": "unavailable",
                "motors": None,
                "roll": None,
                "pitch": None,
                "yaw": None,
                "imuRaw": None,
                "readErrors": {},
                "readAt": utc_now(),
            }

            state_fields = []
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
                except Exception as error:
                    result["readErrors"][field] = str(error)

        battery_safety = self._battery_safety_snapshot(refresh=True, robot=robot)
        result["batterySafety"] = battery_safety
        result["batteryReadStatus"] = battery_safety.get("readStatus") or "unavailable"
        if battery_safety.get("value") is not None and battery_safety.get("unit") == "percent":
            result["battery"] = battery_safety.get("value")
            result["batteryUnit"] = "percent"
        if result["batteryReadStatus"] == "read-failed":
            result["readErrors"]["battery"] = battery_safety.get("readError") or "read_Battery returned failure sentinel 0"
        elif result["batteryReadStatus"] == "invalid-percent":
            result["readErrors"]["battery"] = "read_Battery did not return an integer percentage from 1 to 100"

        blocked_reason = battery_safety.get("blockedReason")
        if (
            blocked_reason
            and not self.dry_run
            and getattr(self, "battery_stop_reason", None) != blocked_reason
        ):
            stop = self._execute_emergency_stop(reason=blocked_reason)
            self.battery_stop_reason = blocked_reason
            battery_safety["safeStopApplied"] = stop.get("executed") is True
            if stop.get("error"):
                battery_safety["safeStopError"] = stop["error"]

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
        lateral_limit = (
            DOGZILLA_MANUAL_MAX_LATERAL_STEP
            if params.get("source") in ("gamepad", "touch")
            else DOGZILLA_LOCOMOTION_MAX_LATERAL_STEP
        )
        y_step = clamp(
            float(params.get("y_step") or 0),
            -lateral_limit,
            lateral_limit,
        )
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
        if self._nav2_cmd_vel_is_blocked():
            blocked_reason = getattr(self, "nav2_cmd_vel_blocked_reason", None) or "unknown"
            return {
                "executed": False,
                "delivery": "rejected",
                "kind": "locomotion.goto",
                "waypoint": params.get("waypoint") or "",
                "waypointSafe": False,
                "error": f"Nav2 gait adapter is blocked by {blocked_reason}; clear emergency stop before waypoint navigation.",
                "blockedReason": blocked_reason,
                "nav2CmdVelBlocked": True,
            }

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
        if current_mode != "navigate":
            current_snapshot = self.nav2_client.snapshot()
            if current_snapshot.get("waypointReady") is True:
                _set_nav_mode("navigate", {"ok": True, "alreadyActive": True})
                mode_transition = {
                    "from": current_mode,
                    "to": "navigate",
                    "started": False,
                    "alreadyActive": True,
                }
            else:
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

            if avoidance_request.get("mode") == NAV2_COSTMAP_LIDAR_MODE:
                avoidance_request = {
                    **avoidance_request,
                    "scanStatus": self.nav2_client._scan_snapshot(),
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

        wait_for_result = params.get("waitForResult") is True
        if wait_for_result:
            try:
                result_timeout = clamp(float(params.get("resultTimeoutSec") or 600.0), 1.0, 900.0)
            except (TypeError, ValueError):
                return {"executed": False, "error": "invalid_navigation_result_timeout"}
            result = self.nav2_client.send_goal(
                frame=frame,
                x=x,
                y=y,
                yaw=yaw,
                wait_for_result=True,
                result_timeout=result_timeout,
            )
        else:
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
        if result.get("goalCompleted") is True:
            response["status"] = "arrived"
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


def autonomous_mapping_marker_is_live(marker: Path, proc_root: Path = Path("/proc")) -> bool:
    try:
        pid = int(marker.read_text(encoding="utf-8").strip())
        command = (proc_root / str(pid) / "cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", errors="replace")
        return "autonomous_mapping_supervisor.sh" in command
    except Exception:
        return False


def get_autonomous_mapping_status(
    maps_dir: Path = AUTONOMOUS_MAPPING_DIR,
    proc_root: Path = Path("/proc"),
) -> dict[str, Any]:
    def read_json(name: str) -> dict[str, Any]:
        try:
            payload = json.loads((maps_dir / name).read_text(encoding="utf-8"))
            return payload if isinstance(payload, dict) else {}
        except Exception:
            return {}

    status = read_json("autonomous-mapping-status.json")
    result = read_json("autonomous-mapping-result.json")
    resume_pose = map_metadata_module.normalize_resume_pose(read_json("robodoge_home_map.json").get("resumePose"))
    return {
        "active": (maps_dir / "autonomous-mapping.ready").is_file()
        and autonomous_mapping_marker_is_live(maps_dir / "autonomous-mapping.active", proc_root),
        "state": status.get("state") or result.get("state") or "idle",
        "startedAt": status.get("startedAt"),
        "updatedAt": status.get("updatedAt"),
        "candidateAvailable": result.get("state") == "candidate-ready" or "candidate=true" in str(result.get("detail") or ""),
        "detail": result.get("detail") or status.get("reason") or "",
        "resumePose": resume_pose,
    }


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
                    "navStandby": get_nav_mode() in {"idle", "localize", "sleep"},
                    "wakeReady": not _NAV_MODE_TRANSITIONING,
                    "gaitBlocked": self.server.runtime._nav2_cmd_vel_is_blocked(),
                    "gaitBlockedReason": getattr(self.server.runtime, "nav2_cmd_vel_blocked_reason", None),
                    "batterySafety": runtime.get("batterySafety"),
                    "autonomousMapping": get_autonomous_mapping_status(),
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
            localization = read_localization_status()
            waypoint_ready = (
                bool(nav2_snapshot.get("waypointReady"))
                and localization.get("trusted") is True
                and get_nav_mode() == "navigate"
            )
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
                    "batterySafety": self.server.runtime._battery_safety_snapshot(refresh=False),
                    "nav2Ready": waypoint_ready,
                    "waypointReady": waypoint_ready,
                    "localization": localization,
                    "nav2Backend": nav2_snapshot.get("backend", "unknown"),
                    "canSendGoal": bool(nav2_snapshot.get("canSendGoal")),
                    "autonomousMapping": get_autonomous_mapping_status(),
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
                "error": scan.get("error"),
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

            if command_accepted and result.get("goalCompleted") is True:
                record = {
                    "commandId": command_id,
                    "receivedAt": utc_now(),
                    "completedAt": utc_now(),
                    "envelope": envelope,
                    "canonicalPlan": canonical_plan,
                    "result": result,
                    "motionStatus": "arrived",
                }
                self.server.recent_commands.appendleft(record)
                append_log_record(record)
                self._send_json(
                    200,
                    {
                        "accepted": True,
                        "commandId": command_id,
                        "result": result,
                        **identity_payload(),
                    },
                )
                return

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
        try:
            return clamp_int(int(raw_action_id), 1, 255)
        except (TypeError, ValueError, OverflowError):
            return None

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
