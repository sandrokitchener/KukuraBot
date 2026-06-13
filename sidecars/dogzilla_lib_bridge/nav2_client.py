from __future__ import annotations

import json
import math
import os
import subprocess
import threading
import time
from typing import Any

from process_utils import parse_json_process_output, summarize_process_text


DEFAULT_EXPECTED_ROS_DOMAIN_ID = os.environ.get("DOGZILLA_EXPECTED_ROS_DOMAIN_ID", "16")
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
DEFAULT_NAV2_CANCEL_TIMEOUT = float(os.environ.get("DOGZILLA_NAV2_CANCEL_TIMEOUT", "1.0"))
DEFAULT_NAV2_STATUS_CACHE_SEC = float(os.environ.get("DOGZILLA_NAV2_STATUS_CACHE_SEC", "5.0"))
DEFAULT_NAV2_STATUS_WAIT_TIMEOUT = float(os.environ.get("DOGZILLA_NAV2_STATUS_WAIT_TIMEOUT", "2.0"))
DEFAULT_NAV2_DOCKER_STATUS_TIMEOUT = float(os.environ.get("DOGZILLA_NAV2_DOCKER_STATUS_TIMEOUT", "10.0"))
DEFAULT_NAV2_ODOM_WAIT_TIMEOUT = float(os.environ.get("DOGZILLA_NAV2_ODOM_WAIT_TIMEOUT", "3.0"))
DEFAULT_ODOM_TOPIC = os.environ.get("DOGZILLA_ODOM_TOPIC", "/odom")
ROS_SETUP_COMMAND = (
    "source /opt/ros/humble/setup.bash 2>/dev/null || true; "
    "source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || "
    "source /home/pi/yahboomcar_ws/install/setup.bash 2>/dev/null || "
    "source /home/yahboom/yahboomcar_ws/install/setup.bash 2>/dev/null || true"
)


