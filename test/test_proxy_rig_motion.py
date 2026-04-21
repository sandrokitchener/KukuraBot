from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
RUNTIME_DIR = ROOT_DIR / "isaacsim" / "runtime"

if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from proxy_rig_motion import ProxyRigMotionSolver  # noqa: E402


class ProxyRigMotionSolverTests(unittest.TestCase):
    def setUp(self):
        walk_config = json.loads((ROOT_DIR / "config" / "dogzilla-proxy-walk-cycle.json").read_text(encoding="utf-8"))
        joint_limits = json.loads((ROOT_DIR / "config" / "dogzilla-proxy-joint-limits.json").read_text(encoding="utf-8"))
        self.solver = ProxyRigMotionSolver(walk_config=walk_config, joint_limits=joint_limits)

    def test_idle_pose_matches_default_joint_ranges(self):
        pose = self.solver.evaluate(
            {
                "status": "idle",
                "gait": "idle",
                "bodyPose": {
                    "height_offset": 0.0,
                    "roll_degrees": 0.0,
                    "pitch_degrees": 0.0,
                },
                "motion": {
                    "moving": False,
                    "speed": 0.0,
                    "forwardSpeed": 0.0,
                    "lateralSpeed": 0.0,
                    "angularSpeed": 0.0,
                },
                "activeAction": None,
            },
            1.0 / 60.0,
        )

        self.assertAlmostEqual(pose["body"]["rollDegrees"], 0.0, delta=0.75)
        self.assertAlmostEqual(pose["body"]["pitchDegrees"], 0.0, delta=0.75)
        self.assertIn("front_left", pose["legs"])
        self.assertIn("rear_right", pose["legs"])

    def test_walk_pose_lifts_a_foot_and_stays_inside_limits(self):
        self.solver.phase = 0.18
        pose = self.solver.evaluate(
            {
                "status": "moving_to_waypoint",
                "gait": "walk",
                "bodyPose": {
                    "height_offset": 0.0,
                    "roll_degrees": 0.0,
                    "pitch_degrees": 0.0,
                },
                "motion": {
                    "moving": True,
                    "speed": 0.12,
                    "forwardSpeed": 0.12,
                    "lateralSpeed": 0.0,
                    "angularSpeed": 0.0,
                },
                "activeAction": None,
            },
            1.0 / 24.0,
        )

        front_left = pose["legs"]["front_left"]
        self.assertGreater(front_left["lower"], 20.0)
        self.assertLessEqual(abs(pose["body"]["pitchDegrees"]), 10.0)

        for leg_pose in pose["legs"].values():
            self.assertGreaterEqual(leg_pose["hip"], -25.0)
            self.assertLessEqual(leg_pose["hip"], 25.0)
            self.assertGreaterEqual(leg_pose["upper"], -45.0)
            self.assertLessEqual(leg_pose["upper"], 45.0)
            self.assertGreaterEqual(leg_pose["lower"], -70.0)
            self.assertLessEqual(leg_pose["lower"], 70.0)

    def test_backflip_pose_rotates_body_and_tucks_legs(self):
        pose = self.solver.evaluate(
            {
                "status": "playing_action",
                "gait": "idle",
                "bodyPose": {
                    "height_offset": 0.0,
                    "roll_degrees": 0.0,
                    "pitch_degrees": 0.0,
                },
                "motion": {
                    "moving": False,
                    "speed": 0.0,
                    "forwardSpeed": 0.0,
                    "lateralSpeed": 0.0,
                    "angularSpeed": 0.0,
                },
                "activeAction": {
                    "name": "backflip",
                    "progress": 0.52,
                },
            },
            1.0 / 60.0,
        )

        self.assertGreater(abs(pose["body"]["pitchDegrees"]), 150.0)
        self.assertGreater(pose["body"]["heightOffset"], 0.02)
        self.assertLess(pose["legs"]["front_left"]["upper"], -5.0)


if __name__ == "__main__":
    unittest.main()
