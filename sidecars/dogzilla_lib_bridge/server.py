from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[2]
LOG_FILE = Path(__file__).resolve().with_name("command_log.ndjson")
DEFAULT_HOST = os.environ.get("DOGZILLA_LIB_BRIDGE_HOST", "0.0.0.0")
DEFAULT_PORT = int(os.environ.get("DOGZILLA_LIB_BRIDGE_PORT", "8893"))
DEFAULT_SERIAL_PORT = os.environ.get("DOGZILLA_SERIAL_PORT", "/dev/ttyAMA0")
DEFAULT_DRY_RUN = os.environ.get("DOGZILLA_DIRECT_DRY_RUN", "1") != "0"
DEFAULT_EXPECTED_ROS_DOMAIN_ID = os.environ.get("DOGZILLA_EXPECTED_ROS_DOMAIN_ID", "16")
DEFAULT_INCLUDE_ATTITUDE_STATE = os.environ.get("DOGZILLA_INCLUDE_ATTITUDE_STATE", "0") == "1"
DEFAULT_INCLUDE_SLOW_STATE = os.environ.get("DOGZILLA_INCLUDE_SLOW_STATE", "0") == "1"
MAX_RECENT_COMMANDS = int(os.environ.get("DOGZILLA_LIB_BRIDGE_HISTORY", "20"))

VENDOR_PATHS = [
    ROOT_DIR / "vendor" / "DOGZILLALib",
    ROOT_DIR / "vendor" / "DOGZILLA",
    Path("/home/pi/DOGZILLA"),
    Path("/home/pi/DOGZILLA/DOGZILLALib"),
    Path("/home/yahboom/DOGZILLA"),
    Path("/home/yahboom/DOGZILLA/DOGZILLALib"),
]
VENDOR_MODULE_CANDIDATES = [
    "DOGZILLALib.DOGZILLALib",
    "DOGZILLALib",
    "dogzilla",
]
VENDOR_FACTORY_CANDIDATES = ["DOGZILLA", "Dogzilla", "dogzilla"]
STUDY_HINTS = {
    "expectedRosDomainId": DEFAULT_EXPECTED_ROS_DOMAIN_ID,
    "pi5DockerEntry": "./run_humble.sh",
    "bringupLaunch": "ros2 launch bringup Navigation_bringup.launch.py",
    "cameraTopicFromAppDocs": "/usb_cam/imge_raw/compress",
    "knownConflict": "Yahboom APP/control startup can occupy camera/control resources; stop it before direct bridge live tests.",
}

ACTION_ALIASES = {
    "lie_down": 1,
    "lie": 1,
    "stand_up": 2,
    "stand": 2,
    "sit_down": 12,
    "sit": 12,
    "reset": 255,
    "reset_pose": 255,
    "stop": 255,
    "startup_stretch": 14,
    "stretch": 14,
    "three_axis": 10,
    "3_axis": 10,
    "swing": 16,
    "pee": 11,
    "crawl": 3,
    "pray": 17,
}


