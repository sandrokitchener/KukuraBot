from __future__ import annotations

import argparse
import json
import math
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlsplit
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


CONTAINER_NAME = os.environ.get("DOGZILLA_CONTAINER", "robodoge-rosbridge")
REMOTE_ROOT = os.environ.get("REMOTE_ROOT", "/home/pi/robodoge")
AUTONOMOUS_MAPPING_DIR = Path(REMOTE_ROOT) / "maps"
LOCALIZATION_STATUS_FILE = AUTONOMOUS_MAPPING_DIR / "robodoge_localization_status.json"
MAP_POSE_MODE_FILE = AUTONOMOUS_MAPPING_DIR / "robodoge_map_pose_mode.json"
NAV2_BATTERY_BLOCK_REASONS = frozenset({
    "battery_cutoff",
    "battery_recovering",
    "battery_stale",
    "battery_unavailable",
    "battery_invalid",
})


def _run(cmd: str, timeout: float = 15.0) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except subprocess.TimeoutExpired as e:
        return -1, f"timed out after {timeout}s: {e.output or ''} {e.stderr or ''}"
    except OSError as e:
        return -1, str(e)


def get_nav_mode() -> str:
    return "navigate"


def nav_mode_snapshot() -> dict[str, Any]:
    return {
        "mode": "navigate",
        "transitioning": False,
        "idleDelaySec": 0.0,
        "history": [],
    }


def nav2_gait_health_snapshot(runtime: Any) -> dict[str, Any]:
    """Return the read-only HTTP edge contract used by Pi Nav2 supervision."""
    mode = nav_mode_snapshot()
    return {
        "ok": True,
        "mode": "http-to-dogzillalib",
        "endpoint": "/nav2/cmd_vel",
        "sourceTopic": "/cmd_vel",
        "navMode": mode["mode"],
        "transitioning": mode["transitioning"],
        "runtimeAvailable": bool(getattr(runtime, "available", False)),
        # A safety block is healthy infrastructure. It must stop motion without
        # causing the Nav2 service supervisor to restart-loop.
        "blocked": bool(runtime._nav2_cmd_vel_is_blocked()),
        "blockedReason": getattr(runtime, "nav2_cmd_vel_blocked_reason", None),
    }


def set_nav_mode(mode: str) -> dict[str, Any]:
    mode = str(mode).lower().strip()
    if mode != "navigate":
        return {
            "ok": False,
            "error": "navigation_always_on",
            "mode": "navigate",
            "validModes": ["navigate"],
            "changed": False,
            "navStandby": False,
            "standbyEnabled": False,
        }
    return {
        "ok": True,
        "mode": "navigate",
        "previousMode": "navigate",
        "changed": False,
        "navStandby": False,
        "standbyEnabled": False,
    }


def sleep_pi() -> dict[str, Any]:
    return set_nav_mode("sleep")


def wake_pi() -> dict[str, Any]:
    return set_nav_mode("navigate")


