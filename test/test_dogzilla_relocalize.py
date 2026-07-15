import importlib.util
from pathlib import Path
import sys
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


if __name__ == "__main__":
    unittest.main()