class DogzillaRuntime:
    def __init__(self, serial_port: str, dry_run: bool):
        self.serial_port = serial_port
        self.dry_run = dry_run
        self.import_error: str | None = None
        self.robot_error: str | None = None
        self.robot = None
        self._lock = threading.Lock()
        self.vendor_paths = load_vendor_paths()
        self.import_attempts: list[dict[str, str]] = []

        for vendor_path in self.vendor_paths:
            if vendor_path.exists():
                sys.path.insert(0, str(vendor_path))

        self.DOGZILLA = self._load_factory()

    @property
    def available(self) -> bool:
        return self.import_error is None

    def snapshot(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "dryRun": self.dry_run,
            "serialPort": self.serial_port,
            "vendorPaths": [str(path) for path in self.vendor_paths],
            "vendorImportAttempts": self.import_attempts,
            "logFile": str(LOG_FILE),
            "knownActions": ACTION_ALIASES,
            "studyHints": STUDY_HINTS,
            "rosDomainId": os.environ.get("ROS_DOMAIN_ID"),
            "expectedRosDomainId": DEFAULT_EXPECTED_ROS_DOMAIN_ID,
            "importError": self.import_error,
            "robotError": self.robot_error,
        }

    def execute(self, canonical_plan: dict[str, Any]) -> dict[str, Any]:
        kind = canonical_plan.get("kind")
        params = canonical_plan.get("params") or {}

        if kind == "state.read":
            return self.read_state()

        if self.dry_run:
            return {"executed": False, "delivery": "dry-run", "kind": kind, "params": params}

        if not self.available:
            return {"executed": False, "error": self.import_error or "DOGZILLALib unavailable"}

        with self._lock:
            robot = self._robot()
            if robot is None:
                return {"executed": False, "error": self.robot_error or "robot unavailable"}

            try:
                if kind == "noop":
                    robot.stop()
                    return {"executed": True, "delivery": "stop"}

                if kind == "locomotion.relative":
                    return self._execute_locomotion(robot, params)

                if kind == "action.once":
                    action_id = resolve_action_id(params)
                    if action_id is None:
                        return {
                            "executed": False,
                            "error": "action.once missing actionId or known action name",
                            "knownActions": ACTION_ALIASES,
                        }
                    robot.action(action_id)
                    return {
                        "executed": True,
                        "delivery": "DOGZILLALib",
                        "kind": kind,
                        "actionId": action_id,
                    }

                if kind == "stabilize.set":
                    robot.imu(1 if params.get("enabled") else 0)
                    return {"executed": True, "delivery": "DOGZILLALib", "kind": kind}

                if kind == "pose.body":
                    return self._execute_body_pose(robot, params)

                return {"executed": False, "error": f"unsupported_kind:{kind}"}
            except Exception as error:
                self.robot_error = str(error)
                return {"executed": False, "error": str(error)}

    def read_state(self) -> dict[str, Any]:
        if not self.available:
            return {"executed": False, "error": self.import_error or "DOGZILLALib unavailable"}

        with self._lock:
            robot = self._robot()
            if robot is None:
                return {"executed": False, "error": self.robot_error or "robot unavailable"}

            result = {
                "executed": True,
                "delivery": "DOGZILLALib",
                "dryRun": self.dry_run,
                "battery": None,
                "motors": None,
                "roll": None,
                "pitch": None,
                "yaw": None,
                "imuRaw": None,
                "readErrors": {},
                "readAt": utc_now(),
            }

            # Keep the default state path light. Some vendor serial reads can block
            # when the controller or robot battery is unhealthy.
            state_fields = [
                ("battery", ["read_Battery", "read_battery"]),
            ]
            if DEFAULT_INCLUDE_ATTITUDE_STATE:
                state_fields.extend(
                    [
                        ("roll", ["read_roll", "read_Roll"]),
                        ("pitch", ["read_pitch", "read_Pitch"]),
                        ("yaw", ["read_yaw", "read_Yaw"]),
                    ]
                )
            if DEFAULT_INCLUDE_SLOW_STATE:
                state_fields.extend(
                    [
                        ("motors", ["read_Motor", "read_motor"]),
                        ("imuRaw", ["read_imu_raw", "read_imu"]),
                    ]
                )

            for field, names in state_fields:
                try:
                    result[field] = call_first(robot, names)
                except Exception as error:
                    result["readErrors"][field] = str(error)

            if not result["readErrors"]:
                del result["readErrors"]
            return result

    def _execute_locomotion(self, robot, params: dict[str, Any]) -> dict[str, Any]:
        x_step = clamp(float(params.get("x_step") or 0), -25, 25)
        y_step = clamp(float(params.get("y_step") or 0), -18, 18)
        turn_rate = clamp(float(params.get("turn_rate") or 0), -100, 100)
        pace = params.get("pace")
        gait = params.get("gait")

        if pace in ("normal", "slow", "high"):
            robot.pace(pace)
        if gait in ("trot", "walk", "high_walk") and hasattr(robot, "gait_type"):
            robot.gait_type(gait)

        robot.move("x", x_step)
        robot.move("y", y_step)
        robot.turn(turn_rate)
        if x_step == 0 and y_step == 0 and turn_rate == 0:
            robot.stop()
        return {"executed": True, "delivery": "DOGZILLALib", "kind": "locomotion.relative"}

    def _execute_body_pose(self, robot, params: dict[str, Any]) -> dict[str, Any]:
        if "height" in params:
            robot.translation("z", clamp(float(params["height"]), 75, 115))
        for axis, key, low, high in (
            ("x", "body_x", -35, 35),
            ("y", "body_y", -18, 18),
        ):
            if key in params:
                robot.translation(axis, clamp(float(params[key]), low, high))
        for axis, key, low, high in (
            ("r", "roll", -20, 20),
            ("p", "pitch", -15, 15),
            ("y", "yaw", -11, 11),
        ):
            if key in params:
                robot.attitude(axis, clamp(float(params[key]), low, high))
        return {"executed": True, "delivery": "DOGZILLALib", "kind": "pose.body"}

    def _robot(self):
        if self.robot is not None:
            return self.robot
        try:
            try:
                self.robot = self.DOGZILLA(self.serial_port)
            except TypeError:
                self.robot = self.DOGZILLA()
        except Exception as error:
            self.robot_error = str(error)
            return None
        return self.robot

    def _load_factory(self):
        for module_name in load_module_candidates():
            try:
                module = __import__(module_name, fromlist=["*"])
            except Exception as error:
                self.import_attempts.append({"module": module_name, "error": str(error)})
                continue

            for factory_name in VENDOR_FACTORY_CANDIDATES:
                factory = getattr(module, factory_name, None)
                if factory is not None:
                    self.import_attempts.append({"module": module_name, "factory": factory_name})
                    self.import_error = None
                    return factory

            self.import_attempts.append({"module": module_name, "error": "no DOGZILLA factory found"})

        self.import_error = "No DOGZILLA Python control factory found"
        return None


class BridgeServer(ThreadingHTTPServer):
    def __init__(self, server_address, handler_class, runtime: DogzillaRuntime):
        super().__init__(server_address, handler_class)
        self.runtime = runtime
        self.received_count = 0
        self.recent_commands: deque[dict[str, Any]] = deque(maxlen=MAX_RECENT_COMMANDS)