class Nav2NavigateClient:
    def __init__(self, action_name: str):
        self.action_name = action_name
        self.wait_timeout = DEFAULT_NAV2_WAIT_TIMEOUT
        self.goal_response_timeout = DEFAULT_NAV2_GOAL_RESPONSE_TIMEOUT
        self.import_error: str | None = None
        self.host_import_error: str | None = None
        self.docker_import_error: str | None = None
        self.server_error: str | None = None
        self.odom_topic = DEFAULT_ODOM_TOPIC
        self.odom_publisher_count = 0
        self.odom_available = False
        self.odom_error: str | None = None
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

        self._refresh_host_prerequisites()
        if not self.odom_available:
            return {
                "executed": False,
                "delivery": "nav2-prerequisite-unavailable",
                "error": self.odom_error or f"No publishers on {self.odom_topic}",
                "action": self.action_name,
                "odom": self._odom_snapshot(),
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

    def cancel_active_goal(self, *, timeout: float = DEFAULT_NAV2_CANCEL_TIMEOUT) -> dict[str, Any]:
        if self.backend == "docker-rclpy":
            return self._cancel_goals_via_docker(timeout=timeout)

        if self._node is None:
            return {
                "executed": False,
                "delivery": "nav2-cancel-unavailable",
                "error": "Nav2 ROS node unavailable for goal cancellation",
                "action": self.action_name,
                "backend": self.backend,
            }

        try:
            from action_msgs.srv import CancelGoal
        except Exception as error:
            return {
                "executed": False,
                "delivery": "nav2-cancel-unavailable",
                "error": str(error),
                "action": self.action_name,
                "backend": self.backend,
            }

        service_name = self._cancel_service_name()
        client = self._node.create_client(CancelGoal, service_name)
        try:
            if not client.wait_for_service(timeout_sec=timeout):
                return {
                    "executed": False,
                    "delivery": "nav2-cancel-unavailable",
                    "error": f"Nav2 cancel service unavailable after {timeout:.1f}s",
                    "action": self.action_name,
                    "service": service_name,
                    "backend": self.backend,
                }

            future = client.call_async(CancelGoal.Request())
            deadline = time.monotonic() + timeout
            while not future.done() and time.monotonic() < deadline:
                time.sleep(0.02)

            if not future.done():
                return {
                    "executed": False,
                    "delivery": "nav2-cancel-timeout",
                    "error": f"Nav2 goal cancel timeout after {timeout:.1f}s",
                    "action": self.action_name,
                    "service": service_name,
                    "backend": self.backend,
                }

            response = future.result()
            goals_canceling = getattr(response, "goals_canceling", []) if response is not None else []
            return {
                "executed": True,
                "delivery": "Nav2 NavigateToPose cancel",
                "action": self.action_name,
                "service": service_name,
                "backend": self.backend,
                "returnCode": getattr(response, "return_code", None),
                "goalsCanceling": len(goals_canceling or []),
            }
        except Exception as error:
            return {
                "executed": False,
                "delivery": "nav2-cancel-error",
                "error": str(error),
                "action": self.action_name,
                "service": service_name,
                "backend": self.backend,
            }
        finally:
            try:
                self._node.destroy_client(client)
            except Exception:
                pass

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
            self._refresh_host_prerequisites()
        except Exception as error:
            self.server_available = False
            self.available = False
            self.server_error = str(error)
            self.import_error = self.server_error
            self.odom_available = False
            self.odom_error = str(error)

    def _refresh_host_prerequisites(self) -> None:
        if self._node is None:
            self.odom_available = False
            self.odom_error = "Nav2 ROS node unavailable for odometry check"
            return

        try:
            publishers = self._node.get_publishers_info_by_topic(DEFAULT_ODOM_TOPIC)
            self.odom_topic = DEFAULT_ODOM_TOPIC
            self.odom_publisher_count = len(publishers)
            self.odom_available = self.odom_publisher_count > 0
            self.odom_error = None if self.odom_available else f"No publishers on {DEFAULT_ODOM_TOPIC}"
        except Exception as error:
            self.odom_publisher_count = 0
            self.odom_available = False
            self.odom_error = str(error)

    def _refresh_docker_status(self) -> None:
        request = {
            "action": self.action_name,
            "waitTimeout": DEFAULT_NAV2_STATUS_WAIT_TIMEOUT,
            "odomWaitTimeout": DEFAULT_NAV2_ODOM_WAIT_TIMEOUT,
            "odomTopic": DEFAULT_ODOM_TOPIC,
        }
        request_json = json.dumps(request)
        script = f"""
import json
import time

import rclpy
from nav2_msgs.action import NavigateToPose
from rclpy.action import ActionClient

request = json.loads({json.dumps(request_json)})
rclpy.init(args=None)
node = rclpy.create_node("dogzilla_direct_nav2_status_client")
client = ActionClient(node, NavigateToPose, request["action"])

def wait_for_publishers(topic, timeout_sec):
    deadline = time.monotonic() + max(float(timeout_sec), 0.0)
    count = 0
    while time.monotonic() <= deadline:
        count = len(node.get_publishers_info_by_topic(topic))
        if count > 0:
            return count
        rclpy.spin_once(node, timeout_sec=0.1)
    return count

try:
    action_available = bool(client.wait_for_server(timeout_sec=float(request["waitTimeout"])))
    odom_publishers = wait_for_publishers(request["odomTopic"], request["odomWaitTimeout"])
    print(json.dumps({{
        "available": action_available,
        "action": request["action"],
        "odom": {{
            "topic": request["odomTopic"],
            "publisherCount": odom_publishers,
            "available": odom_publishers > 0,
        }},
    }}))
finally:
    node.destroy_node()
    rclpy.shutdown()
"""
        try:
            completed = self._run_docker_python(
                script,
                timeout=DEFAULT_NAV2_DOCKER_STATUS_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            if not self.server_available:
                self.server_available = False
                self.available = False
                self.server_error = "Nav2 action server status check timed out"
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

        parsed = parse_json_process_output(completed.stdout)
        if not isinstance(parsed, dict):
            error = summarize_process_text(completed.stderr) or summarize_process_text(completed.stdout) or "Nav2 status check returned no JSON"
            self.client_available = False
            self.server_available = False
            self.available = False
            self.docker_import_error = error
            self.server_error = None
            self.import_error = f"{self.host_import_error}; docker:{error}" if self.host_import_error else error
            return

        self.client_available = True
        self.server_available = parsed.get("available") is True
        self.available = self.client_available and self.server_available
        self.docker_import_error = None
        self.server_error = None if self.server_available else self._nav2_server_unavailable_message()
        self.import_error = None if self.available else self.server_error
        self._set_odom_status_from_payload(parsed.get("odom") if isinstance(parsed.get("odom"), dict) else None)

    def _nav2_server_unavailable_message(self) -> str:
        return f"Nav2 NavigateToPose action server is not running in the ROS graph for action {self.action_name!r}"

    def _set_odom_status_from_payload(self, odom: dict[str, Any] | None) -> None:
        if not odom:
            self.odom_topic = DEFAULT_ODOM_TOPIC
            self.odom_publisher_count = 0
            self.odom_available = False
            self.odom_error = f"Odometry topic {DEFAULT_ODOM_TOPIC} status was not reported"
            return

        self.odom_topic = str(odom.get("topic") or DEFAULT_ODOM_TOPIC)
        try:
            self.odom_publisher_count = int(odom.get("publisherCount") or 0)
        except (TypeError, ValueError):
            self.odom_publisher_count = 0
        self.odom_available = odom.get("available") is True or self.odom_publisher_count > 0
        self.odom_error = None if self.odom_available else f"No publishers on {self.odom_topic}"

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
            "odomWaitTimeout": DEFAULT_NAV2_ODOM_WAIT_TIMEOUT,
            "odomTopic": DEFAULT_ODOM_TOPIC,
        }
        request_json = json.dumps(request)
        script = f"""
import json
import math
import sys
import time

import rclpy
from nav2_msgs.action import NavigateToPose
from rclpy.action import ActionClient

request = json.loads({json.dumps(request_json)})
rclpy.init(args=None)
node = rclpy.create_node("dogzilla_direct_nav2_docker_client")
client = ActionClient(node, NavigateToPose, request["action"])

def wait_for_publishers(topic, timeout_sec):
    deadline = time.monotonic() + max(float(timeout_sec), 0.0)
    count = 0
    while time.monotonic() <= deadline:
        count = len(node.get_publishers_info_by_topic(topic))
        if count > 0:
            return count
        rclpy.spin_once(node, timeout_sec=0.1)
    return count

try:
    if not client.wait_for_server(timeout_sec=float(request["waitTimeout"])):
        print(json.dumps({{
            "executed": False,
            "delivery": "nav2-unavailable",
            "error": f"Nav2 NavigateToPose action server unavailable after {{float(request['waitTimeout']):.1f}}s",
            "action": request["action"],
        }}))
        raise SystemExit(2)

    odom_publishers = wait_for_publishers(request["odomTopic"], request["odomWaitTimeout"])
    if odom_publishers <= 0:
        print(json.dumps({{
            "executed": False,
            "delivery": "nav2-prerequisite-unavailable",
            "error": f"No publishers on {{request['odomTopic']}}",
            "action": request["action"],
            "odom": {{
                "topic": request["odomTopic"],
                "publisherCount": odom_publishers,
                "available": False,
            }},
        }}))
        raise SystemExit(5)

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
        completed = self._run_docker_python(
            script,
            timeout=self.wait_timeout + self.goal_response_timeout + DEFAULT_NAV2_ODOM_WAIT_TIMEOUT + 3,
        )
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

    def _cancel_goals_via_docker(self, *, timeout: float) -> dict[str, Any]:
        request = {
            "action": self.action_name,
            "cancelTimeout": timeout,
        }
        request_json = json.dumps(request)
        script = f"""
import json
import time

import rclpy
from action_msgs.srv import CancelGoal

request = json.loads({json.dumps(request_json)})
action_name = str(request["action"]).strip("/") or "navigate_to_pose"
service_name = f"/{{action_name}}/_action/cancel_goal"

rclpy.init(args=None)
node = rclpy.create_node("dogzilla_direct_nav2_cancel_client")
client = node.create_client(CancelGoal, service_name)

try:
    timeout = float(request["cancelTimeout"])
    if not client.wait_for_service(timeout_sec=timeout):
        print(json.dumps({{
            "executed": False,
            "delivery": "nav2-cancel-unavailable",
            "error": f"Nav2 cancel service unavailable after {{timeout:.1f}}s",
            "action": request["action"],
            "service": service_name,
        }}))
        raise SystemExit(2)

    future = client.call_async(CancelGoal.Request())
    deadline = time.monotonic() + timeout
    while not future.done() and time.monotonic() < deadline:
        rclpy.spin_once(node, timeout_sec=0.05)

    if not future.done():
        print(json.dumps({{
            "executed": False,
            "delivery": "nav2-cancel-timeout",
            "error": f"Nav2 goal cancel timeout after {{timeout:.1f}}s",
            "action": request["action"],
            "service": service_name,
        }}))
        raise SystemExit(3)

    response = future.result()
    goals_canceling = getattr(response, "goals_canceling", []) or []
    print(json.dumps({{
        "executed": True,
        "delivery": "Nav2 NavigateToPose cancel",
        "action": request["action"],
        "service": service_name,
        "returnCode": getattr(response, "return_code", None),
        "goalsCanceling": len(goals_canceling),
    }}))
finally:
    node.destroy_node()
    rclpy.shutdown()
"""
        completed = self._run_docker_python(script, timeout=timeout + 2)
        parsed = parse_json_process_output(completed.stdout)
        if isinstance(parsed, dict):
            return {
                **parsed,
                "backend": self.backend,
                "container": self.docker_container,
            }

        return {
            "executed": False,
            "delivery": "nav2-cancel-docker-failed",
            "error": summarize_process_text(completed.stderr) or summarize_process_text(completed.stdout) or f"docker exec returned {completed.returncode}",
            "action": self.action_name,
            "backend": self.backend,
            "container": self.docker_container,
        }

    def _cancel_service_name(self) -> str:
        action_name = str(self.action_name or DEFAULT_NAV2_ACTION).strip("/") or DEFAULT_NAV2_ACTION.strip("/")
        return f"/{action_name}/_action/cancel_goal"

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
        odom = self._odom_snapshot()
        waypoint_ready = self.available and odom.get("available") is True
        blockers: list[str] = []
        if not self.available:
            blockers.append(self.import_error or self.server_error or "Nav2 NavigateToPose action server unavailable")
        if odom.get("available") is not True:
            blockers.append(odom.get("error") or f"No publishers on {odom.get('topic') or DEFAULT_ODOM_TOPIC}")
        return {
            "available": self.available,
            "waypointReady": waypoint_ready,
            "blockers": blockers,
            "clientAvailable": self.client_available,
            "serverAvailable": self.server_available,
            "action": self.action_name,
            "odom": odom,
            "backend": self.backend,
            "dockerContainer": self.docker_container,
            "allowedFrames": sorted(DEFAULT_NAV2_ALLOWED_FRAMES),
            "waitTimeoutSec": self.wait_timeout,
            "goalResponseTimeoutSec": self.goal_response_timeout,
            "cancelTimeoutSec": DEFAULT_NAV2_CANCEL_TIMEOUT,
            "dockerStatusTimeoutSec": DEFAULT_NAV2_DOCKER_STATUS_TIMEOUT,
            "odomWaitTimeoutSec": DEFAULT_NAV2_ODOM_WAIT_TIMEOUT,
            "importError": self.import_error,
            "hostImportError": self.host_import_error,
            "dockerImportError": self.docker_import_error,
            "serverError": self.server_error,
        }

    def _odom_snapshot(self) -> dict[str, Any]:
        return {
            "topic": getattr(self, "odom_topic", DEFAULT_ODOM_TOPIC) or DEFAULT_ODOM_TOPIC,
            "publisherCount": int(getattr(self, "odom_publisher_count", 0) or 0),
            "available": getattr(self, "odom_available", False) is True,
            "error": getattr(self, "odom_error", None),
        }
