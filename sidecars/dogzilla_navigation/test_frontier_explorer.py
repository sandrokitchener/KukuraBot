import importlib.util
import math
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("frontier_explorer.py")
SPEC = importlib.util.spec_from_file_location("frontier_explorer", MODULE_PATH)
frontier_explorer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(frontier_explorer)


def lidar_scan(default=2.0):
    return [default] * 360, -math.pi, math.radians(1)


def command_for(ranges, angle_min, angle_increment, **overrides):
    values = {
        "angle_min": angle_min,
        "angle_increment": angle_increment,
        "range_min": 0.05,
        "range_max": 8.0,
        "turning": 0,
        "stop_distance": 0.45,
        "clear_distance": 0.65,
        "forward_speed": 0.18,
        "turn_speed": 0.45,
    }
    values.update(overrides)
    return frontier_explorer.choose_reactive_command(ranges, **values)


def active_explorer():
    explorer = frontier_explorer.FrontierExplorer.__new__(
        frontier_explorer.FrontierExplorer
    )
    explorer.args = SimpleNamespace(
        stop_file="missing.stop",
        startup_timeout=120.0,
        map_timeout=15.0,
        scan_pause_after=2.0,
        scan_timeout=120.0,
        pose_timeout=20.0,
        no_growth_timeout=60.0,
        max_session_duration=900.0,
        stop_distance=0.45,
        clear_distance=0.65,
        forward_speed=0.18,
        turn_speed=0.45,
        rotation_timeout=8.0,
    )
    ranges, angle_min, angle_increment = lidar_scan()
    for degrees in range(-25, 26):
        ranges[degrees + 180] = 0.3
    explorer.map_message = object()
    explorer.scan_message = SimpleNamespace(
        ranges=ranges,
        angle_min=angle_min,
        angle_increment=angle_increment,
        range_min=0.05,
        range_max=8.0,
    )
    explorer.started_at = 0.0
    explorer.map_received_at = explorer.scan_received_at = 109.0
    explorer.pose_missing_at = 0.0
    explorer.last_map_growth_at = 109.0
    explorer.initial_pose = None
    explorer.session_max_goal_displacement = 0.0
    explorer.session_translation_command_sec = 0.0
    explorer.last_command = {}
    explorer.turn_direction = 1
    explorer.turn_started_at = 100.0
    explorer.turn_retries = 0
    explorer.turn_count = 1
    explorer.last_status_write_at = 109.0
    explorer.finished = False
    explorer.status = {}
    explorer._robot_pose = lambda: (0.0, 0.0)
    explorer._publish = lambda linear_x, angular_z: None
    explorer._stop = lambda: None
    explorer._write_status = lambda: None
    return explorer


class ReactiveMapperTests(unittest.TestCase):
    def test_drives_forward_when_front_is_clear(self):
        ranges, angle_min, angle_increment = lidar_scan()

        command = command_for(ranges, angle_min, angle_increment)

        self.assertEqual(command["turning"], 0)
        self.assertEqual(command["linearX"], 0.18)
        self.assertEqual(command["angularZ"], 0.0)

    def test_wall_turns_toward_more_open_side(self):
        ranges, angle_min, angle_increment = lidar_scan()
        for degrees in range(-25, 26):
            ranges[degrees + 180] = 0.3
        for degrees in range(-110, -29):
            ranges[degrees + 180] = 0.55

        command = command_for(ranges, angle_min, angle_increment)

        self.assertEqual(command["linearX"], 0.0)
        self.assertEqual(command["turning"], 1)
        self.assertGreater(command["angularZ"], 0.0)

    def test_turn_continues_until_front_is_clear(self):
        ranges, angle_min, angle_increment = lidar_scan(default=0.5)

        command = command_for(
            ranges,
            angle_min,
            angle_increment,
            turning=-1,
        )

        self.assertEqual(command["turning"], -1)
        self.assertLess(command["angularZ"], 0.0)

    def test_unusable_scan_fails_closed(self):
        ranges, angle_min, angle_increment = lidar_scan(default=math.nan)

        command = command_for(ranges, angle_min, angle_increment)

        self.assertEqual(command["linearX"], 0.0)
        self.assertEqual(command["angularZ"], 0.0)
        self.assertEqual(command["reason"], "scan unavailable")

    def test_known_cell_count_ignores_unknown_cells(self):
        self.assertEqual(
            frontier_explorer._known_cell_count([-1, -1, 0, 50, 100]),
            3,
        )

    def test_displacement_tracks_net_motion_from_start(self):
        explorer = active_explorer()
        for pose in ((0.0, 0.0), (0.036, 0.0), (0.072, 0.0), (0.01, 0.0)):
            explorer._update_displacement(pose)
        self.assertAlmostEqual(explorer.session_max_goal_displacement, 0.072)

    def test_turn_timeout_tries_opposite_once_then_stops(self):
        explorer = active_explorer()

        with patch.object(
            frontier_explorer.time,
            "monotonic",
            return_value=109.0,
        ):
            explorer._tick()
        self.assertEqual(explorer.turn_direction, -1)
        self.assertEqual(explorer.turn_retries, 1)

        explorer.scan_received_at = 118.0
        with patch.object(
            frontier_explorer.time,
            "monotonic",
            return_value=118.0,
        ):
            explorer._tick()
        self.assertTrue(explorer.finished)
        self.assertEqual(explorer.status["reason"], "no clear turn direction")

    def test_cmd_vel_classification_separates_forward_from_spin(self):
        settings = {
            "linear_deadband": 0.025,
            "angular_deadband": 0.12,
            "linear_full_scale": 0.26,
            "angular_full_scale": 1.0,
            "rotation_dominance_ratio": 1.25,
        }
        forward = frontier_explorer.classify_cmd_vel(0.13, 0.0, **settings)
        spin = frontier_explorer.classify_cmd_vel(0.0, 0.5, **settings)

        self.assertTrue(forward["translating"])
        self.assertFalse(forward["rotationDominant"])
        self.assertFalse(spin["translating"])
        self.assertTrue(spin["rotationDominant"])

    def test_lock_is_exclusive_and_replaces_stale_owner(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            frontier_explorer,
            "_process_is_running",
            side_effect=lambda pid: pid != 999999,
        ):
            lock_file = Path(directory) / "explorer.lock"
            token = frontier_explorer.acquire_explorer_lock(str(lock_file))
            with self.assertRaises(RuntimeError):
                frontier_explorer.acquire_explorer_lock(str(lock_file))
            frontier_explorer.release_explorer_lock(str(lock_file), token)
            lock_file.write_text(
                '{"pid": 999999, "token": "stale"}',
                encoding="utf-8",
            )
            replacement = frontier_explorer.acquire_explorer_lock(
                str(lock_file)
            )
            frontier_explorer.release_explorer_lock(lock_file, replacement)


if __name__ == "__main__":
    unittest.main()
