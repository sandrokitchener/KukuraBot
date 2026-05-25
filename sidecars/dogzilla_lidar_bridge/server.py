#!/usr/bin/env python3
"""DOGZILLA Pi-local ROS2 LaserScan bridge."""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
import stat
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
    from rclpy.qos import qos_profile_sensor_data
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
    topic_publishers: list[dict[str, Any]] = field(default_factory=list)
    topic_subscriptions: list[dict[str, Any]] = field(default_factory=list)
    topic_graph_at: float | None = None


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

    def update_topic_graph() -> None:
        try:
            publishers = [
                topic_endpoint_to_dict(endpoint)
                for endpoint in node.get_publishers_info_by_topic(args.topic)
            ]
            subscriptions = [
                topic_endpoint_to_dict(endpoint)
                for endpoint in node.get_subscriptions_info_by_topic(args.topic)
            ]
        except Exception as error:
            with state.lock:
                state.latest_error = f"ROS graph query failed: {error}"
            return

        with state.lock:
            state.topic_publishers = publishers
            state.topic_subscriptions = subscriptions
            state.topic_graph_at = time.time()

    node.create_subscription(LaserScan, args.topic, on_scan, qos_profile_sensor_data)
    node.create_timer(1.0, update_topic_graph)
    update_topic_graph()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


def build_driver_command(args: argparse.Namespace) -> list[str]:
    if args.driver == "ydlidar":
        return [
            "ros2",
            "run",
            "ydlidar_ros2_driver",
            "ydlidar_ros2_driver_node",
            "--ros-args",
            "--params-file",
            args.ydlidar_params,
        ]

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
        ros_graph = ros_graph_payload(state)
        serial_diag = serial_diagnostics(args.serial_port)
        return {
            "ok": ok,
            "status": "ok" if ok else "no-scan",
            "frames": state.frames,
            "latestScanAgeSec": age,
            "driverRunning": driver_running,
            "serialPort": args.serial_port,
            "baudrate": args.baudrate,
            "serialDiagnostics": serial_diag,
            "driver": args.driver,
            "ydlidarParams": args.ydlidar_params if args.driver == "ydlidar" else "",
            "topic": args.topic,
            "frameId": scan.frame_id if scan else "",
            "error": "" if ok else state.latest_error or no_scan_error(args, ros_graph),
            "diagnostics": [] if ok else no_scan_diagnostics(args, ros_graph),
            "driverLog": list(state.driver_log)[-20:],
            "rosGraph": ros_graph,
            "scanUrl": "/scan",
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
            "ydlidarParams": args.ydlidar_params if args.driver == "ydlidar" else "",
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

    if args.driver == "oradar":
        checks.append("If ORADAR keeps advertising without frames, try the YDLidar path with --driver ydlidar only as a comparison probe.")

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


def serial_diagnostics(path: str) -> dict[str, Any]:
    exists = os.path.exists(path)
    diag: dict[str, Any] = {
        "path": path,
        "exists": exists,
        "realPath": os.path.realpath(path) if exists else "",
        "byIdPaths": [],
        "byPathPaths": [],
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

    diag["byIdPaths"] = serial_links_for(path, "/dev/serial/by-id")
    diag["byPathPaths"] = serial_links_for(path, "/dev/serial/by-path")
    diag["usb"] = tty_usb_metadata(diag["realPath"] or path)
    return diag


def serial_links_for(path: str, directory: str) -> list[str]:
    target = os.path.realpath(path)
    links: list[str] = []
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                entry_path = os.path.join(directory, entry.name)
                try:
                    if os.path.realpath(entry_path) == target:
                        links.append(entry_path)
                except OSError:
                    continue
    except OSError:
        return links
    return sorted(links)


def tty_usb_metadata(path: str) -> dict[str, str]:
    tty_name = os.path.basename(os.path.realpath(path))
    if not tty_name:
        return {}

    device_path = os.path.realpath(os.path.join("/sys/class/tty", tty_name, "device"))
    if not os.path.exists(device_path):
        return {}

    metadata: dict[str, str] = {}
    current = device_path
    for _ in range(6):
        vendor = read_text_file(os.path.join(current, "idVendor"))
        product = read_text_file(os.path.join(current, "idProduct"))
        if vendor or product:
            metadata["idVendor"] = vendor
            metadata["idProduct"] = product
            metadata["manufacturer"] = read_text_file(os.path.join(current, "manufacturer"))
            metadata["product"] = read_text_file(os.path.join(current, "product"))
            metadata["serial"] = read_text_file(os.path.join(current, "serial"))
            break
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent

    driver_path = os.path.join(device_path, "driver")
    if os.path.islink(driver_path):
        metadata["driver"] = os.path.basename(os.path.realpath(driver_path))
    return {key: value for key, value in metadata.items() if value}


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
    parser.add_argument("--driver", choices=["oradar", "ydlidar"], default=os.getenv("DOGZILLA_LIDAR_DRIVER", "oradar"))
    parser.add_argument("--serial-port", default=os.getenv("DOGZILLA_LIDAR_SERIAL_PORT", "/dev/ttyAMA1"))
    parser.add_argument("--baudrate", type=int, default=int(os.getenv("DOGZILLA_LIDAR_BAUDRATE", "230400")))
    parser.add_argument("--topic", default=os.getenv("DOGZILLA_LIDAR_TOPIC", "/scan"))
    parser.add_argument("--frame-id", default=os.getenv("DOGZILLA_LIDAR_FRAME_ID", "laser_frame"))
    parser.add_argument("--device-model", default=os.getenv("DOGZILLA_LIDAR_DEVICE_MODEL", "MS200"))
    parser.add_argument(
        "--ydlidar-params",
        default=os.getenv(
            "DOGZILLA_YDLIDAR_PARAMS",
            "/root/yahboomcar_ws/install/ydlidar_ros2_driver/share/ydlidar_ros2_driver/params/X2.yaml",
        ),
    )
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
    print(f"Driver: {args.driver}", flush=True)
    print(f"Serial: {args.serial_port} @ {args.baudrate}", flush=True)
    if args.driver == "ydlidar":
        print(f"YDLidar params: {args.ydlidar_params}", flush=True)
    print(f"Topic: {args.topic}", flush=True)
    ensure_worker(state, args)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
