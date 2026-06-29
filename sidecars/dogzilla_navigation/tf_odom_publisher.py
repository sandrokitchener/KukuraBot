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


def quaternion_from_yaw(yaw: float) -> tuple[float, float, float, float]:
    return (0.0, 0.0, math.sin(yaw / 2.0), math.cos(yaw / 2.0))


def relative_pose(origin: Pose2D, current: Pose2D) -> Pose2D:
    dx = current.x - origin.x
    dy = current.y - origin.y
    c = math.cos(origin.yaw)
    s = math.sin(origin.yaw)
    return Pose2D(
        x=(c * dx) + (s * dy),
        y=(-s * dx) + (c * dy),
        yaw=wrap_angle(current.yaw - origin.yaw),
    )


def compute_twist(previous: Pose2D | None, current: Pose2D, dt: float) -> Twist2D:
    if previous is None or dt <= 0:
        return Twist2D(0.0, 0.0, 0.0)
    return Twist2D(
        vx=(current.x - previous.x) / dt,
        vy=(current.y - previous.y) / dt,
        wz=wrap_angle(current.yaw - previous.yaw) / dt,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Publish /odom from an existing TF transform.")
    parser.add_argument("--odom-frame", default="odom")
    parser.add_argument("--base-frame", default="base_link")
    parser.add_argument("--fallback-source-frame", default="map")
    parser.add_argument("--topic", default="/odom")
    parser.add_argument("--rate", type=float, default=10.0)
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
            self.fallback_origin: Pose2D | None = None
            period = 1.0 / max(float(args.rate), 1.0)
            self.timer = self.create_timer(period, self.publish_odom)
            fallback = f", fallback {args.fallback_source_frame}->{args.base_frame}" if args.fallback_source_frame else ""
            self.get_logger().info(
                f"publishing {args.topic} from TF {args.odom_frame}->{args.base_frame}{fallback} at {1.0 / period:.1f} Hz"
            )

        def publish_odom(self) -> None:
            transform = None
            selected_source_frame = args.odom_frame
            last_error = None
            source_frames = [args.odom_frame]
            if args.fallback_source_frame and args.fallback_source_frame not in source_frames:
                source_frames.append(args.fallback_source_frame)

            for source_frame in source_frames:
                try:
                    transform = self.buffer.lookup_transform(source_frame, args.base_frame, rclpy.time.Time())
                    selected_source_frame = source_frame
                    break
                except (LookupException, ConnectivityException, ExtrapolationException) as error:
                    last_error = error

            if transform is None:
                self.get_logger().warn(
                    f"waiting for TF {args.odom_frame}->{args.base_frame} or "
                    f"{args.fallback_source_frame}->{args.base_frame}: {last_error}",
                    throttle_duration_sec=5.0,
                )
                return

            now = self.get_clock().now()
            now_sec = now.nanoseconds / 1_000_000_000.0
            translation = transform.transform.translation
            rotation = transform.transform.rotation
            raw_pose = Pose2D(
                x=float(translation.x),
                y=float(translation.y),
                yaw=yaw_from_quaternion(float(rotation.x), float(rotation.y), float(rotation.z), float(rotation.w)),
            )
            current_pose = raw_pose

            if selected_source_frame != args.odom_frame:
                if self.fallback_origin is None:
                    self.fallback_origin = raw_pose
                    self.get_logger().warn(
                        f"using {selected_source_frame}->{args.base_frame} as synthetic odom anchor",
                        throttle_duration_sec=60.0,
                    )
                current_pose = relative_pose(self.fallback_origin, raw_pose)
                qx, qy, qz, qw = quaternion_from_yaw(current_pose.yaw)
            else:
                self.fallback_origin = None
                qx, qy, qz, qw = float(rotation.x), float(rotation.y), float(rotation.z), float(rotation.w)

            dt = 0.0 if self.previous_time_sec is None else now_sec - self.previous_time_sec
            twist = compute_twist(self.previous_pose, current_pose, dt)

            message = Odometry()
            message.header.stamp = now.to_msg()
            message.header.frame_id = args.odom_frame
            message.child_frame_id = args.base_frame
            message.pose.pose.position.x = current_pose.x
            message.pose.pose.position.y = current_pose.y
            message.pose.pose.position.z = 0.0 if selected_source_frame != args.odom_frame else float(translation.z)
            message.pose.pose.orientation.x = qx
            message.pose.pose.orientation.y = qy
            message.pose.pose.orientation.z = qz
            message.pose.pose.orientation.w = qw
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
