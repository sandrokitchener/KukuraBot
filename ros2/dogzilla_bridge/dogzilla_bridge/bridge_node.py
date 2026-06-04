from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

import rclpy
from dogzilla_bridge.adapters import (
    AdapterError,
    RecordingDogzillaAdapter,
    RosPublisherDogzillaAdapter,
    YahboomPythonDogzillaAdapter,
)
from dogzilla_bridge.commands import CommandValidationError, DogzillaCommandLimits, execute_canonical_plan
from geometry_msgs.msg import Twist
from rclpy.action import ActionClient
from rclpy.node import Node
from std_msgs.msg import Bool, String, UInt16

try:
    from nav2_msgs.action import NavigateToPose
except Exception:  # pragma: no cover - depends on Yahboom/Nav2 image packages
    NavigateToPose = None


DEFAULT_EXPECTED_ROS_DOMAIN_ID = os.environ.get("DOGZILLA_EXPECTED_ROS_DOMAIN_ID", "16")
os.environ.setdefault("ROS_DOMAIN_ID", os.environ.get("DOGZILLA_ROS_DOMAIN_ID", DEFAULT_EXPECTED_ROS_DOMAIN_ID))
STUDY_HINTS = {
    "expectedRosDomainId": DEFAULT_EXPECTED_ROS_DOMAIN_ID,
    "pi5DockerEntry": "./run_humble.sh",
    "bringupLaunch": "ros2 launch bringup Navigation_bringup.launch.py",
    "keyboardTeleop": "ros2 run teleop_twist_keyboard teleop_twist_keyboard",
    "cameraTopicFromAppDocs": "/usb_cam/imge_raw/compress",
}


@dataclass
class BridgeState:
    handled_count: int = 0
    last_status: str = "idle"
    last_command: dict[str, Any] | None = None
    last_result: dict[str, Any] | None = None
    last_error: str | None = None


