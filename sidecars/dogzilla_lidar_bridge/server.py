#!/usr/bin/env python3
"""DOGZILLA Pi-local ROS2 LaserScan bridge."""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
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
    from sensor_msgs.msg import LaserScan
except Exception as error:  # pragma: no cover - exercised on Pi startup
    print(f"Missing ROS2 lidar dependency: {error}", file=sys.stderr, flush=True)
    raise


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
class LidarState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    latest_scan: ScanSnapshot | None = None
    latest_error: str = ""
    frames: int = 0
    driver_process: subprocess.Popen | None = None
    driver_log: deque[str] = field(default_factory=lambda: deque(maxlen=80))
    worker_started: bool = False


class LidarHandler(BaseHTTPRequestHandler):
    server_version = "RoboDogeLidarBridge/1.0"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        ensure_worker(self.server.state, self.server.args)

        if parsed.path == "/healthz":
            self.send_json(HTTPStatus.OK, health_payload(self.server.state, self.server.args))
            return
        if parsed.path == "/scan":
            payload = scan_payload(self.server.state, self.server.args)
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

    def on_scan(message: LaserScan) -> None:
        snapshot = scan_to_snapshot(message)
        with state.lock:
            state.latest_scan = snapshot
            state.frames += 1
            state.latest_error = ""

    node.create_subscription(LaserScan, args.topic, on_scan, 10)
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


def clean_float(value: float) -> float | None:
    number = float(value)
    return number if math.isfinite(number) else None


def health_payload(state: LidarState, args: argparse.Namespace) -> dict[str, Any]:
    with state.lock:
        scan = state.latest_scan
        age = time.time() - scan.received_at if scan else None
        driver_running = state.driver_process is not None and state.driver_process.poll() is None
        ok = scan is not None and age is not None and age <= args.stale_after
        return {
            "ok": ok,
            "status": "ok" if ok else "no-scan",
            "frames": state.frames,
            "latestScanAgeSec": age,
            "driverRunning": driver_running,
            "serialPort": args.serial_port,
            "baudrate": args.baudrate,
            "topic": args.topic,
            "frameId": scan.frame_id if scan else "",
            "error": "" if ok else state.latest_error or "No LaserScan frame received yet.",
            "driverLog": list(state.driver_log)[-20:],
            "scanUrl": "/scan",
        }


def scan_payload(state: LidarState, args: argparse.Namespace) -> dict[str, Any]:
    with state.lock:
        scan = state.latest_scan
        error = state.latest_error

    if scan is None:
        return {
            "ok": False,
            "status": "no-scan",
            "error": error or "No LaserScan frame received yet.",
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
        "angleMin": scan.angle_min,
        "angleMax": scan.angle_max,
        "angleIncrement": scan.angle_increment,
        "rangeMin": scan.range_min,
        "rangeMax": scan.range_max,
        "rangeCount": len(scan.ranges),
        "points": points,
        "stats": stats,
    }


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


def positive_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive finite float")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="DOGZILLA ROS2 LaserScan HTTP bridge")
    parser.add_argument("--host", default=os.getenv("DOGZILLA_LIDAR_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("DOGZILLA_LIDAR_PORT", "8896")))
    parser.add_argument("--serial-port", default=os.getenv("DOGZILLA_LIDAR_SERIAL_PORT", "/dev/ttyUSB0"))
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
    parser.add_argument("--restart-delay", type=positive_float, default=float(os.getenv("DOGZILLA_LIDAR_RESTART_DELAY", "2")))
    parser.set_defaults(start_driver=True)
    return parser


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
    print(f"Serial: {args.serial_port} @ {args.baudrate}", flush=True)
    print(f"Topic: {args.topic}", flush=True)
    ensure_worker(state, args)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
