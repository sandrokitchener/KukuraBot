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
DEFAULT_NAV2_LIFECYCLE_NODES = tuple(
    node.strip().lstrip("/")
    for node in os.environ.get(
        "DOGZILLA_NAV2_REQUIRED_ACTIVE_NODES",
        "controller_server,planner_server,bt_navigator,behavior_server",
    ).split(",")
    if node.strip()
)
DEFAULT_NAV2_LIFECYCLE_WAIT_TIMEOUT = float(os.environ.get("DOGZILLA_NAV2_LIFECYCLE_WAIT_TIMEOUT", "2.0"))
DEFAULT_NAV2_SCAN_TOPIC = os.environ.get(
    "DOGZILLA_NAV2_SCAN_TOPIC",
    os.environ.get("DOGZILLA_NAV2_SCAN_FILTER_TOPIC", "/scan_nav2"),
)
DEFAULT_NAV2_SCAN_WAIT_TIMEOUT = float(os.environ.get("DOGZILLA_NAV2_SCAN_WAIT_TIMEOUT", "2.0"))
ROS_SETUP_COMMAND = (
    "source /opt/ros/humble/setup.bash 2>/dev/null || true; "
    "source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || "
    "source /home/pi/yahboomcar_ws/install/setup.bash 2>/dev/null || "
    "source /home/yahboom/yahboomcar_ws/install/setup.bash 2>/dev/null || true"
)
ODOM_BASE_FRAMES = ("base_link", "base_footprint")
PRIMARY_STATE_ACTIVE = 3


def normalize_frame_id(value: Any) -> str:
    return str(value or "").strip().lstrip("/")


def build_odom_unavailable_message(status: dict[str, Any]) -> str:
    topic = str(status.get("topic") or DEFAULT_ODOM_TOPIC)
    publisher_count = int(status.get("publisherCount") or 0)
    if publisher_count <= 0:
        return f"No publishers on {topic}"
    if status.get("messageAvailable") is not True:
        return f"{topic} has {publisher_count} publisher(s), but no live odometry samples were received."
    if status.get("tfAvailable") is not True:
        return f"{topic} publishes samples, but odom->base_link/base_footprint TF is unavailable."
    return f"Live odometry on {topic} is not ready."


def build_lifecycle_unavailable_message(status: dict[str, Any]) -> str:
    nodes = status.get("nodes") if isinstance(status.get("nodes"), list) else []
    inactive = [
        str(node.get("name") or "")
        for node in nodes
        if isinstance(node, dict) and node.get("active") is not True
    ]
    if inactive:
        return f"Nav2 lifecycle nodes are not active: {', '.join(inactive)}"
    error = str(status.get("error") or "").strip()
    return error or "Nav2 lifecycle state was not proven active"


def build_scan_unavailable_message(status: dict[str, Any]) -> str:
    topic = str(status.get("topic") or DEFAULT_NAV2_SCAN_TOPIC)
    publisher_count = int(status.get("publisherCount") or 0)
    subscription_count = int(status.get("subscriptionCount") or 0)
    if publisher_count <= 0:
        return f"No LaserScan publishers visible on {topic}"
    if subscription_count <= 0:
        return f"No Nav2 costmap subscribers visible on {topic}"
    return f"Nav2 filtered scan topic {topic} is not ready"


def lifecycle_service_name(node_name: str) -> str:
    clean = str(node_name or "").strip().lstrip("/")
    return f"/{clean}/get_state"


def probe_nav2_lifecycle(node: Any, *, nodes: tuple[str, ...], timeout_sec: float) -> dict[str, Any]:
    try:
        import rclpy
        from lifecycle_msgs.srv import GetState
    except Exception as error:
        return {
            "active": False,
            "checkedAt": time.time(),
            "nodes": [],
            "error": str(error),
        }

    node_names = tuple(name for name in nodes if name)
    status: dict[str, Any] = {
        "active": False,
        "checkedAt": time.time(),
        "requiredNodes": list(node_names),
        "nodes": [],
    }
    if not node_names:
        status["error"] = "No required Nav2 lifecycle nodes configured"
        return status

    deadline = time.monotonic() + max(float(timeout_sec), 0.1)
    for node_name in node_names:
        service_name = lifecycle_service_name(node_name)
        node_status: dict[str, Any] = {
            "name": node_name,
            "service": service_name,
            "active": False,
        }
        client = None
        try:
            client = node.create_client(GetState, service_name)
            remaining = max(deadline - time.monotonic(), 0.0)
            if not client.wait_for_service(timeout_sec=min(max(remaining, 0.1), 0.5)):
                node_status["error"] = "lifecycle service unavailable"
                status["nodes"].append(node_status)
                continue

            future = client.call_async(GetState.Request())
            while not future.done() and time.monotonic() < deadline:
                rclpy.spin_once(node, timeout_sec=0.05)

            if not future.done():
                node_status["error"] = "lifecycle state request timed out"
                status["nodes"].append(node_status)
                continue

            response = future.result()
            current_state = getattr(response, "current_state", None)
            state_id = int(getattr(current_state, "id", 0) or 0)
            label = str(getattr(current_state, "label", "") or "")
            node_status["stateId"] = state_id
            node_status["state"] = label
            node_status["active"] = state_id == PRIMARY_STATE_ACTIVE or label.lower() == "active"
        except Exception as error:
            node_status["error"] = str(error)
        finally:
            if client is not None:
                try:
                    node.destroy_client(client)
                except Exception:
                    pass

        status["nodes"].append(node_status)

    status["active"] = bool(status["nodes"]) and all(item.get("active") is True for item in status["nodes"])
    status["error"] = None if status["active"] else build_lifecycle_unavailable_message(status)
    return status