class Handler(BaseHTTPRequestHandler):
    server_version = "DogzillaLibBridge/0.2"

    def do_GET(self):
        if self.path == "/healthz":
            runtime = self.server.runtime.snapshot()
            self._send_json(
                200,
                {
                    "ok": runtime["available"],
                    "mode": "http-to-dogzillalib",
                    "receivedCount": self.server.received_count,
                    "runtime": runtime,
                },
            )
            return
        if self.path == "/feedback":
            self._send_json(
                200,
                {
                    "recentCommands": list(self.server.recent_commands),
                    "receivedCount": self.server.received_count,
                    "runtime": self.server.runtime.snapshot(),
                    "logFile": str(LOG_FILE),
                },
            )
            return
        if self.path == "/state":
            result = self.server.runtime.read_state()
            self._send_json(200 if result.get("executed") else 503, result)
            return
        if self.path == "/actions":
            self._send_json(200, {"actions": ACTION_ALIASES})
            return
        if self.path == "/preflight":
            self._send_json(200, {"runtime": self.server.runtime.snapshot(), "checks": build_preflight_checks()})
            return
        self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/commands":
            self._send_json(404, {"error": "Not found"})
            return

        payload = self._read_json_body()
        envelope = payload.get("envelope") if isinstance(payload, dict) else None
        if not isinstance(envelope, dict):
            self._send_json(400, {"error": 'Expected JSON object with top-level key "envelope"'})
            return

        canonical_plan = envelope.get("canonicalPlan") or envelope.get("payload", {}).get("canonicalPlan")
        if not isinstance(canonical_plan, dict):
            self._send_json(400, {"error": "Missing canonicalPlan"})
            return

        self.server.received_count += 1
        command_id = f"dogzilla-lib-{self.server.received_count:04d}"
        result = self.server.runtime.execute(canonical_plan)
        record = {
            "commandId": command_id,
            "receivedAt": utc_now(),
            "envelope": envelope,
            "canonicalPlan": canonical_plan,
            "result": result,
        }
        self.server.recent_commands.appendleft(record)
        append_log_record(record)

        status = 202 if result.get("executed") or result.get("delivery") == "dry-run" else 422
        self._send_json(status, {"accepted": status == 202, "commandId": command_id, "result": result})

    def log_message(self, fmt, *args):
        return

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return None

    def _send_json(self, status_code: int, payload: dict[str, Any]):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def resolve_action_id(params: dict[str, Any]) -> int | None:
    raw_action_id = params.get("actionId", params.get("action_id"))
    if raw_action_id is not None:
        return clamp_int(int(raw_action_id), 1, 255)

    for key in ("trick", "actionName", "action_name", "name"):
        raw_name = params.get(key)
        if not isinstance(raw_name, str):
            continue
        action_id = ACTION_ALIASES.get(raw_name.strip().lower())
        if action_id is not None:
            return action_id

    return None


def load_vendor_paths() -> list[Path]:
    raw = os.environ.get("DOGZILLA_VENDOR_PATHS", "")
    configured = [Path(item) for item in raw.split(os.pathsep) if item.strip()]
    return configured + VENDOR_PATHS


def load_module_candidates() -> list[str]:
    raw = os.environ.get("DOGZILLA_VENDOR_MODULES", "")
    configured = [item.strip() for item in raw.split(",") if item.strip()]
    return configured + VENDOR_MODULE_CANDIDATES


def call_first(target: Any, names: list[str]) -> Any:
    for name in names:
        method = getattr(target, name, None)
        if method is not None:
            return method()
    raise AttributeError(f"Missing DOGZILLA method. Tried: {', '.join(names)}")


def build_preflight_checks() -> list[dict[str, Any]]:
    return [
        {"name": "same_lan", "expect": "desktop and DOGZILLA on same LAN"},
        {"name": "ros_domain", "expect": f"ROS_DOMAIN_ID={DEFAULT_EXPECTED_ROS_DOMAIN_ID} for Yahboom default image"},
        {"name": "pi5_docker", "command": STUDY_HINTS["pi5DockerEntry"]},
        {"name": "bringup", "command": STUDY_HINTS["bringupLaunch"]},
        {"name": "app_conflict", "expect": STUDY_HINTS["knownConflict"]},
    ]


def append_log_record(record: dict[str, Any]) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def clamp_int(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    parser = argparse.ArgumentParser(description="Robo-Doge direct DOGZILLALib bridge")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--serial-port", default=DEFAULT_SERIAL_PORT)
    parser.add_argument("--live", action="store_true", help="Send commands to hardware. Default is dry-run.")
    args = parser.parse_args()

    runtime = DogzillaRuntime(serial_port=args.serial_port, dry_run=DEFAULT_DRY_RUN and not args.live)
    server = BridgeServer((args.host, args.port), Handler, runtime)
    print(f"DOGZILLALib bridge listening on http://{args.host}:{args.port}")
    print(json.dumps(runtime.snapshot()))
    server.serve_forever()


if __name__ == "__main__":
    main()
