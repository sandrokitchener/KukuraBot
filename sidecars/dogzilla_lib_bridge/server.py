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
DEFAULT_NAV2_ACTION = os.environ.get("DOGZILLA_NAV2_ACTION", "navigate_to_pose")
DEFAULT_NAV2_DOCKER_CONTAINER = os.environ.get("DOGZILLA_NAV2_DOCKER_CONTAINER", "robodoge-lidar-bridge")
DEFAULT_NAV2_DOCKER_ENABLED = os.environ.get("DOGZILLA_NAV2_DOCKER_ENABLED", "1") != "0"
DEFAULT_NAV2_ALLOWED_FRAMES = {
    frame.strip()
    for frame in os.environ.get("DOGZILLA_NAV2_ALLOWED_FRAMES", "map,odom").split(",")
    if frame.strip()
}
DEFAULT_NAV2_WAIT_TIMEOUT = float(os.environ.get("DOGZILLA_NAV2_WAIT_TIMEOUT", "2.0"))
DEFAULT_NAV2_GOAL_RESPONSE_TIMEOUT = float(os.environ.get("DOGZILLA_NAV2_GOAL_RESPONSE_TIMEOUT", "3.0"))
DEFAULT_NAV2_STATUS_CACHE_SEC = float(os.environ.get("DOGZILLA_NAV2_STATUS_CACHE_SEC", "1.0"))
DEFAULT_NAV2_STATUS_WAIT_TIMEOUT = float(os.environ.get("DOGZILLA_NAV2_STATUS_WAIT_TIMEOUT", "0.25"))
DEFAULT_MAP_POSE_URL = os.environ.get("DOGZILLA_MAP_POSE_URL", "http://127.0.0.1:8896/pose")
DEFAULT_MAP_SCAN_URL = os.environ.get("DOGZILLA_MAP_SCAN_URL", "http://127.0.0.1:8896/scan")
DEFAULT_MAP_NAVIGATION_ENABLED = os.environ.get("DOGZILLA_MAP_NAVIGATION_ENABLED", "1") != "0"
DEFAULT_MAP_NAVIGATION_TIMEOUT = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_TIMEOUT", "20.0"))
DEFAULT_MAP_NAVIGATION_POLL_SEC = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_POLL_SEC", "0.20"))
DEFAULT_MAP_NAVIGATION_YAW_TOLERANCE = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_YAW_TOLERANCE", "0.55"))
DEFAULT_MAP_NAVIGATION_OBSTACLE_DISTANCE = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_OBSTACLE_DISTANCE", "0.55"))
DEFAULT_MAP_NAVIGATION_OBSTACLE_STOP_COUNT = int(os.environ.get("DOGZILLA_MAP_NAVIGATION_OBSTACLE_STOP_COUNT", "2"))
DEFAULT_MAP_NAVIGATION_MAX_X_STEP = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_MAX_X_STEP", "10"))
DEFAULT_MAP_NAVIGATION_MAX_Y_STEP = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_MAX_Y_STEP", "8"))
DEFAULT_MAP_NAVIGATION_MAX_TURN_RATE = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_MAX_TURN_RATE", "35"))
DEFAULT_MAP_NAVIGATION_X_GAIN = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_X_GAIN", "40"))
DEFAULT_MAP_NAVIGATION_Y_GAIN = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_Y_GAIN", "32"))
DEFAULT_MAP_NAVIGATION_TURN_GAIN = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_TURN_GAIN", "60"))
DEFAULT_LIDAR_AVOIDANCE_ENABLED = os.environ.get("DOGZILLA_LIDAR_AVOIDANCE_ENABLED", "1") != "0"
DEFAULT_LIDAR_AVOIDANCE_TIMEOUT = float(os.environ.get("DOGZILLA_LIDAR_AVOIDANCE_TIMEOUT", "4.0"))
DEFAULT_LIDAR_AVOIDANCE_COMMAND = os.environ.get("DOGZILLA_LIDAR_AVOIDANCE_COMMAND", "").strip()
MAX_RECENT_COMMANDS = int(os.environ.get("DOGZILLA_LIB_BRIDGE_HISTORY", "20"))
LIDAR_AVOIDANCE_PACKAGE = "yahboom_laser"
LIDAR_AVOIDANCE_NODE = "laser_Avoidance_xgo_RS200"
LIDAR_AVOIDANCE_DOC_COMMAND = f"ros2 run {LIDAR_AVOIDANCE_PACKAGE} {LIDAR_AVOIDANCE_NODE}"
ROS_SETUP_COMMAND = (
    "source /opt/ros/humble/setup.bash 2>/dev/null || true; "
    "source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || "
    "source /home/pi/yahboomcar_ws/install/setup.bash 2>/dev/null || "
    "source /home/yahboom/yahboomcar_ws/install/setup.bash 2>/dev/null || true"
)
LIDAR_AVOIDANCE_START_COMMAND = (
    f"{ROS_SETUP_COMMAND}; "
    f"pgrep -af '[l]aser_Avoidance_xgo_RS200' >/dev/null || "
    f"(nohup {LIDAR_AVOIDANCE_DOC_COMMAND} >/tmp/robodoge-lidar-avoidance.log 2>&1 &); "
    "sleep 0.4; pgrep -af '[l]aser_Avoidance_xgo_RS200' >/dev/null"
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


class LidarAvoidanceSupervisor:
    def __init__(
        self,
        *,
        enabled: bool = DEFAULT_LIDAR_AVOIDANCE_ENABLED,
        timeout: float = DEFAULT_LIDAR_AVOIDANCE_TIMEOUT,
        override_command: str = DEFAULT_LIDAR_AVOIDANCE_COMMAND,
    ):
        self.enabled = enabled
        self.timeout = timeout
        self.override_command = override_command
        self.last_result: dict[str, Any] | None = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "mode": LIDAR_AVOIDANCE_PACKAGE,
            "node": LIDAR_AVOIDANCE_NODE,
            "requiredCommand": LIDAR_AVOIDANCE_DOC_COMMAND,
            "timeoutSec": self.timeout,
            "overrideCommand": bool(self.override_command),
            "lastResult": self.last_result,
        }

    def ensure_running(self, request: dict[str, Any] | None = None) -> dict[str, Any]:
        request = request if isinstance(request, dict) else {}
        base = {
            "required": True,
            "enabled": self.enabled,
            "mode": request.get("mode") or LIDAR_AVOIDANCE_PACKAGE,
            "lidarTopic": request.get("lidarTopic") or "/scan",
            "command": request.get("command") or LIDAR_AVOIDANCE_DOC_COMMAND,
        }

        if not self.enabled:
            result = {**base, "ok": False, "error": "DOGZILLA_LIDAR_AVOIDANCE_ENABLED=0"}
            self.last_result = result
            return result

        failures: list[dict[str, Any]] = []
        for label, command, shell in self._candidate_commands():
            result = self._run_candidate(label, command, shell)
            if result.get("ok"):
                result = {**base, **result}
                self.last_result = result
                return result
            failures.append(result)

        last_error = failures[-1].get("error") if failures else "No LiDAR avoidance command configured"
        result = {
            **base,
            "ok": False,
            "error": last_error,
            "attempts": failures,
        }
        self.last_result = result
        return result

    def _candidate_commands(self) -> list[tuple[str, str | list[str], bool]]:
        if self.override_command:
            return [("override", self.override_command, True)]

        return [
            ("host-ros2", ["bash", "-lc", LIDAR_AVOIDANCE_START_COMMAND], False),
            (
                "lidar-container",
                ["docker", "exec", "robodoge-lidar-bridge", "bash", "-lc", LIDAR_AVOIDANCE_START_COMMAND],
                False,
            ),
        ]

    def _run_candidate(self, label: str, command: str | list[str], shell: bool) -> dict[str, Any]:
        try:
            completed = subprocess.run(
                command,
                shell=shell,
                capture_output=True,
                text=True,
                timeout=self.timeout,
                check=False,
            )
        except FileNotFoundError as error:
            return {
                "ok": False,
                "attempt": label,
                "error": str(error),
                "command": command,
            }
        except subprocess.TimeoutExpired as error:
            return {
                "ok": False,
                "attempt": label,
                "error": f"LiDAR avoidance start timed out after {self.timeout:.1f}s",
                "stdout": summarize_process_text(error.stdout),
                "stderr": summarize_process_text(error.stderr),
                "command": command,
            }

        return {
            "ok": completed.returncode == 0,
            "attempt": label,
            "returncode": completed.returncode,
            "stdout": summarize_process_text(completed.stdout),
            "stderr": summarize_process_text(completed.stderr),
            "error": "" if completed.returncode == 0 else f"{label} returned {completed.returncode}",
            "command": command,
        }


