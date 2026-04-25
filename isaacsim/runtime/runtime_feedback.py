from __future__ import annotations

import json
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class IsaacRuntimeFeedbackStore:
    def __init__(
        self,
        feedback_path: Path | str,
        max_recent_events: int = 20,
        write_interval_seconds: float = 0.5,
    ) -> None:
        self.feedback_path = Path(feedback_path)
        self.max_recent_events = max(1, int(max_recent_events))
        self.write_interval_seconds = max(0.05, float(write_interval_seconds))
        self.last_command: dict[str, Any] | None = None
        self.active_command: dict[str, Any] | None = None
        self.controller_snapshot: dict[str, Any] | None = None
        self.last_event: dict[str, Any] | None = None
        self.recent_events: deque[dict[str, Any]] = deque(maxlen=self.max_recent_events)
        self.updated_at: str | None = None
        self._last_written_at = 0.0
        self._last_written_status = ""
        self._last_written_target = ""

    def record_command(self, command_id: str, envelope: dict[str, Any]) -> dict[str, Any]:
        action = str(envelope.get("action") or "").strip()
        payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
        waypoint_name = str(payload.get("waypointName") or "").strip()
        recorded_at = utc_now()
        command = {
            "commandId": command_id,
            "action": action,
            "waypoint": waypoint_name,
            "receivedAt": recorded_at,
        }

        self.last_command = command
        self.active_command = command if action == "robot_controller.goto_waypoint" and waypoint_name else None
        self._write_state(force=True)
        return command

    def record_snapshot(self, snapshot: dict[str, Any]) -> dict[str, Any] | None:
        previous_snapshot = self.controller_snapshot
        current_snapshot = clone_jsonable(snapshot)
        event = self._detect_arrival(previous_snapshot, current_snapshot)

        self.controller_snapshot = current_snapshot
        if event is not None:
            self.last_event = event
            self.recent_events.appendleft(event)
            self.active_command = None

        self._write_state(force=self._should_force_snapshot_write(current_snapshot, event))
        return event

    def _detect_arrival(
        self,
        previous_snapshot: dict[str, Any] | None,
        current_snapshot: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        if not self.active_command or not current_snapshot:
            return None

        waypoint_name = str(self.active_command.get("waypoint") or "").strip()
        if not waypoint_name:
            return None

        previous_status = str((previous_snapshot or {}).get("status") or "").strip()
        previous_target = str((previous_snapshot or {}).get("targetWaypoint") or "").strip()
        current_status = str(current_snapshot.get("status") or "").strip()
        current_target = str(current_snapshot.get("targetWaypoint") or "").strip()

        was_moving_to_target = previous_status == "moving_to_waypoint" or previous_target == waypoint_name
        is_idle_after_target = current_status == "idle" and not current_target

        if not was_moving_to_target or not is_idle_after_target:
            return None

        command_id = str(self.active_command.get("commandId") or "").strip()
        human_name = waypoint_name.replace("_", " ")
        base_pose = current_snapshot.get("basePose") if isinstance(current_snapshot.get("basePose"), dict) else None

        return {
            "eventId": f"{command_id}:arrived",
            "type": "arrived",
            "commandId": command_id,
            "waypoint": waypoint_name,
            "message": f"Arrived at {human_name}.",
            "completedAt": utc_now(),
            "basePose": base_pose,
        }

    def _should_force_snapshot_write(self, snapshot: dict[str, Any], event: dict[str, Any] | None) -> bool:
        if event is not None:
            return True

        now = time.monotonic()
        current_status = str(snapshot.get("status") or "").strip()
        current_target = str(snapshot.get("targetWaypoint") or "").strip()

        if current_status != self._last_written_status or current_target != self._last_written_target:
            return True

        return now - self._last_written_at >= self.write_interval_seconds

    def _write_state(self, force: bool = False) -> None:
        if not force:
            return

        self.updated_at = utc_now()
        payload = {
            "status": "ok",
            "updatedAt": self.updated_at,
            "lastCommand": self.last_command,
            "activeCommand": self.active_command,
            "controller": self.controller_snapshot,
            "lastEvent": self.last_event,
            "recentEvents": list(self.recent_events),
        }

        self.feedback_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.feedback_path.with_suffix(f"{self.feedback_path.suffix}.tmp")
        temp_path.write_text(f"{json.dumps(payload, indent=2)}\n", encoding="utf-8")
        temp_path.replace(self.feedback_path)
        self._last_written_at = time.monotonic()
        self._last_written_status = str((self.controller_snapshot or {}).get("status") or "").strip()
        self._last_written_target = str((self.controller_snapshot or {}).get("targetWaypoint") or "").strip()


def clone_jsonable(value: Any) -> Any:
    return json.loads(json.dumps(value))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
