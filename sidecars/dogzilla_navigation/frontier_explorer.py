#!/usr/bin/env python3
"""Roomba-style LiDAR motion for Cartographer mapping."""

from __future__ import annotations

import argparse
import json
import math
import os
import time
import uuid
from pathlib import Path
from typing import Any


def _angular_distance(first: float, second: float) -> float:
    return abs((first - second + math.pi) % (2.0 * math.pi) - math.pi)


def classify_cmd_vel(
    linear_x: float,
    angular_z: float,
    *,
    linear_deadband: float,
    angular_deadband: float,
    linear_full_scale: float,
    angular_full_scale: float,
    rotation_dominance_ratio: float,
) -> dict[str, float | bool]:
    linear = abs(float(linear_x))
    angular = abs(float(angular_z))
    linear_active = linear >= linear_deadband
    angular_active = angular >= angular_deadband
    normalized_linear = linear / max(linear_full_scale, 1e-6)
    normalized_angular = angular / max(angular_full_scale, 1e-6)
    return {
        "translating": linear_active,
        "rotationDominant": angular_active
        and (
            not linear_active
            or normalized_angular
            >= normalized_linear * max(rotation_dominance_ratio, 1.0)
        ),
        "normalizedLinear": normalized_linear,
        "normalizedAngular": normalized_angular,
    }


def _sector_min(
    ranges: list[float],
    *,
    angle_min: float,
    angle_increment: float,
    center: float,
    half_width: float,
    range_min: float,
    range_max: float,
) -> float | None:
    values = []
    for index, raw in enumerate(ranges):
        angle = angle_min + index * angle_increment
        if _angular_distance(angle, center) > half_width:
            continue
        value = float(raw)
        if math.isinf(value) and value > 0:
            value = range_max
        if math.isfinite(value) and range_min <= value <= range_max:
            values.append(value)
    return min(values) if values else None


def choose_reactive_command(
    ranges: list[float],
    *,
    angle_min: float,
    angle_increment: float,
    range_min: float,
    range_max: float,
    heading_error: float = 0.0,
    turning: int,
    stop_distance: float,
    clear_distance: float,
    forward_speed: float,
    turn_speed: float,
    steering_gain: float = 0.0,
    max_steering: float = 0.0,
) -> dict[str, float | int | str]:
    front = _sector_min(
        ranges,
        angle_min=angle_min,
        angle_increment=angle_increment,
        center=0.0,
        half_width=math.radians(25),
        range_min=range_min,
        range_max=range_max,
    )
    left = _sector_min(
        ranges,
        angle_min=angle_min,
        angle_increment=angle_increment,
        center=math.radians(70),
        half_width=math.radians(40),
        range_min=range_min,
        range_max=range_max,
    )
    right = _sector_min(
        ranges,
        angle_min=angle_min,
        angle_increment=angle_increment,
        center=math.radians(-70),
        half_width=math.radians(40),
        range_min=range_min,
        range_max=range_max,
    )
    if front is None:
        return {
            "linearX": 0.0,
            "angularZ": 0.0,
            "turning": 0,
            "frontClearance": 0.0,
            "reason": "scan unavailable",
        }
    if turning and front < clear_distance:
        return {
            "linearX": 0.0,
            "angularZ": math.copysign(turn_speed, turning),
            "turning": turning,
            "frontClearance": front,
            "reason": "turning until path clears",
        }
    if front < stop_distance:
        direction = 1 if (left or 0.0) >= (right or 0.0) else -1
        return {
            "linearX": 0.0,
            "angularZ": math.copysign(turn_speed, direction),
            "turning": direction,
            "frontClearance": front,
            "reason": "wall ahead",
        }
    steering = max(
        -max_steering,
        min(max_steering, heading_error * steering_gain),
    )
    return {
        "linearX": forward_speed,
        "angularZ": steering,
        "turning": 0,
        "frontClearance": front,
        "reason": "driving",
    }


def _known_cell_count(cells: Any) -> int:
    return sum(1 for value in cells if int(value) >= 0)