def probe_scan_topic(node: Any, *, topic: str, timeout_sec: float) -> dict[str, Any]:
    try:
        import rclpy
    except Exception:
        rclpy = None

    status: dict[str, Any] = {
        "topic": topic,
        "publisherCount": 0,
        "subscriptionCount": 0,
        "available": False,
        "checkedAt": time.time(),
    }
    deadline = time.monotonic() + max(float(timeout_sec), 0.0)
    while True:
        try:
            status["publisherCount"] = len(node.get_publishers_info_by_topic(topic))
        except Exception:
            status["publisherCount"] = 0
        try:
            status["subscriptionCount"] = len(node.get_subscriptions_info_by_topic(topic))
        except Exception:
            status["subscriptionCount"] = 0

        if status["publisherCount"] > 0 and status["subscriptionCount"] > 0:
            break
        if time.monotonic() >= deadline:
            break
        if rclpy is not None:
            rclpy.spin_once(node, timeout_sec=0.1)
        else:
            time.sleep(0.1)

    status["available"] = status["publisherCount"] > 0 and status["subscriptionCount"] > 0
    status["error"] = None if status["available"] else build_scan_unavailable_message(status)
    return status


def probe_nav2_prerequisites(
    node: Any,
    *,
    odom_topic: str,
    odom_timeout_sec: float,
    lifecycle_nodes: tuple[str, ...],
    lifecycle_timeout_sec: float,
    scan_topic: str,
    scan_timeout_sec: float,
) -> dict[str, Any]:
    return {
        "odom": probe_live_odom(node, topic=odom_topic, timeout_sec=odom_timeout_sec),
        "lifecycle": probe_nav2_lifecycle(node, nodes=lifecycle_nodes, timeout_sec=lifecycle_timeout_sec),
        "scan": probe_scan_topic(node, topic=scan_topic, timeout_sec=scan_timeout_sec),
    }


def probe_live_odom(node: Any, *, topic: str, timeout_sec: float) -> dict[str, Any]:
    try:
        import rclpy
        from nav_msgs.msg import Odometry
        from rclpy.duration import Duration
        from rclpy.time import Time
    except Exception as error:
        return {
            "topic": topic,
            "publisherCount": 0,
            "available": False,
            "messageAvailable": False,
            "tfAvailable": False,
            "error": str(error),
        }

    try:
        import tf2_ros
    except Exception as error:
        tf2_ros = None
        tf_error = str(error)
    else:
        tf_error = None

    status: dict[str, Any] = {
        "topic": topic,
        "publisherCount": 0,
        "available": False,
        "messageAvailable": False,
        "tfAvailable": False,
        "checkedAt": time.time(),
    }

    def on_odom(message: Any) -> None:
        status["messageAvailable"] = True
        status["lastMessageAt"] = time.time()
        status["frameId"] = normalize_frame_id(getattr(getattr(message, "header", None), "frame_id", ""))
        status["childFrameId"] = normalize_frame_id(getattr(message, "child_frame_id", ""))

    subscription = None
    tf_buffer = None
    tf_listener = None
    try:
        subscription = node.create_subscription(Odometry, topic, on_odom, 10)
        if tf2_ros is not None:
            tf_buffer = tf2_ros.Buffer()
            tf_listener = tf2_ros.TransformListener(tf_buffer, node)

        deadline = time.monotonic() + max(float(timeout_sec), 0.0)
        while time.monotonic() <= deadline:
            try:
                status["publisherCount"] = len(node.get_publishers_info_by_topic(topic))
            except Exception:
                status["publisherCount"] = 0

            if tf_buffer is not None:
                for base_frame in ODOM_BASE_FRAMES:
                    try:
                        if tf_buffer.can_transform("odom", base_frame, Time(), timeout=Duration(seconds=0.0)):
                            status["tfAvailable"] = True
                            status["tfTargetFrame"] = base_frame
                            break
                    except Exception as error:
                        tf_error = str(error)

            if status.get("messageAvailable") is True and status.get("tfAvailable") is True:
                break

            rclpy.spin_once(node, timeout_sec=0.1)

        if tf_buffer is not None and status.get("tfAvailable") is not True:
            for base_frame in ODOM_BASE_FRAMES:
                try:
                    if tf_buffer.can_transform("odom", base_frame, Time(), timeout=Duration(seconds=0.1)):
                        status["tfAvailable"] = True
                        status["tfTargetFrame"] = base_frame
                        break
                except Exception as error:
                    tf_error = str(error)
    finally:
        if subscription is not None:
            try:
                node.destroy_subscription(subscription)
            except Exception:
                pass

    status["available"] = status.get("messageAvailable") is True and status.get("tfAvailable") is True
    if status.get("available") is not True:
        if tf_error and status.get("messageAvailable") is True:
            status["tfError"] = tf_error
        status["error"] = build_odom_unavailable_message(status)
    else:
        status["error"] = None
    return status


