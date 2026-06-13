#!/usr/bin/env python3
import argparse
import json
import math
import sys
import time

import rclpy
from nav_msgs.msg import OccupancyGrid
from rclpy.duration import Duration
from rclpy.node import Node
from tf2_ros import Buffer, TransformException, TransformListener


LETHAL_COST = 100
INFLATED_COST = 50


class CostmapInspector(Node):
    def __init__(self, args):
        super().__init__("dogzilla_blocked_costmap_inspector")
        self.args = args
        self.costmap = None
        self.subscription = self.create_subscription(
            OccupancyGrid,
            args.costmap_topic,
            self._on_costmap,
            1,
        )
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)

    def _on_costmap(self, message):
        self.costmap = message

    def sample(self):
        deadline = time.monotonic() + self.args.timeout
        while rclpy.ok() and time.monotonic() < deadline:
            rclpy.spin_once(self, timeout_sec=0.1)
            if self.costmap is not None:
                break

        if self.costmap is None:
            return {
                "ok": False,
                "error": f"no OccupancyGrid received on {self.args.costmap_topic}",
                "costmapTopic": self.args.costmap_topic,
            }

        pose = self._lookup_pose()
        if not pose["ok"]:
            return {
                "ok": False,
                "error": pose["error"],
                "costmapTopic": self.args.costmap_topic,
                "costmapFrame": self.costmap.header.frame_id,
            }

        return inspect_costmap(self.costmap, pose, self.args.window_radius, self.args.costmap_topic)

    def _lookup_pose(self):
        target_frame = self.costmap.header.frame_id or self.args.costmap_frame
        try:
            transform = self.tf_buffer.lookup_transform(
                target_frame,
                self.args.base_frame,
                rclpy.time.Time(),
                timeout=Duration(seconds=self.args.timeout),
            )
        except TransformException as error:
            return {
                "ok": False,
                "error": f"TF lookup failed {target_frame}->{self.args.base_frame}: {error}",
            }

        rotation = transform.transform.rotation
        yaw = math.atan2(
            2.0 * (rotation.w * rotation.z + rotation.x * rotation.y),
            1.0 - 2.0 * (rotation.y * rotation.y + rotation.z * rotation.z),
        )
        translation = transform.transform.translation
        return {
            "ok": True,
            "frame": target_frame,
            "baseFrame": self.args.base_frame,
            "x": translation.x,
            "y": translation.y,
            "yaw": yaw,
        }


def inspect_costmap(costmap, pose, window_radius, costmap_topic):
    info = costmap.info
    resolution = float(info.resolution)
    origin_x = float(info.origin.position.x)
    origin_y = float(info.origin.position.y)
    width = int(info.width)
    height = int(info.height)

    robot_cell = world_to_cell(pose["x"], pose["y"], origin_x, origin_y, resolution)
    radius_cells = max(1, int(math.ceil(window_radius / resolution)))
    stats = {
        "front": empty_sector(),
        "left": empty_sector(),
        "right": empty_sector(),
        "rear": empty_sector(),
        "all": empty_sector(),
    }
    nearest = None

    min_x = max(0, robot_cell[0] - radius_cells)
    max_x = min(width - 1, robot_cell[0] + radius_cells)
    min_y = max(0, robot_cell[1] - radius_cells)
    max_y = min(height - 1, robot_cell[1] + radius_cells)

    for cy in range(min_y, max_y + 1):
        for cx in range(min_x, max_x + 1):
            cost = int(costmap.data[cy * width + cx])
            if cost < INFLATED_COST:
                continue

            wx = origin_x + (cx + 0.5) * resolution
            wy = origin_y + (cy + 0.5) * resolution
            dx = wx - pose["x"]
            dy = wy - pose["y"]
            distance = math.hypot(dx, dy)
            if distance > window_radius:
                continue

            sector = classify_sector(math.atan2(dy, dx) - pose["yaw"])
            add_cell(stats["all"], cost, distance)
            add_cell(stats[sector], cost, distance)
            if nearest is None or distance < nearest["distance"]:
                nearest = {
                    "x": round(wx, 3),
                    "y": round(wy, 3),
                    "distance": round(distance, 3),
                    "cost": cost,
                    "sector": sector,
                }

    blocked_by = [
        name
        for name in ("front", "left", "right", "rear")
        if stats[name]["lethal"] > 0 or stats[name]["inflated"] >= 8
        ]

    return {
        "ok": True,
        "costmapTopic": costmap_topic,
        "costmapFrame": costmap.header.frame_id,
        "resolution": resolution,
        "robot": {
            "frame": pose["frame"],
            "baseFrame": pose["baseFrame"],
            "x": round(pose["x"], 3),
            "y": round(pose["y"], 3),
            "yaw": round(pose["yaw"], 3),
            "cell": {"x": robot_cell[0], "y": robot_cell[1]},
        },
        "windowRadius": window_radius,
        "nearestObstacle": nearest,
        "blockedBy": blocked_by,
        "sectors": stats,
    }


def world_to_cell(x, y, origin_x, origin_y, resolution):
    return (
        int(math.floor((x - origin_x) / resolution)),
        int(math.floor((y - origin_y) / resolution)),
    )


def empty_sector():
    return {"inflated": 0, "lethal": 0, "nearest": None}


def add_cell(stats, cost, distance):
    if cost >= LETHAL_COST:
        stats["lethal"] += 1
    else:
        stats["inflated"] += 1
    if stats["nearest"] is None or distance < stats["nearest"]:
        stats["nearest"] = round(distance, 3)


def classify_sector(angle):
    wrapped = math.atan2(math.sin(angle), math.cos(angle))
    if -math.pi / 4 <= wrapped <= math.pi / 4:
        return "front"
    if math.pi / 4 < wrapped < 3 * math.pi / 4:
        return "left"
    if -3 * math.pi / 4 < wrapped < -math.pi / 4:
        return "right"
    return "rear"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Inspect local Nav2 costmap around DOGZILLA when blocked.")
    parser.add_argument("--costmap-topic", default="/local_costmap/costmap")
    parser.add_argument("--costmap-frame", default="map")
    parser.add_argument("--base-frame", default="base_link")
    parser.add_argument("--window-radius", type=float, default=0.75)
    parser.add_argument("--timeout", type=float, default=3.0)
    args = parser.parse_args(argv)

    rclpy.init()
    node = CostmapInspector(args)
    try:
        print(json.dumps(node.sample(), sort_keys=True))
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main(sys.argv[1:])
