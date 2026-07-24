import importlib.util
import hashlib
import inspect
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType
import unittest


def load_relocalizer_module():
    stubs = {
        "fcntl": {"LOCK_EX": 0, "LOCK_NB": 0, "flock": lambda *_args: None},
        "rclpy": {},
        "rclpy.node": {"Node": object},
        "cartographer_ros_msgs": {},
        "cartographer_ros_msgs.srv": {
            "FinishTrajectory": object,
            "GetTrajectoryStates": object,
            "StartTrajectory": object,
        },
        "nav2_msgs": {},
        "nav2_msgs.srv": {"ManageLifecycleNodes": object},
        "std_srvs": {},
        "std_srvs.srv": {"Trigger": object},
        "tf2_ros": {"Buffer": object, "TransformListener": object},
    }
    for name, attributes in stubs.items():
        module = ModuleType(name)
        for attribute, value in attributes.items():
            setattr(module, attribute, value)
        sys.modules[name] = module

    path = Path(__file__).parents[1] / "sidecars" / "dogzilla_map_pose" / "relocalize_on_frozen_map.py"
    spec = importlib.util.spec_from_file_location("dogzilla_relocalize_test_target", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RelocalizerTests(unittest.TestCase):
    def test_rejects_stable_global_match_far_from_saved_pose_hint(self):
        module = load_relocalizer_module()
        hint = module.resume_pose_hint(
            {
                "resumePose": {
                    "frame": "map",
                    "x": 4.63,
                    "y": -0.16,
                    "yaw": 0.21,
                    "capturedAt": "2026-07-12T13:19:51Z",
                }
            }
        )

        with self.assertRaisesRegex(module.RecoveryError, "disagrees with the saved map pose hint"):
            module.require_pose_near_hint(
                {"position": {"x": 0.0, "y": 0.02}, "yaw": -0.02},
                hint,
                position_tolerance_m=2.0,
            )

    def test_carried_robot_may_face_a_different_heading_near_saved_pose_hint(self):
        module = load_relocalizer_module()
        hint = module.resume_pose_hint(
            {
                "resumePose": {
                    "frame": "map",
                    "x": 4.63,
                    "y": -0.16,
                    "yaw": 0.21,
                    "capturedAt": "2026-07-12T13:19:51Z",
                }
            }
        )

        module.require_pose_near_hint(
            {"position": {"x": 3.58, "y": -0.16}, "yaw": 1.77},
            hint,
            position_tolerance_m=2.0,
        )

    def test_operator_confirmed_carried_robot_may_relocalize_far_from_pose_hint(self):
        module = load_relocalizer_module()

        module.require_pose_near_hint(
            {"position": {"x": 0.0, "y": 0.02}, "yaw": -0.02},
            {"position": {"x": 4.63, "y": -0.16}, "yaw": 0.21},
            position_tolerance_m=2.0,
            allow_jump=True,
        )

    def test_recovery_handoff_does_not_gate_on_unused_local_odom_pose(self):
        module = load_relocalizer_module()

        source = inspect.getsource(module.Relocalizer.run)

        self.assertNotIn('"odom", "base_link", recovery_started_ns', source)
        self.assertIn('"map",\n                "base_link",', source)

    def test_recovery_process_detection_is_namespace_or_config_based(self):
        module = load_relocalizer_module()

        self.assertTrue(
            module.Relocalizer._is_recovery_process(
                ["cartographer_node", "-configuration_basename", "map_recovery.lua"]
            )
        )
        self.assertTrue(
            module.Relocalizer._is_recovery_process(
                ["cartographer_node", "-r", "__ns:=/robodoge_recovery"]
            )
        )
        self.assertFalse(
            module.Relocalizer._is_recovery_process(
                ["cartographer_node", "-configuration_basename", "map_localization.lua"]
            )
        )

    def test_anchor_selection_prefers_most_matched_frozen_trajectory(self):
        module = load_relocalizer_module()

        selected = module.select_anchor_trajectory(
            [
                {"frozenTrajectoryId": 0, "score": 80.0},
                {"frozenTrajectoryId": 1, "score": 60.0},
                {"frozenTrajectoryId": 1, "score": 65.0},
            ],
            [0, 1],
        )

        self.assertEqual(selected, 1)

    def test_nav2_resume_failure_preserves_verified_localization(self):
        module = load_relocalizer_module()
        relocalizer = module.Relocalizer.__new__(module.Relocalizer)
        relocalizer.paused_nav2 = True
        normal_process = object()
        relocalizer.normal_process = normal_process
        relocalizer._manage_nav2 = lambda _action: (_ for _ in ()).throw(
            module.RecoveryError("resume failed")
        )

        resumed, error = relocalizer._resume_nav2()

        self.assertFalse(resumed)
        self.assertEqual(error, "resume failed")
        self.assertIs(relocalizer.normal_process, normal_process)

    def test_candidate_metadata_can_supply_the_resume_pbstream_without_promotion(self):
        module = load_relocalizer_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pbstream = root / "map.pbstream"
            pbstream.write_bytes(b"verified candidate state")
            metadata = root / "candidate.json"
            metadata.write_text(
                json.dumps(
                    {
                        "id": "candidate_test",
                        "artifacts": {
                            "pbstream": {
                                "path": str(pbstream),
                                "sha256": hashlib.sha256(pbstream.read_bytes()).hexdigest(),
                            }
                        },
                        "resumePose": {
                            "frame": "map",
                            "x": 1.25,
                            "y": -0.5,
                            "yaw": 0.25,
                            "capturedAt": "2026-07-21T16:16:37Z",
                        },
                    }
                ),
                encoding="utf-8",
            )
            relocalizer = module.Relocalizer.__new__(module.Relocalizer)
            relocalizer.args = type("Args", (), {"map_metadata": str(metadata)})()

            selected = relocalizer._active_pbstream()

            self.assertEqual(selected, pbstream.resolve())
            self.assertIsNotNone(relocalizer.resume_pose_hint)


if __name__ == "__main__":
    unittest.main()
