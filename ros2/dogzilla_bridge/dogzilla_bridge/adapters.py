from __future__ import annotations

import importlib
from dataclasses import dataclass, field
from math import cos, sin
from typing import Any


class AdapterError(RuntimeError):
    pass


@dataclass
class AdapterResult:
    adapter: str
    executed: bool
    calls: list[dict[str, Any]] = field(default_factory=list)
    telemetry: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "adapter": self.adapter,
            "executed": self.executed,
            "calls": self.calls,
            "telemetry": self.telemetry,
        }


class DogzillaAdapter:
    name = "base"

    def relative_motion(
        self,
        *,
        x_step: float,
        y_step: float,
        turn_rate: float,
        gait: str | None = None,
        pace: str | None = None,
    ) -> AdapterResult:
        raise AdapterError(f"{self.name} does not support relative motion")

    def action_once(self, action_id: int) -> AdapterResult:
        raise AdapterError(f"{self.name} does not support action.once")

    def action_loop(self, enabled: bool) -> AdapterResult:
        raise AdapterError(f"{self.name} does not support action.loop")

    def set_stabilize(self, enabled: bool) -> AdapterResult:
        raise AdapterError(f"{self.name} does not support stabilize.set")

    def body_pose(
        self,
        *,
        body_x: float | None = None,
        body_y: float | None = None,
        height: float | None = None,
        roll: float | None = None,
        pitch: float | None = None,
        yaw: float | None = None,
    ) -> AdapterResult:
        raise AdapterError(f"{self.name} does not support pose.body")

    def set_gait(self, *, gait: str | None = None, mark: float | None = None, pace: str | None = None) -> AdapterResult:
        raise AdapterError(f"{self.name} does not support gait.set")

    def read_state(self, *, want_joints: bool = False, want_battery: bool = True, want_attitude: bool = True) -> AdapterResult:
        raise AdapterError(f"{self.name} does not support state.read")

    def navigate_to_pose(
        self,
        *,
        frame: str,
        x: float,
        y: float,
        yaw: float,
        waypoint: str = "",
        arrival_tolerance_meters: float | None = None,
    ) -> AdapterResult:
        raise AdapterError(f"{self.name} does not support locomotion.goto")


class RecordingDogzillaAdapter(DogzillaAdapter):
    name = "dry-run"

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def _record(self, operation: str, **params: Any) -> AdapterResult:
        call = {"operation": operation, "params": params}
        self.calls.append(call)
        return AdapterResult(adapter=self.name, executed=False, calls=[call])

    def relative_motion(
        self,
        *,
        x_step: float,
        y_step: float,
        turn_rate: float,
        gait: str | None = None,
        pace: str | None = None,
    ) -> AdapterResult:
        return self._record("relative_motion", x_step=x_step, y_step=y_step, turn_rate=turn_rate, gait=gait, pace=pace)

    def action_once(self, action_id: int) -> AdapterResult:
        return self._record("action_once", action_id=action_id)

    def action_loop(self, enabled: bool) -> AdapterResult:
        return self._record("action_loop", enabled=enabled)

    def set_stabilize(self, enabled: bool) -> AdapterResult:
        return self._record("set_stabilize", enabled=enabled)

    def body_pose(
        self,
        *,
        body_x: float | None = None,
        body_y: float | None = None,
        height: float | None = None,
        roll: float | None = None,
        pitch: float | None = None,
        yaw: float | None = None,
    ) -> AdapterResult:
        return self._record("body_pose", body_x=body_x, body_y=body_y, height=height, roll=roll, pitch=pitch, yaw=yaw)

    def set_gait(self, *, gait: str | None = None, mark: float | None = None, pace: str | None = None) -> AdapterResult:
        return self._record("set_gait", gait=gait, mark=mark, pace=pace)

    def read_state(self, *, want_joints: bool = False, want_battery: bool = True, want_attitude: bool = True) -> AdapterResult:
        return self._record("read_state", want_joints=want_joints, want_battery=want_battery, want_attitude=want_attitude)

    def navigate_to_pose(
        self,
        *,
        frame: str,
        x: float,
        y: float,
        yaw: float,
        waypoint: str = "",
        arrival_tolerance_meters: float | None = None,
    ) -> AdapterResult:
        return self._record(
            "navigate_to_pose",
            frame=frame,
            x=x,
            y=y,
            yaw=yaw,
            waypoint=waypoint,
            arrival_tolerance_meters=arrival_tolerance_meters,
        )


