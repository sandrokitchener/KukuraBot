from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import urllib.error
import urllib.request
from typing import Any

from process_utils import summarize_process_text


DEFAULT_MAP_SCAN_URL = os.environ.get("DOGZILLA_MAP_SCAN_URL", "")
DEFAULT_LIDAR_AVOIDANCE_ENABLED = os.environ.get("DOGZILLA_LIDAR_AVOIDANCE_ENABLED", "1") != "0"
DEFAULT_LIDAR_AVOIDANCE_TIMEOUT = float(os.environ.get("DOGZILLA_LIDAR_AVOIDANCE_TIMEOUT", "4.0"))
DEFAULT_LIDAR_AVOIDANCE_COMMAND = os.environ.get("DOGZILLA_LIDAR_AVOIDANCE_COMMAND", "").strip()
DEFAULT_LIDAR_SCAN_WAIT_TIMEOUT = float(os.environ.get("DOGZILLA_LIDAR_SCAN_WAIT_TIMEOUT", "2.0"))
NAV2_COSTMAP_LIDAR_MODE = "nav2_costmap"
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
            "timeoutSec": self.timeout if self.timeout > 0 else None,
            "timeoutEnabled": self.timeout > 0,
            "overrideCommand": bool(self.override_command),
            "lastResult": self.last_result,
        }

    def ensure_running(self, request: dict[str, Any] | None = None) -> dict[str, Any]:
        request = request if isinstance(request, dict) else {}
        mode = str(request.get("mode") or NAV2_COSTMAP_LIDAR_MODE)
        base = {
            "required": True,
            "enabled": self.enabled,
            "mode": mode,
            "lidarTopic": request.get("lidarTopic") or "/scan",
            "command": request.get("command") or LIDAR_AVOIDANCE_DOC_COMMAND,
        }

        if not self.enabled:
            result = {**base, "ok": False, "error": "DOGZILLA_LIDAR_AVOIDANCE_ENABLED=0"}
            self.last_result = result
            return result

        if mode == NAV2_COSTMAP_LIDAR_MODE:
            result = self._ensure_nav2_costmap_scan(base)
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

    def _ensure_nav2_costmap_scan(self, base: dict[str, Any]) -> dict[str, Any]:
        failures: list[dict[str, Any]] = []
        topic = str(base.get("lidarTopic") or "/scan")
        bridge_scan = self._check_bridge_scan_endpoint()
        if bridge_scan.get("ok"):
            return {
                **base,
                **bridge_scan,
                "ok": True,
                "safety": "Nav2 costmaps own obstacle avoidance; the live DOGZILLA scan bridge sees LiDAR data, so Yahboom laser_Avoidance_xgo_RS200 was not started.",
            }

        failures.append(bridge_scan)
        for label, command, shell in self._candidate_scan_checks(topic):
            result = self._run_candidate(label, command, shell)
            stdout = str(result.get("stdout") or "")
            publisher_count = parse_ros_topic_count(stdout, "Publisher count")
            subscription_count = parse_ros_topic_count(stdout, "Subscription count")
            annotated = {
                **result,
                "publisherCount": publisher_count,
                "subscriptionCount": subscription_count,
            }
            if result.get("ok") and publisher_count > 0:
                return {
                    **base,
                    **annotated,
                    "ok": True,
                    "safety": "Nav2 costmaps own obstacle avoidance; Yahboom laser_Avoidance_xgo_RS200 was not started.",
                }
            failures.append(annotated)

        return {
            **base,
            "ok": False,
            "error": f"No LaserScan publishers visible on {topic}; Nav2 costmaps cannot avoid obstacles safely.",
            "attempts": failures,
        }

    def _check_bridge_scan_endpoint(self) -> dict[str, Any]:
        try:
            with urllib.request.urlopen(DEFAULT_MAP_SCAN_URL, timeout=min(max(self.timeout, 1.0), 3.0)) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            return {
                "ok": False,
                "attempt": "dogzilla-scan-endpoint",
                "error": str(error),
                "url": DEFAULT_MAP_SCAN_URL,
            }

        if not isinstance(payload, dict) or payload.get("ok") is not True:
            return {
                "ok": False,
                "attempt": "dogzilla-scan-endpoint",
                "error": str((payload or {}).get("error") if isinstance(payload, dict) else "scan endpoint returned invalid payload") or "scan endpoint unavailable",
                "url": DEFAULT_MAP_SCAN_URL,
            }

        stats = payload.get("stats") if isinstance(payload.get("stats"), dict) else {}
        points = payload.get("points") if isinstance(payload.get("points"), list) else []
        valid_ranges = int(stats.get("validRanges") or len(points))
        if valid_ranges <= 0:
            return {
                "ok": False,
                "attempt": "dogzilla-scan-endpoint",
                "error": "DOGZILLA scan endpoint is healthy but has no valid ranges",
                "url": DEFAULT_MAP_SCAN_URL,
                "validRanges": valid_ranges,
            }

        return {
            "ok": True,
            "attempt": "dogzilla-scan-endpoint",
            "url": DEFAULT_MAP_SCAN_URL,
            "scanFrame": payload.get("frameId"),
            "validRanges": valid_ranges,
            "rangeCount": payload.get("rangeCount"),
            "minRange": stats.get("minRange"),
            "nearFront": stats.get("nearFront"),
            "nearLeft": stats.get("nearLeft"),
            "nearRight": stats.get("nearRight"),
        }

    def _candidate_commands(self) -> list[tuple[str, str | list[str], bool]]:
        if self.override_command:
            return [("override", self.override_command, True)]

        return [
            ("host-ros2", ["bash", "-lc", LIDAR_AVOIDANCE_START_COMMAND], False),
            (
                "lidar-container",
                ["docker", "exec", "robodoge-rosbridge", "bash", "-lc", LIDAR_AVOIDANCE_START_COMMAND],
                False,
            ),
        ]

    def _candidate_scan_checks(self, topic: str) -> list[tuple[str, str | list[str], bool]]:
        quoted_topic = shlex.quote(topic)
        wait_timeout = max(DEFAULT_LIDAR_SCAN_WAIT_TIMEOUT, 0.5)
        command = f"{ROS_SETUP_COMMAND}; timeout {wait_timeout:.1f} ros2 topic info {quoted_topic}"
        return [
            ("host-ros2-scan-topic", ["bash", "-lc", command], False),
            (
                "lidar-container-scan-topic",
                ["docker", "exec", "robodoge-rosbridge", "bash", "-lc", command],
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


def parse_ros_topic_count(output: str, label: str) -> int:
    match = re.search(rf"{re.escape(label)}\s*:\s*(\d+)", output or "")
    return int(match.group(1)) if match else 0
