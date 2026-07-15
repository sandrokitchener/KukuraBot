#!/usr/bin/env python3
"""Bounded Cartographer global relocalization against the active PBSTREAM."""

from __future__ import annotations

import argparse
from collections import deque
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from typing import Any

import rclpy
from cartographer_ros_msgs.srv import (
    FinishTrajectory,
    GetTrajectoryStates,
    StartTrajectory,
)
from nav2_msgs.srv import ManageLifecycleNodes
from rclpy.node import Node
from std_srvs.srv import Trigger
from tf2_ros import Buffer, TransformListener


ACTIVE = 0
FINISHED = 1
FROZEN = 2
STATUS_OK = 0
RECOVERY_NAMESPACE = "/robodoge_recovery"
CROSS_CONSTRAINT_RE = re.compile(
    r"Node \((?P<node_trajectory>\d+),\s*(?P<node>\d+)\).*?"
    r"submap \((?P<submap_trajectory>\d+),\s*(?P<submap>\d+)\).*?"
    r"score (?P<score>\d+(?:\.\d+)?)%"
)


class RecoveryError(RuntimeError):
    pass


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def angular_distance(left: float, right: float) -> float:
    return abs(math.atan2(math.sin(left - right), math.cos(left - right)))


def select_anchor_trajectory(
    constraints: list[dict[str, Any]], frozen_ids: list[int]
) -> int:
    if not frozen_ids:
        raise RecoveryError("Cartographer loaded no frozen trajectories.")
    scores: dict[int, tuple[int, float, float]] = {}
    for constraint in constraints:
        trajectory_id = int(constraint["frozenTrajectoryId"])
        if trajectory_id not in frozen_ids:
            continue
        count, total, highest = scores.get(trajectory_id, (0, 0.0, 0.0))
        score = float(constraint["score"])
        scores[trajectory_id] = (count + 1, total + score, max(highest, score))
    return max(frozen_ids, key=lambda value: (*scores.get(value, (0, 0.0, 0.0)), -value))


def yaw_from_quaternion(x: float, y: float, z: float, w: float) -> float:
    return math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))


def resume_pose_hint(metadata: dict[str, Any]) -> dict[str, Any] | None:
    value = metadata.get("resumePose")
    if not isinstance(value, dict) or value.get("frame") != "map":
        return None
    if not str(value.get("capturedAt") or "").strip():
        return None
    try:
        x, y, yaw = (float(value[name]) for name in ("x", "y", "yaw"))
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(number) for number in (x, y, yaw)):
        return None
    return {
        "position": {"x": x, "y": y, "z": 0.0},
        "orientation": {
            "x": 0.0,
            "y": 0.0,
            "z": math.sin(yaw / 2.0),
            "w": math.cos(yaw / 2.0),
        },
    }


def service_name(namespace: str, leaf: str) -> str:
    return f"{namespace.rstrip('/')}/{leaf}" if namespace else f"/{leaf}"


class AtomicStatus:
    def __init__(self, path: Path):
        self.path = path
        self.value: dict[str, Any] = {
            "trusted": False,
            "proof": None,
            "phase": "starting",
            "error": None,
            "recoveredPose": None,
            "localPose": None,
            "frozenTrajectoryIds": [],
            "recoveryTrajectoryId": None,
            "normalTrajectoryId": None,
            "acceptedCrossTrajectoryConstraintCount": 0,
            "acceptedCrossTrajectoryDistinctNodeCount": 0,
            "acceptedCrossTrajectoryConstraintScores": [],
            "acceptedCrossTrajectoryConstraints": [],
            "startedAt": iso_now(),
            "updatedAt": iso_now(),
            "completedAt": None,
        }
        self.write()

    def update(self, **values: Any) -> None:
        self.value.update(values)
        self.value["updatedAt"] = iso_now()
        self.write()

    def write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(self.value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)


