from __future__ import annotations

import math
from typing import Any


def scan_obstacle_counts(points: list[Any], max_distance: float) -> tuple[int, int, int, float | None]:
    front = 0
    left = 0
    right = 0
    min_range: float | None = None

    for point in points:
        if not isinstance(point, dict):
            continue
        try:
            angle = float(point.get("angle"))
            distance = float(point.get("range"))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(angle) or not math.isfinite(distance) or distance <= 0:
            continue

        min_range = distance if min_range is None else min(min_range, distance)
        if distance > max_distance:
            continue
        if -math.radians(15) <= angle <= math.radians(15):
            front += 1
        elif math.radians(15) < angle <= math.radians(75):
            left += 1
        elif -math.radians(75) <= angle < -math.radians(15):
            right += 1

    return front, left, right, min_range


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def resolve_map_navigation_timeout(value: Any, fallback: float) -> float | None:
    try:
        timeout = float(value if value is not None else fallback)
    except (TypeError, ValueError):
        timeout = fallback

    if not math.isfinite(timeout) or timeout <= 0:
        return None

    return max(1.0, timeout)


def normalize_angle(value: float) -> float:
    while value > math.pi:
        value -= 2 * math.pi
    while value <= -math.pi:
        value += 2 * math.pi
    return value
