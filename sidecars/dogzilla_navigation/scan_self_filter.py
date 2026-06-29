#!/usr/bin/env python3
from __future__ import annotations

import argparse
import math
import sys
import traceback


def angle_in_window(angle: float, start: float, end: float) -> bool:
    angle = angle % (2.0 * math.pi)
    start = start % (2.0 * math.pi)
    end = end % (2.0 * math.pi)
    if start <= end:
        return start <= angle <= end
    return angle >= start or angle <= end


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Mask DOGZILLA self-hit LaserScan returns before Nav2 costmaps.")
    parser.add_argument("--input-topic", default="/scan")
    parser.add_argument("--output-topic", default="/scan_nav2")
    parser.add_argument("--mask-start-deg", type=float, default=135.0)
    parser.add_argument("--mask-end-deg", type=float, default=255.0)
    parser.add_argument("--mask-range-m", type=float, default=0.35)
    args = parser.parse_args(argv)

    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import LaserScan

    class ScanSelfFilter(Node):
        def __init__(self) -> None:
            super().__init__("robodoge_scan_self_filter")
            self.mask_start = math.radians(args.mask_start_deg)
            self.mask_end = math.radians(args.mask_end_deg)
            self.mask_range = max(float(args.mask_range_m), 0.0)
            self.publisher = self.create_publisher(LaserScan, args.output_topic, 10)
            self.subscription = self.create_subscription(LaserScan, args.input_topic, self.filter_scan, 10)
            self.get_logger().info(
                f"publishing {args.output_topic} from {args.input_topic}; "
                f"mask {args.mask_start_deg:.1f}-{args.mask_end_deg:.1f} deg under {self.mask_range:.2f} m"
            )

        def filter_scan(self, message: LaserScan) -> None:
            filtered = LaserScan()
            filtered.header = message.header
            filtered.angle_min = message.angle_min
            filtered.angle_max = message.angle_max
            filtered.angle_increment = message.angle_increment
            filtered.time_increment = message.time_increment
            filtered.scan_time = message.scan_time
            filtered.range_min = message.range_min
            filtered.range_max = message.range_max
            filtered.intensities = message.intensities
            ranges = list(message.ranges)
            for index, value in enumerate(ranges):
                if not math.isfinite(value) or value <= 0.0 or value >= self.mask_range:
                    continue
                angle = message.angle_min + float(index) * message.angle_increment
                if angle_in_window(angle, self.mask_start, self.mask_end):
                    ranges[index] = math.inf
            filtered.ranges = ranges
            self.publisher.publish(filtered)

    node: ScanSelfFilter | None = None
    rclpy.init()
    try:
        node = ScanSelfFilter()
        rclpy.spin(node)
    except KeyboardInterrupt:
        return 0
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return 1
    finally:
        if node is not None:
            node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
