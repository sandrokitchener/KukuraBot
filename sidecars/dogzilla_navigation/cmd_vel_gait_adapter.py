#!/usr/bin/env python3
import argparse
from copy import deepcopy
import json
import os
import threading
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
# Deprecated compatibility defaults. Existing launchers may still pass these
# arguments, but calibration is fixed in nav2_gait_adapter.py and is never
# mutated from the command-forwarding path.
DEFAULT_SPEED_RAMP_INTERVAL = float(os.environ.get("DOGZILLA_NAV2_SPEED_RAMP_INTERVAL", "0.5"))
DEFAULT_SPEED_RAMP_BUFFER = int(os.environ.get("DOGZILLA_NAV2_SPEED_RAMP_BUFFER", "10"))
ZERO_EPSILON = 1e-6


def payload_for_send(payload, *, queued_at, now, stale_stop_sec):
    """Return a safe payload for the current send time.

    A nonzero velocity is useful only while it is fresh. Turning an expired
    command into a stop here prevents a blocked HTTP request from replaying an
    old command after the controller has already moved on.
    """

    if not payload_is_zero(payload) and now - queued_at >= max(float(stale_stop_sec), 0.0):
        return zero_payload(source="ros2:/cmd_vel:expired")
    return deepcopy(payload)


class LatestCommandSender:
    """Send commands on one worker while retaining at most one pending item."""

    def __init__(self, post, *, max_rate_hz, stale_stop_sec):
        self._post = post
        self._min_send_interval = 1.0 / max(float(max_rate_hz), 0.1)
        self._stale_stop_sec = max(float(stale_stop_sec), 0.0)
        self._condition = threading.Condition()
        self._pending = None
        self._startup_zero = None
        self._closing = False
        self._started = False
        self._next_nonzero_send_at = 0.0
        self._thread = threading.Thread(
            target=self._run,
            daemon=True,
            name="cmd-vel-http-sender",
        )

    def start(self, *, initial_payload=None):
        with self._condition:
            if self._started:
                return
            self._started = True
            if initial_payload is not None:
                item = (deepcopy(initial_payload), time.monotonic())
                if payload_is_zero(initial_payload):
                    self._startup_zero = item
                else:
                    self._pending = item
        self._thread.start()

    def submit(self, payload):
        with self._condition:
            if self._closing:
                return False
            self._pending = (deepcopy(payload), time.monotonic())
            self._condition.notify()
        return True

    def close(self, timeout=1.5):
        with self._condition:
            if not self._started:
                return
            if not self._closing:
                self._pending = (
                    zero_payload(source="ros2:/cmd_vel:shutdown"),
                    time.monotonic(),
                )
                self._closing = True
                self._condition.notify()
        self._thread.join(max(float(timeout), 0.0))

    def _run(self):
        while True:
            with self._condition:
                while self._startup_zero is None and self._pending is None:
                    if self._closing:
                        return
                    self._condition.wait()

                is_startup_zero = self._startup_zero is not None
                if is_startup_zero:
                    payload, queued_at = self._startup_zero
                else:
                    payload, queued_at = self._pending
                    self._pending = None

                # Rate-limit nonzero commands without blocking the ROS
                # callback. A newer pending command replaces this one while
                # the worker waits; zero commands always bypass the limiter.
                while not payload_is_zero(payload):
                    delay = self._next_nonzero_send_at - time.monotonic()
                    if delay <= 0:
                        break
                    self._condition.wait(delay)
                    if self._pending is not None:
                        payload, queued_at = self._pending
                        self._pending = None

            safe_payload = payload_for_send(
                payload,
                queued_at=queued_at,
                now=time.monotonic(),
                stale_stop_sec=self._stale_stop_sec,
            )
            is_zero = payload_is_zero(safe_payload)
            try:
                sent = bool(self._post(safe_payload))
            except Exception:
                sent = False

            if is_startup_zero:
                with self._condition:
                    if sent:
                        self._startup_zero = None
                    else:
                        # Startup remains a strict priority gate. A queued Twist
                        # cannot replace this zero while the bridge is unavailable.
                        self._condition.wait(0.05)
                    self._condition.notify()
                continue

            attempted_at = time.monotonic()
            if not is_zero:
                self._next_nonzero_send_at = attempted_at + self._min_send_interval

            if not sent:
                with self._condition:
                    # A newer command may supersede a failed stop while this
                    # HTTP attempt was blocked. Otherwise keep retrying a stop;
                    # one dropped zero must never leave the previous gait
                    # latched indefinitely.
                    if self._pending is None:
                        retry_payload = (
                            safe_payload
                            if is_zero
                            else zero_payload(source="ros2:/cmd_vel:send-failed")
                        )
                        self._pending = (retry_payload, time.monotonic())
                        self._condition.wait(0.05)
                    self._condition.notify()


class CmdVelGaitAdapter(Node):
    def __init__(self, args):
        super().__init__("dogzilla_cmd_vel_gait_adapter")
        self.args = args
        self.last_received_at = 0.0
        self.last_log_at = 0.0
        self.received_nonzero = False
        self.sender = LatestCommandSender(
            self._post,
            max_rate_hz=args.max_rate_hz,
            stale_stop_sec=args.stale_stop_sec,
        )
        self.sender.start(
            initial_payload=zero_payload(source="ros2:/cmd_vel:startup")
        )

        self.subscription = self.create_subscription(Twist, args.input_topic, self._on_twist, 1)
        self.timer = self.create_timer(0.5, self._stop_if_stale)
        self.get_logger().info(
            f"forwarding {args.input_topic} to {args.bridge_url} at <= {args.max_rate_hz:.1f} Hz"
        )

    def _on_twist(self, message):
        now = time.monotonic()
        self.last_received_at = now
        payload = twist_payload(message)
        self.received_nonzero = not payload_is_zero(payload)
        self.sender.submit(payload)

    def _stop_if_stale(self):
        if not self.received_nonzero:
            return
        if self.last_received_at <= 0:
            return
        if time.monotonic() - self.last_received_at < self.args.stale_stop_sec:
            return
        self.received_nonzero = False
        self.sender.submit(zero_payload())

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

    def stop(self):
        self.sender.close()


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


def zero_payload(*, source="ros2:/cmd_vel:stale-stop"):
    return {
        "linear": {"x": 0.0, "y": 0.0, "z": 0.0},
        "angular": {"x": 0.0, "y": 0.0, "z": 0.0},
        "source": source,
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
    parser.add_argument("--speed-ramp-interval", type=float, default=DEFAULT_SPEED_RAMP_INTERVAL, help=argparse.SUPPRESS)
    parser.add_argument("--speed-ramp-buffer", type=int, default=DEFAULT_SPEED_RAMP_BUFFER, help=argparse.SUPPRESS)
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
