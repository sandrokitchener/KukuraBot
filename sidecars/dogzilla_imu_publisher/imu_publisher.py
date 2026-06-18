from __future__ import annotations

import json
import math
import time
import urllib.error
import urllib.request
from typing import Any

try:
    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import Imu
    from geometry_msgs.msg import Quaternion
    RCLPY_AVAILABLE = True
except ImportError:
    RCLPY_AVAILABLE = False
    Node = object


DEFAULT_BRIDGE_URL = "http://127.0.0.1:8893/imu"
DEFAULT_RATE_HZ = 50
DEFAULT_TIMEOUT_SEC = 0.4
DEFAULT_FILTER_ALPHA = 0.15
DEFAULT_YAW_DEADBAND_DEG = 0.5
DEFAULT_GYRO_DEADBAND_RADS = 0.05


def euler_to_quaternion(roll_rad: float, pitch_rad: float, yaw_rad: float) -> tuple[float, float, float, float]:
    cr = math.cos(roll_rad * 0.5)
    sr = math.sin(roll_rad * 0.5)
    cp = math.cos(pitch_rad * 0.5)
    sp = math.sin(pitch_rad * 0.5)
    cy = math.cos(yaw_rad * 0.5)
    sy = math.sin(yaw_rad * 0.5)
    return (
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
        cr * cp * cy + sr * sp * sy,
    )


def parse_imu_raw(raw: Any) -> dict[str, list[float]]:
    result: dict[str, list[float]] = {"accel": [0.0, 0.0, 0.0], "gyro": [0.0, 0.0, 0.0]}
    if raw is None:
        return result
    if isinstance(raw, (list, tuple)):
        if len(raw) >= 6:
            result["accel"] = [float(raw[0]), float(raw[1]), float(raw[2])]
            result["gyro"] = [float(raw[3]), float(raw[4]), float(raw[5])]
    elif isinstance(raw, dict):
        accel_keys = [("accelX", "accel_x", "ax", "x"), ("accelY", "accel_y", "ay", "y"), ("accelZ", "accel_z", "az", "z")]
        for i, keys in enumerate(accel_keys):
            for key in keys:
                if key in raw:
                    result["accel"][i] = float(raw[key])
                    break
        gyro_keys = [("gyroX", "gyro_x", "gx", "x"), ("gyroY", "gyro_y", "gy", "y"), ("gyroZ", "gyro_z", "gz", "z")]
        for i, keys in enumerate(gyro_keys):
            for key in keys:
                if key in raw:
                    result["gyro"][i] = float(raw[key])
                    break
    return result


if RCLPY_AVAILABLE:
    _Node = Node
else:
    _Node = object


class DogzillaImuPublisher(_Node):  # type: ignore
    def __init__(self) -> None:
        if not RCLPY_AVAILABLE:
            return
        super().__init__("dogzilla_imu_publisher")

        import os
        bridge_url = os.environ.get("DOGZILLA_IMU_BRIDGE_URL", DEFAULT_BRIDGE_URL)
        rate_hz = float(os.environ.get("DOGZILLA_IMU_RATE_HZ", str(DEFAULT_RATE_HZ)))
        self.timeout_sec = float(os.environ.get("DOGZILLA_IMU_TIMEOUT_SEC", str(DEFAULT_TIMEOUT_SEC)))
        self.bridge_url = bridge_url

        self.pub = self.create_publisher(Imu, "/imu", 10)
        self.timer = self.create_timer(1.0 / max(rate_hz, 1.0), self._publish_imu)
        self._prev_yaw: float | None = None
        self._prev_time: float | None = None

        self.filter_alpha = float(os.environ.get("DOGZILLA_IMU_FILTER_ALPHA", str(DEFAULT_FILTER_ALPHA)))
        self.yaw_deadband_deg = float(os.environ.get("DOGZILLA_IMU_YAW_DEADBAND_DEG", str(DEFAULT_YAW_DEADBAND_DEG)))
        self.gyro_deadband_rads = float(os.environ.get("DOGZILLA_IMU_GYRO_DEADBAND_RADS", str(DEFAULT_GYRO_DEADBAND_RADS)))
        self._yaw_filtered: float | None = None
        self._last_published_yaw_rad: float | None = None

        self.get_logger().info(
            f"DOGZILLA IMU publisher ready: {bridge_url} @ {rate_hz}Hz"
            f" | filter_alpha={self.filter_alpha} yaw_deadband={self.yaw_deadband_deg}deg gyro_deadband={self.gyro_deadband_rads}rad/s"
        )

    def _publish_imu(self) -> None:
        try:
            req = urllib.request.Request(self.bridge_url)
            with urllib.request.urlopen(req, timeout=self.timeout_sec) as resp:
                data: dict[str, Any] = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError):
            return

        if not data.get("executed"):
            return

        now = self.get_clock().now()
        msg = Imu()
        msg.header.stamp = now.to_msg()
        msg.header.frame_id = "base_link"

        roll_deg = float(data.get("roll") or 0.0)
        pitch_deg = float(data.get("pitch") or 0.0)
        yaw_deg = float(data.get("yaw") or 0.0)
        roll_rad = math.radians(roll_deg)
        pitch_rad = math.radians(pitch_deg)
        yaw_rad = math.radians(yaw_deg)

        if self._yaw_filtered is None:
            self._yaw_filtered = yaw_rad
        else:
            self._yaw_filtered = self.filter_alpha * yaw_rad + (1.0 - self.filter_alpha) * self._yaw_filtered

        yaw_to_publish = self._yaw_filtered
        if self._last_published_yaw_rad is not None:
            diff_rad = self._yaw_filtered - self._last_published_yaw_rad
            diff_rad = math.atan2(math.sin(diff_rad), math.cos(diff_rad))
            if math.degrees(diff_rad) < self.yaw_deadband_deg:
                yaw_to_publish = self._last_published_yaw_rad
            else:
                self._last_published_yaw_rad = self._yaw_filtered
        else:
            self._last_published_yaw_rad = self._yaw_filtered

        qx, qy, qz, qw = euler_to_quaternion(roll_rad, pitch_rad, yaw_to_publish)
        msg.orientation.x = qx
        msg.orientation.y = qy
        msg.orientation.z = qz
        msg.orientation.w = qw

        raw = data.get("imuRaw")
        if raw is not None:
            parsed = parse_imu_raw(raw)
            msg.linear_acceleration.x = parsed["accel"][0]
            msg.linear_acceleration.y = parsed["accel"][1]
            msg.linear_acceleration.z = parsed["accel"][2]
            msg.angular_velocity.x = parsed["gyro"][0]
            msg.angular_velocity.y = parsed["gyro"][1]
            msg.angular_velocity.z = parsed["gyro"][2]
        else:
            if self._prev_yaw is not None and self._prev_time is not None:
                dt = (now.nanoseconds - self._prev_time) / 1e9
                if dt > 0.001:
                    yaw_rate = (yaw_rad - self._prev_yaw) / dt
                    msg.angular_velocity.z = yaw_rate

            self._prev_yaw = yaw_rad
            self._prev_time = float(now.nanoseconds)

        if abs(msg.angular_velocity.z) < self.gyro_deadband_rads:
            msg.angular_velocity.z = 0.0

        self.pub.publish(msg)


def main() -> None:
    if not RCLPY_AVAILABLE:
        print("ERROR: rclpy not available. Run this script on a ROS 2 system.")
        return

    rclpy.init()
    node = DogzillaImuPublisher()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
