from __future__ import annotations

import importlib.util
import math
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch


ROOT_DIR = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT_DIR / "sidecars" / "dogzilla_navigation" / "tf_odom_publisher.py"

spec = importlib.util.spec_from_file_location("tf_odom_publisher", SCRIPT_PATH)
tf_odom_publisher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = tf_odom_publisher
spec.loader.exec_module(tf_odom_publisher)


def _vector3(x: float = 0.0, y: float = 0.0, z: float = 0.0) -> SimpleNamespace:
    return SimpleNamespace(x=x, y=y, z=z)


def _quaternion(yaw: float = 0.0) -> SimpleNamespace:
    return SimpleNamespace(
        x=0.0,
        y=0.0,
        z=math.sin(yaw / 2.0),
        w=math.cos(yaw / 2.0),
    )


class _TransformStamped:
    def __init__(self) -> None:
        self.header = SimpleNamespace(stamp=None, frame_id="")
        self.child_frame_id = ""
        self.transform = SimpleNamespace(translation=_vector3(), rotation=_quaternion())


class _Odometry:
    def __init__(self) -> None:
        self.header = SimpleNamespace(stamp=None, frame_id="")
        self.child_frame_id = ""
        self.pose = SimpleNamespace(
            pose=SimpleNamespace(position=_vector3(), orientation=_quaternion())
        )
        self.twist = SimpleNamespace(
            twist=SimpleNamespace(linear=_vector3(), angular=_vector3())
        )


def _run_main_with_fake_ros(argv: list[str], on_spin) -> dict:
    """Exercise the nested ROS node with deterministic in-process fakes."""

    state = {
        "lookup_calls": [],
        "published_tf": [],
        "publishers_info": [],
        "transforms": {},
    }

    class FakePublisher:
        def __init__(self) -> None:
            self.messages = []

        def publish(self, message) -> None:
            self.messages.append(message)

    class FakeLogger:
        def info(self, *_args, **_kwargs) -> None:
            pass

        def warn(self, *_args, **_kwargs) -> None:
            pass

    class FakeNow:
        nanoseconds = 100_000_000_000

        def to_msg(self) -> SimpleNamespace:
            return SimpleNamespace(sec=100, nanosec=0)

    class FakeNode:
        def __init__(self, _name: str) -> None:
            self._clock = SimpleNamespace(now=FakeNow)
            self._logger = FakeLogger()

        def create_publisher(self, *_args, **_kwargs) -> FakePublisher:
            return FakePublisher()

        def create_timer(self, *_args, **_kwargs) -> object:
            return object()

        def destroy_node(self) -> None:
            pass

        def get_clock(self):
            return self._clock

        def get_logger(self) -> FakeLogger:
            return self._logger

        def get_publishers_info_by_topic(self, _topic: str):
            return state["publishers_info"]

    class FakeBuffer:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def lookup_transform(self, source_frame: str, base_frame: str, _time):
            state["lookup_calls"].append((source_frame, base_frame))
            pose = state["transforms"].get(source_frame)
            if pose is None:
                raise RuntimeError(f"missing transform {source_frame}->{base_frame}")
            transform = _TransformStamped()
            transform.transform.translation = _vector3(pose.x, pose.y, 0.0)
            transform.transform.rotation = _quaternion(pose.yaw)
            return transform

    class FakeBroadcaster:
        def __init__(self, _node) -> None:
            pass

        def sendTransform(self, transform) -> None:
            state["published_tf"].append(transform)

    rclpy = ModuleType("rclpy")
    rclpy.init = lambda: None
    rclpy.ok = lambda: False
    rclpy.shutdown = lambda: None
    rclpy.spin = lambda node: on_spin(node, state)
    rclpy.time = SimpleNamespace(Time=object)

    rclpy_duration = ModuleType("rclpy.duration")
    rclpy_duration.Duration = lambda **kwargs: kwargs
    rclpy_node = ModuleType("rclpy.node")
    rclpy_node.Node = FakeNode
    geometry_msgs = ModuleType("geometry_msgs")
    geometry_msgs_msg = ModuleType("geometry_msgs.msg")
    geometry_msgs_msg.TransformStamped = _TransformStamped
    nav_msgs = ModuleType("nav_msgs")
    nav_msgs_msg = ModuleType("nav_msgs.msg")
    nav_msgs_msg.Odometry = _Odometry
    tf2_ros = ModuleType("tf2_ros")
    tf2_ros.Buffer = FakeBuffer
    tf2_ros.TransformBroadcaster = FakeBroadcaster
    tf2_ros.TransformListener = lambda *_args, **_kwargs: object()

    modules = {
        "geometry_msgs": geometry_msgs,
        "geometry_msgs.msg": geometry_msgs_msg,
        "nav_msgs": nav_msgs,
        "nav_msgs.msg": nav_msgs_msg,
        "rclpy": rclpy,
        "rclpy.duration": rclpy_duration,
        "rclpy.node": rclpy_node,
        "tf2_ros": tf2_ros,
    }
    with patch.dict(sys.modules, modules):
        tf_odom_publisher.main(argv)
    return state


