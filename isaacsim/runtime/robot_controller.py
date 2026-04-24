from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


ROOT_DIR = Path(r"C:\Users\sandr\OneDrive\Documents\Robo-Doge")
DEFAULT_CONTROLLER_CONFIG = ROOT_DIR / "config" / "robot-controller.json"


@dataclass
class Pose2D:
    x: float = 0.0
    y: float = 0.0
    yaw_degrees: float = 0.0


@dataclass
class BodyPose:
    height_offset: float = 0.0
    roll_degrees: float = 0.0
    pitch_degrees: float = 0.0


@dataclass
class NamedActionState:
    name: str
    action_id: str | int | None = None
    verified: bool = False
    play_mode: str = "once"
    duration_seconds: float = 1.0
    elapsed_seconds: float = 0.0

    def snapshot(self) -> dict[str, Any]:
        duration = max(self.duration_seconds, 1e-6)
        return {
            "name": self.name,
            "action_id": self.action_id,
            "verified": self.verified,
            "play_mode": self.play_mode,
            "duration_seconds": self.duration_seconds,
            "elapsed_seconds": self.elapsed_seconds,
            "progress": max(0.0, min(1.0, self.elapsed_seconds / duration)),
        }


@dataclass
class ControllerState:
    base_pose: Pose2D = field(default_factory=Pose2D)
    body_pose: BodyPose = field(default_factory=BodyPose)
    gait: str = "idle"
    target_waypoint: str = ""
    target_pose: Pose2D | None = None
    route: list[Pose2D] = field(default_factory=list)
    route_index: int = 0
    linear_x: float = 0.0
    linear_y: float = 0.0
    angular_z: float = 0.0
    status: str = "idle"
    active_action: NamedActionState | None = None
    debug_tick_counter: int = 0


class MemorySceneAdapter:
    def __init__(self):
        self.transforms: dict[str, dict[str, Any]] = {}

    def set_transform(self, prim_path: str, payload: dict[str, Any]) -> None:
        self.transforms[prim_path] = {**payload}

    def get_transform(self, prim_path: str) -> dict[str, Any]:
        return self.transforms.get(prim_path, {})