class RosPublisherDogzillaAdapter(DogzillaAdapter):
    name = "ros-publisher"

    def __init__(
        self,
        *,
        cmd_vel_publisher: Any,
        action_publisher: Any,
        stabilize_publisher: Any,
        twist_type: Any,
        uint16_type: Any,
        bool_type: Any,
        deadband: float,
        linear_x_full_scale_step: float,
        linear_y_full_scale_step: float,
        angular_z_full_scale_step: float,
        navigate_to_pose_type: Any = None,
        nav_action_client: Any = None,
        clock: Any = None,
    ) -> None:
        self.cmd_vel_publisher = cmd_vel_publisher
        self.action_publisher = action_publisher
        self.stabilize_publisher = stabilize_publisher
        self.twist_type = twist_type
        self.uint16_type = uint16_type
        self.bool_type = bool_type
        self.navigate_to_pose_type = navigate_to_pose_type
        self.nav_action_client = nav_action_client
        self.clock = clock
        self.deadband = deadband
        self.linear_x_full_scale_step = linear_x_full_scale_step
        self.linear_y_full_scale_step = linear_y_full_scale_step
        self.angular_z_full_scale_step = angular_z_full_scale_step

    def relative_motion(
        self,
        *,
        x_step: float,
        y_step: float,
        turn_rate: float,
        gait: str | None = None,
        pace: str | None = None,
    ) -> AdapterResult:
        message = self.twist_type()
        message.linear.x = scale_axis(x_step, self.linear_x_full_scale_step, self.deadband)
        message.linear.y = scale_axis(y_step, self.linear_y_full_scale_step, self.deadband)
        message.angular.z = scale_axis(turn_rate, self.angular_z_full_scale_step, self.deadband)
        self.cmd_vel_publisher.publish(message)
        call = {
            "operation": "publish_twist",
            "params": {
                "linear_x": message.linear.x,
                "linear_y": message.linear.y,
                "angular_z": message.angular.z,
                "gait": gait,
                "pace": pace,
            },
        }
        return AdapterResult(adapter=self.name, executed=True, calls=[call])

    def action_once(self, action_id: int) -> AdapterResult:
        message = self.uint16_type()
        message.data = action_id
        self.action_publisher.publish(message)
        return AdapterResult(adapter=self.name, executed=True, calls=[{"operation": "publish_action", "params": {"action_id": action_id}}])

    def set_stabilize(self, enabled: bool) -> AdapterResult:
        message = self.bool_type()
        message.data = enabled
        self.stabilize_publisher.publish(message)
        return AdapterResult(adapter=self.name, executed=True, calls=[{"operation": "publish_stabilize", "params": {"enabled": enabled}}])

    def navigate_to_pose(
        self,
        *,
        frame: str,
        x: float,
        y: float,
        yaw: float,
        waypoint: str = "",
        arrival_tolerance_meters: float | None = None,
    ) -> AdapterResult:
        if self.navigate_to_pose_type is None or self.nav_action_client is None:
            raise AdapterError("Nav2 NavigateToPose action client is not configured")

        goal = self.navigate_to_pose_type.Goal()
        goal.pose.header.frame_id = frame or "map"
        if self.clock is not None:
            goal.pose.header.stamp = self.clock.now().to_msg()
        goal.pose.pose.position.x = x
        goal.pose.pose.position.y = y
        goal.pose.pose.position.z = 0.0
        goal.pose.pose.orientation.z = sin(yaw / 2.0)
        goal.pose.pose.orientation.w = cos(yaw / 2.0)
        self.nav_action_client.send_goal_async(goal)
        call = {
            "operation": "send_nav2_goal",
            "params": {
                "frame": goal.pose.header.frame_id,
                "x": x,
                "y": y,
                "yaw": yaw,
                "waypoint": waypoint,
                "arrival_tolerance_meters": arrival_tolerance_meters,
            },
        }
        return AdapterResult(adapter=self.name, executed=True, calls=[call])


