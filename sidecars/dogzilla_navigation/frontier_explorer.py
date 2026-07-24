#!/usr/bin/env python3
"""Conservative Cartographer frontier exploration using Nav2 goals only."""

from __future__ import annotations

import argparse
import json
import math
import os
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any

def _is_free(value: int) -> bool:
    return 0 <= value <= 50


def _is_unknown(value: int) -> bool:
    return value < 0


def _index(x: int, y: int, width: int) -> int:
    return y * width + x


def _in_bounds(x: int, y: int, width: int, height: int) -> bool:
    return 0 <= x < width and 0 <= y < height


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
    """Classify controller intent using the gait adapter's normalized scales."""
    linear_magnitude = abs(float(linear_x))
    angular_magnitude = abs(float(angular_z))
    linear_active = linear_magnitude >= max(0.0, float(linear_deadband))
    angular_active = angular_magnitude >= max(0.0, float(angular_deadband))
    normalized_linear = linear_magnitude / max(float(linear_full_scale), 1e-6)
    normalized_angular = angular_magnitude / max(float(angular_full_scale), 1e-6)
    rotation_dominant = angular_active and (
        not linear_active
        or normalized_angular
        >= normalized_linear * max(float(rotation_dominance_ratio), 1.0)
    )
    return {
        # The gait adapter still emits a physical x_step for mixed commands.
        # Keep translation proof independent from the anti-spin classification.
        "translating": linear_active,
        "rotationDominant": rotation_dominant,
        "normalizedLinear": normalized_linear,
        "normalizedAngular": normalized_angular,
    }


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
    """Create exclusive job lock, replacing only a lock left by a dead process."""
    lock_path = Path(path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    payload = json.dumps({"pid": os.getpid(), "token": token, "startedAt": time.time()}) + "\n"
    for _ in range(2):
        try:
            descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            try:
                owner = json.loads(lock_path.read_text(encoding="utf-8"))
                owner_pid = int(owner.get("pid"))
            except (OSError, TypeError, ValueError, json.JSONDecodeError):
                owner_pid = 0
            if owner_pid > 0 and _process_is_running(owner_pid):
                raise RuntimeError(f"another frontier explorer is running (pid {owner_pid})")
            try:
                lock_path.unlink()
            except FileNotFoundError:
                pass
            continue
        with os.fdopen(descriptor, "w", encoding="utf-8") as lock_file:
            lock_file.write(payload)
        return token
    raise RuntimeError("could not acquire frontier explorer lock")


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


def _cancel_acknowledged(response: Any) -> bool:
    # A goal that already reached a terminal state is not returned in
    # goals_canceling, but CancelGoal still reports success (return_code 0).
    return int(getattr(response, "return_code", -1)) == 0 or bool(getattr(response, "goals_canceling", None))


def _angular_distance(first: float, second: float) -> float:
    return abs((first - second + math.pi) % (2.0 * math.pi) - math.pi)


def _nearest_free(cells: list[int], width: int, height: int, start_x: int, start_y: int) -> tuple[int, int] | None:
    if not _in_bounds(start_x, start_y, width, height):
        return None
    queue: deque[tuple[int, int]] = deque([(start_x, start_y)])
    seen = {(start_x, start_y)}
    while queue:
        x, y = queue.popleft()
        if _is_free(cells[_index(x, y, width)]):
            return x, y
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if _in_bounds(nx, ny, width, height) and (nx, ny) not in seen:
                seen.add((nx, ny))
                queue.append((nx, ny))
    return None


def _has_clearance(cells: list[int], width: int, height: int, x: int, y: int, clearance_cells: int) -> bool:
    for cy in range(y - clearance_cells, y + clearance_cells + 1):
        for cx in range(x - clearance_cells, x + clearance_cells + 1):
            if not _in_bounds(cx, cy, width, height):
                return False
            value = cells[_index(cx, cy, width)]
            if value > 50:
                return False
    return True


def select_frontier_goal(
    cells: list[int],
    width: int,
    height: int,
    *,
    resolution: float,
    origin_x: float,
    origin_y: float,
    robot_x: float,
    robot_y: float,
    robot_yaw: float | None = None,
    min_distance: float,
    max_distance: float,
    clearance_cells: int,
    excluded_goals: list[dict[str, float]] | None = None,
    exclusion_radius: float = 0.0,
) -> dict[str, float | int] | None:
    """Choose a reachable, clear free cell adjacent to unknown space."""
    if width <= 0 or height <= 0 or len(cells) != width * height or resolution <= 0:
        return None

    start_x = int(math.floor((robot_x - origin_x) / resolution))
    start_y = int(math.floor((robot_y - origin_y) / resolution))
    start = _nearest_free(cells, width, height, start_x, start_y)
    if start is None:
        return None

    queue: deque[tuple[int, int]] = deque([start])
    seen = {start}
    best: dict[str, float | int] | None = None
    best_score: tuple[float, ...] | None = None

    while queue:
        x, y = queue.popleft()
        unknown_neighbors = 0
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if not _in_bounds(nx, ny, width, height):
                continue
            value = cells[_index(nx, ny, width)]
            if _is_unknown(value):
                unknown_neighbors += 1
            elif _is_free(value) and (nx, ny) not in seen:
                seen.add((nx, ny))
                queue.append((nx, ny))

        if unknown_neighbors == 0 or not _has_clearance(cells, width, height, x, y, clearance_cells):
            continue
        world_x = origin_x + (x + 0.5) * resolution
        world_y = origin_y + (y + 0.5) * resolution
        distance = math.hypot(world_x - robot_x, world_y - robot_y)
        if distance <= min_distance or distance > max_distance:
            continue
        if any(
            math.hypot(world_x - failed["x"], world_y - failed["y"]) < exclusion_radius
            for failed in (excluded_goals or [])
        ):
            continue
        if robot_yaw is None:
            score = (-distance, float(unknown_neighbors))
            heading_error = None
            heading_alignment = None
        else:
            goal_bearing = math.atan2(world_y - robot_y, world_x - robot_x)
            heading_error = _angular_distance(goal_bearing, robot_yaw)
            heading_alignment = math.cos(heading_error)
            # Prefer continuing through the current forward half-plane. For
            # this slow quadruped, take the nearest incremental frontier
            # instead of gambling the whole pass on a multi-meter leg.
            score = (
                1.0 if heading_alignment >= 0.0 else 0.0,
                -distance,
                heading_alignment,
                float(unknown_neighbors),
            )
        if best_score is None or score > best_score:
            best_score = score
            best = {
                "x": world_x,
                "y": world_y,
                "distance": distance,
                "unknownNeighbors": unknown_neighbors,
                "cellX": x,
                "cellY": y,
            }
            if heading_error is not None:
                best["headingError"] = heading_error
                best["headingAlignment"] = heading_alignment
    return best


class FrontierExplorer:
    def __init__(self, args: argparse.Namespace) -> None:
        import rclpy
        from geometry_msgs.msg import PoseStamped, Twist
        from nav2_msgs.action import NavigateToPose
        from nav_msgs.msg import OccupancyGrid
        from rclpy.action import ActionClient
        from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
        from sensor_msgs.msg import LaserScan
        from tf2_ros import Buffer, TransformListener

        self._rclpy = rclpy
        self._PoseStamped = PoseStamped
        self._NavigateToPose = NavigateToPose
        self.args = args
        self.node = rclpy.create_node("robodoge_frontier_explorer")
        self.map_message: Any | None = None
        self.started_monotonic = time.monotonic()
        self.action_wait_started = 0.0
        self.map_received_at = 0.0
        self.scan_received_at = 0.0
        self.pose_missing_at = 0.0
        self.goal_handle: Any | None = None
        self.current_goal: dict[str, float | int] | None = None
        self.cancelled_goal_keys: set[tuple[float, float]] = set()
        self.goal_started_at = 0.0
        self.goal_last_pose: tuple[float, float] | None = None
        self.goal_displacement = 0.0
        self.session_max_goal_displacement = 0.0
        self.session_translation_command_sec = 0.0
        self.cmd_vel_last_at = 0.0
        self.cmd_vel_translating = False
        self.cmd_vel_rotation_dominant = False
        self.last_cmd_vel: dict[str, float | bool] = {}
        self.goal_rotation_dominant_command_sec = 0.0
        self.goal_count = 0
        self.successful_goal_count = 0
        self.failures = 0
        self.failed_goals: list[dict[str, float]] = []
        self.stalled_goals: list[dict[str, float]] = []
        self.no_frontier_cycles = 0
        self.finished = False
        self.cancel_future: Any | None = None
        self.cancel_deadline = 0.0
        self.pending_finish: tuple[str, str] | None = None
        self.status: dict[str, Any] = {"state": "starting", "startedAt": time.time(), "pid": os.getpid()}
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self.node)
        self.action_client = ActionClient(self.node, NavigateToPose, args.action)
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
        self.node.create_subscription(OccupancyGrid, args.map_topic, self._on_map, map_qos)
        self.node.create_subscription(LaserScan, args.scan_topic, self._on_scan, scan_qos)
        self.node.create_subscription(Twist, args.cmd_vel_topic, self._on_cmd_vel, 10)
        self.node.create_timer(1.0, self._tick)
        self._write_status()

    def _on_map(self, message: Any) -> None:
        self.map_message = message
        self.map_received_at = time.monotonic()

    def _on_scan(self, message: Any) -> None:
        self.scan_received_at = time.monotonic()

    def _on_cmd_vel(self, message: Any) -> None:
        """Track the guarded command that actually reaches the gait adapter."""
        now = time.monotonic()
        command_gap = max(0.0, now - self.cmd_vel_last_at) if self.cmd_vel_last_at > 0.0 else 0.0
        if self.current_goal is not None and self.cmd_vel_translating and self.cmd_vel_last_at > 0.0:
            elapsed = min(command_gap, self.args.cmd_vel_max_gap)
            self.session_translation_command_sec += elapsed
        if (
            self.current_goal is not None
            and self.cmd_vel_rotation_dominant
            and self.cmd_vel_last_at > 0.0
        ):
            elapsed = min(command_gap, self.args.cmd_vel_max_gap)
            self.goal_rotation_dominant_command_sec += elapsed

        linear_x = float(message.linear.x)
        angular_z = float(message.angular.z)
        motion = classify_cmd_vel(
            linear_x,
            angular_z,
            linear_deadband=self.args.linear_deadband,
            angular_deadband=self.args.angular_deadband,
            linear_full_scale=self.args.linear_full_scale,
            angular_full_scale=self.args.angular_full_scale,
            rotation_dominance_ratio=self.args.rotation_dominance_ratio,
        )
        self.cmd_vel_translating = bool(motion["translating"])
        self.cmd_vel_rotation_dominant = bool(motion["rotationDominant"])
        self.last_cmd_vel = {
            "linearX": linear_x,
            "angularZ": angular_z,
            **motion,
        }
        self.cmd_vel_last_at = now

    def _write_status(self) -> None:
        path = Path(self.args.status_file)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            **self.status,
            "mapTopic": self.args.map_topic,
            "scanTopic": self.args.scan_topic,
            "cmdVelTopic": self.args.cmd_vel_topic,
            "goalCount": self.goal_count,
            "successfulGoalCount": self.successful_goal_count,
            "failures": self.failures,
            "failedGoals": self.failed_goals,
            "stalledGoals": self.stalled_goals,
            "goalDisplacement": self.goal_displacement,
            "sessionMaxGoalDisplacement": self.session_max_goal_displacement,
            "sessionTranslationCommandSec": self.session_translation_command_sec,
            "goalRotationDominantCommandSec": self.goal_rotation_dominant_command_sec,
            "cmdVelTranslating": self.cmd_vel_translating,
            "cmdVelRotationDominant": self.cmd_vel_rotation_dominant,
            "lastCmdVel": self.last_cmd_vel,
            "scanAgeSec": (
                max(0.0, time.monotonic() - self.scan_received_at)
                if self.scan_received_at > 0.0
                else None
            ),
            "updatedAt": time.time(),
        }
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)

    def _finish_now(self, state: str, reason: str) -> None:
        if self.finished:
            return
        self.status.update({"state": state, "reason": reason, "finishedAt": time.time()})
        self._write_status()
        self.finished = True

    def _finish(self, state: str, reason: str) -> None:
        if self.finished or self.pending_finish is not None:
            return
        self.pending_finish = (state, reason)
        if not self._cancel_goal():
            self.pending_finish = None
            self._finish_now(state, reason)
            return
        self.status.update({"state": "stopping", "reason": "waiting for Nav2 goal cancellation"})
        self._write_status()

    def _robot_pose(self) -> tuple[float, float] | None:
        try:
            transform = self.tf_buffer.lookup_transform("map", self.args.base_frame, self._rclpy.time.Time())
            translation = transform.transform.translation
            return float(translation.x), float(translation.y)
        except Exception:
            return None

    def _robot_yaw(self) -> float | None:
        try:
            transform = self.tf_buffer.lookup_transform("map", self.args.base_frame, self._rclpy.time.Time())
            rotation = transform.transform.rotation
            return math.atan2(
                2.0 * (float(rotation.w) * float(rotation.z) + float(rotation.x) * float(rotation.y)),
                1.0 - 2.0 * (float(rotation.y) ** 2 + float(rotation.z) ** 2),
            )
        except Exception:
            return None

    def _cancel_goal(self) -> bool:
        if self.cancel_future is not None:
            return True
        handle = self.goal_handle
        if handle is None:
            self.goal_started_at = 0.0
            self.goal_last_pose = None
            self.goal_rotation_dominant_command_sec = 0.0
            self.current_goal = None
            return False
        goal = self.current_goal
        goal_key = self._goal_key(goal) if goal is not None else None
        cancel_error: str | None = None
        try:
            self.cancel_future = handle.cancel_goal_async()
        except Exception as error:
            cancel_error = f"Nav2 goal cancellation failed: {error}"
        self.goal_handle = None
        self.goal_started_at = 0.0
        self.goal_last_pose = None
        self.goal_rotation_dominant_command_sec = 0.0
        if goal_key is not None:
            self.cancelled_goal_keys.add(goal_key)
        self.current_goal = None
        if cancel_error is not None:
            self._continue_after_unconfirmed_cancel(cancel_error)
            return False
        self.cancel_deadline = time.monotonic() + max(0.1, self.args.cancel_timeout)
        return True

    @staticmethod
    def _goal_key(goal: dict[str, float | int]) -> tuple[float, float]:
        return round(float(goal["x"]), 3), round(float(goal["y"]), 3)

    def _record_goal_failure(self, goal: dict[str, float | int], reason: str) -> None:
        if not any(
            math.hypot(float(goal["x"]) - failed["x"], float(goal["y"]) - failed["y"])
            < self.args.failed_goal_radius
            for failed in self.failed_goals
        ):
            self.failed_goals.append({"x": float(goal["x"]), "y": float(goal["y"]), "reason": reason})
            self.failures += 1
        self.status.update({"state": "waiting", "lastError": reason})
        self._write_status()

    def _record_goal_stall(self, goal: dict[str, float | int], reason: str) -> None:
        if not any(
            math.hypot(float(goal["x"]) - stalled["x"], float(goal["y"]) - stalled["y"])
            < self.args.failed_goal_radius
            for stalled in self.stalled_goals
        ):
            self.stalled_goals.append({"x": float(goal["x"]), "y": float(goal["y"]), "reason": reason})
        self.status.update({"state": "waiting", "lastError": reason, "goalFailureType": "stall_observed"})
        self._write_status()

    def _continue_after_unconfirmed_cancel(self, reason: str) -> bool:
        self.cancel_future = None
        finishing = self.pending_finish is not None
        self.status.update({
            "state": "stopping" if finishing else "waiting",
            "reason": (
                "finishing after unconfirmed Nav2 cancellation"
                if finishing
                else "retargeting after unconfirmed Nav2 cancellation"
            ),
            "lastError": reason,
        })
        self._write_status()
        return True

    def _wait_for_goal_cancellation(self) -> bool:
        if self.cancel_future is None:
            return True
        if not self.cancel_future.done():
            if time.monotonic() >= self.cancel_deadline:
                return self._continue_after_unconfirmed_cancel("Nav2 did not acknowledge goal cancellation")
            return False
        future = self.cancel_future
        self.cancel_future = None
        try:
            response = future.result()
        except Exception as error:
            return self._continue_after_unconfirmed_cancel(f"Nav2 goal cancellation failed: {error}")
        if not _cancel_acknowledged(response):
            return self._continue_after_unconfirmed_cancel("Nav2 did not acknowledge goal cancellation")
        return True

    def _on_goal_response(self, future: Any, goal: dict[str, float | int]) -> None:
        try:
            handle = future.result()
        except Exception as error:
            if self.finished or self.current_goal is None or self._goal_key(goal) != self._goal_key(self.current_goal):
                return
            self.goal_handle = None
            self.current_goal = None
            self._record_goal_failure(goal, str(error))
            return
        goal_key = self._goal_key(goal)
        current_key = self._goal_key(self.current_goal) if self.current_goal is not None else None
        if self.finished or current_key != goal_key or goal_key in self.cancelled_goal_keys:
            if handle is not None and getattr(handle, "accepted", False):
                try:
                    handle.cancel_goal_async()
                except Exception:
                    pass
            self.cancelled_goal_keys.discard(goal_key)
            return
        if not handle or not handle.accepted:
            self.goal_handle = None
            self.current_goal = None
            self._record_goal_failure(goal, "Nav2 rejected frontier goal")
            return
        self.goal_handle = handle
        result_future = handle.get_result_async()
        result_future.add_done_callback(lambda result, sent_goal=goal: self._on_goal_result(result, sent_goal))

    def _on_goal_result(self, future: Any, goal: dict[str, float | int]) -> None:
        goal_key = self._goal_key(goal)
        if goal_key in self.cancelled_goal_keys:
            self.cancelled_goal_keys.discard(goal_key)
            return
        if self.finished or self.current_goal is None or goal_key != self._goal_key(self.current_goal):
            return
        self.goal_handle = None
        self.current_goal = None
        self.goal_started_at = 0.0
        self.goal_last_pose = None
        self.goal_rotation_dominant_command_sec = 0.0
        failure_reason = "Nav2 frontier goal failed"
        try:
            result = future.result()
            result_status = int(getattr(result, "status", 0))
            succeeded = result_status == 4
        except Exception as error:
            succeeded = False
            result_status = 0
            failure_reason = str(error)
        if succeeded:
            self.successful_goal_count += 1
            self.status.update({"state": "waiting", "reason": "frontier goal reached"})
            self.status.pop("lastError", None)
            self.status.pop("goalFailureType", None)
            self._write_status()
        else:
            self._record_goal_failure(goal, failure_reason if result_status == 0 else f"Nav2 frontier goal failed with status {result_status}")

    def _send_goal(self, goal: dict[str, float | int]) -> None:
        if not self.action_client.wait_for_server(timeout_sec=1.0):
            now = time.monotonic()
            if self.action_wait_started == 0.0:
                self.action_wait_started = now
            if now - self.action_wait_started >= self.args.action_timeout:
                self._finish("stopped", "Nav2 action server unavailable")
            else:
                self.status.update({"state": "waiting", "lastError": "Waiting for Nav2 action server"})
                self._write_status()
            return
        self.action_wait_started = 0.0
        message = self._NavigateToPose.Goal()
        pose = self._PoseStamped()
        pose.header.frame_id = "map"
        pose.header.stamp = self.node.get_clock().now().to_msg()
        pose.pose.position.x = float(goal["x"])
        pose.pose.position.y = float(goal["y"])
        pose.pose.orientation.w = 1.0
        message.pose = pose
        self.goal_started_at = time.monotonic()
        self.goal_last_pose = self._robot_pose()
        self.goal_displacement = 0.0
        self.goal_rotation_dominant_command_sec = 0.0
        self.current_goal = goal
        self.goal_count += 1
        self.status.update({"state": "navigating", "goal": goal, "goalDisplacement": 0.0, "sessionMaxGoalDisplacement": self.session_max_goal_displacement})
        self.status.pop("reason", None)
        self.status.pop("lastError", None)
        self.status.pop("goalFailureType", None)
        self._write_status()
        self.action_client.send_goal_async(message).add_done_callback(
            lambda response, sent_goal=goal: self._on_goal_response(response, sent_goal)
        )

    def _select_goal(
        self,
        pose: tuple[float, float],
        *,
        include_failures: bool = True,
    ) -> dict[str, float | int] | None:
        info = self.map_message.info
        return select_frontier_goal(
            list(self.map_message.data),
            int(info.width),
            int(info.height),
            resolution=float(info.resolution),
            origin_x=float(info.origin.position.x),
            origin_y=float(info.origin.position.y),
            robot_x=pose[0],
            robot_y=pose[1],
            robot_yaw=self._robot_yaw(),
            min_distance=self.args.min_goal_distance,
            max_distance=self.args.max_goal_distance,
            clearance_cells=max(0, int(math.ceil(self.args.goal_clearance / float(info.resolution)))),
            excluded_goals=(
                self.failed_goals + self.stalled_goals
                if include_failures
                else []
            ),
            exclusion_radius=self.args.failed_goal_radius,
        )

    def _tick(self) -> None:
        if self.finished:
            return
        if self.pending_finish is not None or self.cancel_future is not None:
            return
        if Path(self.args.stop_file).exists():
            self._finish("stopped", "stop requested")
            return
        now = time.monotonic()
        if self.map_message is None:
            if now - self.started_monotonic > self.args.action_timeout:
                self._finish("stopped", "live SLAM map is stale")
            return
        if now - self.map_received_at > self.args.map_timeout:
            self._finish("stopped", "live SLAM map is stale")
            return
        if self.scan_received_at == 0:
            if now - self.started_monotonic > self.args.scan_timeout:
                self._finish("stopped", "LiDAR scan is stale")
            return
        scan_age = now - self.scan_received_at
        if scan_age > self.args.scan_timeout:
            self._finish("stopped", "LiDAR scan is stale")
            return
        if scan_age > self.args.scan_pause_after:
            self.status.update({
                "state": "waiting",
                "reason": "waiting for LiDAR scan recovery",
                "lastError": f"LiDAR scan has been stale for {scan_age:.1f} seconds",
            })
            self._write_status()
            if self.current_goal is not None:
                self._cancel_goal()
            return
        if self.current_goal is not None:
            if self.goal_handle is None:
                if now - self.goal_started_at > self.args.action_timeout:
                    self._record_goal_stall(self.current_goal, "Nav2 goal response timed out")
                    self._cancel_goal()
                return
            pose = self._robot_pose()
            if pose is None:
                if self.pose_missing_at == 0.0:
                    self.pose_missing_at = now
                if now - self.pose_missing_at > self.args.pose_timeout:
                    self._finish("stopped", "map to base_link transform unavailable")
                return
            self.pose_missing_at = 0.0
            goal = self.current_goal
            if goal is not None:
                if self.goal_last_pose is not None:
                    moved = math.hypot(pose[0] - self.goal_last_pose[0], pose[1] - self.goal_last_pose[1])
                    if moved >= 0.05:
                        self.goal_displacement += moved
                        self.session_max_goal_displacement = max(
                            self.session_max_goal_displacement,
                            self.goal_displacement,
                        )
                        self.goal_last_pose = pose
                        self.status.update({
                            "goalDisplacement": self.goal_displacement,
                            "sessionMaxGoalDisplacement": self.session_max_goal_displacement,
                        })
                        self._write_status()
                else:
                    self.goal_last_pose = pose
                rotation_command_sec = self.goal_rotation_dominant_command_sec
                if rotation_command_sec >= self.args.rotation_timeout:
                    self._record_goal_stall(
                        goal,
                        "frontier goal accumulated rotation-dominant commands without approach "
                        f"for {rotation_command_sec:.1f} seconds",
                    )
                    self._cancel_goal()
                    return
            if now - self.goal_started_at > self.args.goal_max_duration:
                if goal is not None:
                    self._record_goal_stall(goal, "frontier goal exceeded maximum duration; Nav2 result not yet failed")
                self._cancel_goal()
            return
        if self.goal_count >= self.args.max_goals:
            self._finish("complete", "goal limit reached")
            return
        pose = self._robot_pose()
        if pose is None:
            if self.pose_missing_at == 0.0:
                self.pose_missing_at = now
            if now - self.pose_missing_at > self.args.pose_timeout:
                self._finish("stopped", "map to base_link transform unavailable")
            else:
                self.status.update({"state": "waiting", "reason": "waiting for map to base_link transform"})
                self._write_status()
            return
        self.pose_missing_at = 0.0
        goal = self._select_goal(pose)
        if goal is None:
            reachable_frontier = self._select_goal(pose, include_failures=False)
            self.no_frontier_cycles += 1
            reason = (
                "no safe reachable frontier"
                if reachable_frontier is None
                else "reachable frontiers remain only at skipped destinations"
            )
            self.status.update({"state": "waiting", "reason": reason})
            self._write_status()
            if self.no_frontier_cycles >= self.args.complete_after_no_frontier:
                if reachable_frontier is not None:
                    self._finish("stopped", reason)
                elif self.successful_goal_count > 0:
                    self._finish("complete", reason)
                else:
                    self._finish(
                        "stopped",
                        "no safe reachable frontier before any navigation goal succeeded",
                    )
            return
        self.no_frontier_cycles = 0
        self._send_goal(goal)

    def spin(self) -> None:
        try:
            while self._rclpy.ok() and not self.finished:
                self._rclpy.spin_once(self.node, timeout_sec=0.2)
                if self.pending_finish is not None and self._wait_for_goal_cancellation():
                    state, reason = self.pending_finish
                    self.pending_finish = None
                    self._finish_now(state, reason)
                elif self.cancel_future is not None:
                    self._wait_for_goal_cancellation()
        finally:
            if self.goal_handle is not None:
                self._cancel_goal()
            self.node.destroy_node()


