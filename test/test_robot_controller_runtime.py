from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
RUNTIME_DIR = ROOT_DIR / "isaacsim" / "runtime"

if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from robot_controller import create_controller  # noqa: E402


class RobotControllerRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.controller = create_controller()

    def test_waypoint_motion_snapshot_reports_velocity(self):
        result = self.controller.handle_command(
            {
                "action": "robot_controller.goto_waypoint",
                "payload": {
                    "waypointName": "bedroom",
                    "sceneWaypoint": {
                        "position": [0.6, 0.0, 0.0],
                        "yawDegrees": 0.0,
                    },
                },
            }
        )

        self.assertTrue(result["ok"])
        snapshot = self.controller.tick(0.1)

        self.assertEqual(snapshot["status"], "moving_to_waypoint")
        self.assertTrue(snapshot["motion"]["moving"])
        self.assertGreater(snapshot["motion"]["forwardSpeed"], 0.0)

    def test_named_action_interrupts_motion_and_exposes_progress(self):
        self.controller.handle_command(
            {
                "action": "robot_controller.move_base",
                "payload": {
                    "linearX": 0.12,
                    "linearY": 0.0,
                    "angularZ": 10.0,
                    "gait": "walk",
                },
            }
        )

        result = self.controller.handle_command(
            {
                "action": "articulation.play_named_action",
                "payload": {
                    "actionName": "backflip",
                    "actionId": "proxy_backflip_v1",
                    "actionVerified": True,
                    "playMode": "once",
                },
            }
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["action"], "play_named_action")
        first = self.controller.tick(0.25)

        self.assertEqual(first["status"], "playing_action")
        self.assertEqual(first["gait"], "idle")
        self.assertFalse(first["motion"]["moving"])
        self.assertEqual(first["activeAction"]["name"], "backflip")
        self.assertGreater(first["activeAction"]["progress"], 0.0)

        finished = None
        for _ in range(40):
            finished = self.controller.tick(0.05)

        assert finished is not None
        self.assertIsNone(finished["activeAction"])
        self.assertEqual(finished["status"], "idle")


if __name__ == "__main__":
    unittest.main()
