from __future__ import annotations

from dataclasses import dataclass, field
from math import isfinite
from typing import Any

from dogzilla_bridge.adapters import AdapterResult, DogzillaAdapter


class CommandValidationError(ValueError):
    pass


@dataclass(frozen=True)
class RangeLimit:
    minimum: float
    maximum: float

    def clamp(self, value: Any, *, default: float = 0.0) -> float:
        numeric = coerce_float(value, default=default)
        return max(self.minimum, min(self.maximum, numeric))


@dataclass(frozen=True)
class DogzillaCommandLimits:
    x_step: RangeLimit = RangeLimit(-25.0, 25.0)
    y_step: RangeLimit = RangeLimit(-18.0, 18.0)
    turn_rate: RangeLimit = RangeLimit(-100.0, 100.0)
    body_x: RangeLimit = RangeLimit(-35.0, 35.0)
    body_y: RangeLimit = RangeLimit(-18.0, 18.0)
    height: RangeLimit = RangeLimit(75.0, 115.0)
    roll: RangeLimit = RangeLimit(-20.0, 20.0)
    pitch: RangeLimit = RangeLimit(-15.0, 15.0)
    yaw: RangeLimit = RangeLimit(-11.0, 11.0)
    gaits: tuple[str, ...] = ("walk", "trot")
    paces: tuple[str, ...] = ("slow", "normal", "high")


@dataclass
class CommandExecution:
    status: str
    adapter_result: AdapterResult | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "details": self.details,
            "adapterResult": self.adapter_result.to_dict() if self.adapter_result else None,
        }


def execute_canonical_plan(
    canonical_plan: dict[str, Any],
    adapter: DogzillaAdapter,
    limits: DogzillaCommandLimits | None = None,
) -> CommandExecution:
    limits = limits or DogzillaCommandLimits()
    kind = canonical_plan.get("kind")
    params = canonical_plan.get("params", {})
    if not isinstance(params, dict):
        raise CommandValidationError("canonical plan params must be an object")

    if kind == "noop":
        return CommandExecution(status="noop", details={"reason": params.get("reason")})

    if kind == "action.once":
        action_id = get_action_id(params)
        adapter_result = adapter.action_once(action_id)
        return CommandExecution(status="action.once", adapter_result=adapter_result, details={"actionId": action_id})

    if kind == "action.loop":
        enabled = bool(params.get("enabled"))
        adapter_result = adapter.action_loop(enabled)
        return CommandExecution(status="action.loop", adapter_result=adapter_result, details={"enabled": enabled})

    if kind == "stabilize.set":
        enabled = bool(params.get("enabled"))
        adapter_result = adapter.set_stabilize(enabled)
        return CommandExecution(status="stabilize.set", adapter_result=adapter_result, details={"enabled": enabled})

    if kind == "locomotion.relative":
        gait = optional_choice(params.get("gait"), limits.gaits, "gait")
        pace = optional_choice(params.get("pace"), limits.paces, "pace")
        x_step = limits.x_step.clamp(params.get("x_step"))
        y_step = limits.y_step.clamp(params.get("y_step"))
        turn_rate = limits.turn_rate.clamp(params.get("turn_rate"))
        adapter_result = adapter.relative_motion(
            x_step=x_step,
            y_step=y_step,
            turn_rate=turn_rate,
            gait=gait,
            pace=pace,
        )
        return CommandExecution(
            status="locomotion.relative",
            adapter_result=adapter_result,
            details={"xStep": x_step, "yStep": y_step, "turnRate": turn_rate, "gait": gait, "pace": pace},
        )

    if kind == "pose.body":
        body_x = optional_clamp(limits.body_x, params, "body_x", "bodyX")
        body_y = optional_clamp(limits.body_y, params, "body_y", "bodyY")
        height = optional_clamp(limits.height, params, "height", "bodyHeight")
        roll = optional_clamp(limits.roll, params, "roll")
        pitch = optional_clamp(limits.pitch, params, "pitch")
        yaw = optional_clamp(limits.yaw, params, "yaw")
        adapter_result = adapter.body_pose(
            body_x=body_x,
            body_y=body_y,
            height=height,
            roll=roll,
            pitch=pitch,
            yaw=yaw,
        )
        return CommandExecution(
            status="pose.body",
            adapter_result=adapter_result,
            details={"bodyX": body_x, "bodyY": body_y, "height": height, "roll": roll, "pitch": pitch, "yaw": yaw},
        )

    if kind == "gait.set":
        gait = optional_choice(params.get("gait"), limits.gaits, "gait")
        pace = optional_choice(params.get("pace"), limits.paces, "pace")
        mark = coerce_float(params.get("mark"), default=0.0) if "mark" in params else None
        adapter_result = adapter.set_gait(gait=gait, mark=mark, pace=pace)
        return CommandExecution(status="gait.set", adapter_result=adapter_result, details={"gait": gait, "mark": mark, "pace": pace})

    if kind == "state.read":
        adapter_result = adapter.read_state(
            want_joints=bool(params.get("want_joints") or params.get("wantJoints")),
            want_battery=bool(params.get("want_battery", params.get("wantBattery", True))),
            want_attitude=bool(params.get("want_attitude", params.get("wantAttitude", True))),
        )
        return CommandExecution(status="state.read", adapter_result=adapter_result, details=adapter_result.telemetry)

    if kind == "locomotion.goto":
        return CommandExecution(status="goto-request", details={"reason": "navigation adapter not implemented", "params": params})

    if isinstance(kind, str) and kind.startswith("behavior."):
        return CommandExecution(status="unsupported", details={"reason": "behavior adapter not implemented", "kind": kind})

    return CommandExecution(status="unsupported", details={"reason": f"unsupported_kind:{kind}"})


def get_action_id(params: dict[str, Any]) -> int:
    raw = params.get("actionId", params.get("action_id"))
    if not isinstance(raw, int):
        raise CommandValidationError("action.once missing integer actionId")

    if not (1 <= raw <= 19 or raw == 255):
        raise CommandValidationError("action.once actionId must be 1..19 or 255")

    return raw


def coerce_float(value: Any, *, default: float = 0.0) -> float:
    if value is None:
        return default

    try:
        numeric = float(value)
    except (TypeError, ValueError) as error:
        raise CommandValidationError(f"expected numeric value, got {value!r}") from error

    if not isfinite(numeric):
        raise CommandValidationError(f"expected finite numeric value, got {value!r}")

    return numeric


def optional_clamp(limit: RangeLimit, params: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        if key in params:
            return limit.clamp(params[key])

    return None


def optional_choice(value: Any, choices: tuple[str, ...], field_name: str) -> str | None:
    if value is None or value == "":
        return None

    if not isinstance(value, str):
        raise CommandValidationError(f"{field_name} must be a string")

    normalized = value.strip().lower()
    if normalized not in choices:
        raise CommandValidationError(f"{field_name} must be one of: {', '.join(choices)}")

    return normalized