def main() -> int:
    parser = argparse.ArgumentParser(description="Conservative Nav2 frontier explorer")
    parser.add_argument("--map-topic", default="/map_cartographer")
    parser.add_argument("--scan-topic", default="/scan_nav2")
    parser.add_argument("--cmd-vel-topic", default="/cmd_vel")
    parser.add_argument("--action", default="navigate_to_pose")
    parser.add_argument("--base-frame", default="base_link")
    parser.add_argument("--status-file", required=True)
    parser.add_argument("--stop-file", required=True)
    parser.add_argument("--lock-file", required=True)
    parser.add_argument("--min-goal-distance", type=float, default=0.35)
    parser.add_argument("--max-goal-distance", type=float, default=5.0)
    parser.add_argument("--goal-clearance", type=float, default=0.25)
    parser.add_argument("--failed-goal-radius", type=float, default=0.5)
    parser.add_argument("--goal-max-duration", type=float, default=90.0)
    parser.add_argument("--linear-deadband", type=float, default=0.025)
    parser.add_argument("--angular-deadband", type=float, default=0.12)
    parser.add_argument("--linear-full-scale", type=float, default=0.26)
    parser.add_argument("--angular-full-scale", type=float, default=1.0)
    parser.add_argument("--rotation-dominance-ratio", type=float, default=1.25)
    parser.add_argument("--rotation-timeout", type=float, default=8.0)
    parser.add_argument("--cmd-vel-max-gap", type=float, default=0.5)
    parser.add_argument("--action-timeout", type=float, default=120.0)
    parser.add_argument("--cancel-timeout", type=float, default=2.0)
    parser.add_argument("--map-timeout", type=float, default=8.0)
    parser.add_argument("--scan-pause-after", type=float, default=2.0)
    parser.add_argument("--scan-timeout", type=float, default=120.0)
    parser.add_argument("--pose-timeout", type=float, default=20.0)
    parser.add_argument("--max-goals", type=int, default=80)
    parser.add_argument("--complete-after-no-frontier", type=int, default=30)
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
        explorer = FrontierExplorer(args)
        explorer.spin()
    finally:
        try:
            if rclpy.ok():
                rclpy.shutdown()
        finally:
            release_explorer_lock(args.lock_file, lock_token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
