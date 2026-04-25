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

    def test_waypoint_motion_snapshot_reports_progress(self):
        result = self.controller.handle_command(
            {
                "action": "robot_controller.goto_waypoint",
                "payload": {
                    "waypointName": "bedroom",
                    "sceneWaypoint": {
                        "position": [1.0, 0.0, 0.0],
                        "yawDegrees": 0.0,
                    },
                },
            }
        )

        self.assertTrue(result["ok"])
        snapshot = self.controller.tick(0.1)
        self.assertEqual(snapshot["status"], "moving_to_waypoint")
        self.assertGreater(snapshot["basePose"]["x"], 0.0)

    def test_waypoint_steers_with_front_lidar_hit_prim(self):
        self.controller.handle_command(
            {
                "action": "robot_controller.goto_waypoint",
                "payload": {
                    "waypointName": "bedroom",
                    "sceneWaypoint": {
                        "position": [1.4, 0.0, 0.0],
                        "yawDegrees": 0.0,
                    },
                },
            }
        )

        scan = {
            "angles": [60.0, 90.0, 120.0],
            "linear_depth_data": [0.26, 0.24, 0.85],
            "hit_prim_paths": [
                "/ObstacleRoom/obstacle_right",
                "/ObstacleRoom/obstacle_front",
                "/ObstacleRoom/obstacle_left",
            ],
            "frontYawOffsetDegrees": 90.0,
        }

        snapshot = self.controller.tick(0.2, sensor_state={"lidarFlatScan": scan})

        self.assertEqual(snapshot["status"], "moving_to_waypoint")
        self.assertGreaterEqual(snapshot["basePose"]["x"], -1e-9)
        self.assertGreater(abs(snapshot["basePose"]["y"]), 0.0)

    def test_waypoint_ignores_lidar_hit_outside_front_leg_sector(self):
        self.controller.handle_command(
            {
                "action": "robot_controller.goto_waypoint",
                "payload": {
                    "waypointName": "bedroom",
                    "sceneWaypoint": {
                        "position": [1.4, 0.0, 0.0],
                        "yawDegrees": 0.0,
                    },
                },
            }
        )

        scan = {
            "angles": [0.0],
            "linear_depth_data": [0.2],
            "hit_prim_paths": ["/ObstacleRoom/obstacle_side"],
            "frontYawOffsetDegrees": 90.0,
        }
        snapshot = self.controller.tick(0.2, sensor_state={"lidarFlatScan": scan})

        self.assertEqual(snapshot["status"], "moving_to_waypoint")
        self.assertGreater(snapshot["basePose"]["x"], 0.0)
        self.assertAlmostEqual(snapshot["basePose"]["y"], 0.0)

    def test_waypoint_ignores_lidar_hits_on_robot_self_prims(self):
        self.controller.handle_command(
            {
                "action": "robot_controller.goto_waypoint",
                "payload": {
                    "waypointName": "bedroom",
                    "sceneWaypoint": {
                        "position": [1.4, 0.0, 0.0],
                        "yawDegrees": 0.0,
                    },
                },
            }
        )

        scan = {
            "angles": [90.0],
            "linear_depth_data": [0.2],
            "hit_prim_paths": [
                "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/front_left_hip",
            ],
            "frontYawOffsetDegrees": 90.0,
        }
        snapshot = self.controller.tick(0.2, sensor_state={"lidarFlatScan": scan})

        self.assertEqual(snapshot["status"], "moving_to_waypoint")
        self.assertGreater(snapshot["basePose"]["x"], 0.0)
        self.assertAlmostEqual(snapshot["basePose"]["y"], 0.0)

    def test_waypoint_steers_with_depth_only_front_lidar_hit(self):
        self.controller.handle_command(
            {
                "action": "robot_controller.goto_waypoint",
                "payload": {
                    "waypointName": "bedroom",
                    "sceneWaypoint": {
                        "position": [1.4, 0.0, 0.0],
                        "yawDegrees": 0.0,
                    },
                },
            }
        )

        scan = {
            "angles": [90.0],
            "linear_depth_data": [0.2],
            "frontYawOffsetDegrees": 90.0,
        }
        snapshot = self.controller.tick(0.2, sensor_state={"lidarFlatScan": scan})

        self.assertEqual(snapshot["status"], "moving_to_waypoint")
        self.assertGreaterEqual(snapshot["basePose"]["x"], -1e-9)
        self.assertGreater(abs(snapshot["basePose"]["y"]), 0.0)

    def test_diagonal_waypoint_uses_motion_direction_as_lidar_front(self):
        self.controller.handle_command(
            {
                "action": "robot_controller.goto_waypoint",
                "payload": {
                    "waypointName": "bedroom",
                    "sceneWaypoint": {
                        "position": [1.35, 1.25, 0.0],
                        "yawDegrees": 180.0,
                    },
                },
            }
        )

        scan = {
            "angles": [133.0],
            "linear_depth_data": [0.2],
            "frontYawOffsetDegrees": 90.0,
        }
        snapshot = self.controller.tick(0.2, sensor_state={"lidarFlatScan": scan})

        self.assertEqual(snapshot["status"], "moving_to_waypoint")
        self.assertNotAlmostEqual(snapshot["basePose"]["x"], snapshot["basePose"]["y"], delta=0.005)

    def test_waypoint_plans_route_around_scene_cube_footprint(self):
        self.controller.handle_command(
            {
                "action": "robot_controller.goto_waypoint",
                "payload": {
                    "waypointName": "bedroom",
                    "sceneWaypoint": {
                        "position": [1.4, 0.0, 0.0],
                        "yawDegrees": 0.0,
                    },
                },
            }
        )
        obstacle = {
            "center": [0.55, 0.0],
            "halfExtentsMeters": [0.16, 0.16],
        }
        snapshots = [
            self.controller.tick(0.2, sensor_state={"obstacleFootprints": [obstacle]})
            for _ in range(20)
        ]

        self.assertGreater(snapshots[0]["routeRemaining"], 1)
        self.assertTrue(any(abs(snapshot["basePose"]["y"]) > 0.02 for snapshot in snapshots))
        for snapshot in snapshots:
            pose = snapshot["basePose"]
            inside_x = 0.55 - 0.16 <= pose["x"] <= 0.55 + 0.16
            inside_y = -0.16 <= pose["y"] <= 0.16
            self.assertFalse(inside_x and inside_y)

    def test_waypoint_steers_with_close_hit_in_broad_forward_sector(self):
        self.controller.handle_command(
            {
                "action": "robot_controller.goto_waypoint",
                "payload": {
                    "waypointName": "bedroom",
                    "sceneWaypoint": {
                        "position": [1.4, 0.0, 0.0],
                        "yawDegrees": 0.0,
                    },
                },
            }
        )

        scan = {
            "angles": [140.0],
            "linear_depth_data": [0.2],
            "frontYawOffsetDegrees": 90.0,
        }
        snapshot = self.controller.tick(0.2, sensor_state={"lidarFlatScan": scan})

        self.assertEqual(snapshot["status"], "moving_to_waypoint")
        self.assertGreater(snapshot["basePose"]["x"], 0.0)
        self.assertGreater(abs(snapshot["basePose"]["y"]), 0.0)

    def test_manual_backward_motion_keeps_command_direction_with_front_cube(self):
        self.controller.handle_command(
            {
                "action": "robot_controller.move_base",
                "payload": {
                    "linearX": -0.12,
                    "linearY": 0.0,
                    "angularZ": 0.0,
                    "gait": "walk",
                },
            }
        )

        scan = {
            "angles": [90.0],
            "linear_depth_data": [0.2],
            "hit_prim_paths": ["/ObstacleRoom/obstacle_front"],
            "frontYawOffsetDegrees": 90.0,
        }
        snapshot = self.controller.tick(0.5, sensor_state={"lidarFlatScan": scan})

        self.assertLess(snapshot["basePose"]["x"], 0.0)


if __name__ == "__main__":
    unittest.main()
