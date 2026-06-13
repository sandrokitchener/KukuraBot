from __future__ import annotations

import math
import os
from typing import Any


DEFAULT_NAV2_GAIT_LINEAR_FULL_SCALE = float(os.environ.get("DOGZILLA_NAV2_GAIT_LINEAR_FULL_SCALE", "0.26"))
DEFAULT_NAV2_GAIT_LATERAL_FULL_SCALE = float(os.environ.get("DOGZILLA_NAV2_GAIT_LATERAL_FULL_SCALE", "0.20"))
DEFAULT_NAV2_GAIT_ANGULAR_FULL_SCALE = float(os.environ.get("DOGZILLA_NAV2_GAIT_ANGULAR_FULL_SCALE", "1.0"))
DEFAULT_NAV2_GAIT_MAX_X_STEP = float(os.environ.get("DOGZILLA_NAV2_GAIT_MAX_X_STEP", "8"))
DEFAULT_NAV2_GAIT_MAX_Y_STEP = float(os.environ.get("DOGZILLA_NAV2_GAIT_MAX_Y_STEP", "3"))
DEFAULT_NAV2_GAIT_MAX_TURN_RATE = float(os.environ.get("DOGZILLA_NAV2_GAIT_MAX_TURN_RATE", "24"))
DEFAULT_NAV2_GAIT_FORWARD_TURN_SCALE = float(os.environ.get("DOGZILLA_NAV2_GAIT_FORWARD_TURN_SCALE", "0.25"))
DEFAULT_NAV2_GAIT_LINEAR_DEADBAND = float(os.environ.get("DOGZILLA_NAV2_GAIT_LINEAR_DEADBAND", "0.025"))
DEFAULT_NAV2_GAIT_ANGULAR_DEADBAND = float(os.environ.get("DOGZILLA_NAV2_GAIT_ANGULAR_DEADBAND", "0.12"))
DEFAULT_NAV2_GAIT_TROT_LINEAR = float(os.environ.get("DOGZILLA_NAV2_GAIT_TROT_LINEAR", "0.11"))
DEFAULT_NAV2_GAIT_HIGH_LINEAR = float(os.environ.get("DOGZILLA_NAV2_GAIT_HIGH_LINEAR", "0.20"))
DEFAULT_NAV2_GAIT_ALLOW_TROT = os.environ.get("DOGZILLA_NAV2_GAIT_ALLOW_TROT", "0") == "1"


def nav2_cmd_vel_to_locomotion(payload: dict[str, Any]) -> dict[str, Any]:
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

    linear_x = zero_deadband(linear_x, DEFAULT_NAV2_GAIT_LINEAR_DEADBAND)
    linear_y = zero_deadband(linear_y, DEFAULT_NAV2_GAIT_LINEAR_DEADBAND)
    angular_z = zero_deadband(angular_z, DEFAULT_NAV2_GAIT_ANGULAR_DEADBAND)

    x_step = scale_symmetric(
        linear_x,
        DEFAULT_NAV2_GAIT_LINEAR_FULL_SCALE,
        DEFAULT_NAV2_GAIT_MAX_X_STEP,
    )
    y_step = scale_symmetric(
        linear_y,
        DEFAULT_NAV2_GAIT_LATERAL_FULL_SCALE,
        DEFAULT_NAV2_GAIT_MAX_Y_STEP,
    )
    translating = abs(x_step) > 0 or abs(y_step) > 0
    turn_scale = DEFAULT_NAV2_GAIT_FORWARD_TURN_SCALE if translating and abs(x_step) > 0 else 1.0
    turn_rate = scale_symmetric(
        angular_z,
        DEFAULT_NAV2_GAIT_ANGULAR_FULL_SCALE,
        DEFAULT_NAV2_GAIT_MAX_TURN_RATE * turn_scale,
    )

    abs_linear = max(abs(linear_x), abs(linear_y))
    if DEFAULT_NAV2_GAIT_ALLOW_TROT and abs_linear >= DEFAULT_NAV2_GAIT_TROT_LINEAR:
        gait = "trot"
        pace = "high" if abs_linear >= DEFAULT_NAV2_GAIT_HIGH_LINEAR else "normal"
    elif translating:
        gait = "walk"
        pace = "slow"
    elif abs(turn_rate) > 0:
        gait = "walk"
        pace = "slow"
    else:
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
            "linearFullScale": DEFAULT_NAV2_GAIT_LINEAR_FULL_SCALE,
            "angularFullScale": DEFAULT_NAV2_GAIT_ANGULAR_FULL_SCALE,
            "maxXStep": DEFAULT_NAV2_GAIT_MAX_X_STEP,
            "maxTurnRate": DEFAULT_NAV2_GAIT_MAX_TURN_RATE,
            "forwardTurnScale": DEFAULT_NAV2_GAIT_FORWARD_TURN_SCALE,
            "allowTrot": DEFAULT_NAV2_GAIT_ALLOW_TROT,
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