class RobotController:
    CONTROLLER_NAME = "robot controller"

    def __init__(self, controller_config_path: Path | str = DEFAULT_CONTROLLER_CONFIG, scene_adapter=None):
        self.controller_config_path = Path(controller_config_path)
        self.config = json.loads(self.controller_config_path.read_text(encoding="utf-8"))
        self.root_dir = self.controller_config_path.parents[1]
        self.motion = self.config["motion"]
        self.room_bounds = self.config.get("roomBounds", {})
        self.avoidance = self.config.get("avoidance", {})
        self.planner = self.config.get("planner", {})
        self.named_actions = self.config.get("namedActions", {})
        self.rig_root_prim = self.config["rigRootPrim"]
        self.body_prim = self.config["bodyPrim"]
        self.rig_visual_yaw_offset_degrees = float(self.config.get("rigVisualYawOffsetDegrees", 0.0))
        self.waypoints = self._load_waypoints()
        self.state = ControllerState()
        self.scene_adapter = scene_adapter or MemorySceneAdapter()
        self.debug_every_ticks = int(self.avoidance.get("debugEveryTicks", 20))

    def _load_waypoints(self) -> dict[str, Any]:
        path = self.root_dir / self.config["waypointsFile"]
        data = json.loads(path.read_text(encoding="utf-8"))
        active_set = data["activeSet"]
        return data["sets"][active_set]["waypoints"]

    def handle_command(self, envelope: dict[str, Any]) -> dict[str, Any]:
        action = envelope.get("action", "")
        payload = envelope.get("payload", {})

        if action == "robot_controller.goto_waypoint":
            return self.goto_waypoint(payload.get("waypointName"), payload.get("sceneWaypoint"))
        if action == "robot_controller.move_base":
            return self.move_base(
                linear_x=payload.get("linearX", 0.0),
                linear_y=payload.get("linearY", 0.0),
                angular_z=payload.get("angularZ", 0.0),
                gait=payload.get("gait", "idle"),
            )
        if action == "robot_controller.stop":
            return self.stop()
        if action == "robot_controller.pose_body":
            return self.pose_body(
                height_offset=payload.get("heightOffset", 0.0),
                roll_degrees=payload.get("rollDegrees", 0.0),
                pitch_degrees=payload.get("pitchDegrees", 0.0),
            )
        if action == "robot_controller.play_gait":
            return self.play_gait(payload.get("gait", "idle"))
        if action == "articulation.play_named_action":
            return self.play_named_action(
                action_name=payload.get("actionName"),
                action_id=payload.get("actionId"),
                verified=payload.get("actionVerified", False),
                play_mode=payload.get("playMode", "once"),
            )
        if action == "robot_controller.reset":
            return self.reset()

        return {"ok": False, "error": f"Unsupported action '{action}'"}

    def goto_waypoint(self, waypoint_name: str | None, scene_waypoint: dict[str, Any] | None = None) -> dict[str, Any]:
        if not waypoint_name:
            return {"ok": False, "error": "Missing waypoint name"}

        waypoint = scene_waypoint or self.waypoints.get(waypoint_name)
        if not waypoint:
            return {"ok": False, "error": f"Unknown waypoint '{waypoint_name}'"}

        if waypoint.get("special") == "stay_put":
            self.state.target_waypoint = waypoint_name
            self.state.target_pose = Pose2D(
                x=self.state.base_pose.x,
                y=self.state.base_pose.y,
                yaw_degrees=self.state.base_pose.yaw_degrees,
            )
            self.state.route = []
            self.state.route_index = 0
            self.state.status = "idle"
            return {"ok": True, "mode": "stay_put", "waypoint": waypoint_name}

        if waypoint.get("special"):
            return {"ok": False, "error": f"Special waypoint '{waypoint_name}' needs custom behavior"}

        position = waypoint.get("position", [0.0, 0.0, 0.0])
        yaw_degrees = waypoint.get("yawDegrees", self.state.base_pose.yaw_degrees)
        self.state.target_waypoint = waypoint_name
        self.state.target_pose = Pose2D(x=float(position[0]), y=float(position[1]), yaw_degrees=float(yaw_degrees))
        self.state.route = []
        self.state.route_index = 0
        self.state.linear_x = 0.0
        self.state.linear_y = 0.0
        self.state.angular_z = 0.0
        self.state.status = "moving_to_waypoint"
        self.state.gait = "idle"
        return {
            "ok": True,
            "action": "goto_waypoint",
            "waypoint": waypoint_name,
            "targetPose": {
                "x": self.state.target_pose.x,
                "y": self.state.target_pose.y,
                "yawDegrees": self.state.target_pose.yaw_degrees,
            },
        }

    def move_base(self, linear_x: float, linear_y: float, angular_z: float, gait: str = "idle") -> dict[str, Any]:
        self.state.target_pose = None
        self.state.target_waypoint = ""
        self.state.route = []
        self.state.route_index = 0
        self.state.linear_x = float(linear_x)
        self.state.linear_y = float(linear_y)
        self.state.angular_z = float(angular_z)
        self.state.gait = gait or "idle"
        self.state.status = "manual_move"
        return {
            "ok": True,
            "action": "move_base",
            "linearX": self.state.linear_x,
            "linearY": self.state.linear_y,
            "angularZ": self.state.angular_z,
            "gait": self.state.gait,
        }

    def stop(self) -> dict[str, Any]:
        self.state.linear_x = 0.0
        self.state.linear_y = 0.0
        self.state.angular_z = 0.0
        self.state.target_pose = None
        self.state.target_waypoint = ""
        self.state.route = []
        self.state.route_index = 0
        self.state.gait = "idle"
        self.state.status = "idle"
        return {"ok": True, "action": "stop"}

    def pose_body(self, height_offset: float = 0.0, roll_degrees: float = 0.0, pitch_degrees: float = 0.0) -> dict[str, Any]:
        self.state.body_pose = BodyPose(
            height_offset=float(height_offset),
            roll_degrees=float(roll_degrees),
            pitch_degrees=float(pitch_degrees),
        )
        return {"ok": True, "action": "pose_body", "bodyPose": self.state.body_pose.__dict__}

    def play_gait(self, gait: str) -> dict[str, Any]:
        self.state.gait = gait or "idle"
        if self.state.target_pose is None and self.state.gait == "idle":
            self.state.status = "idle"
        return {"ok": True, "action": "play_gait", "gait": self.state.gait}

    def play_named_action(
        self,
        action_name: str | None,
        action_id: str | int | None = None,
        verified: bool = False,
        play_mode: str = "once",
    ) -> dict[str, Any]:
        normalized_name = str(action_name or "").strip()
        if not normalized_name:
            return {"ok": False, "error": "Missing action name"}

        action_config = self.named_actions.get(normalized_name)
        if action_config is None:
            return {"ok": False, "error": f"Unknown named action '{normalized_name}'"}

        self.state.target_pose = None
        self.state.target_waypoint = ""
        self.state.route = []
        self.state.route_index = 0
        self.state.linear_x = 0.0
        self.state.linear_y = 0.0
        self.state.angular_z = 0.0
        self.state.gait = "idle"
        self.state.status = "playing_action"
        self.state.active_action = NamedActionState(
            name=normalized_name,
            action_id=action_id,
            verified=bool(verified),
            play_mode=play_mode or "once",
            duration_seconds=float(action_config.get("durationSeconds", 1.0)),
        )
        return {"ok": True, "action": "play_named_action", "namedAction": self.state.active_action.snapshot()}

    def reset(self) -> dict[str, Any]:
        self.state = ControllerState()
        self._apply_to_scene()
        return {"ok": True, "action": "reset"}

    def tick(self, dt_seconds: float, sensor_state: dict[str, Any] | None = None) -> dict[str, Any]:
        dt = max(float(dt_seconds), 1e-6)
        sensor_state = sensor_state or {}
        motion_state = self._build_motion_state(0.0, 0.0, 0.0)

        if self.state.active_action is not None:
            self.state.active_action.elapsed_seconds += dt
            if self.state.active_action.elapsed_seconds >= self.state.active_action.duration_seconds:
                self.state.active_action = None
                self.state.status = "idle"
        elif self.state.target_pose is not None:
            tolerance = float(self.motion["arrivalToleranceMeters"])
            obstacle_footprints = self._normalize_obstacle_footprints(sensor_state.get("obstacleFootprints"))
            if obstacle_footprints and not self.state.route and self.planner.get("enabled", True):
                self.state.route = self._plan_route(self.state.base_pose, self.state.target_pose, obstacle_footprints)
                self.state.route_index = 0

            route_target = self._get_route_target(tolerance)
            dx = route_target.x - self.state.base_pose.x
            dy = route_target.y - self.state.base_pose.y
            distance = math.hypot(dx, dy)
            final_distance = math.hypot(
                self.state.target_pose.x - self.state.base_pose.x,
                self.state.target_pose.y - self.state.base_pose.y,
            )

            if final_distance <= tolerance:
                self.state.base_pose.x = self.state.target_pose.x
                self.state.base_pose.y = self.state.target_pose.y
                self.state.base_pose.yaw_degrees = self.state.target_pose.yaw_degrees
                self.state.target_pose = None
                self.state.target_waypoint = ""
                self.state.route = []
                self.state.route_index = 0
                self.state.gait = "idle"
                self.state.status = "idle"
            else:
                speed = float(self.motion["linearSpeedMetersPerSecond"])
                desired_vx = (dx / distance) * speed
                desired_vy = (dy / distance) * speed
                velocity_x, velocity_y, debug = self._avoid_obstacles(
                    desired_vx,
                    desired_vy,
                    sensor_state.get("lidarFlatScan"),
                )
                next_x = self.state.base_pose.x + velocity_x * dt
                next_y = self.state.base_pose.y + velocity_y * dt
                self.state.base_pose.x, self.state.base_pose.y = self._clip_to_room(next_x, next_y)
                if math.hypot(velocity_x, velocity_y) > 1e-6:
                    self._advance_heading_toward_motion(velocity_x, velocity_y, dt)
                self.state.status = "moving_to_waypoint"
                self.state.gait = "walk"
                motion_state = self._build_motion_state(velocity_x, velocity_y, 0.0)
                self._emit_debug(debug, velocity_x, velocity_y)
        else:
            velocity_x, velocity_y, debug = self._avoid_obstacles(
                self.state.linear_x,
                self.state.linear_y,
                sensor_state.get("lidarFlatScan"),
            )
            next_x = self.state.base_pose.x + velocity_x * dt
            next_y = self.state.base_pose.y + velocity_y * dt
            self.state.base_pose.x, self.state.base_pose.y = self._clip_to_room(next_x, next_y)
            self.state.base_pose.yaw_degrees += self.state.angular_z * dt
            if abs(velocity_x) > 1e-6 or abs(velocity_y) > 1e-6 or abs(self.state.angular_z) > 1e-6:
                self.state.status = "manual_move"
                motion_state = self._build_motion_state(velocity_x, velocity_y, self.state.angular_z)
                self._emit_debug(debug, velocity_x, velocity_y)
            elif self.state.status != "playing_action":
                self.state.status = "idle"

        self._apply_to_scene()
        return self.snapshot(motion_state)

    def snapshot(self, motion_state: dict[str, float | bool] | None = None) -> dict[str, Any]:
        return {
            "controller": self.CONTROLLER_NAME,
            "status": self.state.status,
            "basePose": self.state.base_pose.__dict__,
            "bodyPose": self.state.body_pose.__dict__,
            "gait": self.state.gait,
            "targetWaypoint": self.state.target_waypoint,
            "routeRemaining": max(0, len(self.state.route) - self.state.route_index),
            "motion": motion_state or self._build_motion_state(0.0, 0.0, 0.0),
            "activeAction": self.state.active_action.snapshot() if self.state.active_action is not None else None,
        }

    def _apply_to_scene(self) -> None:
        self.scene_adapter.set_transform(
            self.rig_root_prim,
            {
                "translate": [self.state.base_pose.x, self.state.base_pose.y, 0.0],
                "yawDegrees": self.state.base_pose.yaw_degrees + self.rig_visual_yaw_offset_degrees,
            },
        )
        self.scene_adapter.set_transform(
            self.body_prim,
            {
                "heightOffset": self.state.body_pose.height_offset,
                "rollDegrees": self.state.body_pose.roll_degrees,
                "pitchDegrees": self.state.body_pose.pitch_degrees,
            },
        )

    def _build_motion_state(self, linear_x: float, linear_y: float, angular_z: float) -> dict[str, float | bool]:
        speed = math.hypot(float(linear_x), float(linear_y))
        yaw_radians = math.radians(self.state.base_pose.yaw_degrees)
        forward_speed = float(linear_x) * math.cos(yaw_radians) + float(linear_y) * math.sin(yaw_radians)
        lateral_speed = -float(linear_x) * math.sin(yaw_radians) + float(linear_y) * math.cos(yaw_radians)
        angular_speed = float(angular_z)
        return {
            "linearX": float(linear_x),
            "linearY": float(linear_y),
            "angularZ": angular_speed,
            "speed": speed,
            "forwardSpeed": forward_speed,
            "lateralSpeed": lateral_speed,
            "angularSpeed": angular_speed,
            "moving": speed > 1e-6 or abs(angular_speed) > 1e-6,
        }

    def _get_route_target(self, tolerance: float) -> Pose2D:
        if not self.state.route:
            return self.state.target_pose

        while self.state.route_index < len(self.state.route) - 1:
            waypoint = self.state.route[self.state.route_index]
            if math.hypot(waypoint.x - self.state.base_pose.x, waypoint.y - self.state.base_pose.y) > tolerance:
                break
            self.state.route_index += 1

        return self.state.route[self.state.route_index]

    def _plan_route(
        self,
        start: Pose2D,
        goal: Pose2D,
        obstacle_footprints: list[dict[str, Any]],
    ) -> list[Pose2D]:
        if not obstacle_footprints:
            return [Pose2D(goal.x, goal.y, goal.yaw_degrees)]

        cell_size = max(float(self.planner.get("cellSizeMeters", 0.12)), 0.04)
        min_x = float(self.room_bounds.get("minX", -2.5))
        max_x = float(self.room_bounds.get("maxX", 2.5))
        min_y = float(self.room_bounds.get("minY", -2.5))
        max_y = float(self.room_bounds.get("maxY", 2.5))
        max_columns = max(1, int(round((max_x - min_x) / cell_size)))
        max_rows = max(1, int(round((max_y - min_y) / cell_size)))

        def to_cell(x: float, y: float) -> tuple[int, int]:
            col = int(round((float(x) - min_x) / cell_size))
            row = int(round((float(y) - min_y) / cell_size))
            return max(0, min(max_columns, col)), max(0, min(max_rows, row))

        def to_world(cell: tuple[int, int]) -> tuple[float, float]:
            return min_x + cell[0] * cell_size, min_y + cell[1] * cell_size

        def in_bounds(cell: tuple[int, int]) -> bool:
            return 0 <= cell[0] <= max_columns and 0 <= cell[1] <= max_rows

        def blocked(cell: tuple[int, int]) -> bool:
            x, y = to_world(cell)
            return self._point_hits_obstacle(x, y, obstacle_footprints)

        start_cell = self._nearest_free_cell(to_cell(start.x, start.y), in_bounds, blocked)
        goal_cell = self._nearest_free_cell(to_cell(goal.x, goal.y), in_bounds, blocked)
        if start_cell is None or goal_cell is None:
            return [Pose2D(goal.x, goal.y, goal.yaw_degrees)]

        open_heap: list[tuple[float, int, tuple[int, int]]] = []
        open_heap.append((0.0, 0, start_cell))
        came_from: dict[tuple[int, int], tuple[int, int]] = {}
        costs: dict[tuple[int, int], float] = {start_cell: 0.0}
        visited: set[tuple[int, int]] = set()
        counter = 0
        neighbors = [
            (-1, -1), (-1, 0), (-1, 1),
            (0, -1), (0, 1),
            (1, -1), (1, 0), (1, 1),
        ]

        while open_heap:
            open_heap.sort(reverse=True)
            _priority, _counter, current = open_heap.pop()
            if current in visited:
                continue
            if current == goal_cell:
                break
            visited.add(current)

            for dc, dr in neighbors:
                neighbor = (current[0] + dc, current[1] + dr)
                if not in_bounds(neighbor) or blocked(neighbor):
                    continue
                step_cost = math.hypot(dc, dr)
                new_cost = costs[current] + step_cost
                if new_cost >= costs.get(neighbor, math.inf):
                    continue
                costs[neighbor] = new_cost
                came_from[neighbor] = current
                heuristic = math.hypot(goal_cell[0] - neighbor[0], goal_cell[1] - neighbor[1])
                counter += 1
                open_heap.append((-(new_cost + heuristic), -counter, neighbor))

        if goal_cell not in came_from and goal_cell != start_cell:
            return [Pose2D(goal.x, goal.y, goal.yaw_degrees)]

        cells = [goal_cell]
        while cells[-1] != start_cell:
            cells.append(came_from[cells[-1]])
        cells.reverse()

        points = [to_world(cell) for cell in cells]
        points[-1] = (goal.x, goal.y)
        simplified = self._simplify_route(points, obstacle_footprints)
        return [Pose2D(x, y, goal.yaw_degrees if index == len(simplified) - 1 else 0.0) for index, (x, y) in enumerate(simplified)]

    def _nearest_free_cell(self, start_cell, in_bounds, blocked):
        if in_bounds(start_cell) and not blocked(start_cell):
            return start_cell

        queue = [start_cell]
        seen = {start_cell}
        while queue:
            current = queue.pop(0)
            for dc in (-1, 0, 1):
                for dr in (-1, 0, 1):
                    if dc == 0 and dr == 0:
                        continue
                    neighbor = (current[0] + dc, current[1] + dr)
                    if neighbor in seen:
                        continue
                    seen.add(neighbor)
                    if in_bounds(neighbor) and not blocked(neighbor):
                        return neighbor
                    if in_bounds(neighbor):
                        queue.append(neighbor)
        return None

    def _simplify_route(self, points: list[tuple[float, float]], obstacle_footprints: list[dict[str, Any]]):
        if len(points) <= 2:
            return points

        simplified = [points[0]]
        index = 0
        while index < len(points) - 1:
            next_index = len(points) - 1
            while next_index > index + 1:
                if self._segment_clear(points[index], points[next_index], obstacle_footprints):
                    break
                next_index -= 1
            simplified.append(points[next_index])
            index = next_index
        return simplified

    def _segment_clear(
        self,
        start: tuple[float, float],
        end: tuple[float, float],
        obstacle_footprints: list[dict[str, Any]],
    ) -> bool:
        step = max(float(self.planner.get("cellSizeMeters", 0.12)) * 0.5, 0.03)
        distance = math.hypot(end[0] - start[0], end[1] - start[1])
        samples = max(2, int(math.ceil(distance / step)))
        for index in range(samples + 1):
            t = index / samples
            x = start[0] + (end[0] - start[0]) * t
            y = start[1] + (end[1] - start[1]) * t
            if self._point_hits_obstacle(x, y, obstacle_footprints):
                return False
        return True

    def _point_hits_obstacle(self, x: float, y: float, obstacle_footprints: list[dict[str, Any]]) -> bool:
        for obstacle in obstacle_footprints:
            center_x, center_y = obstacle["center"]
            if obstacle.get("radius") is not None:
                if math.hypot(x - center_x, y - center_y) <= obstacle["radius"]:
                    return True
                continue
            half_x, half_y = obstacle["half_extents"]
            if center_x - half_x <= x <= center_x + half_x and center_y - half_y <= y <= center_y + half_y:
                return True
        return False

    def _normalize_obstacle_footprints(self, obstacles: Any) -> list[dict[str, Any]]:
        robot_radius = float(self.planner.get("robotRadiusMeters", self.avoidance.get("robotRadiusMeters", 0.18)))
        padding = float(self.planner.get("clearancePaddingMeters", self.avoidance.get("clearancePaddingMeters", 0.08)))
        inflation = robot_radius + padding
        footprints = []

        for obstacle in obstacles or []:
            if not isinstance(obstacle, dict):
                continue
            center = obstacle.get("center") or obstacle.get("position")
            if not isinstance(center, (list, tuple)) or len(center) < 2:
                continue
            center_x = to_finite_float(center[0])
            center_y = to_finite_float(center[1])
            if center_x is None or center_y is None:
                continue

            radius = to_finite_float(obstacle.get("radiusMeters", obstacle.get("radius")))
            if radius is not None:
                footprints.append({"center": (center_x, center_y), "radius": max(0.0, radius) + inflation})
                continue

            half_extents = obstacle.get("halfExtentsMeters") or obstacle.get("half_extents")
            if isinstance(half_extents, (list, tuple)) and len(half_extents) >= 2:
                half_x = to_finite_float(half_extents[0])
                half_y = to_finite_float(half_extents[1])
                if half_x is not None and half_y is not None:
                    footprints.append({
                        "center": (center_x, center_y),
                        "half_extents": (max(0.0, half_x) + inflation, max(0.0, half_y) + inflation),
                    })

        return footprints

    def _avoid_obstacles(
        self,
        desired_vx: float,
        desired_vy: float,
        lidar_scan: dict[str, Any] | None,
    ):
        debug = {
            "ranges": 0,
            "front_min": math.inf,
            "left_min": math.inf,
            "right_min": math.inf,
            "front_prim": "",
            "depth_only_hits": 0,
            "nearest_distance": math.inf,
            "nearest_angle": math.inf,
            "direct_clearance": math.inf,
            "selected_heading": 0.0,
            "used": False,
            "avoid": False,
        }
        if not self.avoidance.get("enabled", False):
            return desired_vx, desired_vy, debug

        hits = self._collect_lidar_hits(lidar_scan)
        if not hits:
            return desired_vx, desired_vy, debug

        debug["ranges"] = len(hits)
        speed = math.hypot(desired_vx, desired_vy)
        if speed <= 1e-6:
            return desired_vx, desired_vy, debug

        motion_yaw_degrees = math.degrees(math.atan2(desired_vy, desired_vx))
        motion_yaw_radians = math.radians(motion_yaw_degrees)
        lookahead = float(self.avoidance.get("lookaheadDistanceMeters", 1.2))
        trigger = float(self.avoidance.get("frontHitDistanceMeters", 0.3048))
        robot_radius = float(self.avoidance.get("robotRadiusMeters", 0.18))
        padding = float(self.avoidance.get("clearancePaddingMeters", 0.08))
        inflated_radius = robot_radius + padding
        max_heading = float(self.avoidance.get("candidateMaxHeadingDegrees", 90.0))
        step_degrees = max(float(self.avoidance.get("candidateStepDegrees", 10.0)), 1.0)
        speed_floor = float(self.avoidance.get("speedFloorScale", 0.2))
        heading_weight = float(self.avoidance.get("headingCostWeight", 0.35))
        clearance_weight = float(self.avoidance.get("clearanceCostWeight", 1.0))

        front_min = math.inf
        left_min = math.inf
        right_min = math.inf
        local_points: list[tuple[float, float, str]] = []

        for hit in hits:
            angle_deg = normalize_angle_degrees(self.state.base_pose.yaw_degrees + hit["angle_degrees"] - motion_yaw_degrees)
            distance = hit["distance"]
            abs_angle = abs(angle_deg)
            if not hit["prim_path"]:
                debug["depth_only_hits"] += 1
            if distance < debug["nearest_distance"]:
                debug["nearest_distance"] = distance
                debug["nearest_angle"] = angle_deg
            point_x = distance * math.cos(math.radians(angle_deg))
            point_y = distance * math.sin(math.radians(angle_deg))
            if abs_angle <= 90.0 and point_x > 0.02:
                if distance < front_min:
                    front_min = distance
                    debug["front_prim"] = hit["prim_path"]
                local_points.append((point_x, point_y, hit["prim_path"]))
            if 0.0 < angle_deg <= 90.0:
                left_min = min(left_min, distance)
            elif -90.0 <= angle_deg < 0.0:
                right_min = min(right_min, distance)

        debug["front_min"] = front_min
        debug["left_min"] = left_min
        debug["right_min"] = right_min

        if not local_points:
            return desired_vx, desired_vy, debug

        direct_clearance = self._clearance_for_heading(0.0, local_points, inflated_radius, lookahead)
        debug["direct_clearance"] = direct_clearance
        if direct_clearance > trigger:
            return desired_vx, desired_vy, debug

        debug["used"] = True
        debug["avoid"] = True
        best_heading = 0.0
        best_clearance = direct_clearance
        best_score = -math.inf
        preferred_side = 1.0 if left_min >= right_min else -1.0

        for candidate in self._candidate_headings(max_heading, step_degrees):
            clearance = self._clearance_for_heading(candidate, local_points, inflated_radius, lookahead)
            clearance_score = min(clearance, lookahead) / max(lookahead, 1e-6)
            heading_score = 1.0 - min(abs(candidate), max_heading) / max(max_heading, 1e-6)
            score = clearance_weight * clearance_score + heading_weight * heading_score
            if candidate * preferred_side > 0:
                score += 0.02
            if clearance <= direct_clearance + 0.02:
                score -= 0.5
            if score > best_score:
                best_score = score
                best_heading = candidate
                best_clearance = clearance

        if best_heading == 0.0 and direct_clearance <= trigger:
            best_heading = max_heading if left_min >= right_min else -max_heading
            best_clearance = self._clearance_for_heading(best_heading, local_points, inflated_radius, lookahead)

        debug["selected_heading"] = best_heading
        selected_yaw = motion_yaw_radians + math.radians(best_heading)
        speed_scale = max(speed_floor, min(1.0, best_clearance / max(trigger, 1e-6)))
        planned_speed = speed * speed_scale
        return math.cos(selected_yaw) * planned_speed, math.sin(selected_yaw) * planned_speed, debug

    def _candidate_headings(self, max_heading: float, step_degrees: float) -> list[float]:
        headings = [0.0]
        step_count = int(max_heading // step_degrees)
        for index in range(1, step_count + 1):
            offset = index * step_degrees
            headings.extend([offset, -offset])
        if headings[-2:] != [max_heading, -max_heading]:
            headings.extend([max_heading, -max_heading])
        return headings

    def _clearance_for_heading(
        self,
        heading_degrees: float,
        local_points: list[tuple[float, float, str]],
        inflated_radius: float,
        lookahead: float,
    ) -> float:
        heading = math.radians(heading_degrees)
        cos_heading = math.cos(heading)
        sin_heading = math.sin(heading)
        clearance = lookahead

        for point_x, point_y, _prim_path in local_points:
            along = point_x * cos_heading + point_y * sin_heading
            if along <= 0.0 or along > lookahead:
                continue

            lateral = abs(-point_x * sin_heading + point_y * cos_heading)
            if lateral >= inflated_radius:
                continue

            collision_offset = math.sqrt(max(inflated_radius * inflated_radius - lateral * lateral, 0.0))
            clearance = min(clearance, max(0.0, along - collision_offset))

        return clearance

    def _collect_lidar_hits(self, lidar_scan: dict[str, Any] | None) -> list[dict[str, Any]]:
        if not lidar_scan:
            return []

        lidar_ranges = list(lidar_scan.get("linear_depth_data", []) or [])
        lidar_angles = list(lidar_scan.get("angles", []) or [])
        hit_prims = list(
            lidar_scan.get("hit_prim_paths")
            or lidar_scan.get("hitPrimPaths")
            or lidar_scan.get("prim_paths")
            or lidar_scan.get("primData")
            or []
        )
        if len(lidar_ranges) != len(lidar_angles):
            return []
        if len(hit_prims) != len(lidar_ranges):
            hit_prims = [""] * len(lidar_ranges)

        front_yaw_offset = to_finite_float(
            lidar_scan.get("frontYawOffsetDegrees", self.avoidance.get("lidarFrontYawOffsetDegrees", 0.0))
        )
        front_yaw_offset = 0.0 if front_yaw_offset is None else front_yaw_offset
        self_prefixes = tuple(self.avoidance.get("selfPrimPrefixes") or [self.rig_root_prim])
        allow_depth_only = bool(self.avoidance.get("allowDepthOnlyLidarHits", True))
        max_detection_range = float(self.avoidance.get("obstacleDetectionRangeMeters", 1.5))
        hits: list[dict[str, Any]] = []

        for raw_range, raw_angle, raw_prim in zip(lidar_ranges, lidar_angles, hit_prims):
            distance = to_finite_float(raw_range)
            angle = to_finite_float(raw_angle)
            prim_path = str(raw_prim or "").strip()
            if distance is None or angle is None or distance <= 1e-3:
                continue
            if distance > max_detection_range:
                continue
            if not prim_path and not allow_depth_only:
                continue
            if any(prim_path.startswith(prefix) for prefix in self_prefixes):
                continue
            hits.append(
                {
                    "distance": distance,
                    "angle_degrees": normalize_angle_degrees(angle - front_yaw_offset),
                    "prim_path": prim_path,
                }
            )

        return hits

    def _emit_debug(self, debug: dict[str, Any], velocity_x: float, velocity_y: float):
        self.state.debug_tick_counter += 1
        if self.state.debug_tick_counter % self.debug_every_ticks != 0:
            return
        front_min = debug["front_min"]
        nearest_distance = debug["nearest_distance"]
        nearest_angle = debug["nearest_angle"]
        print(
            "robot controller lidar debug:"
            f" ranges={debug['ranges']}"
            f" depth_only_hits={debug['depth_only_hits']}"
            f" front_min={front_min if math.isfinite(front_min) else 'inf'}"
            f" front_prim={debug['front_prim'] or 'none'}"
            f" nearest_distance={nearest_distance if math.isfinite(nearest_distance) else 'inf'}"
            f" nearest_angle={nearest_angle if math.isfinite(nearest_angle) else 'inf'}"
            f" direct_clearance={debug['direct_clearance'] if math.isfinite(debug['direct_clearance']) else 'inf'}"
            f" selected_heading={debug['selected_heading']:.1f}"
            f" left_min={debug['left_min'] if math.isfinite(debug['left_min']) else 'inf'}"
            f" right_min={debug['right_min'] if math.isfinite(debug['right_min']) else 'inf'}"
            f" used={debug['used']}"
            f" avoid={debug['avoid']}"
            f" vx={velocity_x:.3f}"
            f" vy={velocity_y:.3f}"
            f" pose=({self.state.base_pose.x:.3f},{self.state.base_pose.y:.3f})"
        )

    def _clip_to_room(self, x: float, y: float) -> tuple[float, float]:
        if not self.room_bounds.get("enabled", False):
            return float(x), float(y)
        return (
            max(float(self.room_bounds["minX"]), min(float(self.room_bounds["maxX"]), float(x))),
            max(float(self.room_bounds["minY"]), min(float(self.room_bounds["maxY"]), float(y))),
        )

    def _advance_heading_toward_motion(self, velocity_x: float, velocity_y: float, dt_seconds: float):
        desired_yaw = math.degrees(math.atan2(velocity_y, velocity_x))
        yaw_delta = normalize_angle_degrees(desired_yaw - self.state.base_pose.yaw_degrees)
        max_step = float(self.motion["angularSpeedDegreesPerSecond"]) * float(dt_seconds)
        yaw_step = max(-max_step, min(max_step, yaw_delta))
        self.state.base_pose.yaw_degrees = normalize_angle_degrees(self.state.base_pose.yaw_degrees + yaw_step)


def normalize_angle_degrees(value: float) -> float:
    wrapped = (float(value) + 180.0) % 360.0 - 180.0
    return 180.0 if math.isclose(wrapped, -180.0, abs_tol=1e-9) else wrapped


def to_finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def create_controller(scene_adapter=None) -> RobotController:
    return RobotController(scene_adapter=scene_adapter)


if __name__ == "__main__":
    controller = create_controller()
    print(json.dumps(controller.snapshot(), indent=2))
