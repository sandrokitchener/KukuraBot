from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
RUNTIME_DIR = ROOT_DIR / "isaacsim" / "runtime"

if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from runtime_feedback import IsaacRuntimeFeedbackStore  # noqa: E402


class IsaacRuntimeFeedbackStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.feedback_path = Path(self.temp_dir.name) / "runtime_feedback.json"
        self.store = IsaacRuntimeFeedbackStore(self.feedback_path, write_interval_seconds=60.0)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_goto_waypoint_emits_arrival_event_on_idle_transition(self):
        self.store.record_command(
            "cmd-0001",
            {
                "action": "robot_controller.goto_waypoint",
                "payload": {
                    "waypointName": "bedroom",
                },
            },
        )

        event = self.store.record_snapshot(
            {
                "status": "moving_to_waypoint",
                "targetWaypoint": "bedroom",
                "basePose": {
                    "x": 0.4,
                    "y": 0.0,
                    "yaw_degrees": 0.0,
                },
            }
        )
        self.assertIsNone(event)

        event = self.store.record_snapshot(
            {
                "status": "idle",
                "targetWaypoint": "",
                "basePose": {
                    "x": 1.35,
                    "y": 1.25,
                    "yaw_degrees": 180.0,
                },
            }
        )

        self.assertIsNotNone(event)
        self.assertEqual(event["eventId"], "cmd-0001:arrived")
        self.assertEqual(event["waypoint"], "bedroom")
        self.assertEqual(event["message"], "Arrived at bedroom.")

        persisted = json.loads(self.feedback_path.read_text(encoding="utf-8"))
        self.assertIsNone(persisted["activeCommand"])
        self.assertEqual(persisted["lastEvent"]["eventId"], "cmd-0001:arrived")

    def test_non_navigation_command_does_not_emit_arrival_event(self):
        self.store.record_command(
            "cmd-0002",
            {
                "action": "articulation.play_named_action",
                "payload": {
                    "actionName": "backflip",
                },
            },
        )

        event = self.store.record_snapshot(
            {
                "status": "idle",
                "targetWaypoint": "",
                "basePose": {
                    "x": 0.0,
                    "y": 0.0,
                    "yaw_degrees": 0.0,
                },
            }
        )

        self.assertIsNone(event)
        persisted = json.loads(self.feedback_path.read_text(encoding="utf-8"))
        self.assertIsNone(persisted["lastEvent"])


if __name__ == "__main__":
    unittest.main()