LIVE_ODOM_PROBE_SCRIPT = r'''
import time

ODOM_BASE_FRAMES = ("base_link", "base_footprint")

def normalize_frame_id(value):
    return str(value or "").strip().lstrip("/")

def build_odom_unavailable_message(status):
    topic = str(status.get("topic") or "/odom")
    publisher_count = int(status.get("publisherCount") or 0)
    if publisher_count <= 0:
        return f"No publishers on {topic}"
    if status.get("messageAvailable") is not True:
        return f"{topic} has {publisher_count} publisher(s), but no live odometry samples were received."
    if status.get("tfAvailable") is not True:
        return f"{topic} publishes samples, but odom->base_link/base_footprint TF is unavailable."
    return f"Live odometry on {topic} is not ready."

def probe_live_odom(node, *, topic, timeout_sec):
    from nav_msgs.msg import Odometry
    from rclpy.duration import Duration
    from rclpy.time import Time

    try:
        import tf2_ros
    except Exception as error:
        tf2_ros = None
        tf_error = str(error)
    else:
        tf_error = None

    status = {
        "topic": topic,
        "publisherCount": 0,
        "available": False,
        "messageAvailable": False,
        "tfAvailable": False,
        "checkedAt": time.time(),
    }

    def on_odom(message):
        status["messageAvailable"] = True
        status["lastMessageAt"] = time.time()
        status["frameId"] = normalize_frame_id(getattr(getattr(message, "header", None), "frame_id", ""))
        status["childFrameId"] = normalize_frame_id(getattr(message, "child_frame_id", ""))

    subscription = None
    tf_buffer = None
    tf_listener = None
    try:
        subscription = node.create_subscription(Odometry, topic, on_odom, 10)
        if tf2_ros is not None:
            tf_buffer = tf2_ros.Buffer()
            tf_listener = tf2_ros.TransformListener(tf_buffer, node)

        deadline = time.monotonic() + max(float(timeout_sec), 0.0)
        while time.monotonic() <= deadline:
            try:
                status["publisherCount"] = len(node.get_publishers_info_by_topic(topic))
            except Exception:
                status["publisherCount"] = 0

            if tf_buffer is not None:
                for base_frame in ODOM_BASE_FRAMES:
                    try:
                        if tf_buffer.can_transform("odom", base_frame, Time(), timeout=Duration(seconds=0.0)):
                            status["tfAvailable"] = True
                            status["tfTargetFrame"] = base_frame
                            break
                    except Exception as error:
                        tf_error = str(error)

            if status.get("messageAvailable") is True and status.get("tfAvailable") is True:
                break

            rclpy.spin_once(node, timeout_sec=0.1)

        if tf_buffer is not None and status.get("tfAvailable") is not True:
            for base_frame in ODOM_BASE_FRAMES:
                try:
                    if tf_buffer.can_transform("odom", base_frame, Time(), timeout=Duration(seconds=0.1)):
                        status["tfAvailable"] = True
                        status["tfTargetFrame"] = base_frame
                        break
                except Exception as error:
                    tf_error = str(error)
    finally:
        if subscription is not None:
            try:
                node.destroy_subscription(subscription)
            except Exception:
                pass

    status["available"] = status.get("messageAvailable") is True and status.get("tfAvailable") is True
    if status.get("available") is not True:
        if tf_error and status.get("messageAvailable") is True:
            status["tfError"] = tf_error
        status["error"] = build_odom_unavailable_message(status)
    else:
        status["error"] = None
    return status
'''


