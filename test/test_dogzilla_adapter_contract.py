from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
ROS2_PACKAGE_DIR = ROOT_DIR / "ros2" / "dogzilla_bridge"

if str(ROS2_PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(ROS2_PACKAGE_DIR))

from dogzilla_bridge.adapters import RecordingDogzillaAdapter, YahboomPythonDogzillaAdapter  # noqa: E402
from dogzilla_bridge.commands import CommandValidationError, execute_canonical_plan  # noqa: E402


class DogzillaAdapterContractTests(unittest.TestCase):
    def test_relative_motion_is_clamped_before_adapter_call(self):
        adapter = RecordingDogzillaAdapter()
        result = execute_canonical_plan(
            {
                "kind": "locomotion.relative",
                "params": {
                    "x_step": 99,
                    "y_step": -99,
                    "turn_rate": 999,
                    "gait": "walk",
                    "pace": "high",
                },
            },
            adapter,
        )

        self.assertEqual(result.status, "locomotion.relative")
        params = adapter.calls[0]["params"]
        self.assertEqual(params["x_step"], 25.0)
        self.assertEqual(params["y_step"], -18.0)
        self.assertEqual(params["turn_rate"], 100.0)

    def test_action_once_rejects_unverified_range(self):
        adapter = RecordingDogzillaAdapter()

        with self.assertRaises(CommandValidationError):
            execute_canonical_plan({"kind": "action.once", "params": {"actionId": 99}}, adapter)

    def test_pose_body_is_clamped_before_adapter_call(self):
        adapter = RecordingDogzillaAdapter()
        result = execute_canonical_plan(
            {
                "kind": "pose.body",
                "params": {
                    "bodyX": -99,
                    "bodyY": 99,
                    "height": 200,
                    "roll": 99,
                    "pitch": -99,
                    "yaw": 99,
                },
            },
            adapter,
        )

        self.assertEqual(result.status, "pose.body")
        params = adapter.calls[0]["params"]
        self.assertEqual(params["body_x"], -35.0)
        self.assertEqual(params["body_y"], 18.0)
        self.assertEqual(params["height"], 115.0)
        self.assertEqual(params["roll"], 20.0)
        self.assertEqual(params["pitch"], -15.0)
        self.assertEqual(params["yaw"], 11.0)

    def test_yahboom_python_adapter_maps_documented_calls(self):
        controller = FakeDogzillaController()
        adapter = YahboomPythonDogzillaAdapter(controller)

        motion = adapter.relative_motion(x_step=-4, y_step=3, turn_rate=-10, pace="slow")
        action = adapter.action_once(12)
        stabilize = adapter.set_stabilize(True)
        pose = adapter.body_pose(body_x=1, height=95, pitch=10)

        self.assertEqual(motion.adapter, "yahboom-python")
        self.assertTrue(motion.executed)
        self.assertIn(("pace", ("slow",)), controller.calls)
        self.assertIn(("move", ("x", -4)), controller.calls)
        self.assertIn(("move", ("y", 3)), controller.calls)
        self.assertIn(("turn", (-10,)), controller.calls)
        self.assertIn(("action", (12,)), controller.calls)
        self.assertIn(("imu", (1,)), controller.calls)
        self.assertIn(("translation", ("x", 1)), controller.calls)
        self.assertIn(("translation", ("z", 95)), controller.calls)
        self.assertIn(("attitude", ("p", 10)), controller.calls)
        self.assertEqual(action.calls[0]["operation"], "action")
        self.assertEqual(stabilize.calls[0]["operation"], "imu")
        self.assertEqual(pose.calls[-1]["operation"], "attitude")


class FakeDogzillaController:
    def __init__(self):
        self.calls = []

    def pace(self, *args):
        self.calls.append(("pace", args))

    def move(self, *args):
        self.calls.append(("move", args))

    def turn(self, *args):
        self.calls.append(("turn", args))

    def action(self, *args):
        self.calls.append(("action", args))

    def imu(self, *args):
        self.calls.append(("imu", args))

    def translation(self, *args):
        self.calls.append(("translation", args))

    def attitude(self, *args):
        self.calls.append(("attitude", args))


if __name__ == "__main__":
    unittest.main()
