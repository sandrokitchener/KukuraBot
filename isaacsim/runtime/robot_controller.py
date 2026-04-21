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
    linear_x: float = 0.0
    linear_y: float = 0.0
    angular_z: float = 0.0
    status: str = "idle"
    active_action: NamedActionState | None = None


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
        self.named_actions = self.config.get("namedActions", {})
        self.rig_root_prim = self.config["rigRootPrim"]
        self.body_prim = self.config["bodyPrim"]
        self.waypoints = self._load_waypoints()
        self.joint_limits = self._load_joint_limits()
        self.state = ControllerState()
        self.scene_adapter = scene_adapter or MemorySceneAdapter()

    def _load_waypoints(self) -> dict[str, Any]:
        path = self.root_dir / self.config["waypointsFile"]
        data = json.loads(path.read_text(encoding="utf-8"))
        active_set = data["activeSet"]
        return data["sets"][active_set]["waypoints"]

    def _load_joint_limits(self) -> dict[str, Any]:
        path = self.root_dir / self.config["jointLimitsFile"]
        data = json.loads(path.read_text(encoding="utf-8"))
        return data["limits"]

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
                gait=payload.get("gait", "walk"),
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

        return {
            "ok": False,
            "error": f"Unsupported action '{action}'",
        }

    def goto_waypoint(self, waypoint_name: str | None, scene_waypoint: dict[str, Any] | None = None) -> dict[str, Any]:
        if not waypoint_name:
            return {"ok": False, "error": "Missing waypoint name"}

        waypoint = scene_waypoint or self.waypoints.get(waypoint_name)
        if not waypoint:
            return {"ok": False, "error": f"Unknown waypoint '{waypoint_name}'"}

        self._clear_active_action()

        if waypoint.get("special") == "stay_put":
            self.state.target_waypoint = waypoint_name
            self.state.target_pose = Pose2D(
                x=self.state.base_pose.x,
                y=self.state.base_pose.y,
                yaw_degrees=self.state.base_pose.yaw_degrees,
            )
            self.state.status = "idle"
            return {"ok": True, "mode": "stay_put", "waypoint": waypoint_name}

        if waypoint.get("special"):
            return {"ok": False, "error": f"Special waypoint '{waypoint_name}' needs custom behavior"}

        position = waypoint.get("position", [0.0, 0.0, 0.0])
        yaw_degrees = waypoint.get("yawDegrees", 0.0)
        self.state.target_waypoint = waypoint_name
        self.state.target_pose = Pose2D(x=position[0], y=position[1], yaw_degrees=yaw_degrees)
        self.state.gait = "walk"
        self.state.status = "moving_to_waypoint"
        self.state.linear_x = 0.0
        self.state.linear_y = 0.0
        self.state.angular_z = 0.0
        return {
            "ok": True,
            "action": "goto_waypoint",
            "waypoint": waypoint_name,
            "targetPose": {
                "x": position[0],
                "y": position[1],
                "yawDegrees": yaw_degrees,
            },
        }

    def move_base(self, linear_x: float, linear_y: float, angular_z: float, gait: str = "walk") -> dict[str, Any]:
        self._clear_active_action()
        self.state.target_pose = None
        self.state.target_waypoint = ""
        self.state.linear_x = float(linear_x)
        self.state.linear_y = float(linear_y)
        self.state.angular_z = float(angular_z)
        self.state.gait = gait
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
        self.state.gait = "idle"
        self.state.status = "idle"
        self._clear_active_action()
        return {"ok": True, "action": "stop"}

    def pose_body(self, height_offset: float = 0.0, roll_degrees: float = 0.0, pitch_degrees: float = 0.0) -> dict[str, Any]:
        self.state.body_pose = BodyPose(
            height_offset=float(height_offset),
            roll_degrees=float(roll_degrees),
            pitch_degrees=float(pitch_degrees),
        )
        return {
            "ok": True,
            "action": "pose_body",
            "bodyPose": self.state.body_pose.__dict__,
        }

    def play_gait(self, gait: str) -> dict[str, Any]:
        self._clear_active_action()
        self.state.gait = gait or "idle"
        if self.state.gait == "idle" and self.state.target_pose is None:
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
        return {
            "ok": True,
            "action": "play_named_action",
            "namedAction": self.state.active_action.snapshot(),
        }

    def reset(self) -> dict[str, Any]:
        self.state = ControllerState()
        self._apply_to_scene()
        return {"ok": True, "action": "reset"}

    def tick(self, dt_seconds: float) -> dict[str, Any]:
        dt = max(float(dt_seconds), 1e-6)
        motion_state = {
            "linearX": 0.0,
            "linearY": 0.0,
            "angularZ": 0.0,
            "speed": 0.0,
            "forwardSpeed": 0.0,
            "lateralSpeed": 0.0,
            "angularSpeed": 0.0,
            "moving": False,
        }

        if self.state.active_action is not None:
            self.state.active_action.elapsed_seconds += dt
            if self.state.active_action.elapsed_seconds >= self.state.active_action.duration_seconds:
                self._clear_active_action()
                self.state.status = "idle"
            else:
                self.state.status = "playing_action"
        elif self.state.target_pose is not None:
            dx = self.state.target_pose.x - self.state.base_pose.x
            dy = self.state.target_pose.y - self.state.base_pose.y
            distance = math.hypot(dx, dy)
            tolerance = float(self.motion["arrivalToleranceMeters"])

            if distance <= tolerance:
                self.state.base_pose.x = self.state.target_pose.x
                self.state.base_pose.y = self.state.target_pose.y
                self.state.base_pose.yaw_degrees = self.state.target_pose.yaw_degrees
                self.state.target_pose = None
                self.state.target_waypoint = ""
                self.state.status = "idle"
                self.state.gait = "idle"
                self.state.linear_x = 0.0
                self.state.linear_y = 0.0
                self.state.angular_z = 0.0
            else:
                speed = float(self.motion["linearSpeedMetersPerSecond"])
                step = min(speed * dt, distance)
                velocity_x = (dx / distance) * speed
                velocity_y = (dy / distance) * speed
                self.state.base_pose.x += (dx / distance) * step
                self.state.base_pose.y += (dy / distance) * step
                self.state.status = "moving_to_waypoint"
                motion_state = self._build_motion_state(velocity_x, velocity_y, 0.0)
        else:
            self.state.base_pose.x += self.state.linear_x * dt
            self.state.base_pose.y += self.state.linear_y * dt
            self.state.base_pose.yaw_degrees += self.state.angular_z * dt
            if abs(self.state.linear_x) > 1e-6 or abs(self.state.linear_y) > 1e-6 or abs(self.state.angular_z) > 1e-6:
                self.state.status = "manual_move"
            else:
                self.state.status = "idle" if self.state.gait == "idle" else self.state.status
            motion_state = self._build_motion_state(self.state.linear_x, self.state.linear_y, self.state.angular_z)

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
            "motion": motion_state or self._build_motion_state(0.0, 0.0, 0.0),
            "activeAction": self.state.active_action.snapshot() if self.state.active_action is not None else None,
        }

    def _apply_to_scene(self) -> None:
        self.scene_adapter.set_transform(
            self.rig_root_prim,
            {
                "translate": [self.state.base_pose.x, self.state.base_pose.y, 0.0],
                "yawDegrees": self.state.base_pose.yaw_degrees,
            },
        )
        self.scene_adapter.set_transform(
            self.body_prim,
            {
                "heightOffset": self.state.body_pose.height_offset,
                "rollDegrees": self.state.body_pose.roll_degrees,
                "pitchDegrees": self.state.body_pose.pitch_degrees,
                "gait": self.state.gait,
            },
        )

    def _build_motion_state(self, linear_x: float, linear_y: float, angular_z: float) -> dict[str, float | bool]:
        speed = math.hypot(float(linear_x), float(linear_y))
        angular_speed = float(angular_z)
        return {
            "linearX": float(linear_x),
            "linearY": float(linear_y),
            "angularZ": angular_speed,
            "speed": speed,
            "forwardSpeed": float(linear_x),
            "lateralSpeed": float(linear_y),
            "angularSpeed": angular_speed,
            "moving": speed > 1e-6 or abs(angular_speed) > 1e-6,
        }

    def _clear_active_action(self) -> None:
        self.state.active_action = None


def create_controller(scene_adapter=None) -> RobotController:
    return RobotController(scene_adapter=scene_adapter)


if __name__ == "__main__":
    controller = create_controller()
    print(json.dumps(controller.snapshot(), indent=2))