class DogzillaBridgeNode(Node):
    def __init__(self) -> None:
        super().__init__("dogzilla_bridge")
        self.declare_parameter("enabled", True)
        self.declare_parameter("dry_run", True)
        self.declare_parameter("robot_model", "dogzilla-s2")
        self.declare_parameter("namespace", "/dogzilla")
        self.declare_parameter("command_plan_topic", "/dogzilla/command_plan")
        self.declare_parameter("cmd_vel_topic", "/dogzilla/cmd_vel")
        self.declare_parameter("action_topic", "/dogzilla/action")
        self.declare_parameter("stabilize_topic", "/dogzilla/stabilize")
        self.declare_parameter("state_topic", "/dogzilla/state")
        self.declare_parameter("navigate_to_pose_action", "navigate_to_pose")
        self.declare_parameter("adapter_mode", "ros-publisher")
        self.declare_parameter("dogzilla_python_module", "")
        self.declare_parameter("dogzilla_python_factory", "")
        self.declare_parameter("publish_state_hz", 1.0)
        self.declare_parameter("deadband", 0.05)
        self.declare_parameter("linear_x_full_scale_step", 25.0)
        self.declare_parameter("linear_y_full_scale_step", 18.0)
        self.declare_parameter("angular_z_full_scale_step", 100.0)

        self.enabled = bool(self.get_parameter("enabled").value)
        self.dry_run = bool(self.get_parameter("dry_run").value)
        self.deadband = float(self.get_parameter("deadband").value)
        self.linear_x_full_scale_step = float(self.get_parameter("linear_x_full_scale_step").value)
        self.linear_y_full_scale_step = float(self.get_parameter("linear_y_full_scale_step").value)
        self.angular_z_full_scale_step = float(self.get_parameter("angular_z_full_scale_step").value)
        self.adapter_mode = str(self.get_parameter("adapter_mode").value)
        self.state = BridgeState()
        self.command_limits = DogzillaCommandLimits()

        command_plan_topic = str(self.get_parameter("command_plan_topic").value)
        cmd_vel_topic = str(self.get_parameter("cmd_vel_topic").value)
        action_topic = str(self.get_parameter("action_topic").value)
        stabilize_topic = str(self.get_parameter("stabilize_topic").value)
        state_topic = str(self.get_parameter("state_topic").value)
        navigate_to_pose_action = str(self.get_parameter("navigate_to_pose_action").value)
        publish_state_hz = float(self.get_parameter("publish_state_hz").value)

        self.cmd_vel_publisher = self.create_publisher(Twist, cmd_vel_topic, 10)
        self.action_publisher = self.create_publisher(UInt16, action_topic, 10)
        self.stabilize_publisher = self.create_publisher(Bool, stabilize_topic, 10)
        self.state_publisher = self.create_publisher(String, state_topic, 10)
        self.nav_action_client = ActionClient(self, NavigateToPose, navigate_to_pose_action) if NavigateToPose is not None else None
        self.adapter = self._create_adapter()
        self.create_subscription(String, command_plan_topic, self._handle_plan_message, 10)
        self.create_timer(1.0 / max(publish_state_hz, 0.1), self._publish_state_snapshot)

        self.get_logger().info(
            "DOGZILLA bridge ready. "
            f"command_plan_topic={command_plan_topic} dry_run={self.dry_run} "
            f"enabled={self.enabled} adapter={self.adapter.name} nav_action={navigate_to_pose_action}"
        )

    def _handle_plan_message(self, message: String) -> None:
        try:
            envelope = json.loads(message.data)
        except json.JSONDecodeError as error:
            self._mark_error(f"invalid_json:{error}")
            return

        canonical_plan = envelope.get("canonicalPlan") or envelope.get("payload", {}).get("canonicalPlan")
        if not isinstance(canonical_plan, dict):
            self._mark_error("missing_canonical_plan")
            return

        kind = canonical_plan.get("kind")
        params = canonical_plan.get("params", {})
        self.state.handled_count += 1
        self.state.last_command = canonical_plan

        if not self.enabled:
            self.state.last_status = "disabled"
            return

        try:
            result = execute_canonical_plan(canonical_plan, self.adapter, self.command_limits)
            self.state.last_status = result.status
            self.state.last_result = result.to_dict()
            self.state.last_error = None if result.status != "unsupported" else result.details.get("reason")
        except (AdapterError, CommandValidationError) as error:
            self._mark_error(str(error))
        except Exception as error:
            self._mark_error(f"adapter_exception:{error}")

    def _publish_state_snapshot(self) -> None:
        snapshot = {
            "status": self.state.last_status,
            "handledCount": self.state.handled_count,
            "lastCommand": self.state.last_command,
            "lastResult": self.state.last_result,
            "lastError": self.state.last_error,
            "dryRun": self.dry_run,
            "enabled": self.enabled,
            "adapterMode": self.adapter.name,
            "rosDomainId": os.environ.get("ROS_DOMAIN_ID"),
            "expectedRosDomainId": DEFAULT_EXPECTED_ROS_DOMAIN_ID,
            "studyHints": STUDY_HINTS,
        }
        message = String()
        message.data = json.dumps(snapshot)
        self.state_publisher.publish(message)

    def _mark_error(self, error_message: str) -> None:
        self.state.last_status = "error"
        self.state.last_error = error_message
        self.get_logger().warning(error_message)

    def _create_adapter(self):
        if self.dry_run or self.adapter_mode == "dry-run":
            return RecordingDogzillaAdapter()

        if self.adapter_mode == "ros-publisher":
            return RosPublisherDogzillaAdapter(
                cmd_vel_publisher=self.cmd_vel_publisher,
                action_publisher=self.action_publisher,
                stabilize_publisher=self.stabilize_publisher,
                twist_type=Twist,
                uint16_type=UInt16,
                bool_type=Bool,
                deadband=self.deadband,
                linear_x_full_scale_step=self.linear_x_full_scale_step,
                linear_y_full_scale_step=self.linear_y_full_scale_step,
                angular_z_full_scale_step=self.angular_z_full_scale_step,
                navigate_to_pose_type=NavigateToPose,
                nav_action_client=self.nav_action_client,
                clock=self.get_clock(),
            )

        if self.adapter_mode == "yahboom-python":
            module_name = str(self.get_parameter("dogzilla_python_module").value)
            factory_name = str(self.get_parameter("dogzilla_python_factory").value)
            return YahboomPythonDogzillaAdapter.from_module(module_name, factory_name)

        raise AdapterError(f"unsupported adapter_mode:{self.adapter_mode}")


def main() -> None:
    rclpy.init()
    node = DogzillaBridgeNode()

    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
