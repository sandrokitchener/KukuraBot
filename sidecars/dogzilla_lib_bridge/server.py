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
from map_pose_navigation import (
    DEFAULT_MAP_NAVIGATION_ENABLED,
    DEFAULT_MAP_NAVIGATION_MAX_TURN_RATE,
    DEFAULT_MAP_NAVIGATION_MAX_X_STEP,
    DEFAULT_MAP_NAVIGATION_MAX_Y_STEP,
    DEFAULT_MAP_NAVIGATION_OBSTACLE_DISTANCE,
    DEFAULT_MAP_NAVIGATION_OBSTACLE_STOP_COUNT,
    DEFAULT_MAP_NAVIGATION_POLL_SEC,
    DEFAULT_MAP_NAVIGATION_TIMEOUT,
    DEFAULT_MAP_NAVIGATION_TURN_GAIN,
    DEFAULT_MAP_NAVIGATION_X_GAIN,
    DEFAULT_MAP_NAVIGATION_YAW_TOLERANCE,
    DEFAULT_MAP_NAVIGATION_Y_GAIN,
    DEFAULT_MAP_POSE_URL,
    DEFAULT_MAP_SCAN_URL,
    MapPoseNavigationExecutor,
)
from motion_utils import clamp, normalize_angle, resolve_map_navigation_timeout, scan_obstacle_counts
from nav2_gait_adapter import (
    DEFAULT_NAV2_GAIT_ALLOW_TROT,
    DEFAULT_NAV2_GAIT_ANGULAR_DEADBAND,
    DEFAULT_NAV2_GAIT_ANGULAR_FULL_SCALE,
    DEFAULT_NAV2_GAIT_FORWARD_TURN_SCALE,
    DEFAULT_NAV2_GAIT_HIGH_LINEAR,
    DEFAULT_NAV2_GAIT_LATERAL_FULL_SCALE,
    DEFAULT_NAV2_GAIT_LINEAR_DEADBAND,
    DEFAULT_NAV2_GAIT_LINEAR_FULL_SCALE,
    DEFAULT_NAV2_GAIT_MAX_TURN_RATE,
    DEFAULT_NAV2_GAIT_MAX_X_STEP,
    DEFAULT_NAV2_GAIT_MAX_Y_STEP,
    DEFAULT_NAV2_GAIT_TROT_LINEAR,
    nav2_cmd_vel_to_locomotion,
)
from nav2_client import (
    DEFAULT_NAV2_ACTION,
    DEFAULT_NAV2_ALLOWED_FRAMES,
    DEFAULT_NAV2_DOCKER_STATUS_TIMEOUT,
    DEFAULT_NAV2_GOAL_RESPONSE_TIMEOUT,
    DEFAULT_NAV2_ODOM_WAIT_TIMEOUT,
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
DEFAULT_SERIAL_PORT = os.environ.get("DOGZILLA_SERIAL_PORT", "/dev/ttyAMA0")
DEFAULT_DRY_RUN = os.environ.get("DOGZILLA_DIRECT_DRY_RUN", "1") != "0"
DEFAULT_EXPECTED_ROS_DOMAIN_ID = os.environ.get("DOGZILLA_EXPECTED_ROS_DOMAIN_ID", "16")
DEFAULT_INCLUDE_ATTITUDE_STATE = os.environ.get("DOGZILLA_INCLUDE_ATTITUDE_STATE", "0") == "1"
DEFAULT_INCLUDE_SLOW_STATE = os.environ.get("DOGZILLA_INCLUDE_SLOW_STATE", "0") == "1"
DEFAULT_ASYNC_HTTP_GOTO = os.environ.get("DOGZILLA_ASYNC_HTTP_GOTO", "0") == "1"
DEFAULT_NAV2_MIN_BATTERY_PCT = float(os.environ.get("DOGZILLA_NAV2_MIN_BATTERY_PCT", "25"))
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


def validate_goal_inside_active_map(frame: str, x: float, y: float) -> dict[str, Any]:
    return map_metadata_module.validate_goal_inside_active_map(
        frame,
        x,
        y,
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
        self.map_navigation = MapPoseNavigationExecutor()
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
        fallback = self.map_navigation.snapshot() if hasattr(self, "map_navigation") else {"available": False}
        nav2_available = nav2.get("available") is True
        waypoint_ready = nav2.get("waypointReady") is True
        return {
            "available": waypoint_ready,
            "primary": "nav2" if waypoint_ready else "unavailable",
            "actionServerAvailable": nav2_available,
            "waypointReady": waypoint_ready,
            "blockers": nav2.get("blockers") or [],
            "nav2": nav2,
            "fallback": {
                **fallback,
                "automaticDispatch": False,
                "reason": "DOGZILLALib map-pose movement is not used for waypoint dispatch; Nav2 is required.",
            },
        }

    def execute(self, canonical_plan: dict[str, Any]) -> dict[str, Any]:
        kind = canonical_plan.get("kind")
        params = canonical_plan.get("params") or {}

        if kind == "state.read":
            return self.read_state()

        if self.dry_run:
            return {"executed": False, "delivery": "dry-run", "kind": kind, "params": params}

        if kind == "noop" and params.get("reason") in ("emergency_stop", "command_preempt"):
            return self._execute_emergency_stop(reason=str(params.get("reason") or "emergency_stop"))

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

    def _execute_goto(self, params: dict[str, Any], cancel_event: threading.Event | None = None) -> dict[str, Any]:
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

        map_validation = validate_goal_inside_active_map(frame, x, y)
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
                "delivery": "nav2-prerequisite-unavailable",
                "kind": "locomotion.goto",
                "waypoint": params.get("waypoint") or "",
                "waypointSafe": frame == "map",
                "error": nav_prerequisites.get("message") or "Nav2 waypoint prerequisites are not ready",
                "nav2Prerequisites": nav_prerequisites,
                "fallback": "disabled",
                "fallbackError": "Refusing DOGZILLALib map-pose movement fallback; Nav2 with live odometry is required for waypoint navigation.",
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
                    "lidarAvoidance": avoidance_result,
                    "fallback": "disabled",
                    "fallbackError": "Refusing DOGZILLALib map-pose movement fallback; Nav2 NavigateToPose is required for waypoint navigation.",
                }

            return {**result, "lidarAvoidance": avoidance_result}

        self._clear_nav2_cmd_vel_block()
        return {
            **result,
            "kind": "locomotion.goto",
            "waypoint": params.get("waypoint") or "",
            "waypointSafe": frame == "map",
            "arrivalToleranceMeters": params.get("arrivalToleranceMeters", params.get("arrival_tolerance_meters")),
            "lidarAvoidance": avoidance_result,
        }

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
                    "runtime": runtime,
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
        if self.path == "/actions":
            self._send_json(200, {"actions": ACTION_ALIASES})
            return
        if self.path == "/preflight":
            self._send_json(200, {"runtime": self.server.runtime.snapshot(), "checks": build_preflight_checks()})
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
            result = {
                "executed": True,
                "delivery": "navigation-accepted",
                "kind": "locomotion.goto",
                "waypoint": (canonical_plan.get("params") or {}).get("waypoint") or "",
                "async": True,
                "status": "running",
            }
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
                target=self._execute_background_command,
                args=(command_id, envelope, canonical_plan),
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

    def _execute_background_command(self, command_id: str, envelope: dict[str, Any], canonical_plan: dict[str, Any]) -> None:
        result = self.server.runtime.execute(canonical_plan)
        record = {
            "commandId": command_id,
            "completedAt": utc_now(),
            "envelope": envelope,
            "canonicalPlan": canonical_plan,
            "result": result,
            "background": True,
        }
        self.server.recent_commands.appendleft(record)
        append_log_record(record)

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
    print(f"DOGZILLALib bridge listening on http://{args.host}:{args.port}")
    print(json.dumps(runtime.snapshot()))
    server.serve_forever()


if __name__ == "__main__":
    main()
