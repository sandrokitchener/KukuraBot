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


def _process_is_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
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
    return bool(getattr(response, "goals_canceling", None))


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
    min_distance: float,
    max_distance: float,
    clearance_cells: int,
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
    best_score: tuple[int, float] | None = None

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
        score = (-distance, unknown_neighbors)
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
    return best


class FrontierExplorer:
    def __init__(self, args: argparse.Namespace) -> None:
        import rclpy
        from geometry_msgs.msg import PoseStamped
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
        self.goal_started_at = 0.0
        self.goal_count = 0
        self.failures = 0
        self.no_frontier_cycles = 0
        self.finished = False
        self.cancel_future: Any | None = None
        self.cancel_deadline = 0.0
        self.cancel_timeout_reported = False
        self.cancellation_failed = False
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
        self.node.create_timer(1.0, self._tick)
        self._write_status()

    def _on_map(self, message: Any) -> None:
        self.map_message = message
        self.map_received_at = time.monotonic()

    def _on_scan(self, _message: Any) -> None:
        self.scan_received_at = time.monotonic()

    def _write_status(self) -> None:
        path = Path(self.args.status_file)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            **self.status,
            "mapTopic": self.args.map_topic,
            "scanTopic": self.args.scan_topic,
            "goalCount": self.goal_count,
            "failures": self.failures,
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

    def _cancel_goal(self) -> bool:
        if self.cancel_future is not None:
            return True
        handle = self.goal_handle
        self.goal_handle = None
        self.goal_started_at = 0.0
        if handle is None:
            return False
        try:
            self.cancel_future = handle.cancel_goal_async()
        except Exception as error:
            self.cancellation_failed = True
            self.status["lastError"] = f"Nav2 goal cancellation failed: {error}"
            self._write_status()
            return True
        self.cancel_deadline = time.monotonic() + max(0.1, self.args.cancel_timeout)
        self.cancel_timeout_reported = False
        return True

    def _wait_for_goal_cancellation(self) -> bool:
        if self.cancellation_failed:
            return False
        if self.cancel_future is None:
            return True
        if not self.cancel_future.done():
            if time.monotonic() >= self.cancel_deadline and not self.cancel_timeout_reported:
                self.cancel_timeout_reported = True
                self.status.update({"state": "stopping", "lastError": "Nav2 did not acknowledge goal cancellation"})
                self._write_status()
            return False
        future = self.cancel_future
        self.cancel_future = None
        try:
            response = future.result()
        except Exception as error:
            self.cancellation_failed = True
            self.status["lastError"] = f"Nav2 goal cancellation failed: {error}"
            self._write_status()
            return False
        if not _cancel_acknowledged(response):
            self.cancellation_failed = True
            self.status["lastError"] = "Nav2 did not acknowledge goal cancellation"
            self._write_status()
            return False
        return True

    def _on_goal_response(self, future: Any) -> None:
        try:
            handle = future.result()
        except Exception as error:
            self.goal_handle = None
            self.failures += 1
            self.status.update({"state": "waiting", "lastError": str(error)})
            return
        if not handle or not handle.accepted:
            self.goal_handle = None
            self.failures += 1
            self.status.update({"state": "waiting", "lastError": "Nav2 rejected frontier goal"})
            return
        self.goal_handle = handle
        result_future = handle.get_result_async()
        result_future.add_done_callback(self._on_goal_result)

    def _on_goal_result(self, future: Any) -> None:
        self.goal_handle = None
        self.goal_started_at = 0.0
        try:
            result = future.result()
            succeeded = int(getattr(result, "status", 0)) == 4
        except Exception as error:
            succeeded = False
            self.status["lastError"] = str(error)
        self.failures = 0 if succeeded else self.failures + 1
        self.status["state"] = "waiting"
        self._write_status()

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
        self.goal_count += 1
        self.status.update({"state": "navigating", "goal": goal})
        self._write_status()
        self.action_client.send_goal_async(message).add_done_callback(self._on_goal_response)

    def _tick(self) -> None:
        if self.finished:
            return
        if self.pending_finish is not None or self.cancel_future is not None or self.cancellation_failed:
            return
        if Path(self.args.stop_file).exists():
            self._finish("stopped", "stop requested")
            return
        now = time.monotonic()
        if self.map_message is None:
            if now - self.started_monotonic > self.args.map_timeout:
                self._finish("stopped", "live SLAM map is stale")
            return
        if now - self.map_received_at > self.args.map_timeout:
            self._finish("stopped", "live SLAM map is stale")
            return
        if self.scan_received_at == 0:
            if now - self.started_monotonic > self.args.scan_timeout:
                self._finish("stopped", "LiDAR scan is stale")
            return
        if now - self.scan_received_at > self.args.scan_timeout:
            self._finish("stopped", "LiDAR scan is stale")
            return
        if self.failures >= self.args.max_failures:
            self._finish("stopped", "too many Nav2 frontier failures")
            return
        if self.goal_handle is not None:
            if now - self.goal_started_at > self.args.goal_timeout:
                self._cancel_goal()
                self.status.update({"state": "waiting", "lastError": "frontier goal timed out"})
                self._write_status()
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
        info = self.map_message.info
        goal = select_frontier_goal(
            list(self.map_message.data),
            int(info.width),
            int(info.height),
            resolution=float(info.resolution),
            origin_x=float(info.origin.position.x),
            origin_y=float(info.origin.position.y),
            robot_x=pose[0],
            robot_y=pose[1],
            min_distance=self.args.min_goal_distance,
            max_distance=self.args.max_goal_distance,
            clearance_cells=max(0, int(math.ceil(self.args.goal_clearance / float(info.resolution)))),
        )
        if goal is None:
            self.no_frontier_cycles += 1
            self.status.update({"state": "waiting", "reason": "no safe reachable frontier"})
            self._write_status()
            if self.no_frontier_cycles >= self.args.complete_after_no_frontier:
                self._finish("complete", "no safe reachable frontier")
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
    parser.add_argument("--action", default="navigate_to_pose")
    parser.add_argument("--base-frame", default="base_link")
    parser.add_argument("--status-file", required=True)
    parser.add_argument("--stop-file", required=True)
    parser.add_argument("--lock-file", required=True)
    parser.add_argument("--min-goal-distance", type=float, default=0.35)
    parser.add_argument("--max-goal-distance", type=float, default=5.0)
    parser.add_argument("--goal-clearance", type=float, default=0.25)
    parser.add_argument("--goal-timeout", type=float, default=90.0)
    parser.add_argument("--action-timeout", type=float, default=120.0)
    parser.add_argument("--cancel-timeout", type=float, default=10.0)
    parser.add_argument("--map-timeout", type=float, default=8.0)
    parser.add_argument("--scan-timeout", type=float, default=3.0)
    parser.add_argument("--pose-timeout", type=float, default=20.0)
    parser.add_argument("--max-goals", type=int, default=80)
    parser.add_argument("--max-failures", type=int, default=3)
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
