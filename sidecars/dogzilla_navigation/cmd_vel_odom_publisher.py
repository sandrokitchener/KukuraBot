#!/usr/bin/env python3
from __future__ import annotations

import argparse
import math

import rclpy
from geometry_msgs.msg import Quaternion, TransformStamped, Twist
from nav_msgs.msg import Odometry
from rclpy.duration import Duration
from rclpy.node import Node
from tf2_ros import TransformBroadcaster


def quaternion_from_yaw(yaw: float) -> Quaternion:
    q = Quaternion()
    q.x = 0.0
    q.y = 0.0
    q.z = math.sin(yaw / 2.0)
    q.w = math.cos(yaw / 2.0)
    return q


class CmdVelOdomPublisher(Node):
    def __init__(self, args: argparse.Namespace) -> None:
        super().__init__("robodoge_cmd_vel_odom_publisher")
        self.args = args
        self.publisher = self.create_publisher(Odometry, args.topic, 20)
        self.tf_broadcaster = TransformBroadcaster(self)
        self.subscription = self.create_subscription(Twist, args.input_topic, self.handle_twist, 20)

        self.x = 0.0
        self.y = 0.0
        self.yaw = 0.0
        self.vx = 0.0
        self.vy = 0.0
        self.wz = 0.0
        self.last_command_time = self.get_clock().now()
        self.last_publish_time = self.get_clock().now()

        period = 1.0 / max(args.rate, 1.0)
        self.timer = self.create_timer(period, self.publish_odom)
        self.get_logger().info(
            f"publishing {args.topic} and TF {args.odom_frame}->{args.base_frame} "
            f"from {args.input_topic} at {args.rate:.1f} Hz"
        )

    def handle_twist(self, message: Twist) -> None:
        self.vx = float(message.linear.x)
        self.vy = float(message.linear.y)
        self.wz = float(message.angular.z)
        self.last_command_time = self.get_clock().now()

    def publish_odom(self) -> None:
        now = self.get_clock().now()
        dt = (now - self.last_publish_time).nanoseconds / 1_000_000_000.0
        if dt <= 0.0:
            return

        stale = (now - self.last_command_time) > Duration(seconds=self.args.stale_stop_sec)
        vx = 0.0 if stale else self.vx
        vy = 0.0 if stale else self.vy
        wz = 0.0 if stale else self.wz

        cos_yaw = math.cos(self.yaw)
        sin_yaw = math.sin(self.yaw)
        self.x += ((vx * cos_yaw) - (vy * sin_yaw)) * dt
        self.y += ((vx * sin_yaw) + (vy * cos_yaw)) * dt
        self.yaw = math.atan2(math.sin(self.yaw + (wz * dt)), math.cos(self.yaw + (wz * dt)))

        quaternion = quaternion_from_yaw(self.yaw)

        transform = TransformStamped()
        transform.header.stamp = now.to_msg()
        transform.header.frame_id = self.args.odom_frame
        transform.child_frame_id = self.args.base_frame
        transform.transform.translation.x = self.x
        transform.transform.translation.y = self.y
        transform.transform.translation.z = 0.0
        transform.transform.rotation = quaternion
        self.tf_broadcaster.sendTransform(transform)

        message = Odometry()
        message.header.stamp = transform.header.stamp
        message.header.frame_id = self.args.odom_frame
        message.child_frame_id = self.args.base_frame
        message.pose.pose.position.x = self.x
        message.pose.pose.position.y = self.y
        message.pose.pose.position.z = 0.0
        message.pose.pose.orientation = quaternion
        message.twist.twist.linear.x = vx
        message.twist.twist.linear.y = vy
        message.twist.twist.angular.z = wz
        self.publisher.publish(message)

        self.last_publish_time = now


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-topic", default="/cmd_vel")
    parser.add_argument("--topic", default="/odom")
    parser.add_argument("--odom-frame", default="odom")
    parser.add_argument("--base-frame", default="base_link")
    parser.add_argument("--rate", type=float, default=15.0)
    parser.add_argument("--stale-stop-sec", type=float, default=0.45)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rclpy.init()
    node = CmdVelOdomPublisher(args)
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
