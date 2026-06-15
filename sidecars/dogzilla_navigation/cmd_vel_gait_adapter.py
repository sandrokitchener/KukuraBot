#!/usr/bin/env python3
import argparse
import json
import os
import time
import urllib.error
import urllib.request

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node


DEFAULT_INPUT_TOPIC = os.environ.get("DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC", "/cmd_vel")
DEFAULT_BRIDGE_URL = os.environ.get("DOGZILLA_NAV2_GAIT_ADAPTER_URL", "http://127.0.0.1:8893/nav2/cmd_vel")
DEFAULT_MAX_RATE_HZ = float(os.environ.get("DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ", "8.0"))
DEFAULT_STALE_STOP_SEC = float(os.environ.get("DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC", "0.45"))
DEFAULT_HTTP_TIMEOUT_SEC = float(os.environ.get("DOGZILLA_NAV2_GAIT_ADAPTER_HTTP_TIMEOUT_SEC", "0.8"))
ZERO_EPSILON = 1e-6


class CmdVelGaitAdapter(Node):
    def __init__(self, args):
        super().__init__("dogzilla_cmd_vel_gait_adapter")
        self.args = args
        self.last_sent_at = 0.0
        self.last_received_at = 0.0
        self.last_log_at = 0.0
        self.sent_nonzero = False
        self.min_send_interval = 1.0 / max(args.max_rate_hz, 0.1)
        self.subscription = self.create_subscription(Twist, args.input_topic, self._on_twist, 10)
        self.timer = self.create_timer(0.1, self._stop_if_stale)
        self.get_logger().info(
            f"forwarding {args.input_topic} to {args.bridge_url} at <= {args.max_rate_hz:.1f} Hz"
        )

    def _on_twist(self, message):
        now = time.monotonic()
        self.last_received_at = now
        payload = twist_payload(message)
        is_zero = payload_is_zero(payload)
        if not is_zero and now - self.last_sent_at < self.min_send_interval:
            return

        if self._post(payload):
            self.last_sent_at = now
            self.sent_nonzero = not is_zero

    def _stop_if_stale(self):
        if not self.sent_nonzero:
            return
        if self.last_received_at <= 0:
            return
        if time.monotonic() - self.last_received_at < self.args.stale_stop_sec:
            return
        if self._post(zero_payload()):
            self.sent_nonzero = False
            self.last_sent_at = time.monotonic()

    def stop(self):
        self._post(zero_payload())

    def _post(self, payload):
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.args.bridge_url,
            data=data,
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.args.http_timeout_sec) as response:
                response.read()
            return True
        except (OSError, urllib.error.URLError) as error:
            now = time.monotonic()
            if now - self.last_log_at >= 1.0:
                self.get_logger().warning(f"cmd_vel bridge post failed: {error}")
                self.last_log_at = now
            return False


def twist_payload(message):
    return {
        "linear": {
            "x": float(message.linear.x),
            "y": float(message.linear.y),
            "z": float(message.linear.z),
        },
        "angular": {
            "x": float(message.angular.x),
            "y": float(message.angular.y),
            "z": float(message.angular.z),
        },
        "source": "ros2:/cmd_vel",
        "receivedAt": time.time(),
    }


def zero_payload():
    return {
        "linear": {"x": 0.0, "y": 0.0, "z": 0.0},
        "angular": {"x": 0.0, "y": 0.0, "z": 0.0},
        "source": "ros2:/cmd_vel:stale-stop",
        "receivedAt": time.time(),
    }


def payload_is_zero(payload):
    linear = payload.get("linear", {})
    angular = payload.get("angular", {})
    return (
        abs(float(linear.get("x", 0.0))) <= ZERO_EPSILON
        and abs(float(linear.get("y", 0.0))) <= ZERO_EPSILON
        and abs(float(angular.get("z", 0.0))) <= ZERO_EPSILON
    )


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Forward Nav2 /cmd_vel into DOGZILLA gait commands.")
    parser.add_argument("--input-topic", default=DEFAULT_INPUT_TOPIC)
    parser.add_argument("--bridge-url", default=DEFAULT_BRIDGE_URL)
    parser.add_argument("--max-rate-hz", type=float, default=DEFAULT_MAX_RATE_HZ)
    parser.add_argument("--stale-stop-sec", type=float, default=DEFAULT_STALE_STOP_SEC)
    parser.add_argument("--http-timeout-sec", type=float, default=DEFAULT_HTTP_TIMEOUT_SEC)
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    rclpy.init()
    node = CmdVelGaitAdapter(args)
    try:
        rclpy.spin(node)
    finally:
        node.stop()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
