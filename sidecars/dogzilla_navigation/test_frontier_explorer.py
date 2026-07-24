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


def frontier_grid():
    width = height = 11
    cells = [-1] * (width * height)
    for y in range(2, 9):
        for x in range(2, 9):
            cells[y * width + x] = 0
    return cells, width, height


def active_explorer():
    explorer = frontier_explorer.FrontierExplorer.__new__(
        frontier_explorer.FrontierExplorer
    )
    explorer.args = SimpleNamespace(
        stop_file="missing.stop",
        action_timeout=120.0,
        map_timeout=15.0,
        scan_pause_after=2.0,
        scan_timeout=10.0,
        pose_timeout=20.0,
        rotation_timeout=8.0,
        goal_max_duration=90.0,
        cmd_vel_max_gap=0.5,
        failed_goal_radius=0.5,
        max_goals=80,
        complete_after_no_frontier=1,
    )
    explorer.finished = False
    explorer.pending_finish = None
    explorer.cancel_future = None
    explorer.map_message = object()
    explorer.started_monotonic = 0.0
    explorer.map_received_at = explorer.scan_received_at = 109.0
    explorer.pose_missing_at = 0.0
    explorer.current_goal = {"x": 2.0, "y": 3.0}
    explorer.goal_handle = object()
    explorer.goal_started_at = 100.0
    explorer.goal_last_pose = (0.0, 0.0)
    explorer.goal_displacement = 0.0
    explorer.session_max_goal_displacement = 0.0
    explorer.goal_rotation_dominant_command_sec = 0.0
    explorer.goal_count = 1
    explorer.successful_goal_count = 0
    explorer.failed_goals = []
    explorer.stalled_goals = []
    explorer.no_frontier_cycles = 0
    explorer.status = {}
    explorer._robot_pose = lambda: (0.0, 0.0)
    explorer._write_status = lambda: None
    return explorer


class FrontierExplorerTests(unittest.TestCase):
    def test_selects_nearest_forward_frontier(self):
        cells, width, height = frontier_grid()
        goal = frontier_explorer.select_frontier_goal(
            cells,
            width,
            height,
            resolution=0.1,
            origin_x=0.0,
            origin_y=0.0,
            robot_x=0.55,
            robot_y=0.55,
            robot_yaw=0.0,
            min_distance=0.1,
            max_distance=5.0,
            clearance_cells=0,
        )
        self.assertIsNotNone(goal)
        self.assertGreater(goal["x"], 0.55)
        self.assertLess(goal["distance"], 1.0)

    def test_failed_destination_is_skipped(self):
        cells, width, height = frontier_grid()
        first = frontier_explorer.select_frontier_goal(
            cells,
            width,
            height,
            resolution=0.1,
            origin_x=0.0,
            origin_y=0.0,
            robot_x=0.55,
            robot_y=0.55,
            min_distance=0.1,
            max_distance=5.0,
            clearance_cells=0,
        )
        second = frontier_explorer.select_frontier_goal(
            cells,
            width,
            height,
            resolution=0.1,
            origin_x=0.0,
            origin_y=0.0,
            robot_x=0.55,
            robot_y=0.55,
            min_distance=0.1,
            max_distance=5.0,
            clearance_cells=0,
            excluded_goals=[first],
            exclusion_radius=0.5,
        )
        self.assertIsNotNone(second)
        self.assertGreater(
            math.hypot(second["x"] - first["x"], second["y"] - first["y"]),
            0.5,
        )

    def test_cmd_vel_classification_separates_forward_from_spin(self):
        forward = frontier_explorer.classify_cmd_vel(
            0.13,
            0.0,
            linear_deadband=0.025,
            angular_deadband=0.12,
            linear_full_scale=0.26,
            angular_full_scale=1.0,
            rotation_dominance_ratio=1.25,
        )
        spin = frontier_explorer.classify_cmd_vel(
            0.0,
            0.5,
            linear_deadband=0.025,
            angular_deadband=0.12,
            linear_full_scale=0.26,
            angular_full_scale=1.0,
            rotation_dominance_ratio=1.25,
        )
        self.assertTrue(forward["translating"])
        self.assertFalse(forward["rotationDominant"])
        self.assertFalse(spin["translating"])
        self.assertTrue(spin["rotationDominant"])

    def test_terminal_nav2_success_is_the_only_success_count(self):
        explorer = active_explorer()
        explorer.cancelled_goal_keys = set()
        future = SimpleNamespace(result=lambda: SimpleNamespace(status=4))

        explorer._on_goal_result(future, explorer.current_goal)

        self.assertEqual(explorer.successful_goal_count, 1)
        self.assertEqual(explorer.status["reason"], "frontier goal reached")

    def test_rotation_dominant_timeout_skips_goal(self):
        explorer = active_explorer()
        explorer.goal_rotation_dominant_command_sec = 9.0
        stalls = []
        cancels = []
        explorer._record_goal_stall = lambda goal, reason: stalls.append(reason)
        explorer._cancel_goal = lambda: cancels.append(True)

        with patch.object(frontier_explorer.time, "monotonic", return_value=109.0):
            explorer._tick()

        self.assertIn("rotation-dominant commands", stalls[0])
        self.assertEqual(cancels, [True])

    def test_cartographer_yaw_is_not_a_cancellation_signal(self):
        explorer = active_explorer()
        explorer.goal_total_yaw = 10.0
        explorer.goal_yaw_since_progress = 10.0
        stalls = []
        explorer._record_goal_stall = lambda goal, reason: stalls.append(reason)
        explorer._cancel_goal = lambda: self.fail("yaw alone must not cancel")

        with patch.object(frontier_explorer.time, "monotonic", return_value=109.0):
            explorer._tick()

        self.assertEqual(stalls, [])

    def test_excluded_frontiers_do_not_report_complete_coverage(self):
        explorer = active_explorer()
        explorer.current_goal = None
        explorer.goal_handle = None
        explorer._robot_pose = lambda: (0.0, 0.0)
        explorer._select_goal = lambda pose, include_failures=True: (
            None if include_failures else {"x": 1.0, "y": 0.0}
        )
        finishes = []
        explorer._finish = lambda state, reason: finishes.append((state, reason))

        with patch.object(frontier_explorer.time, "monotonic", return_value=109.0):
            explorer._tick()

        self.assertEqual(
            finishes,
            [("stopped", "reachable frontiers remain only at skipped destinations")],
        )

    def test_zero_success_cannot_report_complete(self):
        explorer = active_explorer()
        explorer.current_goal = None
        explorer.goal_handle = None
        explorer._select_goal = lambda pose, include_failures=True: None
        finishes = []
        explorer._finish = lambda state, reason: finishes.append((state, reason))

        with patch.object(frontier_explorer.time, "monotonic", return_value=109.0):
            explorer._tick()

        self.assertEqual(finishes[0][0], "stopped")

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
            lock_file.write_text('{"pid": 999999, "token": "stale"}', encoding="utf-8")
            replacement = frontier_explorer.acquire_explorer_lock(str(lock_file))
            frontier_explorer.release_explorer_lock(str(lock_file), replacement)

    def test_cancel_acknowledges_terminal_goal(self):
        self.assertTrue(
            frontier_explorer._cancel_acknowledged(
                SimpleNamespace(return_code=0, goals_canceling=[])
            )
        )
        self.assertFalse(
            frontier_explorer._cancel_acknowledged(
                SimpleNamespace(return_code=1, goals_canceling=[])
            )
        )


if __name__ == "__main__":
    unittest.main()
