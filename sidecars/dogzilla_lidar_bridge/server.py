#!/usr/bin/env python3
"""DOGZILLA Pi-local ROS2 LaserScan bridge."""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import signal
import stat
import struct
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

try:
    import rclpy
    from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy, qos_profile_sensor_data
    from rclpy.time import Time
    from sensor_msgs.msg import LaserScan
except Exception as error:  # pragma: no cover - exercised on Pi startup
    print(f"Missing ROS2 lidar dependency: {error}", file=sys.stderr, flush=True)
    raise

try:
    from nav_msgs.msg import Odometry, OccupancyGrid
    from tf2_msgs.msg import TFMessage
except Exception as error:  # pragma: no cover - pose remains disabled if optional ROS messages are unavailable
    Odometry = None
    OccupancyGrid = None
    TFMessage = None
    POSE_DEPENDENCY_ERROR = f"Missing ROS2 pose dependency: {error}"
else:
    POSE_DEPENDENCY_ERROR = ""

try:
    from tf2_ros import Buffer, TransformListener
except Exception as error:  # pragma: no cover - direct topic subscriptions still expose pose when available
    Buffer = None
    TransformListener = None
    TF2_BUFFER_ERROR = f"Missing ROS2 TF buffer dependency: {error}"
else:
    TF2_BUFFER_ERROR = ""


@dataclass
class ScanSnapshot:
    seq: int
    received_at: float
    frame_id: str
    angle_min: float
    angle_max: float
    angle_increment: float
    range_min: float
    range_max: float
    ranges: list[float | None]
    intensities: list[float | None]


@dataclass
class PoseSnapshot:
    seq: int
    received_at: float
    frame_id: str
    child_frame_id: str
    source: str
    x: float
    y: float
    theta: float


@dataclass
class ScanOdomState:
    initialized: bool = False
    last_points: list[tuple[float, float]] = field(default_factory=list)
    last_seq: int = 0
    x: float = 0.0
    y: float = 0.0
    theta: float = 0.0
    updates: int = 0


@dataclass
class LidarState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    latest_scan: ScanSnapshot | None = None
    latest_error: str = ""
    frames: int = 0
    driver_process: subprocess.Popen | None = None
    driver_log: deque[str] = field(default_factory=lambda: deque(maxlen=80))
    worker_started: bool = False
    topic_publishers: list[dict[str, Any]] = field(default_factory=list)
    topic_subscriptions: list[dict[str, Any]] = field(default_factory=list)
    topic_graph_at: float | None = None
    latest_pose: PoseSnapshot | None = None
    pose_frames: int = 0
    pose_error: str = ""
    pose_topic_graph: dict[str, dict[str, Any]] = field(default_factory=dict)
    pose_topic_graph_at: float | None = None
    scan_odom: ScanOdomState = field(default_factory=ScanOdomState)
    latest_map: Any | None = None
    map_received_at: float = 0.0


class LidarHandler(BaseHTTPRequestHandler):
    server_version = "RoboDogeLidarBridge/1.0"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        ensure_worker(self.server.state, self.server.args)

        if parsed.path == "/healthz":
            self.send_json(HTTPStatus.OK, health_payload(self.server.state, self.server.args))
            return
        if parsed.path == "/diagnostics":
            self.send_json(HTTPStatus.OK, diagnostics_payload(self.server.state, self.server.args))
            return
        if parsed.path == "/scan":
            payload = scan_payload(self.server.state, self.server.args)
            status = HTTPStatus.OK if payload.get("ok") else HTTPStatus.SERVICE_UNAVAILABLE
            self.send_json(status, payload)
            return
        if parsed.path == "/pose":
            payload = pose_payload(self.server.state, self.server.args)
            status = HTTPStatus.OK if payload.get("ok") else HTTPStatus.SERVICE_UNAVAILABLE
            self.send_json(status, payload)
            return
        if parsed.path == "/map":
            payload = map_payload(self.server.state, self.server.args)
            status = HTTPStatus.OK if payload.get("ok") else HTTPStatus.SERVICE_UNAVAILABLE
            self.send_json(status, payload)
            return

        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", flush=True)


def ensure_worker(state: LidarState, args: argparse.Namespace) -> None:
    with state.lock:
        if state.worker_started:
            return
        state.worker_started = True

    threading.Thread(target=driver_loop, args=(state, args), daemon=True).start()
    threading.Thread(target=scan_loop, args=(state, args), daemon=True).start()


def driver_loop(state: LidarState, args: argparse.Namespace) -> None:
    if not args.start_driver:
        append_driver_log(state, "driver start disabled; subscribing only")
        return

    while True:
        command = build_driver_command(args)
        append_driver_log(state, "starting: " + " ".join(command))
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                start_new_session=True,
            )
            with state.lock:
                state.driver_process = process
                state.latest_error = ""

            assert process.stdout is not None
            for line in process.stdout:
                append_driver_log(state, line.rstrip())

            code = process.wait()
            append_driver_log(state, f"driver exited with code {code}")
            with state.lock:
                state.driver_process = None
                state.latest_error = f"lidar driver exited with code {code}"
        except Exception as error:
            append_driver_log(state, f"driver error: {error}")
            with state.lock:
                state.latest_error = str(error)

        time.sleep(args.restart_delay)


