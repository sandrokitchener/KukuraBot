import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


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

    def test_requires_nav2_cancel_acknowledgement(self):
        self.assertTrue(frontier_explorer._cancel_acknowledged(SimpleNamespace(goals_canceling=[object()])))
        self.assertFalse(frontier_explorer._cancel_acknowledged(SimpleNamespace(goals_canceling=[])))


if __name__ == "__main__":
    unittest.main()