class RosServices:
    def __init__(self, node: Node, namespace: str):
        self.node = node
        self.namespace = namespace
        self.states_client = node.create_client(
            GetTrajectoryStates, service_name(namespace, "get_trajectory_states")
        )
        self.finish_client = node.create_client(
            FinishTrajectory, service_name(namespace, "finish_trajectory")
        )
        self.start_client = node.create_client(
            StartTrajectory, service_name(namespace, "start_trajectory")
        )

    def refresh(self) -> None:
        for client in (self.states_client, self.finish_client, self.start_client):
            self.node.destroy_client(client)
        self.__init__(self.node, self.namespace)

    def wait(self, timeout_sec: float) -> None:
        if not self.states_client.wait_for_service(timeout_sec=timeout_sec):
            raise RecoveryError(
                f"Cartographer service {self.states_client.srv_name} was not available."
            )

    def call(self, client: Any, request: Any, timeout_sec: float) -> Any:
        if not client.wait_for_service(timeout_sec=min(timeout_sec, 3.0)):
            raise RecoveryError(f"ROS service {client.srv_name} was not available.")
        future = client.call_async(request)
        rclpy.spin_until_future_complete(self.node, future, timeout_sec=timeout_sec)
        if not future.done():
            future.cancel()
            raise RecoveryError(f"ROS service {client.srv_name} timed out.")
        if future.exception() is not None:
            raise RecoveryError(f"ROS service {client.srv_name} failed: {future.exception()}")
        return future.result()

    def states(self, timeout_sec: float) -> dict[int, int]:
        deadline = time.monotonic() + timeout_sec
        last_error: RecoveryError | None = None
        for attempt in range(3):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                response = self.call(
                    self.states_client,
                    GetTrajectoryStates.Request(),
                    min(remaining, 10.0),
                )
                if response.status.code != STATUS_OK:
                    raise RecoveryError(
                        f"GetTrajectoryStates failed: {response.status.message or response.status.code}"
                    )
                ids = list(response.trajectory_states.trajectory_id)
                states = list(response.trajectory_states.trajectory_state)
                if len(ids) != len(states):
                    raise RecoveryError("Cartographer returned mismatched trajectory state arrays.")
                return dict(zip(ids, states))
            except RecoveryError as error:
                last_error = error
                if attempt < 2:
                    self.refresh()
                    time.sleep(min(0.5, max(0.0, deadline - time.monotonic())))
        raise last_error or RecoveryError("Cartographer trajectory state query timed out.")

    def finish(self, trajectory_id: int, timeout_sec: float) -> None:
        request = FinishTrajectory.Request()
        request.trajectory_id = int(trajectory_id)
        response = self.call(self.finish_client, request, timeout_sec)
        if response.status.code != STATUS_OK:
            raise RecoveryError(
                f"FinishTrajectory({trajectory_id}) failed: "
                f"{response.status.message or response.status.code}"
            )

    def start(
        self,
        configuration_directory: Path,
        configuration_basename: str,
        timeout_sec: float,
        *,
        initial_pose: dict[str, Any] | None = None,
        relative_to_trajectory_id: int = 0,
    ) -> int:
        request = StartTrajectory.Request()
        request.configuration_directory = str(configuration_directory)
        request.configuration_basename = configuration_basename
        request.use_initial_pose = initial_pose is not None
        request.relative_to_trajectory_id = int(relative_to_trajectory_id)
        request.initial_pose.orientation.w = 1.0
        if initial_pose is not None:
            position = initial_pose["position"]
            orientation = initial_pose["orientation"]
            request.initial_pose.position.x = float(position["x"])
            request.initial_pose.position.y = float(position["y"])
            request.initial_pose.position.z = float(position.get("z", 0.0))
            request.initial_pose.orientation.x = float(orientation["x"])
            request.initial_pose.orientation.y = float(orientation["y"])
            request.initial_pose.orientation.z = float(orientation["z"])
            request.initial_pose.orientation.w = float(orientation["w"])
        response = self.call(self.start_client, request, timeout_sec)
        if response.status.code != STATUS_OK:
            raise RecoveryError(
                f"StartTrajectory({configuration_basename}) failed: "
                f"{response.status.message or response.status.code}"
            )
        return int(response.trajectory_id)