def sleep_status() -> dict[str, Any]:
    return {"ok": True, "sleeping": False, "mode": "navigate"}


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
    pulse_vendor_turn_rate,
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
    _env_number("DOGZILLA_NAV2_MIN_BATTERY_PCT", 30.0),
    minimum=1.0,
)
DEFAULT_BATTERY_WARNING_PCT = max(
    DEFAULT_BATTERY_CUTOFF_PCT,
    _env_number("DOGZILLA_BATTERY_WARNING_PERCENT", 35.0, minimum=1.0),
)
DEFAULT_BATTERY_RECOVERY_PCT = max(
    DEFAULT_BATTERY_CUTOFF_PCT,
    _env_number("DOGZILLA_BATTERY_RECOVERY_PERCENT", 35.0, minimum=1.0),
)
DEFAULT_BATTERY_MAX_AGE_SEC = _env_number(
    "DOGZILLA_BATTERY_MAX_AGE_SEC", 15.0, minimum=1.0, maximum=300.0
)
DEFAULT_BATTERY_TRANSIENT_GRACE_SEC = _env_number(
    "DOGZILLA_BATTERY_TRANSIENT_GRACE_SEC", 15.0, minimum=1.0, maximum=120.0
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
DEFAULT_NAV2_RESULT_MONITOR_TIMEOUT_SEC = _env_number(
    "DOGZILLA_NAV2_RESULT_MONITOR_TIMEOUT_SEC", 600.0, minimum=1.0, maximum=900.0
)
DEFAULT_NAV2_CMD_VEL_MAX_AGE_SEC = _env_number(
    "DOGZILLA_NAV2_CMD_VEL_MAX_AGE_SEC", 0.75, minimum=0.1, maximum=5.0
)
DEFAULT_NAV2_CMD_VEL_DEADMAN_SEC = _env_number(
    "DOGZILLA_NAV2_CMD_VEL_DEADMAN_SEC", 0.75, minimum=0.1, maximum=5.0
)
DEFAULT_NAV2_CMD_VEL_DEADMAN_RETRY_SEC = 0.1
DEFAULT_NAV2_SHUTDOWN_STOP_ATTEMPTS = 3

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
    if kind == "stabilize.set":
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


def validate_goal_inside_active_map(
    frame: str,
    x: float,
    y: float,
    source_frame: str = "",
    *,
    map_id: str = "",
    map_fingerprint: str = "",
) -> dict[str, Any]:
    return map_metadata_module.validate_goal_inside_active_map(
        frame,
        x,
        y,
        source_frame=source_frame,
        metadata_path=DEFAULT_MAP_METADATA_FILE,
        default_yaml_path=DEFAULT_MAP_YAML_FILE,
        map_id=map_id,
        map_fingerprint=map_fingerprint,
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
        return {
            "ok": False,
            "checked": False,
            "reason": "nav2_snapshot_unavailable",
            "message": "Nav2 waypoint readiness evidence is unavailable",
        }

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
        self.nav2_gait_nonzero_command_count = 0
        self.last_nav2_gait_command: dict[str, Any] | None = None
        self.nav2_cmd_vel_deadman_stop_count = 0
        self.nav2_cmd_vel_deadman_last_stop: dict[str, Any] | None = None
        self.nav2_cmd_vel_blocked = False
        self.nav2_cmd_vel_blocked_reason: str | None = None
        self._nav2_cmd_vel_block_reasons: set[str] = set()
        self._nav2_cmd_vel_block_lock = threading.RLock()
        self._shutdown_lock = threading.Lock()
        self._shutdown_result: dict[str, Any] | None = None
        self.battery_safety_enforced = True
        self.battery_last_valid_percent: float | None = None
        self.battery_last_valid_monotonic: float | None = None
        self.battery_last_valid_at: str | None = None
        self.battery_last_read_monotonic: float | None = None
        self.battery_motion_block_reason: str | None = None
        self.battery_stop_reason: str | None = None
        self.battery_transient_failure_since: float | None = None

        for vendor_path in self.vendor_paths:
            if vendor_path.exists():
                sys.path.insert(0, str(vendor_path))

        self.DOGZILLA = self._load_factory()
        self._start_nav2_cmd_vel_deadman()
        self.startup_stop = self._initialize_nav2_motion_safe_state()

    @property
    def available(self) -> bool:
        return self.import_error is None

    def snapshot(self, *, refresh: bool = True) -> dict[str, Any]:
        if refresh:
            nav2 = self.nav2_client.snapshot()
        else:
            try:
                nav2 = self.nav2_client.snapshot(refresh=False)
            except TypeError:
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
            # Health polling is also the bridge's battery watchdog. Refresh is
            # rate-limited inside _battery_safety_snapshot, so this does not
            # issue a serial read on every request, but it prevents a healthy
            # robot from being latched off merely because /healthz was polled.
            "batterySafety": self._battery_safety_snapshot(refresh=refresh, enforce=refresh),
            "nav2GaitAdapter": {
                "receivedCount": int(getattr(self, "nav2_gait_adapter_count", 0) or 0),
                "nonzeroCommandCount": int(getattr(self, "nav2_gait_nonzero_command_count", 0) or 0),
                "lastCommand": getattr(self, "last_nav2_gait_command", None),
                "blocked": self._nav2_cmd_vel_is_blocked(),
                "blockedReason": getattr(self, "nav2_cmd_vel_blocked_reason", None),
                "endpoint": "/nav2/cmd_vel",
                "sourceTopic": "/cmd_vel",
            },
            "startupStop": getattr(self, "startup_stop", None),
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
        action_server_available = (
            nav2.get("actionServerAvailable") is True
            or nav2.get("actionServerDiscovered") is True
            or nav2.get("serverAvailable") is True
        )
        localization_trusted = localization.get("trusted") is True
        waypoint_ready = nav2.get("waypointReady") is True and localization_trusted
        blockers = list(nav2.get("blockers") or [])
        if not localization_trusted:
            blockers.insert(0, localization.get("error") or "Robot location is untrusted; relocalization required")
        odom = nav2.get("odom") if isinstance(nav2.get("odom"), dict) else {}
        scan = nav2.get("scan") if isinstance(nav2.get("scan"), dict) else {}
        readiness = nav2.get("readiness") if isinstance(nav2.get("readiness"), dict) else {}
        checked_at = readiness.get("checkedAt")
        try:
            snapshot_age_sec = max(0.0, time.time() - float(checked_at))
        except (TypeError, ValueError):
            snapshot_age_sec = None
        return {
            "available": waypoint_ready,
            "primary": "nav2" if waypoint_ready else "unavailable",
            "actionServerAvailable": action_server_available,
            "canSendGoal": nav2.get("canSendGoal") is True,
            "stackActive": nav2.get("stackActive") is True,
            "localizationTrusted": localization_trusted,
            "odomFresh": odom.get("fresh") is True,
            "tfFresh": odom.get("tfFresh") is True,
            "scanFresh": scan.get("fresh") is True,
            "snapshotTimestamp": checked_at,
            "snapshotAgeSec": snapshot_age_sec,
            "ownerMode": readiness.get("ownerMode"),
            "waypointReady": waypoint_ready,
            "blockers": blockers,
            "localization": localization,
            "nav2": nav2,
        }

    def _battery_safety_snapshot(
        self,
        *,
        refresh: bool = False,
        enforce: bool = True,
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
            self.battery_transient_failure_since = None
        elif sample_supplied and getattr(self, "battery_transient_failure_since", None) is None:
            self.battery_transient_failure_since = now

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
            transient_age = (
                now - float(self.battery_transient_failure_since)
                if getattr(self, "battery_transient_failure_since", None) is not None
                else None
            )
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
            elif (
                transient_age is not None
                and transient_age <= DEFAULT_BATTERY_TRANSIENT_GRACE_SEC
                and read_status in {"read-failed", "invalid-percent"}
            ):
                status = "last-known"
                cause = "Battery refresh failed transiently; using the last known percentage."
                recovery = "Confirm fresh DOGZILLALib battery telemetry; motion cutoff remains enforced."
            else:
                blocked_reason = "battery_stale"
                status = "stale"
                cause = f"Battery reading is older than {DEFAULT_BATTERY_MAX_AGE_SEC:g} seconds."
        else:
            blocked_reason = "battery_invalid" if read_status == "invalid-percent" else "battery_unavailable"
            status = "invalid" if read_status == "invalid-percent" else "unavailable"
            if read_status == "invalid-percent":
                cause = "DOGZILLA battery reading was not an integer percentage from 1 to 100."

        if enforce:
            if blocked_reason:
                self.battery_motion_block_reason = blocked_reason
                self._replace_nav2_cmd_vel_blocks(NAV2_BATTERY_BLOCK_REASONS, blocked_reason)
            else:
                self.battery_motion_block_reason = None
                self.battery_stop_reason = None
                self._replace_nav2_cmd_vel_blocks(NAV2_BATTERY_BLOCK_REASONS, None)

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
            "transientGraceSec": DEFAULT_BATTERY_TRANSIENT_GRACE_SEC,
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

    def _global_motion_block_rejection(
        self,
        kind: str,
        params: dict[str, Any],
    ) -> dict[str, Any] | None:
        if not canonical_plan_has_motion(kind, params):
            return None
        reason = self._global_motion_block_reason()
        if reason is None:
            return None
        return {
            "executed": False,
            "delivery": "rejected" if kind == "locomotion.goto" else "motion-safety-blocked",
            "kind": kind,
            "error": f"Robot motion is blocked by {reason}.",
            "blocked": True,
            "blockedReason": reason,
            "nav2CmdVelBlocked": True,
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
            blocked_reason = self._nav2_cmd_vel_block_reason()
            if blocked_reason not in (None, "emergency_stop"):
                return {
                    "executed": False,
                    "delivery": "motion-safety-blocked",
                    "error": f"The {blocked_reason} motion block cannot be cleared as an emergency stop.",
                    "blockedReason": blocked_reason,
                    "nav2CmdVelBlocked": True,
                }
            if blocked_reason == "emergency_stop":
                if not self._clear_nav2_cmd_vel_block_if_reason("emergency_stop"):
                    concurrent_reason = self._nav2_cmd_vel_block_reason()
                    return {
                        "executed": False,
                        "delivery": "motion-safety-blocked",
                        "error": f"Motion block changed to {concurrent_reason or 'unknown'} while clearing emergency stop.",
                        "blockedReason": concurrent_reason,
                        "nav2CmdVelBlocked": concurrent_reason is not None,
                    }
            remaining_reason = self._nav2_cmd_vel_block_reason()
            return {
                "executed": True,
                "delivery": "emergency-stop-cleared",
                "nav2CmdVelBlocked": remaining_reason is not None,
                **({"blockedReason": remaining_reason} if remaining_reason is not None else {}),
            }

        if kind == "noop" and params.get("reason") == "command_preempt":
            return self._execute_command_preempt()

        battery_rejection = self._battery_motion_rejection(str(kind or ""), params)
        if battery_rejection is not None:
            return battery_rejection

        global_block = self._global_motion_block_rejection(str(kind or ""), params)
        if global_block is not None:
            return global_block

        if kind == "locomotion.goto":
            cancel_event = self._replace_navigation_cancel_event()
            return self._execute_goto(params, cancel_event=cancel_event)

        if not self.available:
            return {"executed": False, "error": self.import_error or "DOGZILLALib unavailable"}

        if kind != "state.read":
            self.cancel_active_navigation()

        with self._lock:
            global_block = self._global_motion_block_rejection(str(kind or ""), params)
            if global_block is not None:
                return global_block
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

    def _initialize_nav2_motion_safe_state(self) -> dict[str, Any]:
        if self.dry_run:
            return {
                "attempted": False,
                "executed": True,
                "delivery": "dry-run",
                "nav2CmdVelBlocked": False,
            }

        self._block_nav2_cmd_vel("bridge_startup")
        result = self._execute_nav2_fail_safe_stop()
        if result.get("executed") is True:
            self._clear_nav2_cmd_vel_block_if_reason("bridge_startup")
        return {
            **result,
            "startup": True,
            "nav2CmdVelBlocked": self._nav2_cmd_vel_is_blocked(),
            "blockedReason": self._nav2_cmd_vel_block_reason(),
        }

    def _start_nav2_cmd_vel_deadman(
        self,
        *,
        timeout_sec: float = DEFAULT_NAV2_CMD_VEL_DEADMAN_SEC,
    ) -> None:
        thread = getattr(self, "_nav2_cmd_vel_deadman_thread", None)
        if thread is not None and thread.is_alive():
            return
        self._nav2_cmd_vel_deadman_timeout_sec = max(float(timeout_sec), 0.1)
        self._nav2_cmd_vel_deadman_condition = threading.Condition()
        self._nav2_cmd_vel_deadman_deadline = None
        self._nav2_cmd_vel_deadman_shutdown = False
        self.nav2_cmd_vel_deadman_stop_count = int(
            getattr(self, "nav2_cmd_vel_deadman_stop_count", 0) or 0
        )
        self._nav2_cmd_vel_deadman_thread = threading.Thread(
            target=self._nav2_cmd_vel_deadman_loop,
            daemon=True,
            name="nav2-cmd-vel-deadman",
        )
        self._nav2_cmd_vel_deadman_thread.start()

    def _stop_nav2_cmd_vel_deadman(self, timeout: float = 1.0) -> None:
        condition = getattr(self, "_nav2_cmd_vel_deadman_condition", None)
        if condition is None:
            return
        with condition:
            self._nav2_cmd_vel_deadman_shutdown = True
            condition.notify_all()
        thread = getattr(self, "_nav2_cmd_vel_deadman_thread", None)
        if thread is not None:
            thread.join(max(float(timeout), 0.0))

    def _arm_nav2_cmd_vel_deadman(self) -> None:
        condition = getattr(self, "_nav2_cmd_vel_deadman_condition", None)
        if condition is None:
            return
        with condition:
            now = time.monotonic()
            self.nav2_cmd_vel_last_nonzero_monotonic = now
            self._nav2_cmd_vel_deadman_deadline = now + float(
                self._nav2_cmd_vel_deadman_timeout_sec
            )
            condition.notify_all()

    def _disarm_nav2_cmd_vel_deadman(self) -> None:
        condition = getattr(self, "_nav2_cmd_vel_deadman_condition", None)
        if condition is None:
            return
        with condition:
            self._nav2_cmd_vel_deadman_deadline = None
            condition.notify_all()

    def _schedule_nav2_cmd_vel_deadman_retry(self) -> None:
        condition = getattr(self, "_nav2_cmd_vel_deadman_condition", None)
        if condition is None:
            return
        with condition:
            self._nav2_cmd_vel_deadman_deadline = (
                time.monotonic() + DEFAULT_NAV2_CMD_VEL_DEADMAN_RETRY_SEC
            )
            condition.notify_all()

    def _nav2_cmd_vel_deadman_loop(self) -> None:
        condition = self._nav2_cmd_vel_deadman_condition
        while True:
            with condition:
                while True:
                    if self._nav2_cmd_vel_deadman_shutdown:
                        return
                    deadline = self._nav2_cmd_vel_deadman_deadline
                    if deadline is None:
                        condition.wait()
                        continue
                    remaining = float(deadline) - time.monotonic()
                    if remaining > 0:
                        condition.wait(remaining)
                        continue
                    break

            lock = getattr(self, "_lock", None)
            if lock is None:
                time.sleep(DEFAULT_NAV2_CMD_VEL_DEADMAN_RETRY_SEC)
                continue

            with lock:
                with condition:
                    if self._nav2_cmd_vel_deadman_shutdown:
                        return
                    deadline = self._nav2_cmd_vel_deadman_deadline
                    if deadline is None or float(deadline) > time.monotonic():
                        continue
                    self._nav2_cmd_vel_deadman_deadline = None

                robot = self._robot() if self.available else None
                if robot is None:
                    stop = {
                        "attempted": False,
                        "executed": False,
                        "delivery": "nav2-fail-safe-stop-unavailable",
                        "error": self.robot_error or self.import_error or "robot unavailable",
                    }
                else:
                    stop = self._execute_nav2_fail_safe_stop_locked(robot)

                with condition:
                    self.nav2_cmd_vel_deadman_stop_count = int(
                        getattr(self, "nav2_cmd_vel_deadman_stop_count", 0) or 0
                    ) + 1
                    self.nav2_cmd_vel_deadman_last_stop = {
                        "at": utc_now(),
                        "result": stop,
                    }
                    if stop.get("executed") is not True:
                        self._nav2_cmd_vel_deadman_deadline = (
                            time.monotonic() + DEFAULT_NAV2_CMD_VEL_DEADMAN_RETRY_SEC
                        )
                    condition.notify_all()
                if stop.get("executed") is True:
                    self._clear_nav2_cmd_vel_block_if_reason("bridge_startup")

    def _execute_nav2_fail_safe_stop_locked(self, robot: Any) -> dict[str, Any]:
        completed: list[str] = []
        errors: list[str] = []
        operations = (
            ("move-x-zero", lambda: robot.move("x", 0)),
            ("move-y-zero", lambda: robot.move("y", 0)),
            ("turn-zero", lambda: robot.turn(0)),
            ("stop", robot.stop),
        )
        for name, operation in operations:
            try:
                operation()
                completed.append(name)
            except Exception as error:
                errors.append(f"{name}:{error}")
        return {
            "attempted": True,
            "executed": not errors,
            "delivery": "DOGZILLALib fail-safe stop" if not errors else "nav2-fail-safe-stop-error",
            "completed": completed,
            **({"errors": errors} if errors else {}),
        }

    def _execute_nav2_fail_safe_stop(self) -> dict[str, Any]:
        if self.dry_run:
            result = {
                "attempted": False,
                "executed": False,
                "delivery": "dry-run",
            }
            self._schedule_nav2_cmd_vel_deadman_retry()
            return result
        if not self.available:
            result = {
                "attempted": False,
                "executed": False,
                "delivery": "nav2-fail-safe-stop-unavailable",
                "error": self.import_error or "DOGZILLALib unavailable",
            }
            self._schedule_nav2_cmd_vel_deadman_retry()
            return result

        lock = getattr(self, "_lock", None)
        if lock is None:
            lock = threading.Lock()
            self._lock = lock

        with lock:
            robot = self._robot()
            if robot is None:
                result = {
                    "attempted": True,
                    "executed": False,
                    "delivery": "nav2-fail-safe-stop-unavailable",
                    "error": self.robot_error or "robot unavailable",
                }
                self._schedule_nav2_cmd_vel_deadman_retry()
                return result

            result = self._execute_nav2_fail_safe_stop_locked(robot)
            if result.get("executed") is True:
                self._disarm_nav2_cmd_vel_deadman()
            else:
                self._schedule_nav2_cmd_vel_deadman_retry()
            return result

    def shutdown(self) -> dict[str, Any]:
        shutdown_lock = getattr(self, "_shutdown_lock", None)
        if shutdown_lock is None:
            shutdown_lock = threading.Lock()
            self._shutdown_lock = shutdown_lock

        with shutdown_lock:
            previous = getattr(self, "_shutdown_result", None)
            if isinstance(previous, dict):
                return previous

            self._block_nav2_cmd_vel("bridge_shutdown")
            stop_result: dict[str, Any] = {
                "attempted": False,
                "executed": False,
                "delivery": "nav2-fail-safe-stop-unavailable",
            }
            attempts = 0
            for attempts in range(1, DEFAULT_NAV2_SHUTDOWN_STOP_ATTEMPTS + 1):
                stop_result = self._execute_nav2_fail_safe_stop()
                if stop_result.get("executed") is True:
                    break
                if attempts < DEFAULT_NAV2_SHUTDOWN_STOP_ATTEMPTS:
                    time.sleep(DEFAULT_NAV2_CMD_VEL_DEADMAN_RETRY_SEC)

            self._stop_nav2_cmd_vel_deadman()
            result = {
                **stop_result,
                "shutdown": True,
                "shutdownStopAttempts": attempts,
                "nav2CmdVelBlocked": True,
            }
            self._shutdown_result = result
            return result

    def _nav2_cmd_vel_blocked_result(self, params: dict[str, Any]) -> dict[str, Any]:
        return {
            "executed": False,
            "delivery": "nav2-gait-adapter-blocked",
            "kind": "nav2.cmd_vel.gait_adapter",
            "error": "emergency_stop_active",
            "blocked": True,
            "blockedReason": getattr(self, "nav2_cmd_vel_blocked_reason", None) or "emergency_stop",
            "params": params,
        }

    def execute_nav2_cmd_vel(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        payload = payload if isinstance(payload, dict) else {}
        params = nav2_cmd_vel_to_locomotion(payload)
        if get_autonomous_mapping_status().get("active") is True:
            params["gait"] = "trot" if params["x_step"] else "walk"
            params["pace"] = "normal"
            params.setdefault("mapping", {})["allowTrot"] = bool(params["x_step"])
        self.nav2_gait_adapter_count = int(getattr(self, "nav2_gait_adapter_count", 0) or 0) + 1
        has_motion = locomotion_params_have_motion(params)

        if has_motion:
            source_received_at = payload.get("receivedAt")
            try:
                source_received_at = float(source_received_at)
            except (TypeError, ValueError):
                source_received_at = None
            source_age_sec = (
                time.time() - source_received_at
                if source_received_at is not None and math.isfinite(source_received_at)
                else None
            )
            if (
                source_age_sec is None
                or source_age_sec > DEFAULT_NAV2_CMD_VEL_MAX_AGE_SEC
                or source_age_sec < -1.0
            ):
                safety_stop = self._execute_nav2_fail_safe_stop()
                result = {
                    "executed": False,
                    "delivery": "nav2-gait-adapter-stale",
                    "kind": "nav2.cmd_vel.gait_adapter",
                    "error": "stale_or_invalid_cmd_vel_timestamp",
                    "stale": True,
                    "sourceReceivedAt": source_received_at,
                    "sourceAgeSec": source_age_sec,
                    "maxAgeSec": DEFAULT_NAV2_CMD_VEL_MAX_AGE_SEC,
                    "safetyStop": safety_stop,
                    "params": params,
                }
                self.last_nav2_gait_command = {
                    "receivedAt": utc_now(),
                    "result": result,
                }
                return result
            self.nav2_gait_nonzero_command_count = int(
                getattr(self, "nav2_gait_nonzero_command_count", 0) or 0
            ) + 1

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

        if (
            has_motion
            and self._nav2_cmd_vel_block_reason() == "command_preempt"
            and get_autonomous_mapping_status().get("active") is True
        ):
            self._clear_command_preempt_nav2_cmd_vel_block()

        if self._nav2_cmd_vel_is_blocked() and locomotion_params_have_motion(params):
            result = self._nav2_cmd_vel_blocked_result(params)
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
            if has_motion and self._nav2_cmd_vel_is_blocked():
                result = self._nav2_cmd_vel_blocked_result(params)
                self.last_nav2_gait_command = {
                    "receivedAt": utc_now(),
                    "result": result,
                }
                return result

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
                requested_turn_rate = float(params.get("turn_rate") or 0.0)
                pulsed_turn_rate, turn_phase, turn_sign = pulse_vendor_turn_rate(
                    requested_turn_rate,
                    getattr(self, "nav2_turn_pulse_accumulator", 0.0),
                    getattr(self, "nav2_turn_pulse_sign", 0),
                )
                self.nav2_turn_pulse_accumulator = turn_phase
                self.nav2_turn_pulse_sign = turn_sign
                params["turn_rate"] = pulsed_turn_rate
                params.setdefault("mapping", {}).update(
                    {
                        "requestedTurnRate": requested_turn_rate,
                        "vendorTurnPulseActive": (
                            requested_turn_rate != 0.0
                            and pulsed_turn_rate != requested_turn_rate
                        ),
                    }
                )
                locomotion = self._execute_locomotion(robot, params)
                if locomotion.get("executed") is True:
                    if has_motion:
                        self._arm_nav2_cmd_vel_deadman()
                    else:
                        self._disarm_nav2_cmd_vel_deadman()
                result = {
                    **locomotion,
                    "delivery": "DOGZILLALib nav2 gait adapter",
                    "kind": "nav2.cmd_vel.gait_adapter",
                    "params": params,
                }
            except Exception as error:
                self.robot_error = str(error)
                safety_stop = self._execute_nav2_fail_safe_stop_locked(robot)
                if safety_stop.get("executed") is True:
                    self._disarm_nav2_cmd_vel_deadman()
                else:
                    self._schedule_nav2_cmd_vel_deadman_retry()
                result = {
                    "executed": False,
                    "delivery": "nav2-gait-adapter-error",
                    "error": str(error),
                    "safetyStop": safety_stop,
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
        # A command-preempt gate stays latched while the new goal passes all
        # readiness checks. It is cleared only after Nav2 accepts the fresh goal.
        blocked_reason = self._nav2_cmd_vel_block_reason() or "unknown"
        if blocked_reason not in ("unknown", "command_preempt"):
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
        map_validation = validate_goal_inside_active_map(
            frame,
            x,
            y,
            source_frame=source_frame,
            map_id=str(params.get("mapId") or params.get("map_id") or ""),
            map_fingerprint=str(
                params.get("mapFingerprint") or params.get("map_fingerprint") or ""
            ),
        )
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
        global_block = self._global_motion_block_rejection("locomotion.goto", params)
        if global_block is not None:
            return global_block

        def on_goal_accepted(_accepted: dict[str, Any]) -> None:
            concurrent_block = self._global_motion_block_reason()
            if concurrent_block is not None:
                raise RuntimeError(
                    f"Goal accepted while robot motion became blocked by {concurrent_block}"
                )
            self._clear_command_preempt_nav2_cmd_vel_block()

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
                on_goal_accepted=on_goal_accepted,
            )
        else:
            result = self.nav2_client.send_goal(
                frame=frame,
                x=x,
                y=y,
                yaw=yaw,
                on_goal_accepted=on_goal_accepted,
            )
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
        # Reject late Twist messages from the canceled goal. A fresh accepted
        # goto clears this gate after readiness checks have passed.
        self._block_nav2_cmd_vel("command_preempt")

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

    def _nav2_cmd_vel_state_lock(self) -> threading.RLock:
        lock = getattr(self, "_nav2_cmd_vel_block_lock", None)
        if lock is None:
            lock = threading.RLock()
            self._nav2_cmd_vel_block_lock = lock
        return lock

    @staticmethod
    def _nav2_cmd_vel_block_priority(reason: str) -> int:
        if reason == "bridge_shutdown":
            return 500
        if reason == "emergency_stop":
            return 400
        if reason == "bridge_startup":
            return 350
        if reason in NAV2_BATTERY_BLOCK_REASONS:
            return 200
        if reason == "command_preempt":
            return 100
        # Unknown safety reasons remain fail-closed and outrank transient gates.
        return 300

    def _nav2_cmd_vel_block_reasons_locked(self) -> set[str]:
        reasons = getattr(self, "_nav2_cmd_vel_block_reasons", None)
        if not isinstance(reasons, set):
            reasons = set()
            if bool(getattr(self, "nav2_cmd_vel_blocked", False)):
                reasons.add(str(getattr(self, "nav2_cmd_vel_blocked_reason", None) or "unknown"))
            self._nav2_cmd_vel_block_reasons = reasons
        return reasons

    def _sync_nav2_cmd_vel_block_state_locked(self) -> str | None:
        reasons = self._nav2_cmd_vel_block_reasons_locked()
        if not reasons:
            self.nav2_cmd_vel_blocked = False
            self.nav2_cmd_vel_blocked_reason = None
            return None
        effective = max(
            reasons,
            key=lambda reason: (self._nav2_cmd_vel_block_priority(reason), reason),
        )
        self.nav2_cmd_vel_blocked = True
        self.nav2_cmd_vel_blocked_reason = effective
        return effective

    def _block_nav2_cmd_vel(self, reason: str) -> None:
        with self._nav2_cmd_vel_state_lock():
            self._nav2_cmd_vel_block_reasons_locked().add(str(reason or "unknown"))
            self._sync_nav2_cmd_vel_block_state_locked()

    def _replace_nav2_cmd_vel_blocks(
        self,
        replaced_reasons: set[str] | frozenset[str],
        reason: str | None,
    ) -> None:
        with self._nav2_cmd_vel_state_lock():
            reasons = self._nav2_cmd_vel_block_reasons_locked()
            reasons.difference_update(replaced_reasons)
            if reason is not None:
                reasons.add(str(reason or "unknown"))
            self._sync_nav2_cmd_vel_block_state_locked()

    def _clear_nav2_cmd_vel_block_if_reason(self, reason: str) -> bool:
        with self._nav2_cmd_vel_state_lock():
            reasons = self._nav2_cmd_vel_block_reasons_locked()
            if reason not in reasons:
                return False
            reasons.remove(reason)
            self._sync_nav2_cmd_vel_block_state_locked()
            return True

    def _clear_command_preempt_nav2_cmd_vel_block(self) -> None:
        self._clear_nav2_cmd_vel_block_if_reason("command_preempt")

    def _nav2_cmd_vel_block_reason(self) -> str | None:
        with self._nav2_cmd_vel_state_lock():
            return self._sync_nav2_cmd_vel_block_state_locked()

    def _global_motion_block_reason(self) -> str | None:
        reason = self._nav2_cmd_vel_block_reason()
        return None if reason in (None, "command_preempt") else reason

    def _nav2_cmd_vel_is_blocked(self) -> bool:
        return self._nav2_cmd_vel_block_reason() is not None

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
    active = (maps_dir / "autonomous-mapping.ready").is_file() and autonomous_mapping_marker_is_live(
        maps_dir / "autonomous-mapping.active", proc_root
    )
    candidate_exists = bool(map_metadata_module.list_unpromoted_candidate_metadata(maps_dir))
    return {
        "active": active,
        "state": (
            status.get("state") or result.get("state") or "idle"
            if active
            else result.get("state") or status.get("state") or "idle"
        ),
        "startedAt": status.get("startedAt"),
        "updatedAt": status.get("updatedAt"),
        "candidateAvailable": candidate_exists or result.get("state") == "candidate-ready" or "candidate=true" in str(result.get("detail") or ""),
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
        if urlsplit(self.path).path == "/map/candidate":
            result = map_metadata_module.read_latest_candidate_occupancy_grid(AUTONOMOUS_MAPPING_DIR)
            self._send_json(200 if result.get("ok") else 404, result)
            return
        if self.path == "/nav2/cmd_vel/health":
            self._send_json(200, nav2_gait_health_snapshot(self.server.runtime))
            return
        if urlsplit(self.path).path == "/healthz":
            force_probe = parse_qs(urlsplit(self.path).query).get("probe") == ["1"]
            runtime = self.server.runtime.snapshot(refresh=force_probe)
            self._send_json(
                200,
                {
                    "ok": runtime["available"],
                    "mode": "http-to-dogzillalib",
                    "receivedCount": self.server.received_count,
                    "loadAverage": _get_load_average(),
                    "navMode": get_nav_mode(),
                    "navStandby": False,
                    "wakeReady": True,
                    "gaitBlocked": self.server.runtime._nav2_cmd_vel_is_blocked(),
                    "gaitBlockedReason": getattr(self.server.runtime, "nav2_cmd_vel_blocked_reason", None),
                    "batterySafety": runtime.get("batterySafety"),
                    "autonomousMapping": get_autonomous_mapping_status(),
                    "runtime": runtime,
                },
            )
            return
        if self.path == "/healthz-lite":
            # Lightweight endpoint: uses cached nav2 state, with one bounded
            # backend recovery only when the Pi watcher proves the stack ready.
            nav2 = self.server.runtime.nav2_client
            try:
                nav2_snapshot = nav2.snapshot(refresh=False)
                refresh_backend = getattr(nav2, "refresh_backend_for_ready_snapshot", None)
                if callable(refresh_backend):
                    nav2_snapshot = refresh_backend(nav2_snapshot)
            except Exception as exc:
                nav2_snapshot = {"error": str(exc), "waypointReady": False, "canSendGoal": False, "backend": "unknown"}
            localization = read_localization_status()
            autonomous_mapping = get_autonomous_mapping_status()
            waypoint_ready = (
                bool(nav2_snapshot.get("waypointReady"))
                and localization.get("trusted") is True
                and autonomous_mapping.get("active") is not True
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
                    "batterySafety": self.server.runtime._battery_safety_snapshot(refresh=True),
                    "nav2Ready": waypoint_ready,
                    "waypointReady": waypoint_ready,
                    "localization": localization,
                    "localizationTrusted": localization.get("trusted") is True,
                    "nav2Backend": nav2_snapshot.get("backend", "unknown"),
                    "canSendGoal": bool(nav2_snapshot.get("canSendGoal")),
                    "actionServerAvailable": bool(nav2_snapshot.get("actionServerAvailable")),
                    "stackActive": bool(nav2_snapshot.get("stackActive")),
                    "odomFresh": bool((nav2_snapshot.get("odom") or {}).get("fresh")),
                    "tfFresh": bool((nav2_snapshot.get("odom") or {}).get("tfFresh")),
                    "scanFresh": bool((nav2_snapshot.get("scan") or {}).get("fresh")),
                    "autonomousMapping": autonomous_mapping,
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
                    "runtime": self.server.runtime.snapshot(refresh=False),
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
            self._send_json(200, {
                "ok": True,
                "topic": scan.get("topic", DEFAULT_NAV2_SCAN_TOPIC),
                "publisherCount": scan.get("publisherCount", 0),
                "subscriptionCount": scan.get("subscriptionCount", 0),
                "messageAvailable": scan.get("messageAvailable", False),
                "available": scan.get("available", False),
                "fresh": scan.get("fresh", False),
                "lastMessageAt": scan.get("lastMessageAt"),
                "checkedAt": checked_at,
                "ageSec": scan.get("ageSec"),
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
            return

        if self.path == "/wake":
            result = wake_pi()
            self._send_json(200, result)
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
            self._send_json(409, {
                "ok": False,
                "error": "nav2_gait_calibration_is_immutable",
                "config": get_speed_config(),
            })
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
                start_gait_count = int(
                    getattr(self.server.runtime, "nav2_gait_nonzero_command_count", 0) or 0
                )
                started_at = time.monotonic()
                result["async"] = True
                result["status"] = "accepted"
                result.setdefault("goalStatus", "accepted")
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
        in the handler. This thread observes command activity and waits on the
        accepted goal's GetResult path.
        """
        runtime = self.server.runtime
        motion_status: str = "no-command"
        error_detail: str | None = None
        existing_result: dict[str, Any] = {}

        for record in self.server.recent_commands:
            if record.get("commandId") == command_id:
                existing_result = dict(record.get("result") or {})
                existing_result["status"] = "executing"
                existing_result["goalStatus"] = "executing"
                record["result"] = existing_result
                record["status"] = "executing"
                break

        params = canonical_plan.get("params") if isinstance(canonical_plan.get("params"), dict) else {}
        try:
            result_timeout = clamp(
                float(params.get("resultTimeoutSec") or DEFAULT_NAV2_RESULT_MONITOR_TIMEOUT_SEC),
                1.0,
                900.0,
            )
        except (TypeError, ValueError):
            result_timeout = DEFAULT_NAV2_RESULT_MONITOR_TIMEOUT_SEC
        goal_id = str(existing_result.get("goalId") or "")
        wait_for_result = getattr(getattr(runtime, "nav2_client", None), "wait_for_goal_result", None)
        action_result_holder: dict[str, dict[str, Any]] = {}
        action_result_started = threading.Event()
        action_result_done = threading.Event()

        def collect_action_result() -> None:
            action_result_started.set()
            try:
                if callable(wait_for_result) and goal_id:
                    action_result_holder["result"] = wait_for_result(goal_id, timeout=result_timeout)
                else:
                    action_result_holder["result"] = {
                        "executed": False,
                        "delivery": "nav2-result-unavailable",
                        "error": "Nav2 goal result tracking is unavailable",
                        "goalAccepted": True,
                        "goalCompleted": False,
                        "goalStatus": "unknown",
                        "goalId": goal_id,
                    }
            except Exception as exc:
                action_result_holder["result"] = {
                    "executed": False,
                    "delivery": "nav2-result-unavailable",
                    "error": str(exc),
                    "goalAccepted": True,
                    "goalCompleted": False,
                    "goalStatus": "unknown",
                    "goalId": goal_id,
                }
            finally:
                action_result_done.set()

        threading.Thread(
            target=collect_action_result,
            daemon=True,
            name=f"nav2-result-{command_id}",
        ).start()
        action_result_started.wait(1.0)

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

        if not action_result_done.wait(result_timeout + 5.0):
            action_result = {
                "executed": False,
                "delivery": "nav2-result-timeout",
                "error": f"Nav2 goal did not finish within {result_timeout:.1f}s",
                "goalAccepted": True,
                "goalCompleted": False,
                "goalStatus": "executing",
                "goalId": goal_id,
            }
        else:
            action_result = action_result_holder["result"]

        completed_at = utc_now()

        # Fetch the result from the existing record (set by the handler).
        result: dict[str, Any] = {}
        updated = False
        for record in self.server.recent_commands:
            if record.get("commandId") == command_id:
                result = dict(record.get("result") or {})
                accepted_delivery = result.get("delivery")
                result.update(action_result)
                if accepted_delivery == "accepted":
                    result["delivery"] = accepted_delivery
                result["motionStatus"] = motion_status
                result["status"] = (
                    result.get("goalStatus")
                    if result.get("goalCompleted") is True
                    else "timeout" if action_result.get("delivery") == "nav2-result-timeout"
                    else result.get("goalStatus") or "unknown"
                )
                if error_detail:
                    result["monitorError"] = error_detail
                record["completedAt"] = completed_at
                record["result"] = result
                record["background"] = True
                record["motionStatus"] = motion_status
                record["status"] = result["status"]
                updated = True
                break

        if not updated:
            result = {
                "delivery": "accepted",
                "motionStatus": motion_status,
                **action_result,
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
                "status": result.get("goalStatus") or "unknown",
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
        """Monitor for nonzero command activity using in-memory state only.

        Does NOT call full /healthz-style Docker probes or
        nav2_client._refresh_status(force=True) in a loop. Uses only the
        accepted, nonzero gait-command counter.

        Returns one of: "commanding", "no-command", "cancelled", "failed".
        Commanding is deliberately not reported as physical movement.
        """
        deadline = started_at + window_sec

        while time.monotonic() < deadline:
            if runtime._navigation_cancel_event().is_set():
                return "cancelled"

            current_gait_count = int(
                getattr(runtime, "nav2_gait_nonzero_command_count", 0) or 0
            )
            if current_gait_count > start_gait_count:
                return "commanding"

            time.sleep(0.5)

        return "no-command"

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


def shutdown_direct_bridge(runtime: DogzillaRuntime, server: BridgeServer) -> dict[str, Any]:
    result = runtime.shutdown()
    server.shutdown()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Robo-Doge direct DOGZILLALib bridge")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--serial-port", default=DEFAULT_SERIAL_PORT)
    parser.add_argument("--live", action="store_true", help="Send commands to hardware. Default is dry-run.")
    args = parser.parse_args()

    runtime = DogzillaRuntime(serial_port=args.serial_port, dry_run=DEFAULT_DRY_RUN and not args.live)
    server = BridgeServer((args.host, args.port), Handler, runtime)
    print(f"DOGZILLALib bridge listening on http://{args.host}:{args.port}")
    print(json.dumps(runtime.snapshot()))
    shutdown_requested = threading.Event()
    shutdown_thread: threading.Thread | None = None

    def request_shutdown(_signum: int, _frame: Any) -> None:
        nonlocal shutdown_thread
        if shutdown_requested.is_set():
            return
        shutdown_requested.set()
        shutdown_thread = threading.Thread(
            target=shutdown_direct_bridge,
            args=(runtime, server),
            name="dogzilla-bridge-shutdown",
        )
        shutdown_thread.start()

    previous_sigterm = signal.getsignal(signal.SIGTERM)
    signal.signal(signal.SIGTERM, request_shutdown)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if shutdown_thread is None:
            runtime.shutdown()
        else:
            shutdown_thread.join()
        server.server_close()
        signal.signal(signal.SIGTERM, previous_sigterm)


if __name__ == "__main__":
    main()