class MapPoseNavigationExecutor:
    def __init__(
        self,
        *,
        enabled: bool = DEFAULT_MAP_NAVIGATION_ENABLED,
        pose_url: str = DEFAULT_MAP_POSE_URL,
        scan_url: str = DEFAULT_MAP_SCAN_URL,
        timeout: float = DEFAULT_MAP_NAVIGATION_TIMEOUT,
        poll_sec: float = DEFAULT_MAP_NAVIGATION_POLL_SEC,
    ):
        self.enabled = enabled
        self.pose_url = pose_url
        self.scan_url = scan_url
        self.timeout = timeout
        self.poll_sec = poll_sec
        self.last_result: dict[str, Any] | None = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "available": self.enabled,
            "mode": "map-pose-closed-loop",
            "poseUrl": self.pose_url,
            "scanUrl": self.scan_url,
            "timeoutSec": self.timeout,
            "pollSec": self.poll_sec,
            "obstacleDistanceMeters": DEFAULT_MAP_NAVIGATION_OBSTACLE_DISTANCE,
            "maxXStep": DEFAULT_MAP_NAVIGATION_MAX_X_STEP,
            "maxYStep": DEFAULT_MAP_NAVIGATION_MAX_Y_STEP,
            "maxTurnRate": DEFAULT_MAP_NAVIGATION_MAX_TURN_RATE,
            "lastResult": self.last_result,
        }

    def goto(self, robot, *, frame: str, x: float, y: float, yaw: float, params: dict[str, Any]) -> dict[str, Any]:
        waypoint = params.get("waypoint") or ""
        tolerance = clamp(
            float(params.get("arrivalToleranceMeters", params.get("arrival_tolerance_meters", 0.25)) or 0.25),
            0.05,
            1.0,
        )
        yaw_tolerance = clamp(
            float(params.get("yawToleranceRadians", DEFAULT_MAP_NAVIGATION_YAW_TOLERANCE) or DEFAULT_MAP_NAVIGATION_YAW_TOLERANCE),
            0.05,
            3.14,
        )
        timeout = clamp(
            float(params.get("timeoutSec", self.timeout) or self.timeout),
            1.0,
            120.0,
        )

        result_base = {
            "kind": "locomotion.goto",
            "delivery": "DOGZILLALib map-pose navigation",
            "waypoint": waypoint,
            "waypointSafe": frame == "map",
            "frame": frame,
            "x": x,
            "y": y,
            "yaw": yaw,
            "arrivalToleranceMeters": tolerance,
        }

        if not self.enabled:
            result = {**result_base, "executed": False, "error": "DOGZILLA_MAP_NAVIGATION_ENABLED=0"}
            self.last_result = result
            return result

        if frame != "map":
            result = {**result_base, "executed": False, "error": f"map_pose_navigation_requires_map_frame:{frame}"}
            self.last_result = result
            return result

        samples: list[dict[str, Any]] = []
        started = time.monotonic()
        last_pose: dict[str, Any] | None = None

        try:
            while time.monotonic() - started < timeout:
                pose_response = self._read_pose()
                if not pose_response.get("ok"):
                    stop_robot(robot)
                    result = {
                        **result_base,
                        "executed": False,
                        "delivery": "map-pose-navigation-unavailable",
                        "error": pose_response.get("error") or "map pose unavailable",
                        "pose": pose_response,
                    }
                    self.last_result = result
                    return result

                pose = pose_response["pose"]
                last_pose = pose
                dx = x - pose["x"]
                dy = y - pose["y"]
                distance = math.hypot(dx, dy)
                yaw_error = normalize_angle(yaw - pose["theta"])
                samples.append({
                    "x": round(pose["x"], 4),
                    "y": round(pose["y"], 4),
                    "theta": round(pose["theta"], 4),
                    "distance": round(distance, 4),
                    "yawError": round(yaw_error, 4),
                })
                samples = samples[-8:]

                if distance <= tolerance and abs(yaw_error) <= yaw_tolerance:
                    stop_robot(robot)
                    result = {
                        **result_base,
                        "executed": True,
                        "arrived": True,
                        "distanceMeters": distance,
                        "yawErrorRadians": yaw_error,
                        "elapsedSec": round(time.monotonic() - started, 3),
                        "samples": samples,
                        "finalPose": pose,
                    }
                    self.last_result = result
                    return result

                forward_error = math.cos(pose["theta"]) * dx + math.sin(pose["theta"]) * dy
                lateral_error = -math.sin(pose["theta"]) * dx + math.cos(pose["theta"]) * dy
                turn_error = normalize_angle(math.atan2(dy, dx) - pose["theta"]) if distance > tolerance else yaw_error
                x_step = clamp(forward_error * DEFAULT_MAP_NAVIGATION_X_GAIN, -DEFAULT_MAP_NAVIGATION_MAX_X_STEP, DEFAULT_MAP_NAVIGATION_MAX_X_STEP)
                y_step = clamp(lateral_error * DEFAULT_MAP_NAVIGATION_Y_GAIN, -DEFAULT_MAP_NAVIGATION_MAX_Y_STEP, DEFAULT_MAP_NAVIGATION_MAX_Y_STEP)
                turn_rate = clamp(turn_error * DEFAULT_MAP_NAVIGATION_TURN_GAIN, -DEFAULT_MAP_NAVIGATION_MAX_TURN_RATE, DEFAULT_MAP_NAVIGATION_MAX_TURN_RATE)
                obstacle = self._read_obstacle()
                if obstacle.get("blocked") and x_step > 0:
                    x_step = 0.0
                    turn_rate = clamp(
                        turn_rate + float(obstacle.get("turnBias") or 0.0),
                        -DEFAULT_MAP_NAVIGATION_MAX_TURN_RATE,
                        DEFAULT_MAP_NAVIGATION_MAX_TURN_RATE,
                    )
                    y_step = clamp(
                        y_step + float(obstacle.get("sideBias") or 0.0),
                        -DEFAULT_MAP_NAVIGATION_MAX_Y_STEP,
                        DEFAULT_MAP_NAVIGATION_MAX_Y_STEP,
                    )
                if obstacle.get("ok"):
                    samples[-1]["obstacle"] = {
                        "front": obstacle.get("front"),
                        "left": obstacle.get("left"),
                        "right": obstacle.get("right"),
                        "blocked": obstacle.get("blocked"),
                    }

                robot.move("x", x_step)
                robot.move("y", y_step)
                robot.turn(turn_rate)
                time.sleep(self.poll_sec)
        finally:
            stop_robot(robot)

        result = {
            **result_base,
            "executed": False,
            "delivery": "map-pose-navigation-timeout",
            "error": f"Map-pose navigation timed out after {timeout:.1f}s",
            "elapsedSec": round(time.monotonic() - started, 3),
            "samples": samples,
            "finalPose": last_pose,
        }
        self.last_result = result
        return result

    def _read_pose(self) -> dict[str, Any]:
        try:
            with urllib.request.urlopen(self.pose_url, timeout=1.5) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            return {"ok": False, "error": str(error)}

        pose = payload.get("mapPose") or payload.get("pose") if isinstance(payload, dict) else None
        if not isinstance(pose, dict):
            return {"ok": False, "error": "map pose response missing pose"}
        if payload.get("waypointSafe") is not True or pose.get("frame") != "map":
            return {"ok": False, "error": "map pose is not waypoint-safe"}

        try:
            parsed = {
                "x": float(pose["x"]),
                "y": float(pose["y"]),
                "theta": normalize_angle(float(pose.get("theta") or 0.0)),
                "frame": str(pose.get("frame") or ""),
                "childFrame": str(pose.get("childFrame") or ""),
                "source": str(pose.get("source") or ""),
            }
        except (KeyError, TypeError, ValueError) as error:
            return {"ok": False, "error": f"invalid map pose: {error}"}

        if not all(math.isfinite(parsed[key]) for key in ("x", "y", "theta")):
            return {"ok": False, "error": "invalid map pose: non_finite"}

        return {"ok": True, "pose": parsed}

    def _read_obstacle(self) -> dict[str, Any]:
        try:
            with urllib.request.urlopen(self.scan_url, timeout=0.7) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            return {"ok": False, "blocked": False, "error": str(error)}

        if not isinstance(payload, dict) or payload.get("ok") is not True:
            return {"ok": False, "blocked": False, "error": str(payload.get("error") or "scan unavailable")}

        front, left, right, min_range = scan_obstacle_counts(
            payload.get("points") if isinstance(payload.get("points"), list) else [],
            DEFAULT_MAP_NAVIGATION_OBSTACLE_DISTANCE,
        )
        blocked = front >= DEFAULT_MAP_NAVIGATION_OBSTACLE_STOP_COUNT
        side_bias = 0.0
        turn_bias = 0.0

        if blocked:
            # Pick the clearer side. Positive y steps left; positive turn rotates left.
            if left <= right:
                side_bias = DEFAULT_MAP_NAVIGATION_MAX_Y_STEP
                turn_bias = DEFAULT_MAP_NAVIGATION_MAX_TURN_RATE * 0.65
            else:
                side_bias = -DEFAULT_MAP_NAVIGATION_MAX_Y_STEP
                turn_bias = -DEFAULT_MAP_NAVIGATION_MAX_TURN_RATE * 0.65

        return {
            "ok": True,
            "blocked": blocked,
            "front": front,
            "left": left,
            "right": right,
            "minRange": min_range,
            "sideBias": side_bias,
            "turnBias": turn_bias,
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

        for vendor_path in self.vendor_paths:
            if vendor_path.exists():
                sys.path.insert(0, str(vendor_path))

        self.DOGZILLA = self._load_factory()

    @property
    def available(self) -> bool:
        return self.import_error is None

    def snapshot(self) -> dict[str, Any]:
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
            "nav2": self.nav2_client.snapshot(),
            "navigation": self.navigation_snapshot(),
            "lidarAvoidance": self.lidar_avoidance.snapshot() if hasattr(self, "lidar_avoidance") else None,
            "rosDomainId": os.environ.get("ROS_DOMAIN_ID"),
            "expectedRosDomainId": DEFAULT_EXPECTED_ROS_DOMAIN_ID,
            "importError": self.import_error,
            "robotError": self.robot_error,
        }

    def navigation_snapshot(self) -> dict[str, Any]:
        nav2 = self.nav2_client.snapshot()
        fallback = self.map_navigation.snapshot() if hasattr(self, "map_navigation") else {"available": False}
        return {
            "available": nav2.get("available") is True or fallback.get("available") is True,
            "primary": "nav2" if nav2.get("available") is True else "map-pose-closed-loop",
            "nav2": nav2,
            "fallback": fallback,
        }

    def execute(self, canonical_plan: dict[str, Any]) -> dict[str, Any]:
        kind = canonical_plan.get("kind")
        params = canonical_plan.get("params") or {}

        if kind == "state.read":
            return self.read_state()

        if self.dry_run:
            return {"executed": False, "delivery": "dry-run", "kind": kind, "params": params}

        if kind == "locomotion.goto":
            return self._execute_goto(params)

        if not self.available:
            return {"executed": False, "error": self.import_error or "DOGZILLALib unavailable"}

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

        if pace in ("normal", "slow", "high"):
            robot.pace(pace)
        if gait in ("trot", "walk", "high_walk") and hasattr(robot, "gait_type"):
            robot.gait_type(gait)

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

    def _execute_goto(self, params: dict[str, Any]) -> dict[str, Any]:
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
                robot = self._robot()
                if robot is None:
                    return {
                        **result,
                        "lidarAvoidance": avoidance_result,
                        "fallback": "map-pose-closed-loop",
                        "fallbackError": self.robot_error or "robot unavailable",
                    }

                fallback_result = self.map_navigation.goto(
                    robot,
                    frame=frame,
                    x=x,
                    y=y,
                    yaw=yaw,
                    params=params,
                )
                return {
                    **fallback_result,
                    "nav2": result,
                    "lidarAvoidance": avoidance_result,
                }

            return {**result, "lidarAvoidance": avoidance_result}

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


