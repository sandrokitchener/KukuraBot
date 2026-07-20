import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("frontier_explorer.py")
SPEC = importlib.util.spec_from_file_location("frontier_explorer", MODULE_PATH)
frontier_explorer = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(frontier_explorer)


class FrontierSelectionTest(unittest.TestCase):
    def test_clearance_allows_unknown_beside_a_free_frontier(self):
        width = height = 7
        cells = [-1] * (width * height)
        for y in range(2, 5):
            for x in range(2, 5):
                cells[y * width + x] = 0

        self.assertTrue(frontier_explorer._has_clearance(cells, width, height, 2, 3, 1))

    def test_selects_reachable_free_frontier(self):
        width = height = 9
        cells = [-1] * (width * height)
        for y in range(2, 7):
            for x in range(2, 7):
                cells[y * width + x] = 0

        goal = frontier_explorer.select_frontier_goal(
            cells,
            width,
            height,
            resolution=0.1,
            origin_x=0.0,
            origin_y=0.0,
            robot_x=0.4,
            robot_y=0.4,
            min_distance=0.1,
            max_distance=1.0,
            clearance_cells=0,
        )

        self.assertIsNotNone(goal)
        self.assertEqual(cells[goal["cellY"] * width + goal["cellX"]], 0)
        self.assertGreater(goal["distance"], 0.1)

    def test_prefers_nearest_safe_frontier(self):
        width = height = 11
        cells = [-1] * (width * height)
        for y in range(2, 9):
            for x in range(2, 9):
                cells[y * width + x] = 0

        goal = frontier_explorer.select_frontier_goal(
            cells,
            width,
            height,
            resolution=0.1,
            origin_x=0.0,
            origin_y=0.0,
            robot_x=0.5,
            robot_y=0.5,
            min_distance=0.1,
            max_distance=1.0,
            clearance_cells=0,
        )

        self.assertIsNotNone(goal)
        self.assertLess(goal["distance"], 0.5)

    def test_skips_failed_frontier_and_selects_another_region(self):
        width = height = 11
        cells = [-1] * (width * height)
        for y in range(2, 9):
            for x in range(2, 9):
                cells[y * width + x] = 0

        first = frontier_explorer.select_frontier_goal(
            cells, width, height,
            resolution=0.1, origin_x=0.0, origin_y=0.0,
            robot_x=0.5, robot_y=0.5,
            min_distance=0.1, max_distance=1.0, clearance_cells=0,
        )
        second = frontier_explorer.select_frontier_goal(
            cells, width, height,
            resolution=0.1, origin_x=0.0, origin_y=0.0,
            robot_x=0.5, robot_y=0.5,
            min_distance=0.1, max_distance=1.0, clearance_cells=0,
            excluded_goals=[{"x": first["x"], "y": first["y"]}],
            exclusion_radius=0.3,
        )

        self.assertIsNotNone(second)
        self.assertGreaterEqual(
            frontier_explorer.math.hypot(second["x"] - first["x"], second["y"] - first["y"]),
            0.3,
        )

    def test_rejects_unknown_and_unreachable_regions(self):
        width = height = 9
        cells = [-1] * (width * height)
        cells[4 * width + 4] = 0

        goal = frontier_explorer.select_frontier_goal(
            cells,
            width,
            height,
            resolution=0.1,
            origin_x=0.0,
            origin_y=0.0,
            robot_x=0.4,
            robot_y=0.4,
            min_distance=0.1,
            max_distance=1.0,
            clearance_cells=1,
        )

        self.assertIsNone(goal)


