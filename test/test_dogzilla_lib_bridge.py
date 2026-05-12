from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
BRIDGE_DIR = ROOT_DIR / "sidecars" / "dogzilla_lib_bridge"

if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

import server as dogzilla_lib_bridge  # noqa: E402


class DogzillaLibBridgeTests(unittest.TestCase):
    def test_state_read_aliases_accept_study_page_method_names(self):
        fake = FakeRobot()

        self.assertEqual(dogzilla_lib_bridge.call_first(fake, ["read_Battery", "read_battery"]), 87)
        self.assertEqual(dogzilla_lib_bridge.call_first(fake, ["read_Motor", "read_motor"]), [1, 2, 3])

    def test_preflight_reports_study_page_ros_domain(self):
        checks = dogzilla_lib_bridge.build_preflight_checks()

        self.assertTrue(any("ROS_DOMAIN_ID=16" in check.get("expect", "") for check in checks))
        self.assertTrue(any(check.get("command") == "./run_humble.sh" for check in checks))


class FakeRobot:
    def read_Battery(self):
        return 87

    def read_Motor(self):
        return [1, 2, 3]


if __name__ == "__main__":
    unittest.main()