class Nav2NavigateClient:
    def __init__(self, action_name: str):
        self.action_name = action_name
        self.wait_timeout = DEFAULT_NAV2_WAIT_TIMEOUT
        self.goal_response_timeout = DEFAULT_NAV2_GOAL_RESPONSE_TIMEOUT
        self.import_error: str | None = None
        self.host_import_error: str | None = None
        self.docker_import_error: str | None = None
        self.server_error: str | None = None
        self.client_available = False
        self.server_available = False
        self._last_status_check = 0.0
        self.backend = "host-rclpy"
        self.docker_container = DEFAULT_NAV2_DOCKER_CONTAINER
        self.available = False
        self._node = None
        self._executor = None
        self._thread: threading.Thread | None = None
        self._action_client = None
        self._navigate_to_pose_type = None

        try:
            import rclpy
            from nav2_msgs.action import NavigateToPose
            from rclpy.action import ActionClient
            from rclpy.executors import SingleThreadedExecutor
        except Exception as error:
            self.host_import_error = str(error)
            self.import_error = str(error)
            self._try_enable_docker_backend()
            return

        try:
            rclpy.init(args=None)
            self._node = rclpy.create_node("dogzilla_direct_nav2_client")
            self._executor = SingleThreadedExecutor()
            self._executor.add_node(self._node)
            self._thread = threading.Thread(target=self._executor.spin, daemon=True)
            self._thread.start()
            self._action_client = ActionClient(self._node, NavigateToPose, action_name)
            self._navigate_to_pose_type = NavigateToPose
            self.client_available = True
            self._refresh_status(force=True)
        except Exception as error:
            self.import_error = str(error)

    def send_goal(self, *, frame: str, x: float, y: float, yaw: float) -> dict[str, Any]:
        if self.backend == "docker-rclpy":
            return self._send_goal_via_docker(frame=frame, x=x, y=y, yaw=yaw)

        self._refresh_status()

        if not self.client_available:
            return {
                "executed": False,
                "delivery": "nav2-unavailable",
                "error": self.import_error or "Nav2 NavigateToPose client unavailable",
                "action": self.action_name,
            }

        if not self._action_client.wait_for_server(timeout_sec=self.wait_timeout):
            return {
                "executed": False,
                "delivery": "nav2-unavailable",
                "error": f"Nav2 NavigateToPose action server unavailable after {self.wait_timeout:.1f}s",
                "action": self.action_name,
            }

        goal = self._navigate_to_pose_type.Goal()
        goal.pose.header.frame_id = frame
        goal.pose.header.stamp = self._node.get_clock().now().to_msg()
        goal.pose.pose.position.x = x
        goal.pose.pose.position.y = y
        goal.pose.pose.position.z = 0.0
        goal.pose.pose.orientation.z = math.sin(yaw / 2.0)
        goal.pose.pose.orientation.w = math.cos(yaw / 2.0)
        future = self._action_client.send_goal_async(goal)
        deadline = time.monotonic() + self.goal_response_timeout
        while not future.done() and time.monotonic() < deadline:
            time.sleep(0.02)

        if not future.done():
            return {
                "executed": False,
                "delivery": "nav2-timeout",
                "error": f"Nav2 NavigateToPose goal response timeout after {self.goal_response_timeout:.1f}s",
                "action": self.action_name,
                "frame": frame,
                "x": x,
                "y": y,
                "yaw": yaw,
            }

        goal_handle = future.result()
        if goal_handle is None or not getattr(goal_handle, "accepted", False):
            return {
                "executed": False,
                "delivery": "nav2-rejected",
                "error": "Nav2 NavigateToPose goal rejected",
                "action": self.action_name,
                "frame": frame,
                "x": x,
                "y": y,
                "yaw": yaw,
            }

        return {
            "executed": True,
            "delivery": "Nav2 NavigateToPose",
            "action": self.action_name,
            "goalAccepted": True,
            "frame": frame,
            "x": x,
            "y": y,
            "yaw": yaw,
        }

    def _try_enable_docker_backend(self) -> None:
        if not DEFAULT_NAV2_DOCKER_ENABLED:
            self.docker_import_error = "DOGZILLA_NAV2_DOCKER_ENABLED=0"
            return

        if not self.docker_container:
            self.docker_import_error = "DOGZILLA_NAV2_DOCKER_CONTAINER is empty"
            return

        completed = self._run_docker_python(
            "import rclpy\nfrom nav2_msgs.action import NavigateToPose\nfrom rclpy.action import ActionClient\nprint('ok')\n",
            timeout=6,
        )
        if completed.returncode == 0:
            self.backend = "docker-rclpy"
            self.client_available = True
            self.import_error = None
            self.docker_import_error = None
            self._refresh_status(force=True)
            return

        self.docker_import_error = summarize_process_text(completed.stderr) or summarize_process_text(completed.stdout) or f"docker exec returned {completed.returncode}"
        self.import_error = f"{self.host_import_error}; docker:{self.docker_import_error}"

    def _refresh_status(self, *, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_status_check < DEFAULT_NAV2_STATUS_CACHE_SEC:
            return

        self._last_status_check = now

        if self.backend == "docker-rclpy":
            self._refresh_docker_status()
            return

        if not self.client_available or self._action_client is None:
            if self.host_import_error and DEFAULT_NAV2_DOCKER_ENABLED:
                self._try_enable_docker_backend()
                if self.backend == "docker-rclpy":
                    return
            self.server_available = False
            self.available = False
            return

        try:
            self.server_available = bool(
                self._action_client.wait_for_server(timeout_sec=DEFAULT_NAV2_STATUS_WAIT_TIMEOUT)
            )
            self.server_error = None if self.server_available else self._nav2_server_unavailable_message()
            self.available = self.client_available and self.server_available
            self.import_error = None if self.available else self.server_error
        except Exception as error:
            self.server_available = False
            self.available = False
            self.server_error = str(error)
            self.import_error = self.server_error

    def _refresh_docker_status(self) -> None:
        try:
            completed = self._run_docker_shell(
                f"{ROS_SETUP_COMMAND}; ros2 action list",
                timeout=3,
            )
        except subprocess.TimeoutExpired:
            self.server_available = False
            self.available = False
            self.server_error = "Nav2 action list timed out"
            self.import_error = self.server_error
            return

        if completed.returncode != 0:
            error = summarize_process_text(completed.stderr) or summarize_process_text(completed.stdout) or f"docker exec returned {completed.returncode}"
            self.client_available = False
            self.server_available = False
            self.available = False
            self.docker_import_error = error
            self.server_error = None
            self.import_error = f"{self.host_import_error}; docker:{error}" if self.host_import_error else error
            return

        actions = {
            line.strip().lstrip("/")
            for line in summarize_process_text(completed.stdout, limit=5000).splitlines()
            if line.strip()
        }
        self.client_available = True
        self.server_available = self.action_name.strip().lstrip("/") in actions
        self.available = self.client_available and self.server_available
        self.docker_import_error = None
        self.server_error = None if self.server_available else self._nav2_server_unavailable_message()
        self.import_error = None if self.available else self.server_error

    def _nav2_server_unavailable_message(self) -> str:
        return f"Nav2 NavigateToPose action server is not running in the ROS graph for action {self.action_name!r}"

    def _run_docker_shell(self, command: str, *, timeout: float) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "docker",
                "exec",
                "-e",
                f"ROS_DOMAIN_ID={DEFAULT_EXPECTED_ROS_DOMAIN_ID}",
                self.docker_container,
                "bash",
                "-lc",
                command,
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )

    def _send_goal_via_docker(self, *, frame: str, x: float, y: float, yaw: float) -> dict[str, Any]:
        request = {
            "action": self.action_name,
            "frame": frame,
            "x": x,
            "y": y,
            "yaw": yaw,
            "waitTimeout": self.wait_timeout,
            "goalResponseTimeout": self.goal_response_timeout,
        }
        request_json = json.dumps(request)
        script = f"""
import json
import math
import sys

import rclpy
from nav2_msgs.action import NavigateToPose
from rclpy.action import ActionClient

request = json.loads({json.dumps(request_json)})
rclpy.init(args=None)
node = rclpy.create_node("dogzilla_direct_nav2_docker_client")
client = ActionClient(node, NavigateToPose, request["action"])
try:
    if not client.wait_for_server(timeout_sec=float(request["waitTimeout"])):
        print(json.dumps({{
            "executed": False,
            "delivery": "nav2-unavailable",
            "error": f"Nav2 NavigateToPose action server unavailable after {{float(request['waitTimeout']):.1f}}s",
            "action": request["action"],
        }}))
        raise SystemExit(2)

    goal = NavigateToPose.Goal()
    goal.pose.header.frame_id = request["frame"]
    goal.pose.header.stamp = node.get_clock().now().to_msg()
    goal.pose.pose.position.x = float(request["x"])
    goal.pose.pose.position.y = float(request["y"])
    goal.pose.pose.position.z = 0.0
    yaw = float(request["yaw"])
    goal.pose.pose.orientation.z = math.sin(yaw / 2.0)
    goal.pose.pose.orientation.w = math.cos(yaw / 2.0)

    future = client.send_goal_async(goal)
    rclpy.spin_until_future_complete(node, future, timeout_sec=float(request["goalResponseTimeout"]))
    if not future.done():
        print(json.dumps({{
            "executed": False,
            "delivery": "nav2-timeout",
            "error": f"Nav2 NavigateToPose goal response timeout after {{float(request['goalResponseTimeout']):.1f}}s",
            "action": request["action"],
        }}))
        raise SystemExit(3)

    goal_handle = future.result()
    if goal_handle is None or not getattr(goal_handle, "accepted", False):
        print(json.dumps({{
            "executed": False,
            "delivery": "nav2-rejected",
            "error": "Nav2 NavigateToPose goal rejected",
            "action": request["action"],
        }}))
        raise SystemExit(4)

    print(json.dumps({{
        "executed": True,
        "delivery": "Nav2 NavigateToPose",
        "action": request["action"],
        "goalAccepted": True,
        "frame": request["frame"],
        "x": float(request["x"]),
        "y": float(request["y"]),
        "yaw": yaw,
    }}))
finally:
    node.destroy_node()
    rclpy.shutdown()
"""
        completed = self._run_docker_python(script, timeout=self.wait_timeout + self.goal_response_timeout + 3)
        parsed = parse_json_process_output(completed.stdout)
        if isinstance(parsed, dict):
            return {
                **parsed,
                "backend": self.backend,
                "container": self.docker_container,
            }

        return {
            "executed": False,
            "delivery": "nav2-docker-failed",
            "error": summarize_process_text(completed.stderr) or summarize_process_text(completed.stdout) or f"docker exec returned {completed.returncode}",
            "action": self.action_name,
            "backend": self.backend,
            "container": self.docker_container,
        }

    def _run_docker_python(self, script: str, *, timeout: float) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "docker",
                "exec",
                "-i",
                "-e",
                f"ROS_DOMAIN_ID={DEFAULT_EXPECTED_ROS_DOMAIN_ID}",
                self.docker_container,
                "bash",
                "-lc",
                f"{ROS_SETUP_COMMAND}; python3 -",
            ],
            input=script,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )

    def snapshot(self) -> dict[str, Any]:
        self._refresh_status()
        return {
            "available": self.available,
            "clientAvailable": self.client_available,
            "serverAvailable": self.server_available,
            "action": self.action_name,
            "backend": self.backend,
            "dockerContainer": self.docker_container,
            "allowedFrames": sorted(DEFAULT_NAV2_ALLOWED_FRAMES),
            "waitTimeoutSec": self.wait_timeout,
            "goalResponseTimeoutSec": self.goal_response_timeout,
            "importError": self.import_error,
            "hostImportError": self.host_import_error,
            "dockerImportError": self.docker_import_error,
            "serverError": self.server_error,
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


def stop_performance_mode(robot: Any) -> bool:
    method = getattr(robot, "perform", None)
    if method is None:
        return False

    try:
        method(0)
    except Exception:
        return False

    return True


def scan_obstacle_counts(points: list[Any], max_distance: float) -> tuple[int, int, int, float | None]:
    front = 0
    left = 0
    right = 0
    min_range: float | None = None

    for point in points:
        if not isinstance(point, dict):
            continue
        try:
            angle = float(point.get("angle"))
            distance = float(point.get("range"))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(angle) or not math.isfinite(distance) or distance <= 0:
            continue

        min_range = distance if min_range is None else min(min_range, distance)
        if distance > max_distance:
            continue
        if -math.radians(15) <= angle <= math.radians(15):
            front += 1
        elif math.radians(15) < angle <= math.radians(75):
            left += 1
        elif -math.radians(75) <= angle < -math.radians(15):
            right += 1

    return front, left, right, min_range


def get_lidar_avoidance_request(params: dict[str, Any]) -> dict[str, Any]:
    raw = params.get("obstacleAvoidance", params.get("obstacle_avoidance"))
    if raw is True:
        return {"required": True}
    if not isinstance(raw, dict):
        return {"required": False}
    return {**raw, "required": raw.get("required") is True}


def summarize_process_text(value: Any, *, limit: int = 500) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    text = str(value).strip()
    if len(text) <= limit:
        return text
    return text[-limit:]


def parse_json_process_output(value: Any) -> dict[str, Any] | None:
    text = summarize_process_text(value, limit=5000)
    if not text:
        return None

    for line in reversed(text.splitlines()):
        candidate = line.strip()
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        return parsed if isinstance(parsed, dict) else None

    return None


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


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def normalize_angle(value: float) -> float:
    while value > math.pi:
        value -= 2 * math.pi
    while value <= -math.pi:
        value += 2 * math.pi
    return value


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