def scan_loop(state: LidarState, args: argparse.Namespace) -> None:
    rclpy.init(args=None)
    node = rclpy.create_node("robodoge_lidar_bridge")
    pose_parent_frames = parse_frame_list(args.pose_parent_frames)
    base_frames = parse_frame_list(args.base_frames)
    tf_buffer = Buffer() if Buffer is not None else None
    if tf_buffer is not None and TransformListener is not None:
        TransformListener(tf_buffer, node)

    def on_scan(message: LaserScan) -> None:
        snapshot = scan_to_snapshot(message)
        with state.lock:
            state.latest_scan = snapshot
            state.frames += 1
            state.latest_error = ""
        update_scan_odom_snapshot(state, snapshot, args)

    def on_map(message: Any) -> None:
        with state.lock:
            state.latest_map = message
            state.map_received_at = time.time()

    def on_tf(message: Any) -> None:
        if TFMessage is None:
            return

        for transform in message.transforms:
            snapshot = pose_from_transform(transform, pose_parent_frames, base_frames)
            if snapshot is not None:
                update_pose_snapshot(state, snapshot, args)

    def on_odom(message: Any) -> None:
        snapshot = pose_from_odom(message, base_frames, args)
        if snapshot is not None:
            update_pose_snapshot(state, snapshot, args)

    def update_pose_from_tf_buffer() -> None:
        if tf_buffer is None:
            if TF2_BUFFER_ERROR:
                with state.lock:
                    state.pose_error = TF2_BUFFER_ERROR
            return

        for parent_frame in sorted(pose_parent_frames, key=lambda frame: pose_frame_priority(frame, args), reverse=True):
            for base_frame in base_frames:
                try:
                    transform = tf_buffer.lookup_transform(parent_frame, base_frame, Time())
                except Exception as error:
                    with state.lock:
                        state.pose_error = f"TF lookup {parent_frame}->{base_frame} unavailable: {error}"
                    continue

                snapshot = pose_from_transform(transform, pose_parent_frames, base_frames)
                if snapshot is not None:
                    update_pose_snapshot(state, snapshot, args)
                    return

    def update_topic_graph() -> None:
        try:
            scan_graph = topic_graph_for(node, args.topic)
            pose_graph = {
                topic: topic_graph_for(node, topic)
                for topic in (args.tf_topic, args.static_tf_topic, args.odom_topic)
            }
        except Exception as error:
            with state.lock:
                state.latest_error = f"ROS graph query failed: {error}"
            return

        with state.lock:
            state.topic_publishers = scan_graph["publishers"]
            state.topic_subscriptions = scan_graph["subscriptions"]
            state.topic_graph_at = time.time()
            state.pose_topic_graph = pose_graph
            state.pose_topic_graph_at = state.topic_graph_at

    node.create_subscription(LaserScan, args.topic, on_scan, qos_profile_sensor_data)
    if TFMessage is not None:
        node.create_subscription(TFMessage, args.tf_topic, on_tf, qos_profile_sensor_data)
        node.create_subscription(TFMessage, args.static_tf_topic, on_tf, static_tf_qos())
    if Odometry is not None:
        node.create_subscription(Odometry, args.odom_topic, on_odom, qos_profile_sensor_data)
    if OccupancyGrid is not None:
        map_qos = QoSProfile(
            depth=1,
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.TRANSIENT_LOCAL,
        )
        node.create_subscription(OccupancyGrid, args.map_topic, on_map, map_qos)
    if POSE_DEPENDENCY_ERROR:
        with state.lock:
            state.pose_error = POSE_DEPENDENCY_ERROR
    node.create_timer(1.0, update_topic_graph)
    node.create_timer(args.pose_poll_interval, update_pose_from_tf_buffer)
    update_topic_graph()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


def build_driver_command(args: argparse.Namespace) -> list[str]:
    return [
        "ros2",
        "run",
        "oradar_lidar",
        "oradar_scan",
        "--ros-args",
        "-p",
        f"port_name:={args.serial_port}",
        "-p",
        f"baudrate:={args.baudrate}",
        "-p",
        f"frame_id:={args.frame_id}",
        "-p",
        f"scan_topic:={args.topic}",
        "-p",
        f"device_model:={args.device_model}",
        "-p",
        f"angle_min:={args.angle_min}",
        "-p",
        f"angle_max:={args.angle_max}",
        "-p",
        f"range_min:={args.range_min}",
        "-p",
        f"range_max:={args.range_max}",
        "-p",
        f"clockwise:={'true' if args.clockwise else 'false'}",
        "-p",
        f"motor_speed:={args.motor_speed}",
    ]


def scan_to_snapshot(message: LaserScan) -> ScanSnapshot:
    ranges = [clean_float(value) for value in message.ranges]
    intensities = [clean_float(value) for value in message.intensities]
    return ScanSnapshot(
        seq=message.header.stamp.sec * 1_000_000_000 + message.header.stamp.nanosec,
        received_at=time.time(),
        frame_id=message.header.frame_id,
        angle_min=float(message.angle_min),
        angle_max=float(message.angle_max),
        angle_increment=float(message.angle_increment),
        range_min=float(message.range_min),
        range_max=float(message.range_max),
        ranges=ranges,
        intensities=intensities,
    )


def update_scan_odom_snapshot(state: LidarState, scan: ScanSnapshot, args: argparse.Namespace) -> None:
    if not args.scan_odom:
        return

    points = scan_to_odom_points(scan, args)
    if len(points) < args.scan_odom_min_points:
        return

    with state.lock:
        odom = state.scan_odom
        if not odom.initialized:
            odom.initialized = True
            odom.last_points = points
            odom.last_seq = scan.seq
            source = f"scan-odom:{args.topic}:origin"
        else:
            dx_body, dy_body, dtheta, score = estimate_scan_delta(odom.last_points, points, args)
            theta_mid = normalize_angle(odom.theta + dtheta * 0.5)
            odom.x += math.cos(theta_mid) * dx_body - math.sin(theta_mid) * dy_body
            odom.y += math.sin(theta_mid) * dx_body + math.cos(theta_mid) * dy_body
            odom.theta = normalize_angle(odom.theta + dtheta)
            odom.last_points = points
            odom.last_seq = scan.seq
            odom.updates += 1
            source = f"scan-odom:{args.topic}:score={score:.4f}:updates={odom.updates}"

        pose = PoseSnapshot(
            seq=scan.seq,
            received_at=scan.received_at,
            frame_id=args.odom_frame,
            child_frame_id=args.default_base_frame,
            source=source,
            x=odom.x,
            y=odom.y,
            theta=odom.theta,
        )

    update_pose_snapshot(state, pose, args)