class FrontierJobSafetyTest(unittest.TestCase):
    def test_sideways_motion_does_not_reset_goal_progress_timeout(self):
        explorer = frontier_explorer.FrontierExplorer.__new__(frontier_explorer.FrontierExplorer)
        explorer.args = SimpleNamespace(stop_file="missing.stop", map_timeout=8.0, scan_timeout=3.0, max_failures=6,
                                        pose_timeout=20.0, goal_max_duration=300.0, goal_timeout=45.0,
                                        goal_progress_distance=0.5)
        explorer.finished = False
        explorer.pending_finish = None
        explorer.cancel_future = None
        explorer.cancellation_failed = False
        explorer.map_message = object()
        explorer.map_received_at = explorer.scan_received_at = 146.0
        explorer.failures = 0
        explorer.current_goal = {"x": 10.0, "y": 0.0}
        explorer.stalled_goals = []
        explorer.goal_handle = object()
        explorer.goal_started_at = explorer.goal_progress_at = 100.0
        explorer.goal_best_distance = 10.0
        explorer.goal_last_pose = (0.0, 0.0)
        explorer.goal_displacement = 0.0
        explorer.pose_missing_at = 0.0
        explorer.status = {}
        explorer._robot_pose = lambda: (0.0, 0.1)
        explorer._write_status = lambda: None
        stalls = []
        explorer._record_goal_stall = lambda goal, reason: stalls.append(reason)
        explorer._cancel_goal = lambda: None

        with patch.object(frontier_explorer.time, "monotonic", return_value=146.0):
            explorer._tick()

        self.assertEqual(stalls, ["frontier goal stalled; Nav2 result not yet failed"])
        self.assertAlmostEqual(explorer.session_max_goal_displacement, 0.1)

    def test_stall_does_not_consume_failure_budget_or_mark_goal_unreachable(self):
        explorer = frontier_explorer.FrontierExplorer.__new__(frontier_explorer.FrontierExplorer)
        explorer.args = SimpleNamespace(failed_goal_radius=0.75)
        explorer.stalled_goals = []
        explorer.failed_goals = []
        explorer.failures = 0
        explorer.status = {}
        explorer._write_status = lambda: None

        explorer._record_goal_stall({"x": 1.0, "y": 2.0}, "frontier goal stalled; Nav2 result not yet failed")

        self.assertEqual(explorer.failures, 0)
        self.assertEqual(explorer.failed_goals, [])
        self.assertEqual(explorer.stalled_goals[0]["x"], 1.0)
        self.assertEqual(explorer.stalled_goals[0]["y"], 2.0)
        self.assertEqual(explorer.status["goalFailureType"], "stall_observed")

    def test_cancel_exception_finishes_explorer_instead_of_hanging(self):
        explorer = frontier_explorer.FrontierExplorer.__new__(frontier_explorer.FrontierExplorer)
        explorer.goal_handle = SimpleNamespace(cancel_goal_async=lambda: (_ for _ in ()).throw(RuntimeError("cancel failed")))
        explorer.current_goal = {"x": 1.0, "y": 2.0}
        explorer.goal_started_at = 1.0
        explorer.goal_last_pose = None
        explorer.cancel_future = None
        explorer.cancelled_goal_keys = set()
        explorer.cancellation_failed = False
        explorer.status = {}
        explorer.finished = False
        explorer._write_status = lambda: None

        self.assertFalse(explorer._cancel_goal())
        self.assertTrue(explorer.finished)
        self.assertEqual(explorer.status["state"], "stopped")

    def test_cancel_retries_once_before_terminal_stop(self):
        calls = []

        def cancel_goal_async():
            calls.append(True)
            if len(calls) == 1:
                raise RuntimeError("transient cancel failure")
            return SimpleNamespace(done=lambda: False)

        explorer = frontier_explorer.FrontierExplorer.__new__(frontier_explorer.FrontierExplorer)
        explorer.goal_handle = SimpleNamespace(cancel_goal_async=cancel_goal_async)
        explorer.current_goal = {"x": 1.0, "y": 2.0}
        explorer.goal_started_at = 1.0
        explorer.goal_last_pose = None
        explorer.cancel_future = None
        explorer.cancelled_goal_keys = set()
        explorer.cancellation_failed = False
        explorer.cancel_deadline = 0.0
        explorer.cancel_timeout_reported = False
        explorer.args = SimpleNamespace(cancel_timeout=10.0)
        explorer.status = {}
        explorer.finished = False
        explorer._write_status = lambda: None

        self.assertTrue(explorer._cancel_goal())
        self.assertEqual(len(calls), 2)
        self.assertIsNotNone(explorer.cancel_future)
        self.assertFalse(explorer.finished)

    def test_lock_is_exclusive_and_replaces_only_stale_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            lock_file = Path(directory) / "frontier.lock"
            token = frontier_explorer.acquire_explorer_lock(str(lock_file))
            with self.assertRaisesRegex(RuntimeError, "another frontier explorer is running"):
                frontier_explorer.acquire_explorer_lock(str(lock_file))
            frontier_explorer.release_explorer_lock(str(lock_file), token)
            self.assertFalse(lock_file.exists())

            lock_file.write_text(json.dumps({"pid": 99_999_999, "token": "stale"}), encoding="utf-8")
            replacement = frontier_explorer.acquire_explorer_lock(str(lock_file))
            self.assertNotEqual(replacement, "stale")
            frontier_explorer.release_explorer_lock(str(lock_file), replacement)

    def test_accepts_terminal_nav2_goal_cancel_response(self):
        self.assertTrue(frontier_explorer._cancel_acknowledged(SimpleNamespace(goals_canceling=[object()])))
        self.assertTrue(frontier_explorer._cancel_acknowledged(SimpleNamespace(return_code=0, goals_canceling=[])))
        self.assertFalse(frontier_explorer._cancel_acknowledged(SimpleNamespace(goals_canceling=[])))
        self.assertFalse(frontier_explorer._cancel_acknowledged(SimpleNamespace(return_code=1, goals_canceling=[])))


if __name__ == "__main__":
    unittest.main()
