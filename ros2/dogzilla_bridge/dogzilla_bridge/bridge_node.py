from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node
from std_msgs.msg import Bool, String, UInt16


@dataclass
class BridgeState:
    handled_count: int = 0
    last_status: str = "idle"
    last_command: dict[str, Any] | None = None
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
        self.state = BridgeState()

        command_plan_topic = str(self.get_parameter("command_plan_topic").value)
        cmd_vel_topic = str(self.get_parameter("cmd_vel_topic").value)
        action_topic = str(self.get_parameter("action_topic").value)
        stabilize_topic = str(self.get_parameter("stabilize_topic").value)
        state_topic = str(self.get_parameter("state_topic").value)
        publish_state_hz = float(self.get_parameter("publish_state_hz").value)

        self.cmd_vel_publisher = self.create_publisher(Twist, cmd_vel_topic, 10)
        self.action_publisher = self.create_publisher(UInt16, action_topic, 10)
        self.stabilize_publisher = self.create_publisher(Bool, stabilize_topic, 10)
        self.state_publisher = self.create_publisher(String, state_topic, 10)
        self.create_subscription(String, command_plan_topic, self._handle_plan_message, 10)
        self.create_timer(1.0 / max(publish_state_hz, 0.1), self._publish_state_snapshot)

        self.get_logger().info(
            f"DOGZILLA bridge ready. command_plan_topic={command_plan_topic} dry_run={self.dry_run} enabled={self.enabled}"
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
            if kind == "noop":
                self.state.last_status = "noop"
                return

            if kind == "action.once":
                self._handle_action_once(params)
                return

            if kind == "stabilize.set":
                self._handle_stabilize(params)
                return

            if kind == "locomotion.relative":
                self._handle_relative_motion(params)
                return

            if kind == "locomotion.goto":
                self.state.last_status = "goto-request"
                self.get_logger().info(
                    f"Navigation request queued for waypoint={params.get('waypoint')} frame={params.get('frame')}"
                )
                return

            self.state.last_status = "unsupported"
            self.state.last_error = f"unsupported_kind:{kind}"
        except Exception as error:
            self._mark_error(str(error))

    def _handle_action_once(self, params: dict[str, Any]) -> None:
        action_id = params.get("actionId")
        if not isinstance(action_id, int):
            self._mark_error("action.once missing integer actionId")
            return

        self.state.last_status = "action.once"
        if self.dry_run:
          return

        message = UInt16()
        message.data = action_id
        self.action_publisher.publish(message)

    def _handle_stabilize(self, params: dict[str, Any]) -> None:
        enabled = bool(params.get("enabled"))
        self.state.last_status = "stabilize.set"
        if self.dry_run:
          return

        message = Bool()
        message.data = enabled
        self.stabilize_publisher.publish(message)

    def _handle_relative_motion(self, params: dict[str, Any]) -> None:
        self.state.last_status = "locomotion.relative"
        if self.dry_run:
          return

        message = Twist()
        message.linear.x = scale_axis(params.get("x_step"), self.linear_x_full_scale_step, self.deadband)
        message.linear.y = scale_axis(params.get("y_step"), self.linear_y_full_scale_step, self.deadband)
        message.angular.z = scale_axis(params.get("turn_rate"), self.angular_z_full_scale_step, self.deadband)
        self.cmd_vel_publisher.publish(message)

    def _publish_state_snapshot(self) -> None:
        snapshot = {
            "status": self.state.last_status,
            "handledCount": self.state.handled_count,
            "lastCommand": self.state.last_command,
            "lastError": self.state.last_error,
            "dryRun": self.dry_run,
            "enabled": self.enabled,
        }
        message = String()
        message.data = json.dumps(snapshot)
        self.state_publisher.publish(message)

    def _mark_error(self, error_message: str) -> None:
        self.state.last_status = "error"
        self.state.last_error = error_message
        self.get_logger().warning(error_message)


def scale_axis(value: Any, full_scale: float, deadband: float) -> float:
    numeric = float(value or 0.0)

    if abs(numeric) <= deadband:
        return 0.0

    return numeric / max(full_scale, 1.0)


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
