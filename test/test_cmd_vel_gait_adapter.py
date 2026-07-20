from __future__ import annotations

import importlib.util
import sys
import threading
import time
import types
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT_DIR / "sidecars" / "dogzilla_navigation" / "cmd_vel_gait_adapter.py"


def load_adapter_module():
    rclpy = types.ModuleType("rclpy")
    rclpy_node = types.ModuleType("rclpy.node")
    rclpy_node.Node = object
    geometry_msgs = types.ModuleType("geometry_msgs")
    geometry_msgs_msg = types.ModuleType("geometry_msgs.msg")
    geometry_msgs_msg.Twist = object

    modules = {
        "rclpy": rclpy,
        "rclpy.node": rclpy_node,
        "geometry_msgs": geometry_msgs,
        "geometry_msgs.msg": geometry_msgs_msg,
    }
    previous = {name: sys.modules.get(name) for name in modules}
    sys.modules.update(modules)
    try:
        spec = importlib.util.spec_from_file_location("cmd_vel_gait_adapter", SCRIPT_PATH)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


adapter = load_adapter_module()


def moving_payload(value: float):
    return {
        "linear": {"x": value, "y": 0.0, "z": 0.0},
        "angular": {"x": 0.0, "y": 0.0, "z": 0.0},
        "source": "test",
        "receivedAt": time.time(),
    }


class LatestCommandSenderTests(unittest.TestCase):
    def test_expired_nonzero_payload_becomes_fail_safe_zero(self):
        payload = adapter.payload_for_send(
            moving_payload(0.2),
            queued_at=10.0,
            now=10.6,
            stale_stop_sec=0.45,
        )

        self.assertTrue(adapter.payload_is_zero(payload))
        self.assertEqual(payload["source"], "ros2:/cmd_vel:expired")

    def test_worker_drops_intermediate_backlog_and_sends_latest(self):
        posts = []
        first_started = threading.Event()
        release_first = threading.Event()
        latest_sent = threading.Event()

        def post(payload):
            posts.append(payload)
            if len(posts) == 1:
                first_started.set()
                release_first.wait(1.0)
            if payload.get("linear", {}).get("x") == 0.3:
                latest_sent.set()
            return True

        sender = adapter.LatestCommandSender(
            post,
            max_rate_hz=1000.0,
            stale_stop_sec=1.0,
        )
        sender.start()
        self.addCleanup(sender.close)

        sender.submit(moving_payload(0.1))
        self.assertTrue(first_started.wait(1.0))
        sender.submit(moving_payload(0.2))
        sender.submit(moving_payload(0.3))
        release_first.set()

        self.assertTrue(latest_sent.wait(1.0))
        self.assertEqual([item["linear"]["x"] for item in posts[:2]], [0.1, 0.3])

    def test_failed_nonzero_post_schedules_fail_safe_zero(self):
        posts = []
        zero_sent = threading.Event()

        def post(payload):
            posts.append(payload)
            if adapter.payload_is_zero(payload):
                zero_sent.set()
                return True
            return False

        sender = adapter.LatestCommandSender(
            post,
            max_rate_hz=1000.0,
            stale_stop_sec=1.0,
        )
        sender.start()
        self.addCleanup(sender.close)
        sender.submit(moving_payload(0.2))

        self.assertTrue(zero_sent.wait(1.0))
        self.assertFalse(adapter.payload_is_zero(posts[0]))
        self.assertTrue(adapter.payload_is_zero(posts[1]))

    def test_failed_zero_is_retried_until_success(self):
        posts = []
        retry_succeeded = threading.Event()

        def post(payload):
            posts.append(payload)
            if len(posts) >= 2:
                retry_succeeded.set()
                return True
            return False

        sender = adapter.LatestCommandSender(
            post,
            max_rate_hz=1000.0,
            stale_stop_sec=1.0,
        )
        sender.start()
        self.addCleanup(sender.close)
        sender.submit(adapter.zero_payload())

        self.assertTrue(retry_succeeded.wait(1.0))
        self.assertTrue(all(adapter.payload_is_zero(payload) for payload in posts[:2]))

    def test_startup_safe_zero_is_sent_and_retried(self):
        posts = []
        retry_succeeded = threading.Event()

        def post(payload):
            posts.append(payload)
            if len(posts) >= 2:
                retry_succeeded.set()
                return True
            return False

        sender = adapter.LatestCommandSender(
            post,
            max_rate_hz=1000.0,
            stale_stop_sec=1.0,
        )
        sender.start(initial_payload=adapter.zero_payload(source="ros2:/cmd_vel:startup"))
        self.addCleanup(sender.close)

        self.assertTrue(retry_succeeded.wait(1.0))
        self.assertTrue(all(adapter.payload_is_zero(payload) for payload in posts[:2]))
        self.assertEqual(posts[0]["source"], "ros2:/cmd_vel:startup")

    def test_startup_safe_zero_cannot_be_replaced_by_queued_motion(self):
        posts = []
        first_started = threading.Event()
        release_first = threading.Event()
        motion_sent = threading.Event()

        def post(payload):
            posts.append(payload)
            if len(posts) == 1:
                first_started.set()
                release_first.wait(1.0)
                return False
            if not adapter.payload_is_zero(payload):
                motion_sent.set()
            return True

        sender = adapter.LatestCommandSender(
            post,
            max_rate_hz=1000.0,
            stale_stop_sec=1.0,
        )
        sender.start(initial_payload=adapter.zero_payload(source="ros2:/cmd_vel:startup"))
        self.addCleanup(sender.close)

        self.assertTrue(first_started.wait(1.0))
        sender.submit(moving_payload(0.2))
        release_first.set()

        self.assertTrue(motion_sent.wait(1.0))
        self.assertGreaterEqual(len(posts), 3)
        self.assertTrue(adapter.payload_is_zero(posts[0]))
        self.assertTrue(adapter.payload_is_zero(posts[1]))
        self.assertFalse(adapter.payload_is_zero(posts[2]))
        self.assertEqual(posts[0]["source"], "ros2:/cmd_vel:startup")
        self.assertEqual(posts[1]["source"], "ros2:/cmd_vel:startup")


if __name__ == "__main__":
    unittest.main()