def _process_is_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def acquire_explorer_lock(path: str) -> str:
    lock_path = Path(path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    payload = json.dumps(
        {"pid": os.getpid(), "token": token, "startedAt": time.time()}
    ) + "\n"
    for _ in range(2):
        try:
            descriptor = os.open(
                lock_path,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                0o644,
            )
        except FileExistsError:
            try:
                owner_pid = int(
                    json.loads(
                        lock_path.read_text(encoding="utf-8")
                    ).get("pid")
                )
            except (OSError, TypeError, ValueError, json.JSONDecodeError):
                owner_pid = 0
            if owner_pid > 0 and _process_is_running(owner_pid):
                raise RuntimeError(
                    f"another mapping explorer is running (pid {owner_pid})"
                )
            try:
                lock_path.unlink()
            except FileNotFoundError:
                pass
            continue
        with os.fdopen(descriptor, "w", encoding="utf-8") as lock_file:
            lock_file.write(payload)
        return token
    raise RuntimeError("could not acquire mapping explorer lock")


def release_explorer_lock(path: str, token: str) -> None:
    lock_path = Path(path)
    try:
        owner = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    if owner.get("token") == token:
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass


class FrontierExplorer:
    def __init__(self, args: argparse.Namespace) -> None:
        import rclpy
        from geometry_msgs.msg import Twist
        from nav_msgs.msg import OccupancyGrid
        from rclpy.qos import (
            DurabilityPolicy,
            HistoryPolicy,
            QoSProfile,
            ReliabilityPolicy,
        )
        from sensor_msgs.msg import LaserScan
        from tf2_ros import Buffer, TransformListener

        self._rclpy = rclpy
        self._Twist = Twist
        self.args = args
        self.node = rclpy.create_node("robodoge_frontier_explorer")
        self.map_message: Any | None = None
        self.scan_message: Any | None = None
        self.started_at = time.monotonic()
        self.map_received_at = 0.0
        self.scan_received_at = 0.0
        self.pose_missing_at = 0.0
        self.last_map_growth_at = 0.0
        self.max_known_cells = 0
        self.initial_pose: tuple[float, float] | None = None
        self.session_max_goal_displacement = 0.0
        self.session_translation_command_sec = 0.0
        self.cmd_vel_last_at = 0.0
        self.cmd_vel_translating = False
        self.last_cmd_vel: dict[str, float | bool] = {}
        self.last_command: dict[str, float | int | str] = {}
        self.turn_direction = 0
        self.turn_started_at = 0.0
        self.turn_retries = 0
        self.turn_count = 0
        self.last_status_write_at = 0.0
        self.finished = False
        self.status = {
            "state": "starting",
            "motionMode": "reactive_lidar",
            "startedAt": time.time(),
            "pid": os.getpid(),
        }
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self.node)
        self.command_publisher = self.node.create_publisher(
            Twist, args.command_topic, 10
        )
        map_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.TRANSIENT_LOCAL,
        )
        scan_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
        )
        self.node.create_subscription(
            OccupancyGrid,
            args.map_topic,
            self._on_map,
            map_qos,
        )
        self.node.create_subscription(
            LaserScan,
            args.scan_topic,
            self._on_scan,
            scan_qos,
        )
        self.node.create_subscription(
            Twist,
            args.cmd_vel_topic,
            self._on_cmd_vel,
            10,
        )
        self.node.create_timer(args.control_period, self._tick)
        self._write_status()

    def _on_map(self, message: Any) -> None:
        now = time.monotonic()
        known_cells = _known_cell_count(message.data)
        if (
            self.last_map_growth_at == 0.0
            or known_cells >= self.max_known_cells + self.args.map_growth_cells
        ):
            self.last_map_growth_at = now
            self.max_known_cells = max(self.max_known_cells, known_cells)
        self.map_message = message
        self.map_received_at = now

    def _on_scan(self, message: Any) -> None:
        self.scan_message = message
        self.scan_received_at = time.monotonic()

    def _on_cmd_vel(self, message: Any) -> None:
        now = time.monotonic()
        if self.cmd_vel_translating and self.cmd_vel_last_at > 0.0:
            self.session_translation_command_sec += min(
                now - self.cmd_vel_last_at,
                self.args.cmd_vel_max_gap,
            )
        motion = classify_cmd_vel(
            float(message.linear.x),
            float(message.angular.z),
            linear_deadband=self.args.linear_deadband,
            angular_deadband=self.args.angular_deadband,
            linear_full_scale=self.args.linear_full_scale,
            angular_full_scale=self.args.angular_full_scale,
            rotation_dominance_ratio=self.args.rotation_dominance_ratio,
        )
        self.cmd_vel_translating = bool(motion["translating"])
        self.cmd_vel_last_at = now
        self.last_cmd_vel = {
            "linearX": float(message.linear.x),
            "angularZ": float(message.angular.z),
            **motion,
        }

    def _write_status(self) -> None:
        path = Path(self.args.status_file)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            **self.status,
            "mapTopic": self.args.map_topic,
            "scanTopic": self.args.scan_topic,
            "commandTopic": self.args.command_topic,
            "cmdVelTopic": self.args.cmd_vel_topic,
            "knownCellCount": self.max_known_cells,
            "turnCount": self.turn_count,
            "sessionMaxGoalDisplacement": (
                self.session_max_goal_displacement
            ),
            "sessionTranslationCommandSec": (
                self.session_translation_command_sec
            ),
            "lastReactiveCommand": self.last_command,
            "lastCmdVel": self.last_cmd_vel,
            "updatedAt": time.time(),
        }
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(payload, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
        self.last_status_write_at = time.monotonic()

    def _publish(self, linear_x: float, angular_z: float) -> None:
        command = self._Twist()
        command.linear.x = float(linear_x)
        command.angular.z = float(angular_z)
        self.command_publisher.publish(command)

    def _stop(self) -> None:
        self._publish(0.0, 0.0)

    def _finish(self, state: str, reason: str) -> None:
        if self.finished:
            return
        self._stop()
        self.status.update(
            {"state": state, "reason": reason, "finishedAt": time.time()}
        )
        self._write_status()
        self.finished = True

    def _robot_pose(self) -> tuple[float, float] | None:
        try:
            translation = self.tf_buffer.lookup_transform(
                "map",
                self.args.base_frame,
                self._rclpy.time.Time(),
            ).transform.translation
            return float(translation.x), float(translation.y)
        except Exception:
            return None

    def _update_displacement(self, pose: tuple[float, float]) -> None:
        if self.initial_pose is None:
            self.initial_pose = pose
            return
        self.session_max_goal_displacement = max(
            self.session_max_goal_displacement,
            math.hypot(
                pose[0] - self.initial_pose[0],
                pose[1] - self.initial_pose[1],
            ),
        )

    def _inputs_ready(self, now: float) -> bool:
        if self.map_message is None:
            self._stop()
            if now - self.started_at >= self.args.startup_timeout:
                self._finish("stopped", "live SLAM map unavailable")
            return False
        if now - self.map_received_at >= self.args.map_timeout:
            self._finish("stopped", "live SLAM map is stale")
            return False
        if self.scan_message is None:
            self._stop()
            if now - self.started_at >= self.args.scan_timeout:
                self._finish("stopped", "LiDAR scan unavailable")
            return False
        scan_age = now - self.scan_received_at
        if scan_age >= self.args.scan_timeout:
            self._finish("stopped", "LiDAR scan is stale")
            return False
        if scan_age >= self.args.scan_pause_after:
            self._stop()
            self.status.update(
                {
                    "state": "waiting",
                    "reason": "waiting for LiDAR scan recovery",
                }
            )
            return False
        return True

    def _tick(self) -> None:
        if self.finished:
            return
        if Path(self.args.stop_file).exists():
            self._finish("stopped", "stop requested")
            return
        now = time.monotonic()
        if not self._inputs_ready(now):
            if now - self.last_status_write_at >= 1.0:
                self._write_status()
            return
        pose = self._robot_pose()
        if pose is None:
            self._stop()
            if self.pose_missing_at == 0.0:
                self.pose_missing_at = now
            if now - self.pose_missing_at >= self.args.pose_timeout:
                self._finish(
                    "stopped",
                    "map to base_link transform unavailable",
                )
            return
        self.pose_missing_at = 0.0
        self._update_displacement(pose)
        motion_proven = (
            self.session_max_goal_displacement >= 0.05
            and self.session_translation_command_sec >= 1.0
        )
        if (
            motion_proven
            and now - self.last_map_growth_at >= self.args.no_growth_timeout
        ):
            self._finish("complete", "map stopped growing")
            return
        if now - self.started_at >= self.args.max_session_duration:
            self._finish(
                "complete" if motion_proven else "stopped",
                "mapping time limit reached",
            )
            return

        scan = self.scan_message
        command = choose_reactive_command(
            list(scan.ranges),
            angle_min=float(scan.angle_min),
            angle_increment=float(scan.angle_increment),
            range_min=max(0.0, float(scan.range_min)),
            range_max=max(0.01, float(scan.range_max)),
            turning=self.turn_direction,
            stop_distance=self.args.stop_distance,
            clear_distance=self.args.clear_distance,
            forward_speed=self.args.forward_speed,
            turn_speed=self.args.turn_speed,
        )
        next_turn = int(command["turning"])
        if next_turn and not self.turn_direction:
            self.turn_started_at = now
            self.turn_count += 1
        self.turn_direction = next_turn
        if (
            self.turn_direction
            and now - self.turn_started_at >= self.args.rotation_timeout
        ):
            if self.turn_retries == 0:
                self.turn_direction *= -1
                self.turn_started_at = now
                self.turn_retries = 1
                command["turning"] = self.turn_direction
                command["angularZ"] = math.copysign(
                    self.args.turn_speed,
                    self.turn_direction,
                )
                command["reason"] = "trying opposite turn"
            else:
                self._finish("stopped", "no clear turn direction")
                return
        elif not self.turn_direction:
            self.turn_started_at = 0.0
            self.turn_retries = 0
        self.last_command = command
        self._publish(
            float(command["linearX"]),
            float(command["angularZ"]),
        )
        self.status.update(
            {
                "state": (
                    "turning" if self.turn_direction else "exploring"
                ),
                "reason": command["reason"],
            }
        )
        if now - self.last_status_write_at >= 1.0:
            self._write_status()

    def spin(self) -> None:
        try:
            while self._rclpy.ok() and not self.finished:
                self._rclpy.spin_once(self.node, timeout_sec=0.2)
        finally:
            self._stop()
            self.node.destroy_node()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Roomba-style LiDAR mapper"
    )
    parser.add_argument("--map-topic", default="/map_cartographer")
    parser.add_argument("--scan-topic", default="/scan_nav2")
    parser.add_argument("--command-topic", default="/cmd_vel_nav")
    parser.add_argument("--cmd-vel-topic", default="/cmd_vel")
    parser.add_argument("--base-frame", default="base_link")
    parser.add_argument("--status-file", required=True)
    parser.add_argument("--stop-file", required=True)
    parser.add_argument("--lock-file", required=True)
    parser.add_argument("--stop-distance", type=float, default=0.55)
    parser.add_argument("--clear-distance", type=float, default=0.75)
    parser.add_argument("--forward-speed", type=float, default=0.18)
    parser.add_argument("--turn-speed", type=float, default=0.75)
    parser.add_argument("--rotation-timeout", type=float, default=8.0)
    parser.add_argument("--control-period", type=float, default=0.2)
    parser.add_argument("--map-growth-cells", type=int, default=20)
    parser.add_argument("--no-growth-timeout", type=float, default=60.0)
    parser.add_argument("--max-session-duration", type=float, default=900.0)
    parser.add_argument("--linear-deadband", type=float, default=0.025)
    parser.add_argument("--angular-deadband", type=float, default=0.12)
    parser.add_argument("--linear-full-scale", type=float, default=0.26)
    parser.add_argument("--angular-full-scale", type=float, default=1.0)
    parser.add_argument(
        "--rotation-dominance-ratio",
        type=float,
        default=1.25,
    )
    parser.add_argument("--cmd-vel-max-gap", type=float, default=0.5)
    parser.add_argument("--startup-timeout", type=float, default=120.0)
    parser.add_argument("--map-timeout", type=float, default=15.0)
    parser.add_argument("--scan-pause-after", type=float, default=2.0)
    parser.add_argument("--scan-timeout", type=float, default=120.0)
    parser.add_argument("--pose-timeout", type=float, default=20.0)
    args = parser.parse_args()
    try:
        import rclpy
    except ImportError as error:
        raise SystemExit(f"rclpy unavailable: {error}")
    rclpy.init(args=None)
    try:
        lock_token = acquire_explorer_lock(args.lock_file)
    except RuntimeError as error:
        raise SystemExit(str(error))
    try:
        FrontierExplorer(args).spin()
    finally:
        try:
            if rclpy.ok():
                rclpy.shutdown()
        finally:
            release_explorer_lock(args.lock_file, lock_token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
