from __future__ import annotations

import json
import math
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any

from motion_utils import clamp, normalize_angle, resolve_map_navigation_timeout, scan_obstacle_counts


DEFAULT_MAP_POSE_URL = os.environ.get("DOGZILLA_MAP_POSE_URL", "http://127.0.0.1:8896/pose")
DEFAULT_MAP_SCAN_URL = os.environ.get("DOGZILLA_MAP_SCAN_URL", "http://127.0.0.1:8896/scan")
DEFAULT_MAP_NAVIGATION_ENABLED = os.environ.get("DOGZILLA_MAP_NAVIGATION_ENABLED", "0") == "1"
DEFAULT_MAP_NAVIGATION_TIMEOUT = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_TIMEOUT", "0.0"))
DEFAULT_MAP_NAVIGATION_POLL_SEC = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_POLL_SEC", "0.20"))
DEFAULT_MAP_NAVIGATION_YAW_TOLERANCE = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_YAW_TOLERANCE", "0.55"))
DEFAULT_MAP_NAVIGATION_OBSTACLE_DISTANCE = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_OBSTACLE_DISTANCE", "0.55"))
DEFAULT_MAP_NAVIGATION_OBSTACLE_STOP_COUNT = int(os.environ.get("DOGZILLA_MAP_NAVIGATION_OBSTACLE_STOP_COUNT", "2"))
DEFAULT_MAP_NAVIGATION_MAX_X_STEP = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_MAX_X_STEP", "4"))
DEFAULT_MAP_NAVIGATION_MAX_Y_STEP = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_MAX_Y_STEP", "3"))
DEFAULT_MAP_NAVIGATION_MAX_TURN_RATE = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_MAX_TURN_RATE", "18"))
DEFAULT_MAP_NAVIGATION_X_GAIN = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_X_GAIN", "14"))
DEFAULT_MAP_NAVIGATION_Y_GAIN = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_Y_GAIN", "10"))
DEFAULT_MAP_NAVIGATION_TURN_GAIN = float(os.environ.get("DOGZILLA_MAP_NAVIGATION_TURN_GAIN", "28"))


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

    def goto(
        self,
        robot,
        *,
        frame: str,
        x: float,
        y: float,
        yaw: float,
        params: dict[str, Any],
        cancel_event: threading.Event | None = None,
    ) -> dict[str, Any]:
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
        timeout = resolve_map_navigation_timeout(params.get("timeoutSec", self.timeout), self.timeout)

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
        deadline = started + timeout if timeout is not None else None
        last_pose: dict[str, Any] | None = None

        try:
            while deadline is None or time.monotonic() < deadline:
                if cancel_event is not None and cancel_event.is_set():
                    stop_robot(robot)
                    result = {
                        **result_base,
                        "executed": False,
                        "delivery": "map-pose-navigation-cancelled",
                        "error": "Map-pose navigation cancelled by a newer robot command",
                        "elapsedSec": round(time.monotonic() - started, 3),
                        "samples": samples,
                        "finalPose": last_pose,
                    }
                    self.last_result = result
                    return result

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


def stop_robot(robot: Any) -> None:
    stop = getattr(robot, "stop", None)
    if callable(stop):
        stop()