NAV2_PREREQUISITE_PROBE_SCRIPT = LIVE_ODOM_PROBE_SCRIPT + r'''

PRIMARY_STATE_ACTIVE = 3

def build_lifecycle_unavailable_message(status):
    nodes = status.get("nodes") if isinstance(status.get("nodes"), list) else []
    inactive = [
        str(node.get("name") or "")
        for node in nodes
        if isinstance(node, dict) and node.get("active") is not True
    ]
    if inactive:
        return f"Nav2 lifecycle nodes are not active: {', '.join(inactive)}"
    error = str(status.get("error") or "").strip()
    return error or "Nav2 lifecycle state was not proven active"

def build_scan_unavailable_message(status):
    topic = str(status.get("topic") or "/scan_nav2")
    publisher_count = int(status.get("publisherCount") or 0)
    subscription_count = int(status.get("subscriptionCount") or 0)
    if publisher_count <= 0:
        return f"No LaserScan publishers visible on {topic}"
    if subscription_count <= 0:
        return f"No Nav2 costmap subscribers visible on {topic}"
    return f"Nav2 filtered scan topic {topic} is not ready"

def lifecycle_service_name(node_name):
    clean = str(node_name or "").strip().lstrip("/")
    return f"/{clean}/get_state"

def probe_nav2_lifecycle(node, *, nodes, timeout_sec):
    from lifecycle_msgs.srv import GetState

    node_names = tuple(name for name in nodes if name)
    status = {
        "active": False,
        "checkedAt": time.time(),
        "requiredNodes": list(node_names),
        "nodes": [],
    }
    if not node_names:
        status["error"] = "No required Nav2 lifecycle nodes configured"
        return status

    deadline = time.monotonic() + max(float(timeout_sec), 0.1)
    for node_name in node_names:
        service_name = lifecycle_service_name(node_name)
        node_status = {
            "name": node_name,
            "service": service_name,
            "active": False,
        }
        client = None
        try:
            client = node.create_client(GetState, service_name)
            remaining = max(deadline - time.monotonic(), 0.0)
            if not client.wait_for_service(timeout_sec=min(max(remaining, 0.1), 0.5)):
                node_status["error"] = "lifecycle service unavailable"
                status["nodes"].append(node_status)
                continue

            future = client.call_async(GetState.Request())
            while not future.done() and time.monotonic() < deadline:
                rclpy.spin_once(node, timeout_sec=0.05)

            if not future.done():
                node_status["error"] = "lifecycle state request timed out"
                status["nodes"].append(node_status)
                continue

            response = future.result()
            current_state = getattr(response, "current_state", None)
            state_id = int(getattr(current_state, "id", 0) or 0)
            label = str(getattr(current_state, "label", "") or "")
            node_status["stateId"] = state_id
            node_status["state"] = label
            node_status["active"] = state_id == PRIMARY_STATE_ACTIVE or label.lower() == "active"
        except Exception as error:
            node_status["error"] = str(error)
        finally:
            if client is not None:
                try:
                    node.destroy_client(client)
                except Exception:
                    pass

        status["nodes"].append(node_status)

    status["active"] = bool(status["nodes"]) and all(item.get("active") is True for item in status["nodes"])
    status["error"] = None if status["active"] else build_lifecycle_unavailable_message(status)
    return status

def probe_scan_topic(node, *, topic, timeout_sec):
    status = {
        "topic": topic,
        "publisherCount": 0,
        "subscriptionCount": 0,
        "available": False,
        "checkedAt": time.time(),
    }
    deadline = time.monotonic() + max(float(timeout_sec), 0.0)
    while True:
        try:
            status["publisherCount"] = len(node.get_publishers_info_by_topic(topic))
        except Exception:
            status["publisherCount"] = 0
        try:
            status["subscriptionCount"] = len(node.get_subscriptions_info_by_topic(topic))
        except Exception:
            status["subscriptionCount"] = 0

        if status["publisherCount"] > 0 and status["subscriptionCount"] > 0:
            break
        if time.monotonic() >= deadline:
            break
        rclpy.spin_once(node, timeout_sec=0.1)

    status["available"] = status["publisherCount"] > 0 and status["subscriptionCount"] > 0
    status["error"] = None if status["available"] else build_scan_unavailable_message(status)
    return status
'''


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
        self.odom_message_available = False
        self.odom_tf_available = False
        self.odom_frame_id: str | None = None
        self.odom_child_frame_id: str | None = None
        self.odom_tf_target_frame: str | None = None
        self.odom_last_message_at: float | None = None
        self.odom_checked_at: float | None = None
        self.odom_error: str | None = None
        self.lifecycle_active = False
        self.lifecycle_status: dict[str, Any] | None = None
        self.lifecycle_error: str | None = None
        self.scan_topic = DEFAULT_NAV2_SCAN_TOPIC
        self.scan_publisher_count = 0
        self.scan_subscription_count = 0
        self.scan_available = False
        self.scan_checked_at: float | None = None
        self.scan_error: str | None = None
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
        if not self.lifecycle_active:
            return {
                "executed": False,
                "delivery": "nav2-prerequisite-unavailable",
                "error": self.lifecycle_error or "Nav2 lifecycle state was not proven active",
                "action": self.action_name,
                "lifecycle": self._lifecycle_snapshot(),
            }
        if not self.scan_available:
            return {
                "executed": False,
                "delivery": "nav2-prerequisite-unavailable",
                "error": self.scan_error or f"No Nav2 costmap subscribers visible on {self.scan_topic}",
                "action": self.action_name,
                "scan": self._scan_snapshot(),
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

        try:
            completed = self._run_docker_python(
                "import rclpy\nfrom nav2_msgs.action import NavigateToPose\nfrom rclpy.action import ActionClient\nprint('ok')\n",
                timeout=6,
            )
        except subprocess.TimeoutExpired:
            self.docker_import_error = "docker import probe timed out after 6.0s"
            self.import_error = f"{self.host_import_error}; docker:{self.docker_import_error}"
            return
        if completed.returncode == 0:
            self.backend = "docker-rclpy"
            self.client_available = True
            self.import_error = None
            self.docker_import_error = None
            return

        self._try_install_docker_nav2_msgs()

        try:
            completed = self._run_docker_python(
                "import rclpy\nfrom nav2_msgs.action import NavigateToPose\nfrom rclpy.action import ActionClient\nprint('ok')\n",
                timeout=6,
            )
        except subprocess.TimeoutExpired:
            self.docker_import_error = "docker import probe timed out after 6.0s"
            self.import_error = f"{self.host_import_error}; docker:{self.docker_import_error}"
            return
        if completed.returncode == 0:
            self.backend = "docker-rclpy"
            self.client_available = True
            self.import_error = None
            self.docker_import_error = None
            return

        self.docker_import_error = summarize_process_text(completed.stderr) or summarize_process_text(completed.stdout) or f"docker exec returned {completed.returncode}"
        self.import_error = f"{self.host_import_error}; docker:{self.docker_import_error}"

    def _try_install_docker_nav2_msgs(self) -> None:
        try:
            subprocess.run(
                [
                    "docker", "exec", self.docker_container,
                    "bash", "-c",
                    "apt-get update -qq 2>/dev/null && apt-get install -y --no-install-recommends -qq ros-humble-nav2-msgs 2>/dev/null",
                ],
                timeout=30,
                capture_output=True,
                check=False,
            )
        except Exception:
            pass

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
                    self._refresh_docker_status()
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

        self._set_odom_status_from_payload(self._probe_host_odom_status(DEFAULT_ODOM_TOPIC, DEFAULT_NAV2_ODOM_WAIT_TIMEOUT))

    def _probe_host_odom_status(self, topic: str, timeout_sec: float) -> dict[str, Any]:
        return self._probe_host_prerequisite_status(topic, timeout_sec).get("odom", {})

    def _probe_host_prerequisite_status(self, topic: str, timeout_sec: float) -> dict[str, Any]:
        try:
            import rclpy
        except Exception as error:
            return {
                "odom": {
                    "topic": topic,
                    "publisherCount": 0,
                    "available": False,
                    "messageAvailable": False,
                    "tfAvailable": False,
                    "error": str(error),
                },
                "lifecycle": {
                    "active": False,
                    "error": str(error),
                },
                "scan": {
                    "topic": DEFAULT_NAV2_SCAN_TOPIC,
                    "publisherCount": 0,
                    "subscriptionCount": 0,
                    "available": False,
                    "error": str(error),
                },
            }

        try:
            node = rclpy.create_node("dogzilla_direct_nav2_prereq_probe")
        except Exception as error:
            return {
                "odom": {
                    "topic": topic,
                    "publisherCount": 0,
                    "available": False,
                    "messageAvailable": False,
                    "tfAvailable": False,
                    "error": str(error),
                },
                "lifecycle": {
                    "active": False,
                    "error": str(error),
                },
                "scan": {
                    "topic": DEFAULT_NAV2_SCAN_TOPIC,
                    "publisherCount": 0,
                    "subscriptionCount": 0,
                    "available": False,
                    "error": str(error),
                },
            }

        try:
            status = probe_nav2_prerequisites(
                node,
                odom_topic=topic,
                odom_timeout_sec=timeout_sec,
                lifecycle_nodes=DEFAULT_NAV2_LIFECYCLE_NODES,
                lifecycle_timeout_sec=DEFAULT_NAV2_LIFECYCLE_WAIT_TIMEOUT,
                scan_topic=DEFAULT_NAV2_SCAN_TOPIC,
                scan_timeout_sec=DEFAULT_NAV2_SCAN_WAIT_TIMEOUT,
            )
            self._set_lifecycle_status_from_payload(status.get("lifecycle") if isinstance(status.get("lifecycle"), dict) else None)
            self._set_scan_status_from_payload(status.get("scan") if isinstance(status.get("scan"), dict) else None)
            return status
        finally:
            try:
                node.destroy_node()
            except Exception:
                pass

    def _refresh_docker_status(self) -> None:
        request = {
            "action": self.action_name,
            "waitTimeout": DEFAULT_NAV2_STATUS_WAIT_TIMEOUT,
            "odomWaitTimeout": DEFAULT_NAV2_ODOM_WAIT_TIMEOUT,
            "odomTopic": DEFAULT_ODOM_TOPIC,
            "lifecycleNodes": list(DEFAULT_NAV2_LIFECYCLE_NODES),
            "lifecycleWaitTimeout": DEFAULT_NAV2_LIFECYCLE_WAIT_TIMEOUT,
            "scanTopic": DEFAULT_NAV2_SCAN_TOPIC,
            "scanWaitTimeout": DEFAULT_NAV2_SCAN_WAIT_TIMEOUT,
        }
        request_json = json.dumps(request)
        script = f"""
import json
import time

import rclpy
from nav2_msgs.action import NavigateToPose
from rclpy.action import ActionClient

{NAV2_PREREQUISITE_PROBE_SCRIPT}

request = json.loads({json.dumps(request_json)})
rclpy.init(args=None)
node = rclpy.create_node("dogzilla_direct_nav2_status_client")
client = ActionClient(node, NavigateToPose, request["action"])

try:
    action_available = bool(client.wait_for_server(timeout_sec=float(request["waitTimeout"])))
    odom = probe_live_odom(node, topic=request["odomTopic"], timeout_sec=request["odomWaitTimeout"])
    lifecycle = probe_nav2_lifecycle(
        node,
        nodes=tuple(request["lifecycleNodes"]),
        timeout_sec=request["lifecycleWaitTimeout"],
    )
    scan = probe_scan_topic(
        node,
        topic=request["scanTopic"],
        timeout_sec=request["scanWaitTimeout"],
    )
    print(json.dumps({{
        "available": action_available,
        "action": request["action"],
        "odom": odom,
        "lifecycle": lifecycle,
        "scan": scan,
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
        self._set_lifecycle_status_from_payload(parsed.get("lifecycle") if isinstance(parsed.get("lifecycle"), dict) else None)
        self._set_scan_status_from_payload(parsed.get("scan") if isinstance(parsed.get("scan"), dict) else None)

    def _nav2_server_unavailable_message(self) -> str:
        return f"Nav2 NavigateToPose action server is not running in the ROS graph for action {self.action_name!r}"

    def _set_odom_status_from_payload(self, odom: dict[str, Any] | None) -> None:
        if not odom:
            self.odom_topic = DEFAULT_ODOM_TOPIC
            self.odom_publisher_count = 0
            self.odom_available = False
            self.odom_message_available = False
            self.odom_tf_available = False
            self.odom_frame_id = None
            self.odom_child_frame_id = None
            self.odom_tf_target_frame = None
            self.odom_last_message_at = None
            self.odom_checked_at = None
            self.odom_error = f"Odometry topic {DEFAULT_ODOM_TOPIC} status was not reported"
            return

        self.odom_topic = str(odom.get("topic") or DEFAULT_ODOM_TOPIC)
        try:
            self.odom_publisher_count = int(odom.get("publisherCount") or 0)
        except (TypeError, ValueError):
            self.odom_publisher_count = 0
        self.odom_message_available = odom.get("messageAvailable") is True or odom.get("sampleAvailable") is True
        self.odom_tf_available = odom.get("tfAvailable") is True
        self.odom_frame_id = str(odom.get("frameId") or "") or None
        self.odom_child_frame_id = str(odom.get("childFrameId") or "") or None
        self.odom_tf_target_frame = str(odom.get("tfTargetFrame") or "") or None
        try:
            self.odom_last_message_at = float(odom.get("lastMessageAt")) if odom.get("lastMessageAt") is not None else None
        except (TypeError, ValueError):
            self.odom_last_message_at = None
        try:
            self.odom_checked_at = float(odom.get("checkedAt")) if odom.get("checkedAt") is not None else None
        except (TypeError, ValueError):
            self.odom_checked_at = None
        self.odom_available = (
            odom.get("available") is True
            and self.odom_message_available
            and self.odom_tf_available
        )
        self.odom_error = None if self.odom_available else str(odom.get("error") or build_odom_unavailable_message({
            "topic": self.odom_topic,
            "publisherCount": self.odom_publisher_count,
            "messageAvailable": self.odom_message_available,
            "tfAvailable": self.odom_tf_available,
        }))

    def _set_lifecycle_status_from_payload(self, lifecycle: dict[str, Any] | None) -> None:
        if not lifecycle:
            self.lifecycle_active = False
            self.lifecycle_status = {
                "active": False,
                "requiredNodes": list(DEFAULT_NAV2_LIFECYCLE_NODES),
                "nodes": [],
                "error": "Nav2 lifecycle state was not reported",
            }
            self.lifecycle_error = self.lifecycle_status["error"]
            return

        nodes = lifecycle.get("nodes") if isinstance(lifecycle.get("nodes"), list) else []
        self.lifecycle_active = lifecycle.get("active") is True
        self.lifecycle_status = {
            **lifecycle,
            "requiredNodes": lifecycle.get("requiredNodes") or list(DEFAULT_NAV2_LIFECYCLE_NODES),
            "nodes": nodes,
            "active": self.lifecycle_active,
        }
        self.lifecycle_error = None if self.lifecycle_active else str(
            lifecycle.get("error") or build_lifecycle_unavailable_message(self.lifecycle_status)
        )
        self.lifecycle_status["error"] = self.lifecycle_error

    def _set_scan_status_from_payload(self, scan: dict[str, Any] | None) -> None:
        if not scan:
            self.scan_topic = DEFAULT_NAV2_SCAN_TOPIC
            self.scan_publisher_count = 0
            self.scan_subscription_count = 0
            self.scan_available = False
            self.scan_checked_at = None
            self.scan_error = f"Nav2 filtered scan topic {DEFAULT_NAV2_SCAN_TOPIC} status was not reported"
            return

        self.scan_topic = str(scan.get("topic") or DEFAULT_NAV2_SCAN_TOPIC)
        try:
            self.scan_publisher_count = int(scan.get("publisherCount") or 0)
        except (TypeError, ValueError):
            self.scan_publisher_count = 0
        try:
            self.scan_subscription_count = int(scan.get("subscriptionCount") or 0)
        except (TypeError, ValueError):
            self.scan_subscription_count = 0
        try:
            self.scan_checked_at = float(scan.get("checkedAt")) if scan.get("checkedAt") is not None else None
        except (TypeError, ValueError):
            self.scan_checked_at = None
        self.scan_available = (
            scan.get("available") is True
            and self.scan_publisher_count > 0
            and self.scan_subscription_count > 0
        )
        self.scan_error = None if self.scan_available else str(scan.get("error") or build_scan_unavailable_message({
            "topic": self.scan_topic,
            "publisherCount": self.scan_publisher_count,
            "subscriptionCount": self.scan_subscription_count,
        }))

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
            "lifecycleNodes": list(DEFAULT_NAV2_LIFECYCLE_NODES),
            "lifecycleWaitTimeout": DEFAULT_NAV2_LIFECYCLE_WAIT_TIMEOUT,
            "scanTopic": DEFAULT_NAV2_SCAN_TOPIC,
            "scanWaitTimeout": DEFAULT_NAV2_SCAN_WAIT_TIMEOUT,
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

{NAV2_PREREQUISITE_PROBE_SCRIPT}

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

    odom = probe_live_odom(node, topic=request["odomTopic"], timeout_sec=request["odomWaitTimeout"])
    if odom.get("available") is not True:
        print(json.dumps({{
            "executed": False,
            "delivery": "nav2-prerequisite-unavailable",
            "error": odom.get("error") or f"Live odometry on {{request['odomTopic']}} is not ready.",
            "action": request["action"],
            "odom": odom,
        }}))
        raise SystemExit(5)

    lifecycle = probe_nav2_lifecycle(
        node,
        nodes=tuple(request["lifecycleNodes"]),
        timeout_sec=request["lifecycleWaitTimeout"],
    )
    if lifecycle.get("active") is not True:
        print(json.dumps({{
            "executed": False,
            "delivery": "nav2-prerequisite-unavailable",
            "error": lifecycle.get("error") or "Nav2 lifecycle state was not proven active.",
            "action": request["action"],
            "lifecycle": lifecycle,
        }}))
        raise SystemExit(6)

    scan = probe_scan_topic(
        node,
        topic=request["scanTopic"],
        timeout_sec=request["scanWaitTimeout"],
    )
    if scan.get("available") is not True:
        print(json.dumps({{
            "executed": False,
            "delivery": "nav2-prerequisite-unavailable",
            "error": scan.get("error") or f"Nav2 filtered scan topic {{request['scanTopic']}} is not ready.",
            "action": request["action"],
            "scan": scan,
        }}))
        raise SystemExit(7)

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
        docker_timeout = self.wait_timeout + self.goal_response_timeout + DEFAULT_NAV2_ODOM_WAIT_TIMEOUT + 12
        try:
            completed = self._run_docker_python(script, timeout=docker_timeout)
        except subprocess.TimeoutExpired:
            return {
                "executed": False,
                "delivery": "nav2-docker-timeout",
                "error": f"Nav2 docker goal helper timed out after {docker_timeout:.1f}s",
                "action": self.action_name,
                "backend": self.backend,
                "container": self.docker_container,
            }
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
        lifecycle = self._lifecycle_snapshot()
        scan = self._scan_snapshot()
        waypoint_ready = (
            self.available
            and odom.get("available") is True
            and lifecycle.get("active") is True
            and scan.get("available") is True
        )
        blockers: list[str] = []
        if not self.available:
            blockers.append(self.import_error or self.server_error or "Nav2 NavigateToPose action server unavailable")
        if odom.get("available") is not True:
            blockers.append(odom.get("error") or f"No publishers on {odom.get('topic') or DEFAULT_ODOM_TOPIC}")
        if lifecycle.get("active") is not True:
            blockers.append(lifecycle.get("error") or "Nav2 lifecycle state was not proven active")
        if scan.get("available") is not True:
            blockers.append(scan.get("error") or f"No Nav2 costmap subscribers visible on {scan.get('topic') or DEFAULT_NAV2_SCAN_TOPIC}")
        return {
            "available": self.available,
            "waypointReady": waypoint_ready,
            "blockers": blockers,
            "clientAvailable": self.client_available,
            "serverAvailable": self.server_available,
            "action": self.action_name,
            "odom": odom,
            "lifecycle": lifecycle,
            "scan": scan,
            "backend": self.backend,
            "dockerContainer": self.docker_container,
            "allowedFrames": sorted(DEFAULT_NAV2_ALLOWED_FRAMES),
            "waitTimeoutSec": self.wait_timeout,
            "goalResponseTimeoutSec": self.goal_response_timeout,
            "cancelTimeoutSec": DEFAULT_NAV2_CANCEL_TIMEOUT,
            "dockerStatusTimeoutSec": DEFAULT_NAV2_DOCKER_STATUS_TIMEOUT,
            "odomWaitTimeoutSec": DEFAULT_NAV2_ODOM_WAIT_TIMEOUT,
            "lifecycleWaitTimeoutSec": DEFAULT_NAV2_LIFECYCLE_WAIT_TIMEOUT,
            "scanWaitTimeoutSec": DEFAULT_NAV2_SCAN_WAIT_TIMEOUT,
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
            "messageAvailable": getattr(self, "odom_message_available", False) is True,
            "tfAvailable": getattr(self, "odom_tf_available", False) is True,
            "frameId": getattr(self, "odom_frame_id", None),
            "childFrameId": getattr(self, "odom_child_frame_id", None),
            "tfTargetFrame": getattr(self, "odom_tf_target_frame", None),
            "lastMessageAt": getattr(self, "odom_last_message_at", None),
            "checkedAt": getattr(self, "odom_checked_at", None),
            "error": getattr(self, "odom_error", None),
        }

    def _lifecycle_snapshot(self) -> dict[str, Any]:
        status = getattr(self, "lifecycle_status", None)
        if isinstance(status, dict):
            return {
                **status,
                "active": getattr(self, "lifecycle_active", False) is True,
                "error": getattr(self, "lifecycle_error", None),
            }
        return {
            "active": False,
            "requiredNodes": list(DEFAULT_NAV2_LIFECYCLE_NODES),
            "nodes": [],
            "error": getattr(self, "lifecycle_error", None) or "Nav2 lifecycle state was not reported",
        }

    def _scan_snapshot(self) -> dict[str, Any]:
        return {
            "topic": getattr(self, "scan_topic", DEFAULT_NAV2_SCAN_TOPIC) or DEFAULT_NAV2_SCAN_TOPIC,
            "publisherCount": int(getattr(self, "scan_publisher_count", 0) or 0),
            "subscriptionCount": int(getattr(self, "scan_subscription_count", 0) or 0),
            "available": getattr(self, "scan_available", False) is True,
            "checkedAt": getattr(self, "scan_checked_at", None),
            "error": getattr(self, "scan_error", None),
        }
