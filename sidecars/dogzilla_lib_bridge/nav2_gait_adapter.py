from __future__ import annotations

import math
import os
from copy import deepcopy
from typing import Any


# --- Dynamic speed config ---
# Start from env defaults, updatable at runtime via update_speed_config().

_SPEED_CONFIG: dict[str, Any] = {
    "linearFullScale": float(os.environ.get("DOGZILLA_NAV2_GAIT_LINEAR_FULL_SCALE", "0.26")),
    "lateralFullScale": float(os.environ.get("DOGZILLA_NAV2_GAIT_LATERAL_FULL_SCALE", "0.20")),
    "angularFullScale": float(os.environ.get("DOGZILLA_NAV2_GAIT_ANGULAR_FULL_SCALE", "1.0")),
    "maxXStep": float(os.environ.get("DOGZILLA_NAV2_GAIT_MAX_X_STEP", "8")),
    "maxYStep": float(os.environ.get("DOGZILLA_NAV2_GAIT_MAX_Y_STEP", "0")),
    "maxTurnRate": float(os.environ.get("DOGZILLA_NAV2_GAIT_MAX_TURN_RATE", "24")),
    "forwardTurnScale": float(os.environ.get("DOGZILLA_NAV2_GAIT_FORWARD_TURN_SCALE", "0.25")),
    "linearDeadband": float(os.environ.get("DOGZILLA_NAV2_GAIT_LINEAR_DEADBAND", "0.025")),
    "angularDeadband": float(os.environ.get("DOGZILLA_NAV2_GAIT_ANGULAR_DEADBAND", "0.12")),
    "trotLinear": float(os.environ.get("DOGZILLA_NAV2_GAIT_TROT_LINEAR", "0.11")),
    "highLinear": float(os.environ.get("DOGZILLA_NAV2_GAIT_HIGH_LINEAR", "0.20")),
    "allowTrot": False,
}

DEFAULT_NAV2_GAIT_MAX_TURN_RATE = _SPEED_CONFIG["maxTurnRate"]
DEFAULT_NAV2_GAIT_ALLOW_TROT = _SPEED_CONFIG["allowTrot"]


def get_speed_config() -> dict[str, Any]:
    """Return a copy of the current dynamic speed config."""
    return deepcopy(_SPEED_CONFIG)


def update_speed_config(overrides: dict[str, Any]) -> dict[str, Any]:
    """Apply overrides to the dynamic speed config. Returns the updated config."""
    allowed = {
        "linearFullScale", "lateralFullScale", "angularFullScale",
        "maxXStep", "maxTurnRate", "forwardTurnScale",
        "linearDeadband", "angularDeadband",
        "trotLinear", "highLinear",
    }
    for key, value in overrides.items():
        if key in allowed:
            _SPEED_CONFIG[key] = value
    return get_speed_config()


def nav2_cmd_vel_to_locomotion(payload: dict[str, Any]) -> dict[str, Any]:
    cfg = _SPEED_CONFIG

    linear = payload.get("linear") if isinstance(payload.get("linear"), dict) else {}
    angular = payload.get("angular") if isinstance(payload.get("angular"), dict) else {}
    twist = payload.get("twist") if isinstance(payload.get("twist"), dict) else {}
    twist_linear = twist.get("linear") if isinstance(twist.get("linear"), dict) else {}
    twist_angular = twist.get("angular") if isinstance(twist.get("angular"), dict) else {}

    linear_x = first_finite_number(
        payload.get("linear_x"),
        payload.get("linearX"),
        linear.get("x"),
        twist_linear.get("x"),
        0.0,
    )
    linear_y = first_finite_number(
        payload.get("linear_y"),
        payload.get("linearY"),
        linear.get("y"),
        twist_linear.get("y"),
        0.0,
    )
    angular_z = first_finite_number(
        payload.get("angular_z"),
        payload.get("angularZ"),
        angular.get("z"),
        twist_angular.get("z"),
        0.0,
    )

    linear_x = zero_deadband(linear_x, cfg["linearDeadband"])
    linear_y = zero_deadband(linear_y, cfg["linearDeadband"])
    angular_z = zero_deadband(angular_z, cfg["angularDeadband"])

    max_x_step = min(max(float(cfg["maxXStep"]), 0.0), 8.0)
    x_step = scale_symmetric(linear_x, cfg["linearFullScale"], max_x_step)
    y_step = 0.0
    translating = abs(x_step) > 0 or abs(y_step) > 0
    turn_scale = cfg["forwardTurnScale"] if translating and abs(x_step) > 0 else 1.0
    turn_rate = scale_symmetric(angular_z, cfg["angularFullScale"], cfg["maxTurnRate"] * turn_scale)

    gait = "walk"
    pace = "slow"

    return {
        "x_step": round_float(x_step),
        "y_step": round_float(y_step),
        "turn_rate": round_float(turn_rate),
        "gait": gait,
        "pace": pace,
        "source": "nav2_cmd_vel",
        "twist": {
            "linear": {
                "x": round_float(linear_x, digits=4),
                "y": round_float(linear_y, digits=4),
            },
            "angular": {
                "z": round_float(angular_z, digits=4),
            },
        },
        "mapping": {
            "linearFullScale": cfg["linearFullScale"],
            "angularFullScale": cfg["angularFullScale"],
            "maxXStep": max_x_step,
            "maxTurnRate": cfg["maxTurnRate"],
            "forwardTurnScale": cfg["forwardTurnScale"],
            "allowTrot": False,
        },
    }


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def first_finite_number(*values: Any) -> float:
    for value in values:
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            return number
    return 0.0


def zero_deadband(value: float, deadband: float) -> float:
    return 0.0 if abs(value) < max(deadband, 0.0) else value


def scale_symmetric(value: float, full_scale: float, output_max: float) -> float:
    if full_scale <= 0 or output_max <= 0:
        return 0.0
    return clamp((value / full_scale) * output_max, -output_max, output_max)


def round_float(value: float, *, digits: int = 3) -> float:
    return round(float(value), digits)