class Relocalizer:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.remote_root = Path(args.remote_root).resolve()
        self.maps_dir = self.remote_root / "maps"
        self.logs_dir = self.remote_root / "logs"
        self.configuration_dir = Path(__file__).resolve().parent
        self.status = AtomicStatus(
            self.maps_dir / "robodoge_localization_status.json"
        )
        self.node = Node(f"robodoge_global_relocalizer_{os.getpid()}")
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self.node)
        self.global_services = RosServices(self.node, "")
        self.recovery_services = RosServices(self.node, RECOVERY_NAMESPACE)
        self.recovery_process: subprocess.Popen[Any] | None = None
        self.normal_process: subprocess.Popen[Any] | None = None
        self.original_pids: set[int] = set()
        self.original_stopped = False
        self.paused_nav2 = False
        self.recovery_trajectory_id: int | None = None
        self.normal_trajectory_id: int | None = None
        self.normal_config = ""
        self.handoff_config = ""
        self.recovery_config = ""
        self.active_pbstream = Path()
        self.resume_pose_hint: dict[str, Any] | None = None

    def run(self) -> dict[str, Any]:
        try:
            self._resolve_runtime()
            self._pause_nav2_if_active()
            self.status.update(
                phase="starting_recovery_process",
                normalConfigurationBasename=self.normal_config,
                handoffConfigurationBasename=self.handoff_config,
                recoveryConfigurationBasename=self.recovery_config,
                activePbstream=str(self.active_pbstream),
                initialPoseHint=self.resume_pose_hint,
                nav2PausedByRecovery=self.paused_nav2,
            )

            recovery_log = self.logs_dir / "map-pose-cartographer-recovery.log"
            self.recovery_process = self._launch_cartographer(
                self.recovery_config,
                self.active_pbstream,
                recovery_log,
                namespace=RECOVERY_NAMESPACE,
                start_default=False,
            )
            self.recovery_services.refresh()
            self.recovery_services.wait(self.args.service_timeout_sec)
            recovery_states = self.recovery_services.states(
                self.args.service_timeout_sec
            )
            frozen_ids = sorted(
                trajectory_id
                for trajectory_id, state in recovery_states.items()
                if state == FROZEN
            )
            if not frozen_ids:
                raise RecoveryError("Recovery Cartographer loaded no frozen trajectories.")
            self.status.update(
                phase="stopping_previous_localization",
                frozenTrajectoryIds=frozen_ids,
            )

            self._stop_pids(self.original_pids)
            self.original_stopped = True
            self.status.update(phase="starting_recovery_trajectory")
            recovery_started_ns = self.node.get_clock().now().nanoseconds
            self.recovery_trajectory_id = self.recovery_services.start(
                self.configuration_dir,
                self.recovery_config,
                self.args.service_timeout_sec,
                initial_pose=self.resume_pose_hint,
                relative_to_trajectory_id=frozen_ids[0],
            )
            self.status.update(
                phase="global_matching",
                recoveryTrajectoryId=self.recovery_trajectory_id,
                recoveryStartedAt=iso_now(),
            )

            constraints = self._wait_for_cross_constraints(
                recovery_log,
                self.recovery_trajectory_id,
                set(frozen_ids),
            )
            matched_trajectory_id = select_anchor_trajectory(constraints, frozen_ids)
            map_anchor_id = frozen_ids[0]
            self.status.update(phase="stabilizing_recovered_pose", matchedAt=iso_now())
            local_pose = self._wait_for_stable_transform(
                "odom", "base_link", recovery_started_ns
            )
            self.status.update(phase="finishing_recovery_trajectory")
            self.recovery_services.finish(
                self.recovery_trajectory_id, self.args.finish_timeout_sec
            )
            recovered_pose = self._wait_for_stable_transform(
                "map",
                "base_link",
                recovery_started_ns,
                required_samples=1,
                require_fresh=False,
            )
            self.status.update(
                localPose=local_pose,
                recoveredPose=recovered_pose,
                acceptedCrossTrajectoryConstraintCount=len(constraints),
                acceptedCrossTrajectoryConstraintScores=[
                    item["score"] for item in constraints
                ],
                acceptedCrossTrajectoryConstraints=constraints,
                matchedFrozenTrajectoryId=matched_trajectory_id,
                mapAnchorTrajectoryId=map_anchor_id,
            )

            self.status.update(
                phase="starting_normal_localization",
            )
            normal_log = self.logs_dir / "map-pose-cartographer.log"
            self.normal_process = self._launch_cartographer(
                self.handoff_config,
                self.active_pbstream,
                normal_log,
                namespace="",
                start_default=False,
            )
            self.global_services.refresh()
            self.global_services.wait(self.args.service_timeout_sec)
            normal_loaded_states = self.global_services.states(
                self.args.service_timeout_sec
            )
            normal_frozen_ids = sorted(
                trajectory_id
                for trajectory_id, state in normal_loaded_states.items()
                if state == FROZEN
            )
            self.status.update(
                normalLoadedStates=normal_loaded_states,
                normalFrozenTrajectoryIds=normal_frozen_ids,
            )
            if matched_trajectory_id not in normal_frozen_ids:
                raise RecoveryError(
                    "Handoff Cartographer did not reload the matched frozen trajectory."
                )
            if map_anchor_id not in normal_frozen_ids:
                raise RecoveryError(
                    "Handoff Cartographer did not reload the frozen map-frame anchor trajectory."
                )

            normal_started_ns = self.node.get_clock().now().nanoseconds
            # recovered_pose is expressed in Cartographer's global map frame.
            # Anchor it to the root loaded trajectory, not a later trajectory's
            # local frame, when PBSTREAMs contain repeated mapping sessions.
            normal_anchor_id = map_anchor_id
            self.normal_trajectory_id = self.global_services.start(
                self.configuration_dir,
                self.handoff_config,
                self.args.service_timeout_sec,
                initial_pose=recovered_pose,
                relative_to_trajectory_id=normal_anchor_id,
            )
            self.status.update(
                phase="verifying_normal_localization",
                normalTrajectoryId=self.normal_trajectory_id,
                normalAnchorTrajectoryId=normal_anchor_id,
                normalStartedAt=iso_now(),
            )
            self._require_state(
                self.global_services, self.normal_trajectory_id, ACTIVE
            )
            normal_pose = self._wait_for_stable_transform(
                "map", "base_link", normal_started_ns
            )
            if math.hypot(
                normal_pose["position"]["x"] - recovered_pose["position"]["x"],
                normal_pose["position"]["y"] - recovered_pose["position"]["y"],
            ) > self.args.handoff_position_tolerance_m:
                raise RecoveryError("Normal localization did not preserve recovered position.")
            if angular_distance(normal_pose["yaw"], recovered_pose["yaw"]) > self.args.handoff_yaw_tolerance_rad:
                raise RecoveryError("Normal localization did not preserve recovered yaw.")

            self._stop_process(self.recovery_process)
            self.recovery_process = None
            mapping_handoff = not self.handoff_config.endswith("_localization.lua")
            nav2_resumed, nav2_resume_error = (
                (False, None) if mapping_handoff else self._resume_nav2()
            )
            self.status.update(
                trusted=True,
                proof="cartographer-global-constraints",
                phase="mapping" if mapping_handoff else "trusted",
                error=None,
                recoveredPose=normal_pose,
                completedAt=iso_now(),
                nav2Resumed=nav2_resumed,
                nav2ResumeError=nav2_resume_error,
            )
            return self.status.value
        except BaseException as error:
            cleanup_error = self._rollback()
            message = str(error) or error.__class__.__name__
            if cleanup_error:
                message = f"{message}; rollback: {cleanup_error}"
            self.status.update(
                trusted=False,
                phase="error",
                error=message,
                completedAt=iso_now(),
                nav2Resumed=False,
            )
            raise

    def _resolve_runtime(self) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        processes = self._cartographer_processes()
        orphaned_recovery_pids = {
            pid for pid, args in processes.items() if self._is_recovery_process(args)
        }
        if orphaned_recovery_pids:
            self._stop_pids(orphaned_recovery_pids)
            processes = self._cartographer_processes()
        if len(processes) > 1:
            raise RecoveryError(
                f"Expected at most one Cartographer process, found {sorted(processes)}."
            )
        self.original_pids = set(processes)
        process_args = next(iter(processes.values()), [])
        detected_config = self._flag_value(process_args, "configuration_basename")
        if detected_config.endswith("_recovery.lua"):
            detected_config = detected_config.replace("_recovery.lua", ".lua")
        self.normal_config = self.args.normal_config or detected_config
        if not self.normal_config:
            self.normal_config = "robodoge_dogzilla_laser_only_noimu_localization.lua"
        self._require_basename(self.normal_config)
        if not self.normal_config.endswith("_localization.lua"):
            raise RecoveryError(
                f"Refusing global relocalization from non-localization config: {self.normal_config}"
            )
        self.recovery_config = self.args.recovery_config or self.normal_config.replace(
            ".lua", "_recovery.lua"
        )
        self.handoff_config = self.args.handoff_config or self.normal_config
        self._require_basename(self.recovery_config)
        self._require_basename(self.handoff_config)
        for basename in (self.normal_config, self.recovery_config, self.handoff_config):
            if not (self.configuration_dir / basename).is_file():
                raise RecoveryError(f"Cartographer configuration is missing: {basename}")
        self.active_pbstream = self._active_pbstream()
        self.status.update(previousCartographerProcessIds=sorted(self.original_pids))

    def _active_pbstream(self) -> Path:
        metadata_path = self.maps_dir / "robodoge_home_map.json"
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RecoveryError(f"Could not read active map metadata: {error}") from error
        artifacts = metadata.get("artifacts")
        pbstream = artifacts.get("pbstream") if isinstance(artifacts, dict) else None
        if not isinstance(pbstream, dict):
            raise RecoveryError("Active map metadata has no PBSTREAM manifest.")
        value = str(pbstream.get("path") or metadata.get("pbstream") or "").strip()
        expected_hash = str(pbstream.get("sha256") or "").strip().lower()
        if not value or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
            raise RecoveryError("Active PBSTREAM manifest is invalid.")
        path = Path(value)
        if not path.is_absolute():
            path = metadata_path.parent / path
        path = path.resolve()
        if not path.is_file() or path.stat().st_size == 0:
            raise RecoveryError(f"Active PBSTREAM is missing: {path}")
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected_hash:
            raise RecoveryError(f"Active PBSTREAM hash mismatch: {path}")
        self.resume_pose_hint = resume_pose_hint(metadata)
        return path

    def _pause_nav2_if_active(self) -> None:
        if self.args.no_pause_nav2:
            return
        active = self._nav2_is_active()
        if active is None:
            raise RecoveryError("Could not prove Nav2 inactive before changing map localization.")
        if active is not True:
            return
        self._manage_nav2("pause")
        self.paused_nav2 = True

    def _nav2_is_active(self) -> bool | None:
        client = self.node.create_client(
            Trigger, "/lifecycle_manager_navigation/is_active"
        )
        if not client.wait_for_service(timeout_sec=2.0):
            return None
        response = self._call(client, Trigger.Request(), 3.0)
        return bool(response.success)

    def _manage_nav2(self, action: str) -> None:
        client = self.node.create_client(
            ManageLifecycleNodes, "/lifecycle_manager_navigation/manage_nodes"
        )
        if not client.wait_for_service(timeout_sec=3.0):
            raise RecoveryError(f"Nav2 lifecycle service unavailable for {action}.")
        request = ManageLifecycleNodes.Request()
        request.command = int(
            getattr(
                ManageLifecycleNodes.Request,
                "PAUSE" if action == "pause" else "RESUME",
                1 if action == "pause" else 2,
            )
        )
        response = self._call(client, request, self.args.service_timeout_sec)
        if not response.success:
            raise RecoveryError(f"Nav2 lifecycle {action} failed.")

    def _resume_nav2(self) -> tuple[bool, str | None]:
        if not self.paused_nav2:
            return False, None
        try:
            self._manage_nav2("resume")
            return True, None
        except Exception as error:
            return False, str(error)

    def _call(self, client: Any, request: Any, timeout_sec: float) -> Any:
        future = client.call_async(request)
        rclpy.spin_until_future_complete(self.node, future, timeout_sec=timeout_sec)
        if not future.done():
            future.cancel()
            raise RecoveryError(f"ROS service {client.srv_name} timed out.")
        if future.exception() is not None:
            raise RecoveryError(f"ROS service {client.srv_name} failed: {future.exception()}")
        return future.result()

    def _launch_cartographer(
        self,
        configuration_basename: str,
        pbstream: Path,
        log_path: Path,
        *,
        namespace: str,
        start_default: bool,
    ) -> subprocess.Popen[Any]:
        binary = Path(self.args.cartographer_node)
        if not binary.is_file():
            raise RecoveryError(f"Cartographer executable is missing: {binary}")
        command = [
            str(binary),
            f"-configuration_directory={self.configuration_dir}",
            f"-configuration_basename={configuration_basename}",
            f"-load_state_filename={pbstream}",
            "-load_frozen_state=true",
            f"-start_trajectory_with_default_topics={'true' if start_default else 'false'}",
            "-logtostderr=true",
            "-logbufsecs=0",
            "--ros-args",
            "-p",
            "use_sim_time:=false",
            "-r",
            "scan:=/scan",
        ]
        if namespace:
            command.extend(["-r", f"__ns:={namespace}"])
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("w", encoding="utf-8", newline="\n") as log_handle:
            process = subprocess.Popen(
                command,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
            )
        time.sleep(0.5)
        if process.poll() is not None:
            raise RecoveryError(
                f"Cartographer exited during startup: {self._log_tail(log_path)}"
            )
        return process

    def _wait_for_cross_constraints(
        self,
        log_path: Path,
        recovery_id: int,
        frozen_ids: set[int],
    ) -> list[dict[str, Any]]:
        deadline = time.monotonic() + self.args.match_timeout_sec
        offset = 0
        pending = ""
        accepted: dict[tuple[int, int, int], dict[str, Any]] = {}
        distinct_nodes: set[int] = set()
        while time.monotonic() < deadline:
            if self.recovery_process is None or self.recovery_process.poll() is not None:
                raise RecoveryError(
                    f"Recovery Cartographer exited: {self._log_tail(log_path)}"
                )
            if log_path.is_file():
                with log_path.open("r", encoding="utf-8", errors="replace") as handle:
                    handle.seek(offset)
                    chunk = handle.read()
                    offset = handle.tell()
                pending += chunk
                complete_lines = pending.splitlines(keepends=True)
                if complete_lines and not complete_lines[-1].endswith(("\n", "\r")):
                    pending = complete_lines.pop()
                else:
                    pending = ""
                for match in CROSS_CONSTRAINT_RE.finditer("".join(complete_lines)):
                    node_trajectory = int(match.group("node_trajectory"))
                    node_id = int(match.group("node"))
                    frozen_trajectory = int(match.group("submap_trajectory"))
                    frozen_submap = int(match.group("submap"))
                    score = float(match.group("score"))
                    if (
                        node_trajectory != recovery_id
                        or frozen_trajectory not in frozen_ids
                        or score < self.args.min_score_percent
                    ):
                        continue
                    key = (node_id, frozen_trajectory, frozen_submap)
                    accepted[key] = {
                        "recoveryNodeId": node_id,
                        "frozenTrajectoryId": frozen_trajectory,
                        "frozenSubmapId": frozen_submap,
                        "score": score,
                    }
                    distinct_nodes.add(node_id)
                if accepted:
                    values = list(accepted.values())
                    self.status.update(
                        acceptedCrossTrajectoryConstraintCount=len(values),
                        acceptedCrossTrajectoryDistinctNodeCount=len(distinct_nodes),
                        acceptedCrossTrajectoryConstraintScores=[
                            item["score"] for item in values
                        ],
                        acceptedCrossTrajectoryConstraints=values,
                    )
                if len(distinct_nodes) >= self.args.min_cross_nodes:
                    return list(accepted.values())
            rclpy.spin_once(self.node, timeout_sec=0.2)
        raise RecoveryError(
            f"Global localization timed out without {self.args.min_cross_nodes} "
            "distinct frozen-map constraint matches."
        )

    def _wait_for_stable_transform(
        self,
        target_frame: str,
        source_frame: str,
        newer_than_ns: int,
        *,
        required_samples: int | None = None,
        require_fresh: bool = True,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + self.args.stable_timeout_sec
        sample_count = required_samples or self.args.stable_samples
        samples: deque[dict[str, Any]] = deque(maxlen=sample_count)
        seen_stamps: set[int] = set()
        while time.monotonic() < deadline:
            rclpy.spin_once(self.node, timeout_sec=0.2)
            try:
                transform = self.tf_buffer.lookup_transform(
                    target_frame, source_frame, rclpy.time.Time()
                )
            except Exception:
                continue
            stamp_ns = (
                int(transform.header.stamp.sec) * 1_000_000_000
                + int(transform.header.stamp.nanosec)
            )
            age_sec = (self.node.get_clock().now().nanoseconds - stamp_ns) / 1e9
            if (
                stamp_ns <= newer_than_ns
                or stamp_ns in seen_stamps
                or age_sec < -0.5
                or (require_fresh and age_sec > self.args.transform_max_age_sec)
            ):
                continue
            seen_stamps.add(stamp_ns)
            translation = transform.transform.translation
            rotation = transform.transform.rotation
            sample = {
                "frame": target_frame,
                "childFrame": source_frame,
                "position": {
                    "x": float(translation.x),
                    "y": float(translation.y),
                    "z": float(translation.z),
                },
                "orientation": {
                    "x": float(rotation.x),
                    "y": float(rotation.y),
                    "z": float(rotation.z),
                    "w": float(rotation.w),
                },
                "yaw": yaw_from_quaternion(
                    float(rotation.x),
                    float(rotation.y),
                    float(rotation.z),
                    float(rotation.w),
                ),
                "stampSec": stamp_ns / 1e9,
                "capturedAt": iso_now(),
            }
            samples.append(sample)
            if len(samples) == sample_count and self._samples_stable(samples):
                return samples[-1]
        raise RecoveryError(
            f"Transform {target_frame}->{source_frame} did not become fresh and stable."
        )

    def _samples_stable(self, samples: deque[dict[str, Any]]) -> bool:
        values = list(samples)
        for index, left in enumerate(values):
            for right in values[index + 1 :]:
                if math.hypot(
                    left["position"]["x"] - right["position"]["x"],
                    left["position"]["y"] - right["position"]["y"],
                ) > self.args.stable_position_tolerance_m:
                    return False
                if angular_distance(left["yaw"], right["yaw"]) > self.args.stable_yaw_tolerance_rad:
                    return False
        return True

    def _require_state(
        self,
        services: RosServices,
        trajectory_id: int,
        expected_state: int,
        timeout_sec: float | None = None,
    ) -> None:
        deadline = time.monotonic() + (timeout_sec or self.args.service_timeout_sec)
        while time.monotonic() < deadline:
            states = services.states(self.args.service_timeout_sec)
            if states.get(trajectory_id) == expected_state:
                return
            time.sleep(0.2)
        raise RecoveryError(
            f"Trajectory {trajectory_id} did not reach state {expected_state}."
        )

    def _rollback(self) -> str:
        errors: list[str] = []
        if self.paused_nav2:
            try:
                if self._nav2_is_active() is True:
                    self._manage_nav2("pause")
            except Exception as error:
                errors.append(f"keep Nav2 paused: {error}")
        if self.recovery_trajectory_id is not None and self.recovery_process is not None:
            try:
                states = self.recovery_services.states(3.0)
                if states.get(self.recovery_trajectory_id) == ACTIVE:
                    self.recovery_services.finish(self.recovery_trajectory_id, 5.0)
            except Exception as error:
                errors.append(f"finish recovery: {error}")

        if self.normal_process is not None:
            try:
                self._stop_process(self.normal_process)
            except Exception as error:
                errors.append(f"stop incomplete normal process: {error}")
            self.normal_process = None

        restored = False
        restore_started = False
        if self.original_stopped and not restore_started:
            try:
                restore_log = self.logs_dir / "map-pose-cartographer.log"
                self.normal_process = self._launch_cartographer(
                    self.normal_config,
                    self.active_pbstream,
                    restore_log,
                    namespace="",
                    start_default=False,
                )
                restore_started = True
            except Exception as error:
                errors.append(f"start normal rollback process: {error}")

        if self.recovery_process is not None:
            try:
                self._stop_process(self.recovery_process)
                self.recovery_process = None
            except Exception as error:
                errors.append(f"stop recovery process: {error}")
        if restore_started and self.recovery_process is None:
            try:
                self.global_services.wait(5.0)
                restored_id = self.global_services.start(
                    self.configuration_dir,
                    self.normal_config,
                    8.0,
                )
                self._require_state(self.global_services, restored_id, ACTIVE)
                self.normal_trajectory_id = restored_id
                restored = True
            except Exception as error:
                errors.append(f"start normal rollback trajectory: {error}")
        try:
            self.status.update(
                restoredNormalLocalization=restored,
                recoveryProcessStillRunning=(
                    self.recovery_process.pid
                    if self.recovery_process is not None
                    and self.recovery_process.poll() is None
                    else None
                ),
            )
        except Exception as error:
            errors.append(f"write rollback status: {error}")
        return "; ".join(errors)

    def _cartographer_processes(self) -> dict[int, list[str]]:
        processes: dict[int, list[str]] = {}
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                args = (entry / "cmdline").read_bytes().split(b"\0")
                decoded = [value.decode("utf-8", "replace") for value in args if value]
            except (FileNotFoundError, PermissionError, ProcessLookupError):
                continue
            if decoded and Path(decoded[0]).name == "cartographer_node":
                processes[int(entry.name)] = decoded
        return processes

    @staticmethod
    def _is_recovery_process(args: list[str]) -> bool:
        return any(
            value.endswith("_recovery.lua") or value == "__ns:=/robodoge_recovery"
            for value in args
        )

    @staticmethod
    def _flag_value(args: list[str], flag: str) -> str:
        short = f"-{flag}"
        for index, value in enumerate(args):
            if value == short and index + 1 < len(args):
                return args[index + 1]
            if value.startswith(f"{short}="):
                return value.split("=", 1)[1]
        return ""

    @staticmethod
    def _require_basename(value: str) -> None:
        if not value or Path(value).name != value:
            raise RecoveryError(f"Invalid Cartographer configuration basename: {value}")

    def _stop_pids(self, pids: set[int]) -> None:
        for pid in pids:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + self.args.process_stop_timeout_sec
        remaining = set(pids)
        while remaining and time.monotonic() < deadline:
            remaining = {pid for pid in remaining if Path(f"/proc/{pid}").exists()}
            if remaining:
                time.sleep(0.1)
        for pid in remaining:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def _stop_process(self, process: subprocess.Popen[Any]) -> None:
        if process.poll() is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=self.args.process_stop_timeout_sec)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=2.0)
        except ProcessLookupError:
            pass
        process.poll()
        if process.returncode is None:
            raise RecoveryError(f"Process {process.pid} did not stop.")

    @staticmethod
    def _log_tail(path: Path, lines: int = 12) -> str:
        try:
            return " | ".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
        except OSError:
            return "log unavailable"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Relocalize DOGZILLA globally against the active frozen PBSTREAM."
    )
    parser.add_argument("--remote-root", default=os.environ.get("REMOTE_ROOT", "/home/pi/robodoge"))
    parser.add_argument("--normal-config", default="")
    parser.add_argument("--handoff-config", default="")
    parser.add_argument("--recovery-config", default="")
    parser.add_argument(
        "--cartographer-node",
        default="/opt/ros/humble/lib/cartographer_ros/cartographer_node",
    )
    parser.add_argument("--no-pause-nav2", action="store_true")
    parser.add_argument("--match-timeout-sec", type=float, default=60.0)
    parser.add_argument("--service-timeout-sec", type=float, default=30.0)
    parser.add_argument("--finish-timeout-sec", type=float, default=90.0)
    parser.add_argument("--stable-timeout-sec", type=float, default=15.0)
    parser.add_argument("--process-stop-timeout-sec", type=float, default=5.0)
    parser.add_argument("--min-score-percent", type=float, default=55.0)
    parser.add_argument("--min-cross-nodes", type=int, default=3)
    parser.add_argument("--stable-samples", type=int, default=5)
    parser.add_argument("--stable-position-tolerance-m", type=float, default=0.10)
    parser.add_argument("--stable-yaw-tolerance-rad", type=float, default=0.10)
    parser.add_argument("--handoff-position-tolerance-m", type=float, default=0.25)
    parser.add_argument("--handoff-yaw-tolerance-rad", type=float, default=0.25)
    parser.add_argument("--transform-max-age-sec", type=float, default=2.0)
    args = parser.parse_args()
    if args.min_score_percent < 55.0:
        parser.error("--min-score-percent cannot be lower than 55")
    if args.min_cross_nodes < 3:
        parser.error("--min-cross-nodes cannot be lower than 3")
    if args.stable_samples < 3:
        parser.error("--stable-samples cannot be lower than 3")
    for name in (
        "match_timeout_sec",
        "service_timeout_sec",
        "finish_timeout_sec",
        "stable_timeout_sec",
        "process_stop_timeout_sec",
        "transform_max_age_sec",
    ):
        if getattr(args, name) <= 0:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    return args


def main() -> int:
    args = parse_args()

    def stop_requested(signum: int, _frame: Any) -> None:
        raise InterruptedError(f"received signal {signum}")

    signal.signal(signal.SIGTERM, stop_requested)
    signal.signal(signal.SIGINT, stop_requested)
    rclpy.init(args=None)
    relocalizer: Relocalizer | None = None
    lock_handle: Any = None
    try:
        lock_path = Path(args.remote_root).resolve() / "maps" / "robodoge_localization.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_handle = lock_path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RecoveryError("Another DOGZILLA global relocalization is running.") from error
        lock_handle.seek(0)
        lock_handle.truncate()
        lock_handle.write(f"{os.getpid()}\n")
        lock_handle.flush()
        relocalizer = Relocalizer(args)
        result = relocalizer.run()
        print(json.dumps(result, sort_keys=True))
        return 0
    except BaseException as error:
        print(f"DOGZILLA global relocalization failed: {error}", file=sys.stderr)
        return 1
    finally:
        if relocalizer is not None:
            relocalizer.node.destroy_node()
        if lock_handle is not None:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
            lock_handle.close()
        rclpy.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
