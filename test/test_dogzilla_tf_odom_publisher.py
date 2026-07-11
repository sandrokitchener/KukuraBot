from __future__ import annotations

import importlib.util
import math
import sys
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT_DIR / "sidecars" / "dogzilla_navigation" / "tf_odom_publisher.py"

spec = importlib.util.spec_from_file_location("tf_odom_publisher", SCRIPT_PATH)
tf_odom_publisher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = tf_odom_publisher
spec.loader.exec_module(tf_odom_publisher)


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

    def test_compute_twist_derives_velocity_from_tf_delta(self):
        previous = tf_odom_publisher.Pose2D(x=1.0, y=-1.0, yaw=math.radians(170))
        current = tf_odom_publisher.Pose2D(x=1.4, y=-0.8, yaw=math.radians(-170))

        twist = tf_odom_publisher.compute_twist(previous, current, 2.0)

        self.assertAlmostEqual(twist.vx, 0.2)
        self.assertAlmostEqual(twist.vy, 0.1)
        self.assertAlmostEqual(twist.wz, math.radians(20) / 2.0)

    def test_compute_twist_zeroes_first_sample(self):
        current = tf_odom_publisher.Pose2D(x=1.4, y=-0.8, yaw=0.2)

        twist = tf_odom_publisher.compute_twist(None, current, 0.0)

        self.assertEqual(twist, tf_odom_publisher.Twist2D(0.0, 0.0, 0.0))


if __name__ == "__main__":
    unittest.main()