def scan_to_odom_points(scan: ScanSnapshot, args: argparse.Namespace) -> list[tuple[float, float]]:
    valid_points: list[tuple[float, float]] = []
    min_range = max(float(args.scan_odom_min_range), scan.range_min)
    max_range = min(float(args.scan_odom_max_range), scan.range_max)

    for index, distance in enumerate(scan.ranges):
        if distance is None or distance < min_range or distance > max_range:
            continue
        angle = scan.angle_min + index * scan.angle_increment
        valid_points.append((distance * math.cos(angle), distance * math.sin(angle)))

    if len(valid_points) <= args.scan_odom_points:
        return valid_points

    step = max(1, len(valid_points) // args.scan_odom_points)
    return valid_points[::step][: args.scan_odom_points]


def estimate_scan_delta(
    previous_points: list[tuple[float, float]],
    current_points: list[tuple[float, float]],
    args: argparse.Namespace,
) -> tuple[float, float, float, float]:
    if not previous_points or not current_points:
        return 0.0, 0.0, 0.0, 0.0

    previous_centroid = centroid(previous_points)
    current_centroid = centroid(current_points)
    best_rotation = 0.0
    best_translation = (0.0, 0.0)
    best_score = float("inf")
    search_degrees = max(0.0, float(args.scan_odom_rotation_search_degrees))
    step_degrees = max(0.5, float(args.scan_odom_rotation_step_degrees))
    steps = int(search_degrees / step_degrees)

    for step in range(-steps, steps + 1):
        rotation = math.radians(step * step_degrees)
        rotated_previous = [rotate_point(point, rotation) for point in previous_points]
        rotated_centroid = rotate_point(previous_centroid, rotation)
        translation = (
            current_centroid[0] - rotated_centroid[0],
            current_centroid[1] - rotated_centroid[1],
        )
        score = nearest_neighbor_score(rotated_previous, current_points, translation, args.scan_odom_score_points)
        if score < best_score:
            best_score = score
            best_rotation = rotation
            best_translation = translation

    # The scan transform maps old environment points into the new robot frame.
    # Robot body motion is the inverse of that apparent environment shift.
    dx_body = clamp(-best_translation[0], -args.scan_odom_max_translation, args.scan_odom_max_translation)
    dy_body = clamp(-best_translation[1], -args.scan_odom_max_translation, args.scan_odom_max_translation)
    dtheta = clamp(-best_rotation, -math.radians(args.scan_odom_max_rotation_degrees), math.radians(args.scan_odom_max_rotation_degrees))
    return dx_body, dy_body, dtheta, best_score


def nearest_neighbor_score(
    transformed_previous: list[tuple[float, float]],
    current_points: list[tuple[float, float]],
    translation: tuple[float, float],
    max_points: int,
) -> float:
    if not transformed_previous or not current_points:
        return float("inf")

    sample_step = max(1, len(transformed_previous) // max(1, max_points))
    sample = transformed_previous[::sample_step][:max_points]
    total = 0.0
    for px, py in sample:
        tx = px + translation[0]
        ty = py + translation[1]
        total += min((tx - cx) * (tx - cx) + (ty - cy) * (ty - cy) for cx, cy in current_points)

    return total / max(1, len(sample))


def centroid(points: list[tuple[float, float]]) -> tuple[float, float]:
    total_x = sum(point[0] for point in points)
    total_y = sum(point[1] for point in points)
    count = max(1, len(points))
    return total_x / count, total_y / count


def rotate_point(point: tuple[float, float], angle: float) -> tuple[float, float]:
    cosine = math.cos(angle)
    sine = math.sin(angle)
    return point[0] * cosine - point[1] * sine, point[0] * sine + point[1] * cosine


def pose_from_transform(transform: Any, pose_parent_frames: set[str], base_frames: set[str]) -> PoseSnapshot | None:
    frame_id = normalize_frame_id(transform.header.frame_id)
    child_frame_id = normalize_frame_id(transform.child_frame_id)
    if frame_id not in pose_parent_frames or child_frame_id not in base_frames:
        return None

    translation = transform.transform.translation
    rotation = transform.transform.rotation
    x = clean_float(translation.x)
    y = clean_float(translation.y)
    theta = quaternion_to_yaw(rotation)
    if x is None or y is None or theta is None:
        return None

    return PoseSnapshot(
        seq=stamp_to_seq(transform.header.stamp),
        received_at=time.time(),
        frame_id=frame_id,
        child_frame_id=child_frame_id,
        source=f"tf:{frame_id}->{child_frame_id}",
        x=x,
        y=y,
        theta=theta,
    )


def pose_from_odom(message: Any, base_frames: set[str], args: argparse.Namespace) -> PoseSnapshot | None:
    child_frame_id = normalize_frame_id(getattr(message, "child_frame_id", "")) or args.default_base_frame
    if child_frame_id not in base_frames:
        return None

    pose = message.pose.pose
    x = clean_float(pose.position.x)
    y = clean_float(pose.position.y)
    theta = quaternion_to_yaw(pose.orientation)
    if x is None or y is None or theta is None:
        return None

    return PoseSnapshot(
        seq=stamp_to_seq(message.header.stamp),
        received_at=time.time(),
        frame_id=normalize_frame_id(message.header.frame_id) or args.odom_frame,
        child_frame_id=child_frame_id,
        source=f"odom:{args.odom_topic}",
        x=x,
        y=y,
        theta=theta,
    )


def update_pose_snapshot(state: LidarState, snapshot: PoseSnapshot, args: argparse.Namespace) -> None:
    with state.lock:
        current = state.latest_pose
        if should_replace_pose(current, snapshot, args):
            state.latest_pose = snapshot
        state.pose_frames += 1
        state.pose_error = ""


def should_replace_pose(current: PoseSnapshot | None, incoming: PoseSnapshot, args: argparse.Namespace) -> bool:
    if current is None:
        return True

    current_age = time.time() - current.received_at
    if current_age > args.pose_stale_after:
        return True

    incoming_priority = pose_frame_priority(incoming.frame_id, args)
    current_priority = pose_frame_priority(current.frame_id, args)
    return incoming_priority >= current_priority


def pose_frame_priority(frame_id: str, args: argparse.Namespace) -> int:
    if normalize_frame_id(frame_id) == normalize_frame_id(args.map_frame):
        return 2
    if normalize_frame_id(frame_id) == normalize_frame_id(args.odom_frame):
        return 1
    return 0


def quaternion_to_yaw(quaternion: Any) -> float | None:
    x = clean_float(quaternion.x)
    y = clean_float(quaternion.y)
    z = clean_float(quaternion.z)
    w = clean_float(quaternion.w)
    if x is None or y is None or z is None or w is None:
        return None

    siny_cosp = 2.0 * (w * z + x * y)
    cosy_cosp = 1.0 - 2.0 * (y * y + z * z)
    return math.atan2(siny_cosp, cosy_cosp)


def stamp_to_seq(stamp: Any) -> int:
    return int(getattr(stamp, "sec", 0)) * 1_000_000_000 + int(getattr(stamp, "nanosec", 0))


def clean_float(value: float) -> float | None:
    number = float(value)
    return number if math.isfinite(number) else None


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def normalize_angle(value: float) -> float:
    while value > math.pi:
        value -= 2.0 * math.pi
    while value <= -math.pi:
        value += 2.0 * math.pi
    return value


def health_payload(state: LidarState, args: argparse.Namespace) -> dict[str, Any]:
    with state.lock:
        scan = state.latest_scan
        age = time.time() - scan.received_at if scan else None
        driver_running = state.driver_process is not None and state.driver_process.poll() is None
        ok = scan is not None and age is not None and age <= args.stale_after
        ros_graph = ros_graph_payload(state)
        frames = state.frames
        frame_id = scan.frame_id if scan else ""
        latest_error = state.latest_error
        driver_log = list(state.driver_log)[-20:]

    serial_diag = serial_diagnostics(args.serial_port)
    return {
        "ok": ok,
        "status": "ok" if ok else "no-scan",
        "frames": frames,
        "latestScanAgeSec": age,
        "driverRunning": driver_running,
        "serialPort": args.serial_port,
        "baudrate": args.baudrate,
        "serialDiagnostics": serial_diag,
        "driver": args.driver,
        "topic": args.topic,
        "frameId": frame_id,
        "error": "" if ok else latest_error or no_scan_error(args, ros_graph),
        "diagnostics": [] if ok else no_scan_diagnostics(args, ros_graph),
        "driverLog": driver_log,
        "rosGraph": ros_graph,
        "scanUrl": "/scan",
        "poseUrl": "/pose",
        "pose": pose_summary_payload(state, args),
    }


def scan_payload(state: LidarState, args: argparse.Namespace) -> dict[str, Any]:
    with state.lock:
        scan = state.latest_scan
        error = state.latest_error
        frames = state.frames
        driver_log = list(state.driver_log)[-20:]
        ros_graph = ros_graph_payload(state)
        serial_diag = serial_diagnostics(args.serial_port)

    if scan is None:
        return {
            "ok": False,
            "status": "no-scan",
            "error": error or no_scan_error(args, ros_graph),
            "diagnostics": no_scan_diagnostics(args, ros_graph),
            "frames": frames,
            "serialPort": args.serial_port,
            "baudrate": args.baudrate,
            "serialDiagnostics": serial_diag,
            "driver": args.driver,
            "topic": args.topic,
            "driverLog": driver_log,
            "rosGraph": ros_graph,
            "points": [],
        }

    points = scan_points(scan, args.max_points)
    stats = scan_stats(scan)
    return {
        "ok": True,
        "status": "ok",
        "seq": scan.seq,
        "frameAt": scan.received_at,
        "frameId": scan.frame_id,
        "serialDiagnostics": serial_diag,
        "angleMin": scan.angle_min,
        "angleMax": scan.angle_max,
        "angleIncrement": scan.angle_increment,
        "rangeMin": scan.range_min,
        "rangeMax": scan.range_max,
        "rangeCount": len(scan.ranges),
        "points": points,
        "stats": stats,
    }


def diagnostics_payload(state: LidarState, args: argparse.Namespace) -> dict[str, Any]:
    with state.lock:
        scan = state.latest_scan
        frames = state.frames
        driver_running = state.driver_process is not None and state.driver_process.poll() is None
        driver_log = list(state.driver_log)[-30:]
        ros_graph = ros_graph_payload(state)
        latest_error = state.latest_error

    age = time.time() - scan.received_at if scan else None
    stale = age is None or age > args.stale_after
    serial_diag = serial_diagnostics(args.serial_port)

    return {
        "ok": scan is not None and not stale,
        "status": "ok" if scan is not None and not stale else "no-scan",
        "driver": args.driver,
        "driverRunning": driver_running,
        "driverLog": driver_log,
        "serialPort": args.serial_port,
        "baudrate": args.baudrate,
        "serialDiagnostics": serial_diag,
        "topic": args.topic,
        "rosGraph": ros_graph,
        "frames": frames,
        "latestFrameAgeSeconds": age,
        "latestFrameId": scan.frame_id if scan else "",
        "latestError": latest_error,
        "diagnostics": [] if scan is not None and not stale else no_scan_diagnostics(args, ros_graph),
        "nextChecks": lidar_next_checks(args, ros_graph, serial_diag, frames),
        "pose": pose_payload(state, args),
    }


def pose_payload(state: LidarState, args: argparse.Namespace) -> dict[str, Any]:
    with state.lock:
        pose = state.latest_pose
        frames = state.pose_frames
        error = state.pose_error
        pose_graph = pose_graph_payload(state)

    if pose is None:
        return {
            "ok": False,
            "status": "no-pose",
            "pose": None,
            "mapPose": None,
            "waypointSafe": False,
            "frames": frames,
            "error": error or no_pose_error(args, pose_graph),
            "diagnostics": no_pose_diagnostics(args, pose_graph),
            "rosGraph": pose_graph,
            "docs": pose_docs_payload(),
        }

    age = time.time() - pose.received_at
    stale = age > args.pose_stale_after
    waypoint_safe = normalize_frame_id(pose.frame_id) == normalize_frame_id(args.map_frame)
    source_available = pose_source_available(pose, pose_graph, args)
    if not source_available:
        return {
            "ok": False,
            "status": "no-pose",
            "pose": None,
            "mapPose": None,
            "waypointSafe": False,
            "frames": frames,
            "error": pose_source_unavailable_error(pose, args),
            "diagnostics": no_pose_diagnostics(args, pose_graph),
            "rosGraph": pose_graph,
            "docs": pose_docs_payload(),
        }

    status = "stale" if stale else "ok" if waypoint_safe else "local-odom"
    pose_body = pose_to_dict(pose, age)

    return {
        "ok": not stale,
        "status": status,
        "pose": pose_body,
        "mapPose": pose_body if waypoint_safe else None,
        "waypointSafe": waypoint_safe and not stale,
        "frames": frames,
        "error": "" if not stale else f"Pose frame is stale; latest age {age:.2f}s.",
        "diagnostics": [] if not stale else no_pose_diagnostics(args, pose_graph),
        "rosGraph": pose_graph,
        "docs": pose_docs_payload(),
    }


def map_payload(state: LidarState, args: argparse.Namespace) -> dict[str, Any]:
    with state.lock:
        grid = state.latest_map

    if grid is None or OccupancyGrid is None:
        return {
            "ok": False,
            "status": "no-map",
            "error": "No occupancy grid available. Start Cartographer mapping first.",
        }

    try:
        width = int(grid.info.width)
        height = int(grid.info.height)
        resolution = float(grid.info.resolution)
        origin_x = float(grid.info.origin.position.x)
        origin_y = float(grid.info.origin.position.y)
        origin_yaw = quaternion_to_yaw(grid.info.origin.orientation) or 0.0

        raw = struct.pack(f"<{len(grid.data)}b", *grid.data)
        encoded = base64.b64encode(raw).decode("ascii")

        return {
            "ok": True,
            "status": "ok",
            "width": width,
            "height": height,
            "resolution": resolution,
            "origin": {"x": origin_x, "y": origin_y, "yaw": origin_yaw, "theta": origin_yaw},
            "cells": encoded,
            "cellCount": len(grid.data),
        }
    except Exception as error:
        return {
            "ok": False,
            "status": "error",
            "error": f"Failed to encode occupancy grid: {error}",
        }


def pose_source_available(pose: PoseSnapshot, pose_graph: dict[str, Any], args: argparse.Namespace) -> bool:
    topics = pose_graph.get("topics", {}) if isinstance(pose_graph, dict) else {}
    source = str(pose.source or "")
    if source.startswith("tf:"):
        return int(topics.get(args.tf_topic, {}).get("publisherCount", 0)) > 0
    if source.startswith("odom:"):
        return int(topics.get(args.odom_topic, {}).get("publisherCount", 0)) > 0
    if source.startswith("scan-odom:"):
        return bool(args.scan_odom)
    return True


def pose_source_unavailable_error(pose: PoseSnapshot, args: argparse.Namespace) -> str:
    source = str(pose.source or "")
    if source.startswith("tf:"):
        return f"Last TF pose source {source} is no longer live; {args.tf_topic} has no publisher."
    if source.startswith("odom:"):
        return f"Last odometry pose source {source} is no longer live; {args.odom_topic} has no publisher."
    return f"Last pose source {source or 'unknown'} is no longer live."


def pose_summary_payload(state: LidarState, args: argparse.Namespace) -> dict[str, Any]:
    payload = pose_payload(state, args)
    pose = payload.get("pose")
    return {
        "ok": payload.get("ok", False),
        "status": payload.get("status", "no-pose"),
        "frame": pose.get("frame") if isinstance(pose, dict) else "",
        "source": pose.get("source") if isinstance(pose, dict) else "",
        "waypointSafe": payload.get("waypointSafe", False),
    }


def pose_to_dict(pose: PoseSnapshot, age: float) -> dict[str, Any]:
    return {
        "x": round(pose.x, 5),
        "y": round(pose.y, 5),
        "theta": round(pose.theta, 5),
        "frame": pose.frame_id,
        "childFrame": pose.child_frame_id,
        "source": pose.source,
        "receivedAt": pose.received_at,
        "ageSec": age,
    }


def lidar_next_checks(
    args: argparse.Namespace,
    ros_graph: dict[str, Any],
    serial_diag: dict[str, Any],
    frames: int,
) -> list[str]:
    checks: list[str] = []

    if not serial_diag.get("exists"):
        checks.append(f"Confirm the lidar device path exists: {args.serial_port}.")
    elif not serial_diag.get("readable") or not serial_diag.get("writable"):
        checks.append(f"Fix permissions for {args.serial_port}; bridge needs read/write access.")

    if int(ros_graph.get("publisherCount", 0)) == 0:
        checks.append(f"Driver is not advertising {args.topic}; check driver package, params, and serial launch arguments.")
    elif frames == 0:
        checks.append(f"{args.topic} is advertised but no frames arrived; inspect UART wiring, baudrate, and lidar model/driver match.")

    checks.append("Do not enable waypoint navigation until LaserScan frames and a real pose source are verified.")
    return checks


def topic_endpoint_to_dict(endpoint: Any) -> dict[str, Any]:
    qos = getattr(endpoint, "qos_profile", None)
    return {
        "nodeName": getattr(endpoint, "node_name", ""),
        "nodeNamespace": getattr(endpoint, "node_namespace", ""),
        "topicType": getattr(endpoint, "topic_type", ""),
        "endpointType": str(getattr(endpoint, "endpoint_type", "")),
        "qos": {
            "reliability": enum_name(getattr(qos, "reliability", None)),
            "durability": enum_name(getattr(qos, "durability", None)),
            "history": enum_name(getattr(qos, "history", None)),
            "depth": getattr(qos, "depth", None),
        },
    }


def enum_name(value: Any) -> str:
    return getattr(value, "name", str(value or ""))


def ros_graph_payload(state: LidarState) -> dict[str, Any]:
    return {
        "updatedAt": state.topic_graph_at,
        "publisherCount": len(state.topic_publishers),
        "subscriptionCount": len(state.topic_subscriptions),
        "publishers": state.topic_publishers,
        "subscriptions": state.topic_subscriptions,
    }


def pose_graph_payload(state: LidarState) -> dict[str, Any]:
    return {
        "updatedAt": state.pose_topic_graph_at,
        "topics": state.pose_topic_graph,
    }


def topic_graph_for(node: Any, topic: str) -> dict[str, Any]:
    publishers = [
        topic_endpoint_to_dict(endpoint)
        for endpoint in node.get_publishers_info_by_topic(topic)
    ]
    subscriptions = [
        topic_endpoint_to_dict(endpoint)
        for endpoint in node.get_subscriptions_info_by_topic(topic)
    ]
    return {
        "publisherCount": len(publishers),
        "subscriptionCount": len(subscriptions),
        "publishers": publishers,
        "subscriptions": subscriptions,
    }


def static_tf_qos() -> QoSProfile:
    return QoSProfile(
        depth=1,
        durability=DurabilityPolicy.TRANSIENT_LOCAL,
        reliability=ReliabilityPolicy.RELIABLE,
    )


def parse_frame_list(value: str) -> set[str]:
    frames = {
        normalize_frame_id(item)
        for item in str(value or "").replace(";", ",").split(",")
        if normalize_frame_id(item)
    }
    return frames or {"base_link"}


def normalize_frame_id(value: Any) -> str:
    text = str(value or "").strip()
    return text[1:] if text.startswith("/") else text


def no_pose_error(args: argparse.Namespace, pose_graph: dict[str, Any]) -> str:
    topic_publishers = sum(
        int(topic.get("publisherCount", 0))
        for topic in pose_graph.get("topics", {}).values()
        if isinstance(topic, dict)
    )
    if topic_publishers > 0:
        return (
            "ROS pose topics are visible, but no usable map/odom pose has been resolved. "
            f"Looking for parent frames [{args.pose_parent_frames}] and base frames [{args.base_frames}]."
        )
    return (
        "No ROS pose source is visible yet. Start Yahboom navigation/localization so /tf, /tf_static, "
        f"or {args.odom_topic} publishes the robot base pose."
    )


def no_pose_diagnostics(args: argparse.Namespace, pose_graph: dict[str, Any]) -> list[str]:
    diagnostics = [
        f"TF topics: {args.tf_topic}, {args.static_tf_topic}",
        f"Odometry topic: {args.odom_topic}",
        f"Accepted parent frames: {args.pose_parent_frames}",
        f"Accepted base frames: {args.base_frames}",
        "Map-frame pose is required before saved waypoints are trustworthy.",
    ]
    if TF2_BUFFER_ERROR:
        diagnostics.append(TF2_BUFFER_ERROR)
    if POSE_DEPENDENCY_ERROR:
        diagnostics.append(POSE_DEPENDENCY_ERROR)
    topics = pose_graph.get("topics", {}) if isinstance(pose_graph, dict) else {}
    for topic, graph in topics.items():
        if isinstance(graph, dict):
            diagnostics.append(f"{topic}: {graph.get('publisherCount', 0)} publisher(s)")
    return diagnostics


def pose_docs_payload() -> dict[str, Any]:
    return {
        "basis": "Local DOGZILLA section-14 docs start MS200 on /scan, use Cartographer for odom/map pose, and use Nav2 map goals for navigation.",
        "safePoseRule": "Only map-frame pose is waypoint-safe; odom pose is local drift telemetry.",
        "sources": [
            "docs/DOGZILLA-main/14.Lidar course/1. Introduction and use of radar.pdf",
            "docs/DOGZILLA-main/14.Lidar course/3. Robot dog mapping.pdf",
            "docs/DOGZILLA-main/14.Lidar course/4. Robot Dog Navigation.pdf",
            "docs/DOGZILLA-main/14.Lidar course/5. Patrol.pdf",
        ],
    }


def serial_diagnostics(path: str) -> dict[str, Any]:
    exists = os.path.exists(path)
    diag: dict[str, Any] = {
        "path": path,
        "exists": exists,
        "realPath": os.path.realpath(path) if exists else "",
        "readable": os.access(path, os.R_OK) if exists else False,
        "writable": os.access(path, os.W_OK) if exists else False,
    }

    if exists:
        try:
            path_stat = os.stat(path)
            diag.update({
                "mode": stat.filemode(path_stat.st_mode),
                "isCharDevice": stat.S_ISCHR(path_stat.st_mode),
                "uid": path_stat.st_uid,
                "gid": path_stat.st_gid,
            })
        except OSError as error:
            diag["statError"] = str(error)

    return diag


def read_text_file(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return ""


def scan_points(scan: ScanSnapshot, max_points: int) -> list[dict[str, float]]:
    ranges = scan.ranges
    stride = max(1, math.ceil(len(ranges) / max(1, max_points)))
    points: list[dict[str, float]] = []

    for index in range(0, len(ranges), stride):
        distance = ranges[index]
        if distance is None or distance < scan.range_min or distance > scan.range_max:
            continue
        angle = scan.angle_min + scan.angle_increment * index
        points.append({
            "angle": round(angle, 5),
            "range": round(distance, 4),
            "x": round(math.cos(angle) * distance, 4),
            "y": round(math.sin(angle) * distance, 4),
        })

    return points


def scan_stats(scan: ScanSnapshot) -> dict[str, Any]:
    valid = [
        value
        for value in scan.ranges
        if value is not None and scan.range_min <= value <= scan.range_max
    ]
    front = count_sector(scan, -math.radians(15), math.radians(15), 0.75)
    left = count_sector(scan, math.radians(15), math.radians(75), 0.75)
    right = count_sector(scan, -math.radians(75), -math.radians(15), 0.75)
    return {
        "validRanges": len(valid),
        "minRange": round(min(valid), 4) if valid else None,
        "maxRange": round(max(valid), 4) if valid else None,
        "nearFront": front,
        "nearLeft": left,
        "nearRight": right,
    }


def count_sector(scan: ScanSnapshot, start_angle: float, end_angle: float, max_range: float) -> int:
    count = 0
    for index, distance in enumerate(scan.ranges):
        if distance is None or distance > max_range:
            continue
        angle = scan.angle_min + scan.angle_increment * index
        if start_angle <= angle <= end_angle:
            count += 1
    return count


def append_driver_log(state: LidarState, line: str) -> None:
    if not line:
        return
    print(line, flush=True)
    with state.lock:
        state.driver_log.append(line)


def no_scan_error(args: argparse.Namespace, ros_graph: dict[str, Any] | None = None) -> str:
    publisher_count = int(ros_graph.get("publisherCount", 0)) if ros_graph else 0
    if publisher_count > 0:
        return (
            f"{args.topic} is advertised by {publisher_count} ROS publisher(s), "
            f"but no LaserScan frames have arrived in the HTTP bridge. "
            f"The driver opened {args.serial_port} at {args.baudrate}; "
            "check the UART RX/TX data path, serial device, and whether the connected lidar is publishing MS200 packets."
        )

    return (
        f"No LaserScan frame received on {args.topic}; "
        f"driver is opening {args.serial_port} at {args.baudrate}, "
        "but no valid scan packets have arrived on the serial receive path."
    )


def no_scan_diagnostics(args: argparse.Namespace, ros_graph: dict[str, Any] | None = None) -> list[str]:
    diagnostics = [
        f"Driver: {args.driver}",
        f"Serial target: {args.serial_port} @ {args.baudrate}",
        f"ROS topic: {args.topic}",
    ]
    publisher_count = int(ros_graph.get("publisherCount", 0)) if ros_graph else 0
    if publisher_count > 0:
        diagnostics.append("ROS publisher is visible, but no messages were received.")
    else:
        diagnostics.append("No ROS publisher is visible for the scan topic yet.")
    diagnostics.append("Motor spin only proves lidar power; the app still needs valid scan packets on the serial receive path.")
    return diagnostics


def positive_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive finite float")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="DOGZILLA ROS2 LaserScan HTTP bridge")
    parser.add_argument("--host", default=os.getenv("DOGZILLA_LIDAR_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("DOGZILLA_LIDAR_PORT", "8896")))
    parser.add_argument("--driver", choices=["oradar"], default=os.getenv("DOGZILLA_LIDAR_DRIVER", "oradar"))
    parser.add_argument("--serial-port", default=os.getenv("DOGZILLA_LIDAR_SERIAL_PORT", "/dev/ttyAMA1"))
    parser.add_argument("--baudrate", type=int, default=int(os.getenv("DOGZILLA_LIDAR_BAUDRATE", "230400")))
    parser.add_argument("--topic", default=os.getenv("DOGZILLA_LIDAR_TOPIC", "/scan"))
    parser.add_argument("--frame-id", default=os.getenv("DOGZILLA_LIDAR_FRAME_ID", "laser_frame"))
    parser.add_argument("--device-model", default=os.getenv("DOGZILLA_LIDAR_DEVICE_MODEL", "MS200"))
    parser.add_argument("--angle-min", type=float, default=float(os.getenv("DOGZILLA_LIDAR_ANGLE_MIN", "0.0")))
    parser.add_argument("--angle-max", type=float, default=float(os.getenv("DOGZILLA_LIDAR_ANGLE_MAX", "360.0")))
    parser.add_argument("--range-min", type=float, default=float(os.getenv("DOGZILLA_LIDAR_RANGE_MIN", "0.05")))
    parser.add_argument("--range-max", type=float, default=float(os.getenv("DOGZILLA_LIDAR_RANGE_MAX", "20.0")))
    parser.add_argument("--motor-speed", type=int, default=int(os.getenv("DOGZILLA_LIDAR_MOTOR_SPEED", "10")))
    parser.add_argument("--clockwise", action="store_true")
    parser.add_argument("--no-start-driver", dest="start_driver", action="store_false")
    parser.add_argument("--max-points", type=int, default=int(os.getenv("DOGZILLA_LIDAR_MAX_POINTS", "720")))
    parser.add_argument("--stale-after", type=positive_float, default=float(os.getenv("DOGZILLA_LIDAR_STALE_AFTER", "3")))
    parser.add_argument("--pose-stale-after", type=positive_float, default=float(os.getenv("DOGZILLA_POSE_STALE_AFTER", "2")))
    parser.add_argument("--pose-poll-interval", type=positive_float, default=float(os.getenv("DOGZILLA_POSE_POLL_INTERVAL", "0.2")))
    parser.add_argument(
        "--scan-odom",
        dest="scan_odom",
        action="store_true",
        default=parse_env_bool("DOGZILLA_SCAN_ODOM", False),
        help="Enable experimental LaserScan-only odometry estimates. Off by default because it can drift while stationary.",
    )
    parser.add_argument("--no-scan-odom", dest="scan_odom", action="store_false")
    parser.add_argument("--scan-odom-min-range", type=positive_float, default=float(os.getenv("DOGZILLA_SCAN_ODOM_MIN_RANGE", "0.12")))
    parser.add_argument("--scan-odom-max-range", type=positive_float, default=float(os.getenv("DOGZILLA_SCAN_ODOM_MAX_RANGE", "4.0")))
    parser.add_argument("--scan-odom-min-points", type=int, default=int(os.getenv("DOGZILLA_SCAN_ODOM_MIN_POINTS", "30")))
    parser.add_argument("--scan-odom-points", type=int, default=int(os.getenv("DOGZILLA_SCAN_ODOM_POINTS", "90")))
    parser.add_argument("--scan-odom-score-points", type=int, default=int(os.getenv("DOGZILLA_SCAN_ODOM_SCORE_POINTS", "45")))
    parser.add_argument("--scan-odom-max-translation", type=positive_float, default=float(os.getenv("DOGZILLA_SCAN_ODOM_MAX_TRANSLATION", "0.08")))
    parser.add_argument("--scan-odom-max-rotation-degrees", type=positive_float, default=float(os.getenv("DOGZILLA_SCAN_ODOM_MAX_ROTATION_DEGREES", "8")))
    parser.add_argument("--scan-odom-rotation-search-degrees", type=positive_float, default=float(os.getenv("DOGZILLA_SCAN_ODOM_ROTATION_SEARCH_DEGREES", "8")))
    parser.add_argument("--scan-odom-rotation-step-degrees", type=positive_float, default=float(os.getenv("DOGZILLA_SCAN_ODOM_ROTATION_STEP_DEGREES", "2")))
    parser.add_argument("--tf-topic", default=os.getenv("DOGZILLA_TF_TOPIC", "/tf"))
    parser.add_argument("--static-tf-topic", default=os.getenv("DOGZILLA_STATIC_TF_TOPIC", "/tf_static"))
    parser.add_argument("--odom-topic", default=os.getenv("DOGZILLA_ODOM_TOPIC", "/odom"))
    parser.add_argument("--map-topic", default=os.getenv("DOGZILLA_MAP_TOPIC", "/map"))
    parser.add_argument("--map-frame", default=os.getenv("DOGZILLA_MAP_FRAME", "map"))
    parser.add_argument("--odom-frame", default=os.getenv("DOGZILLA_ODOM_FRAME", "odom"))
    parser.add_argument("--default-base-frame", default=os.getenv("DOGZILLA_DEFAULT_BASE_FRAME", "base_link"))
    parser.add_argument(
        "--base-frames",
        default=os.getenv("DOGZILLA_BASE_FRAMES", "base_link,base_footprint"),
    )
    parser.add_argument(
        "--pose-parent-frames",
        default=os.getenv("DOGZILLA_POSE_PARENT_FRAMES", "map,odom"),
    )
    parser.add_argument("--restart-delay", type=positive_float, default=float(os.getenv("DOGZILLA_LIDAR_RESTART_DELAY", "2")))
    parser.set_defaults(start_driver=True)
    return parser


def parse_env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def main() -> int:
    args = build_parser().parse_args()
    state = LidarState()

    def handle_signal(signum: int, _frame: Any) -> None:
        with state.lock:
            process = state.driver_process
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    server = ThreadingHTTPServer((args.host, args.port), LidarHandler)
    server.state = state  # type: ignore[attr-defined]
    server.args = args  # type: ignore[attr-defined]
    print(f"DOGZILLA lidar bridge listening on http://{args.host}:{args.port}", flush=True)
    print(f"Driver: {args.driver}", flush=True)
    print(f"Serial: {args.serial_port} @ {args.baudrate}", flush=True)
    print(f"Topic: {args.topic}", flush=True)
    print(f"Pose: {args.tf_topic}, {args.static_tf_topic}, {args.odom_topic}", flush=True)
    ensure_worker(state, args)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