class TfOdomPublisherMathTests(unittest.TestCase):
    def test_lookup_loop_catches_runtime_tf_exceptions(self):
        source = SCRIPT_PATH.read_text(encoding="utf-8")

        self.assertIn("except Exception as error:", source)

    def test_yaw_from_quaternion_reads_planar_rotation(self):
        yaw = math.radians(90)

        result = tf_odom_publisher.yaw_from_quaternion(
            0.0,
            0.0,
            math.sin(yaw / 2.0),
            math.cos(yaw / 2.0),
        )

        self.assertAlmostEqual(result, yaw)

    def test_compute_twist_rotates_parent_frame_delta_into_base_link(self):
        previous = tf_odom_publisher.Pose2D(x=1.0, y=-1.0, yaw=math.radians(90))
        current = tf_odom_publisher.Pose2D(x=1.0, y=-0.6, yaw=math.radians(90))

        twist = tf_odom_publisher.compute_twist(previous, current, 2.0)

        self.assertAlmostEqual(twist.vx, 0.2)
        self.assertAlmostEqual(twist.vy, 0.0)
        self.assertAlmostEqual(twist.wz, 0.0)

    def test_compute_twist_wraps_yaw_delta(self):
        previous = tf_odom_publisher.Pose2D(x=1.0, y=-1.0, yaw=math.radians(170))
        current = tf_odom_publisher.Pose2D(x=1.0, y=-1.0, yaw=math.radians(-170))

        twist = tf_odom_publisher.compute_twist(previous, current, 2.0)

        self.assertAlmostEqual(twist.wz, math.radians(20) / 2.0)

    def test_compute_twist_zeroes_first_sample(self):
        current = tf_odom_publisher.Pose2D(x=1.4, y=-0.8, yaw=0.2)

        twist = tf_odom_publisher.compute_twist(None, current, 0.0)

        self.assertEqual(twist, tf_odom_publisher.Twist2D(0.0, 0.0, 0.0))

    def test_synthetic_fallback_does_not_consume_its_own_odom_transform(self):
        self.assertEqual(
            tf_odom_publisher.source_frame_candidates(
                "odom",
                "map",
                synthetic_fallback_active=True,
            ),
            ("map",),
        )

    def test_real_odom_is_the_only_lookup_before_explicit_fallback_is_active(self):
        self.assertEqual(
            tf_odom_publisher.source_frame_candidates(
                "odom",
                "map",
                synthetic_fallback_active=False,
            ),
            ("odom",),
        )

    def test_fallback_waits_for_grace_then_activates_at_deadline(self):
        authority = tf_odom_publisher.FallbackAuthority(fallback_after_sec=5.0, started_at=10.0)

        self.assertEqual(authority.update(14.9, real_transform_available=False, real_authority_present=False), "wait")
        self.assertEqual(authority.update(15.0, real_transform_available=False, real_authority_present=False), "fallback")
        self.assertTrue(authority.synthetic_active)

    def test_late_real_authority_retires_synthetic_fallback_one_way(self):
        authority = tf_odom_publisher.FallbackAuthority(
            fallback_after_sec=5.0,
            started_at=10.0,
            synthetic_active=True,
        )

        self.assertEqual(authority.update(16.0, real_transform_available=False, real_authority_present=True), "handoff")
        self.assertFalse(authority.synthetic_active)
        self.assertTrue(authority.retired)
        self.assertEqual(authority.update(30.0, real_transform_available=False, real_authority_present=False), "wait")

    def test_real_transform_wins_before_fallback_grace(self):
        authority = tf_odom_publisher.FallbackAuthority(fallback_after_sec=5.0, started_at=10.0)

        self.assertEqual(authority.update(11.0, real_transform_available=True, real_authority_present=False), "real")
        self.assertFalse(authority.synthetic_active)

    def test_real_authority_prevents_synthetic_fallback_from_starting(self):
        authority = tf_odom_publisher.FallbackAuthority(fallback_after_sec=1.0, started_at=0.0)

        self.assertEqual(authority.update(2.0, real_transform_available=False, real_authority_present=True), "wait")
        self.assertFalse(authority.synthetic_active)

    def test_disabled_fallback_never_claims_odom_authority(self):
        authority = tf_odom_publisher.FallbackAuthority(fallback_after_sec=0.0, started_at=0.0)

        self.assertEqual(authority.update(100.0, real_transform_available=False, real_authority_present=False), "wait")
        self.assertFalse(authority.synthetic_active)

    def test_production_defaults_only_consume_real_odom(self):
        def on_spin(node, state) -> None:
            state["transforms"]["odom"] = tf_odom_publisher.Pose2D(1.0, 2.0, 0.25)

            node.publish_odom()

            self.assertEqual(node.fallback_authority.fallback_after_sec, 0.0)
            self.assertFalse(node.fallback_authority.synthetic_active)
            self.assertEqual(state["lookup_calls"], [("odom", "base_link")])
            self.assertEqual(state["published_tf"], [])

        _run_main_with_fake_ros([], on_spin)

    def test_late_authority_handoff_resets_history_and_zeroes_first_real_twist(self):
        def on_spin(node, state) -> None:
            node.fallback_authority.synthetic_active = True
            node.fallback_origin = tf_odom_publisher.Pose2D(10.0, 20.0, 1.0)
            node.previous_pose = tf_odom_publisher.Pose2D(50.0, 60.0, 2.0)
            node.previous_time_sec = 1.0
            node.previous_source_frame = "map"
            state["publishers_info"] = [SimpleNamespace(node_name="/cartographer_node")]
            state["transforms"]["odom"] = tf_odom_publisher.Pose2D(-100.0, 200.0, -2.5)

            node.publish_odom()

            self.assertTrue(node.fallback_authority.retired)
            self.assertIsNone(node.fallback_origin)
            self.assertIsNone(node.previous_pose)
            self.assertIsNone(node.previous_time_sec)
            self.assertIsNone(node.previous_source_frame)
            self.assertEqual(node.publisher.messages, [])
            self.assertEqual(state["lookup_calls"], [])

            node.publish_odom()

            message = node.publisher.messages[-1]
            self.assertEqual(message.twist.twist.linear.x, 0.0)
            self.assertEqual(message.twist.twist.linear.y, 0.0)
            self.assertEqual(message.twist.twist.angular.z, 0.0)
            self.assertEqual(node.previous_source_frame, "odom")
            self.assertEqual(state["lookup_calls"], [("odom", "base_link")])
            self.assertEqual(state["published_tf"], [])

        _run_main_with_fake_ros(
            ["--fallback-source-frame", "map", "--synthetic-fallback-after-sec", "1.0"],
            on_spin,
        )


if __name__ == "__main__":
    unittest.main()