class YahboomPythonDogzillaAdapter(DogzillaAdapter):
    name = "yahboom-python"

    def __init__(self, controller: Any) -> None:
        self.controller = controller

    @classmethod
    def from_module(cls, module_name: str, factory_name: str = "") -> "YahboomPythonDogzillaAdapter":
        if not module_name:
            raise AdapterError("dogzilla_python_module parameter is required for yahboom-python adapter")

        module = importlib.import_module(module_name)
        factory = None

        if factory_name:
            factory = getattr(module, factory_name)
        else:
            for candidate in ("DOGZILLA", "Dogzilla", "dogzilla", "XGO", "XGOEDU"):
                if hasattr(module, candidate):
                    factory = getattr(module, candidate)
                    break

        if factory is None:
            raise AdapterError(f"No DOGZILLA factory found in module {module_name}")

        controller = factory() if callable(factory) else factory
        return cls(controller)

    def relative_motion(
        self,
        *,
        x_step: float,
        y_step: float,
        turn_rate: float,
        gait: str | None = None,
        pace: str | None = None,
    ) -> AdapterResult:
        calls: list[dict[str, Any]] = []

        if pace:
            self._call_if_present("pace", pace, calls=calls)

        if is_zero(x_step) and is_zero(y_step) and is_zero(turn_rate):
            self._call("stop", calls=calls)
            return AdapterResult(adapter=self.name, executed=True, calls=calls)

        if not is_zero(x_step):
            if self._has("move"):
                self._call("move", "x", x_step, calls=calls)
            elif x_step > 0:
                self._call("forward", abs(x_step), calls=calls)
            else:
                self._call("back", abs(x_step), calls=calls)

        if not is_zero(y_step):
            if self._has("move"):
                self._call("move", "y", y_step, calls=calls)
            elif y_step > 0:
                self._call("left", abs(y_step), calls=calls)
            else:
                self._call("right", abs(y_step), calls=calls)

        if not is_zero(turn_rate):
            if self._has("turn"):
                self._call("turn", turn_rate, calls=calls)
            elif turn_rate > 0:
                self._call("turnleft", abs(turn_rate), calls=calls)
            else:
                self._call("turnright", abs(turn_rate), calls=calls)

        return AdapterResult(adapter=self.name, executed=True, calls=calls)

    def action_once(self, action_id: int) -> AdapterResult:
        calls: list[dict[str, Any]] = []
        self._call_if_present("perform", 0, calls=calls)
        self._call("action", action_id, calls=calls)
        return AdapterResult(adapter=self.name, executed=True, calls=calls)

    def action_loop(self, enabled: bool) -> AdapterResult:
        calls: list[dict[str, Any]] = []
        self._call("perform", 1 if enabled else 0, calls=calls)
        return AdapterResult(adapter=self.name, executed=True, calls=calls)

    def set_stabilize(self, enabled: bool) -> AdapterResult:
        calls: list[dict[str, Any]] = []
        self._call("imu", 1 if enabled else 0, calls=calls)
        return AdapterResult(adapter=self.name, executed=True, calls=calls)

    def body_pose(
        self,
        *,
        body_x: float | None = None,
        body_y: float | None = None,
        height: float | None = None,
        roll: float | None = None,
        pitch: float | None = None,
        yaw: float | None = None,
    ) -> AdapterResult:
        calls: list[dict[str, Any]] = []

        for direction, value in (("x", body_x), ("y", body_y), ("z", height)):
            if value is not None:
                self._call("translation", direction, value, calls=calls)

        for direction, value in (("r", roll), ("p", pitch), ("y", yaw)):
            if value is not None:
                self._call("attitude", direction, value, calls=calls)

        return AdapterResult(adapter=self.name, executed=True, calls=calls)

    def set_gait(self, *, gait: str | None = None, mark: float | None = None, pace: str | None = None) -> AdapterResult:
        calls: list[dict[str, Any]] = []

        if gait or mark is not None:
            raise AdapterError("Yahboom Python docs do not expose a stable direct gait.set method; verify on hardware first")

        if pace:
            self._call("pace", pace, calls=calls)

        return AdapterResult(adapter=self.name, executed=True, calls=calls)

    def read_state(self, *, want_joints: bool = False, want_battery: bool = True, want_attitude: bool = True) -> AdapterResult:
        telemetry: dict[str, Any] = {}
        calls: list[dict[str, Any]] = []

        if want_battery:
            telemetry["battery"] = self._call("read_Battery", calls=calls)

        if want_attitude:
            telemetry["roll"] = self._call("read_roll", calls=calls)
            telemetry["pitch"] = self._call("read_pitch", calls=calls)
            telemetry["yaw"] = self._call("read_yaw", calls=calls)

        if want_joints:
            telemetry["motors"] = self._call("read_Motor", calls=calls)

        return AdapterResult(adapter=self.name, executed=True, calls=calls, telemetry=telemetry)

    def _has(self, name: str) -> bool:
        return hasattr(self.controller, name)

    def _call_if_present(self, name: str, *args: Any, calls: list[dict[str, Any]]) -> Any:
        if not self._has(name):
            return None

        return self._call(name, *args, calls=calls)

    def _call(self, name: str, *args: Any, calls: list[dict[str, Any]]) -> Any:
        method = getattr(self.controller, name, None)
        if method is None:
            raise AdapterError(f"Yahboom controller missing method: {name}")

        result = method(*args)
        calls.append({"operation": name, "params": {"args": list(args)}})
        return result


def scale_axis(value: Any, full_scale: float, deadband: float) -> float:
    numeric = float(value or 0.0)

    if abs(numeric) <= deadband:
        return 0.0

    return numeric / max(full_scale, 1.0)


def is_zero(value: float) -> bool:
    return abs(value) <= 1e-9
