from __future__ import annotations

import math
from typing import Any


class ProxyRigMotionSolver:
    LEG_GROUPS = {
        "front_left": "front",
        "front_right": "front",
        "rear_left": "rear",
        "rear_right": "rear",
    }

    STORAGE_SIGNS = {
        "front": -1.0,
        "rear": 1.0,
    }

    def __init__(self, walk_config: dict[str, Any], joint_limits: dict[str, Any]):
        self.walk_config = walk_config
        self.defaults = walk_config["defaults"]
        self.phase_offsets = walk_config["gait"]["phaseOffsets"]
        self.ik = walk_config.get("ik", {})
        self.reactions = walk_config.get("reactions", {})
        self.named_actions = walk_config.get("namedActions", {})
        self.joint_limits = joint_limits.get("limits", joint_limits)
        self.upper_length = float(self.ik.get("upperLength", 0.09))
        self.lower_length = float(self.ik.get("lowerLength", 0.1))
        self.hip_share = float(self.ik.get("hipShare", 0.25))
        self.step_reach = float(self.ik.get("stepReach", 0.024))
        self.lift_height = float(self.ik.get("liftHeight", 0.028))
        self.reference_speed = float(self.ik.get("referenceSpeed", 0.12))
        self.response_rate = float(self.reactions.get("responseRate", 8.0))
        self.phase = 0.0
        self.filtered_roll = 0.0
        self.filtered_pitch = 0.0
        self.filtered_height = 0.0
        self.previous_speed = 0.0
        self.rest_targets = {
            "front": self._rest_target_for_group("front"),
            "rear": self._rest_target_for_group("rear"),
        }

    def evaluate(self, snapshot: dict[str, Any], dt_seconds: float) -> dict[str, Any]:
        dt = max(float(dt_seconds), 1e-6)
        body_pose = snapshot.get("bodyPose", {}) or {}
        body_base = {
            "heightOffset": float(body_pose.get("height_offset", 0.0)),
            "rollDegrees": float(body_pose.get("roll_degrees", 0.0)),
            "pitchDegrees": float(body_pose.get("pitch_degrees", 0.0)),
        }

        active_action = snapshot.get("activeAction")
        if isinstance(active_action, dict) and active_action.get("name") == "backflip":
            return self._evaluate_backflip(body_base, active_action)

        return self._evaluate_locomotion(snapshot, body_base, dt)

    def _evaluate_locomotion(self, snapshot: dict[str, Any], body_base: dict[str, float], dt: float) -> dict[str, Any]:
        motion = snapshot.get("motion", {}) or {}
        gait = snapshot.get("gait", "idle")
        moving = bool(motion.get("moving")) and gait in {"walk", "trot"}
        speed = float(motion.get("speed", 0.0))
        forward_speed = float(motion.get("forwardSpeed", 0.0))
        lateral_speed = float(motion.get("lateralSpeed", 0.0))
        angular_speed = float(motion.get("angularSpeed", 0.0))
        speed_ratio = self._clamp(speed / max(self.reference_speed, 1e-6), 0.0, 1.6)

        if moving:
            cadence = 0.9 if gait == "walk" else 1.8
            self.phase = (self.phase + dt * cadence * max(0.35, speed_ratio)) % 1.0
        else:
            self.phase = 0.0

        acceleration = (speed - self.previous_speed) / dt
        self.previous_speed = speed

        desired_pitch = body_base["pitchDegrees"] + self._clamp(
            -forward_speed * float(self.reactions.get("pitchFromForwardSpeed", 16.0))
            - acceleration * float(self.reactions.get("pitchFromAcceleration", 0.4)),
            -float(self.reactions.get("maxPitchDegrees", 9.0)),
            float(self.reactions.get("maxPitchDegrees", 9.0)),
        )
        desired_roll = body_base["rollDegrees"] + self._clamp(
            lateral_speed * float(self.reactions.get("rollFromLateralSpeed", 18.0))
            + angular_speed * float(self.reactions.get("rollFromAngularSpeed", -0.08)),
            -float(self.reactions.get("maxRollDegrees", 7.0)),
            float(self.reactions.get("maxRollDegrees", 7.0)),
        )
        bob = float(self.reactions.get("bobAmplitude", 0.006)) * min(speed_ratio, 1.0) * math.sin(self.phase * math.tau * 2.0)
        compression = float(self.reactions.get("heightCompression", 0.01)) * min(speed_ratio, 1.0)
        desired_height = body_base["heightOffset"] + bob - compression

        self.filtered_pitch = self._approach(self.filtered_pitch, desired_pitch, dt)
        self.filtered_roll = self._approach(self.filtered_roll, desired_roll, dt)
        self.filtered_height = self._approach(self.filtered_height, desired_height, dt)

        legs = {}
        stride = self.step_reach * min(max(speed_ratio, 0.35), 1.35)
        lift_height = self.lift_height * min(max(speed_ratio, 0.5), 1.4)

        for leg_name, group in self.LEG_GROUPS.items():
            target_x = self.rest_targets[group]["x"]
            target_z = self.rest_targets[group]["z"]

            if moving:
                phase = (self.phase + self.phase_offsets[leg_name]) % 1.0
                swing = math.sin(phase * math.tau)
                lift = max(0.0, math.sin(phase * math.tau))
                target_x += stride * swing
                target_z += lift_height * lift

            legs[leg_name] = self._solve_leg(group, target_x, target_z)

        return {
            "body": {
                "heightOffset": self.filtered_height,
                "rollDegrees": self.filtered_roll,
                "pitchDegrees": self.filtered_pitch,
            },
            "legs": legs,
        }

    def _evaluate_backflip(self, body_base: dict[str, float], active_action: dict[str, Any]) -> dict[str, Any]:
        action_config = self.named_actions.get("backflip", {})
        progress = float(active_action.get("progress", 0.0))
        progress = self._clamp(progress, 0.0, 1.0)
        spin = float(action_config.get("spinDegrees", 360.0)) * self._smoothstep(0.16, 0.88, progress)
        crouch = -float(action_config.get("crouchDepth", 0.028)) * self._pulse(progress, 0.0, 0.12, 0.28)
        jump = float(action_config.get("launchHeight", 0.085)) * math.sin(math.pi * self._smoothstep(0.12, 0.92, progress))
        tuck = self._pulse(progress, 0.18, 0.45, 0.84)
        landing = self._smoothstep(0.78, 1.0, progress)
        tuck_reach = float(action_config.get("tuckReach", 0.038))
        tuck_lift = float(action_config.get("tuckLift", 0.078))
        landing_stretch = float(action_config.get("landingStretch", 0.014))

        legs = {}
        for leg_name, group in self.LEG_GROUPS.items():
            rest = self.rest_targets[group]
            target_x = rest["x"] - tuck_reach * tuck + landing_stretch * landing
            target_z = rest["z"] + tuck_lift * tuck
            legs[leg_name] = self._solve_leg(group, target_x, target_z)

        return {
            "body": {
                "heightOffset": body_base["heightOffset"] + crouch + jump,
                "rollDegrees": body_base["rollDegrees"],
                "pitchDegrees": body_base["pitchDegrees"] + spin,
            },
            "legs": legs,
        }

    def _rest_target_for_group(self, group: str) -> dict[str, float]:
        prefix = "front" if group == "front" else "rear"
        sign = self.STORAGE_SIGNS[group]
        hip = sign * float(self.defaults[f"{prefix}Hip"])
        upper = sign * float(self.defaults[f"{prefix}Upper"])
        lower = sign * float(self.defaults[f"{prefix}Lower"])
        shoulder = math.radians(hip + upper)
        knee = math.radians(hip + upper + lower)
        x = self.upper_length * math.sin(shoulder) + self.lower_length * math.sin(knee)
        z = -(self.upper_length * math.cos(shoulder) + self.lower_length * math.cos(knee))
        return {"x": x, "z": z}

    def _solve_leg(self, group: str, target_x: float, target_z: float) -> dict[str, float]:
        x = float(target_x)
        y = -float(target_z)
        radius = math.hypot(x, y)
        min_reach = abs(self.upper_length - self.lower_length) + 1e-6
        max_reach = (self.upper_length + self.lower_length) - 1e-6
        radius = self._clamp(radius, min_reach, max_reach)

        if radius > 0.0:
            scale = radius / max(math.hypot(x, y), 1e-6)
            x *= scale
            y *= scale

        cos_elbow = self._clamp(
            (x * x + y * y - self.upper_length * self.upper_length - self.lower_length * self.lower_length)
            / (2.0 * self.upper_length * self.lower_length),
            -1.0,
            1.0,
        )
        elbow = -math.acos(cos_elbow)
        shoulder = math.atan2(x, y) - math.atan2(
            self.lower_length * math.sin(elbow),
            self.upper_length + self.lower_length * math.cos(elbow),
        )

        shoulder_deg = math.degrees(shoulder)
        elbow_deg = math.degrees(elbow)
        hip_deg = shoulder_deg * self.hip_share
        upper_deg = shoulder_deg - hip_deg
        sign = self.STORAGE_SIGNS[group]

        return {
            "hip": self._clamp_joint("hipRotateX", sign * hip_deg),
            "upper": self._clamp_joint("upperRotateX", sign * upper_deg),
            "lower": self._clamp_joint("lowerRotateX", sign * elbow_deg),
        }

    def _clamp_joint(self, limit_key: str, value: float) -> float:
        limit = self.joint_limits[limit_key]
        return self._clamp(float(value), float(limit["min"]), float(limit["max"]))

    def _approach(self, current: float, target: float, dt: float) -> float:
        alpha = 1.0 - math.exp(-self.response_rate * dt)
        return current + (target - current) * alpha

    @staticmethod
    def _smoothstep(edge0: float, edge1: float, value: float) -> float:
        if edge0 == edge1:
            return 1.0 if value >= edge1 else 0.0
        t = ProxyRigMotionSolver._clamp((value - edge0) / (edge1 - edge0), 0.0, 1.0)
        return t * t * (3.0 - 2.0 * t)

    @staticmethod
    def _pulse(value: float, start: float, peak: float, end: float) -> float:
        rise = ProxyRigMotionSolver._smoothstep(start, peak, value)
        fall = 1.0 - ProxyRigMotionSolver._smoothstep(peak, end, value)
        return max(0.0, rise * fall)

    @staticmethod
    def _clamp(value: float, minimum: float, maximum: float) -> float:
        return max(minimum, min(maximum, value))
