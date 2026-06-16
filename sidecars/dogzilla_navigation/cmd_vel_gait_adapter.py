#!/usr/bin/env python3
import argparse
import json
import math
import os
import time
import urllib.error
import urllib.request
from collections import deque

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node


DEFAULT_INPUT_TOPIC = os.environ.get("DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC", "/cmd_vel")
DEFAULT_BRIDGE_URL = os.environ.get("DOGZILLA_NAV2_GAIT_ADAPTER_URL", "http://127.0.0.1:8893/nav2/cmd_vel")
DEFAULT_MAX_RATE_HZ = float(os.environ.get("DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ", "8.0"))
DEFAULT_STALE_STOP_SEC = float(os.environ.get("DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC", "0.45"))
DEFAULT_HTTP_TIMEOUT_SEC = float(os.environ.get("DOGZILLA_NAV2_GAIT_ADAPTER_HTTP_TIMEOUT_SEC", "0.8"))
DEFAULT_SPEED_RAMP_INTERVAL = float(os.environ.get("DOGZILLA_NAV2_SPEED_RAMP_INTERVAL", "0.5"))
DEFAULT_SPEED_RAMP_BUFFER = int(os.environ.get("DOGZILLA_NAV2_SPEED_RAMP_BUFFER", "10"))
ZERO_EPSILON = 1e-6

# Confidence thresholds for speed ramp-up
_CONFIDENCE_LOW = 0.3
_CONFIDENCE_HIGH = 0.7
_LINEAR_FULL_SCALE_MAX = 0.35
_LINEAR_FULL_SCALE_MED = 0.26
_LINEAR_FULL_SCALE_MIN = 0.15
_MAX_EXPECTED_LINEAR = 0.26
_MAX_EXPECTED_ANGULAR = 1.0
_SMOOTHING_FACTOR = 0.3  # exponential smoothing for damping speed transitions


class CmdVelGaitAdapter(Node):
    def __init__(self, args):
        super().__init__("dogzilla_cmd_vel_gait_adapter")
        self.args = args
        self.last_sent_at = 0.0
        self.last_received_at = 0.0
        self.last_log_at = 0.0
        self.sent_nonzero = False
        self.min_send_interval = 1.0 / max(args.max_rate_hz, 0.1)

        # Speed ramp-up state
        self._twist_buffer = deque(maxlen=args.speed_ramp_buffer)
        self._current_linear_scale = _LINEAR_FULL_SCALE_MED
        self._current_allow_trot = False
        self._last_config_update_at = 0.0
        self._last_speed_config_log_at = 0.0
        self._config_url = self._derive_speed_config_url(args.bridge_url)
        self._speed_ramp_enabled = args.speed_ramp_interval > 0
        self._last_ramp_log_at = 0.0

        self.subscription = self.create_subscription(Twist, args.input_topic, self._on_twist, 10)
        self.timer = self.create_timer(0.5, self._stop_if_stale)
        if self._speed_ramp_enabled:
            self._ramp_timer = self.create_timer(args.speed_ramp_interval, self._compute_and_apply_ramp)
        self.get_logger().info(
            f"forwarding {args.input_topic} to {args.bridge_url} at <= {args.max_rate_hz:.1f} Hz"
            + (f"; speed ramp every {args.speed_ramp_interval:.1f}s" if self._speed_ramp_enabled else "")
        )

    def _on_twist(self, message):
        now = time.monotonic()
        self.last_received_at = now
        payload = twist_payload(message)
        is_zero = payload_is_zero(payload)
        if not is_zero and now - self.last_sent_at < self.min_send_interval:
            return

        # Buffer samples for confidence computation
        if self._speed_ramp_enabled and not is_zero:
            self._twist_buffer.append((message.linear.x, message.angular.z, now))

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

    def _compute_and_apply_ramp(self):
        now = time.monotonic()
        if not self._twist_buffer:
            return

        # Compute average linear and angular from recent samples
        valid = self._prune_stale_samples(now)
        if not valid:
            return

        avg_linear = sum(abs(s[0]) for s in valid) / len(valid)
        avg_angular = sum(abs(s[1]) for s in valid) / len(valid)

        # Confidence: 0 (tight/turning) to 1 (open straight)
        linear_ratio = min(avg_linear / _MAX_EXPECTED_LINEAR, 1.0)
        angular_penalty = 1.0 - min(avg_angular / _MAX_EXPECTED_ANGULAR, 0.8)
        confidence = linear_ratio * angular_penalty

        # Determine target speed params
        if confidence > _CONFIDENCE_HIGH:
            target_scale = _LINEAR_FULL_SCALE_MAX
            target_trot = True
        elif confidence > _CONFIDENCE_LOW:
            target_scale = _LINEAR_FULL_SCALE_MED
            target_trot = False
        else:
            target_scale = _LINEAR_FULL_SCALE_MIN
            target_trot = False

        # Smooth transitions to avoid jerky speed changes
        smoothed_scale = self._smooth(self._current_linear_scale, target_scale)
        # Toggle trot only when confidence is consistently above/below threshold
        smoothed_trot = target_trot

        if (abs(smoothed_scale - self._current_linear_scale) < 0.01
                and smoothed_trot == self._current_allow_trot):
            return  # no meaningful change

        self._current_linear_scale = smoothed_scale
        self._current_allow_trot = smoothed_trot

        payload = {
            "linearFullScale": round(smoothed_scale, 3),
            "allowTrot": smoothed_trot,
        }
        if smoothed_trot:
            payload["trotLinear"] = 0.11
            payload["highLinear"] = 0.20

        if self._post_speed_config(payload):
            self._last_config_update_at = now
            if now - self._last_ramp_log_at >= 2.0:
                self.get_logger().info(
                    f"speed ramp: confidence={confidence:.2f} "
                    f"→ linearFullScale={payload['linearFullScale']}, allowTrot={payload['allowTrot']}"
                )
                self._last_ramp_log_at = now

    def _prune_stale_samples(self, now, max_age=2.0):
        fresh = [s for s in self._twist_buffer if now - s[2] < max_age]
        self._twist_buffer.clear()
        self._twist_buffer.extend(fresh)
        return fresh

    def _smooth(self, current, target):
        """Exponential smoothing toward target."""
        return current + (target - current) * _SMOOTHING_FACTOR

    def _derive_speed_config_url(self, bridge_url):
        base = bridge_url.rstrip("/")
        if base.endswith("/cmd_vel"):
            base = base[: -len("/cmd_vel")]
        return base + "/speed_config"

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

    def _post_speed_config(self, payload):
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self._config_url,
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
            if now - self._last_speed_config_log_at >= 5.0:
                self.get_logger().warning(f"speed config update failed: {error}")
                self._last_speed_config_log_at = now
            return False

    def stop(self):
        # Reset speed config to safe defaults on shutdown
        self._post_speed_config({"linearFullScale": _LINEAR_FULL_SCALE_MED, "allowTrot": False})
        self._post(zero_payload())


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
    parser.add_argument("--speed-ramp-interval", type=float, default=DEFAULT_SPEED_RAMP_INTERVAL)
    parser.add_argument("--speed-ramp-buffer", type=int, default=DEFAULT_SPEED_RAMP_BUFFER)
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
