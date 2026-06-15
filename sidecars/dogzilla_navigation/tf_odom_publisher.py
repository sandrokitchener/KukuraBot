#!/usr/bin/env python3
from __future__ import annotations

import argparse
import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Pose2D:
    x: float
    y: float
    yaw: float


@dataclass(frozen=True)
class Twist2D:
    vx: float
    vy: float
    wz: float


def yaw_from_quaternion(x: float, y: float, z: float, w: float) -> float:
    return math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))


def wrap_angle(value: float) -> float:
    return math.atan2(math.sin(value), math.cos(value))


def compute_twist(previous: Pose2D | None, current: Pose2D, dt: float) -> Twist2D:
    if previous is None or dt <= 0:
        return Twist2D(0.0, 0.0, 0.0)
    return Twist2D(
        vx=(current.x - previous.x) / dt,
        vy=(current.y - previous.y) / dt,
        wz=wrap_angle(current.yaw - previous.yaw) / dt,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Publish /odom from an existing TF odom->base transform.")
    parser.add_argument("--odom-frame", default="odom")
    parser.add_argument("--base-frame", default="base_link")
    parser.add_argument("--topic", default="/odom")
    parser.add_argument("--rate", type=float, default=20.0)
    args = parser.parse_args(argv)

    import rclpy
    from nav_msgs.msg import Odometry
    from rclpy.duration import Duration
    from rclpy.node import Node
    from tf2_ros import Buffer, ConnectivityException, ExtrapolationException, LookupException, TransformListener

    class TfOdomPublisher(Node):
        def __init__(self) -> None:
            super().__init__("robodoge_tf_odom_publisher")
            self.buffer = Buffer(cache_time=Duration(seconds=10.0))
            self.listener = TransformListener(self.buffer, self)
            self.publisher = self.create_publisher(Odometry, args.topic, 20)
            self.previous_pose: Pose2D | None = None
            self.previous_time_sec: float | None = None
            period = 1.0 / max(float(args.rate), 1.0)
            self.timer = self.create_timer(period, self.publish_odom)
            self.get_logger().info(
                f"publishing {args.topic} from TF {args.odom_frame}->{args.base_frame} at {1.0 / period:.1f} Hz"
            )

        def publish_odom(self) -> None:
            try:
                transform = self.buffer.lookup_transform(args.odom_frame, args.base_frame, rclpy.time.Time())
            except (LookupException, ConnectivityException, ExtrapolationException) as error:
                self.get_logger().warn(f"waiting for TF {args.odom_frame}->{args.base_frame}: {error}", throttle_duration_sec=5.0)
                return

            now = self.get_clock().now()
            now_sec = now.nanoseconds / 1_000_000_000.0
            translation = transform.transform.translation
            rotation = transform.transform.rotation
            current_pose = Pose2D(
                x=float(translation.x),
                y=float(translation.y),
                yaw=yaw_from_quaternion(float(rotation.x), float(rotation.y), float(rotation.z), float(rotation.w)),
            )
            dt = 0.0 if self.previous_time_sec is None else now_sec - self.previous_time_sec
            twist = compute_twist(self.previous_pose, current_pose, dt)

            message = Odometry()
            message.header.stamp = now.to_msg()
            message.header.frame_id = args.odom_frame
            message.child_frame_id = args.base_frame
            message.pose.pose.position.x = current_pose.x
            message.pose.pose.position.y = current_pose.y
            message.pose.pose.position.z = float(translation.z)
            message.pose.pose.orientation = rotation
            message.twist.twist.linear.x = twist.vx
            message.twist.twist.linear.y = twist.vy
            message.twist.twist.angular.z = twist.wz
            self.publisher.publish(message)

            self.previous_pose = current_pose
            self.previous_time_sec = now_sec

    rclpy.init()
    node = TfOdomPublisher()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
