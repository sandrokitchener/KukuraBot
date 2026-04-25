from __future__ import annotations

import argparse
import json
import os
import threading
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[2]
LOG_FILE = Path(__file__).resolve().with_name("command_log.ndjson")
DEFAULT_PLAN_TOPIC = os.environ.get("DOGZILLA_PLAN_TOPIC", "/dogzilla/command_plan")
DEFAULT_STATE_TOPIC = os.environ.get("DOGZILLA_STATE_TOPIC", "/dogzilla/state")
DEFAULT_NODE_NAME = os.environ.get("DOGZILLA_HTTP_BRIDGE_NODE_NAME", "dogzilla_http_bridge")
MAX_RECENT_COMMANDS = int(os.environ.get("DOGZILLA_HTTP_BRIDGE_HISTORY", "20"))


class Ros2PublisherRuntime:
    def __init__(self, plan_topic: str, state_topic: str, node_name: str):
        self.plan_topic = plan_topic
        self.state_topic = state_topic
        self.node_name = node_name
        self.available = False
        self.import_error: str | None = None
        self.last_state_message: Any | None = None
        self.last_state_at: str | None = None
        self.last_publish_at: str | None = None
        self.last_publish_error: str | None = None
        self._executor = None
        self._node = None
        self._thread: threading.Thread | None = None
        self._publisher = None
        self._string_type = None
        self._lock = threading.Lock()

        try:
            import rclpy
            from rclpy.executors import SingleThreadedExecutor
            from rclpy.node import Node
            from std_msgs.msg import String
        except Exception as error:  # pragma: no cover - import path varies by machine
            self.import_error = str(error)
            self.rclpy = None
            self.Node = None
            return

        self.rclpy = rclpy
        self.SingleThreadedExecutor = SingleThreadedExecutor
        self.Node = Node
        self._string_type = String

        try:
            self.rclpy.init(args=None)
            self._node = self.Node(node_name)
            self._publisher = self._node.create_publisher(String, plan_topic, 10)
            self._node.create_subscription(String, state_topic, self._handle_state, 10)
            self._executor = self.SingleThreadedExecutor()
            self._executor.add_node(self._node)
            self._thread = threading.Thread(target=self._spin, daemon=True)
            self._thread.start()
            self.available = True
        except Exception as error:  # pragma: no cover - runtime depends on ROS2 install
            self.import_error = str(error)
            self.available = False

    def publish_envelope(self, envelope: dict[str, Any]) -> dict[str, Any]:
        if not self.available:
            return {
                "published": False,
                "reason": self.import_error or "rclpy unavailable",
            }

        try:
            message = self._string_type()
            message.data = json.dumps(envelope)
            self._publisher.publish(message)
            published_at = utc_now()
            with self._lock:
                self.last_publish_at = published_at
                self.last_publish_error = None
            return {
                "published": True,
                "publishedAt": published_at,
                "topic": self.plan_topic,
            }
        except Exception as error:  # pragma: no cover - runtime depends on ROS2 install
            with self._lock:
                self.last_publish_error = str(error)
            return {
                "published": False,
                "reason": str(error),
                "topic": self.plan_topic,
            }

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
              "available": self.available,
              "planTopic": self.plan_topic,
              "stateTopic": self.state_topic,
              "nodeName": self.node_name,
              "importError": self.import_error,
              "lastStateMessage": self.last_state_message,
              "lastStateAt": self.last_state_at,
              "lastPublishAt": self.last_publish_at,
              "lastPublishError": self.last_publish_error,
            }

    def close(self) -> None:
        if not self.available:
            return

        try:
            if self._executor is not None:
                self._executor.shutdown(timeout_sec=0.1)
            if self._node is not None:
                self._node.destroy_node()
            if self.rclpy is not None:
                self.rclpy.shutdown()
        except Exception:
            return

    def _spin(self) -> None:
        try:
            self._executor.spin()
        except Exception:
            return

    def _handle_state(self, message) -> None:
        body = message.data

        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = body

        with self._lock:
            self.last_state_message = parsed
            self.last_state_at = utc_now()


class Ros2BridgeServer(ThreadingHTTPServer):
    def __init__(self, server_address, handler_class, runtime: Ros2PublisherRuntime):
        super().__init__(server_address, handler_class)
        self.runtime = runtime
        self.received_count = 0
        self.recent_commands: deque[dict[str, Any]] = deque(maxlen=MAX_RECENT_COMMANDS)


class Ros2BridgeHandler(BaseHTTPRequestHandler):
    server_version = "Ros2Bridge/0.1"

    def do_GET(self):
        if self.path == "/healthz":
            self._send_json(200, self._health_payload())
            return

        if self.path == "/feedback":
            self._send_json(200, self._feedback_payload())
            return

        self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/commands":
            self._send_json(404, {"error": "Not found"})
            return

        payload = self._read_json_body()
        if not payload:
            self._send_json(400, {"error": "Missing JSON payload"})
            return

        envelope = payload.get("envelope")
        if not isinstance(envelope, dict):
            self._send_json(400, {"error": 'Expected JSON object with top-level key "envelope"'})
            return

        self.server.received_count += 1
        command_id = f"ros2-cmd-{self.server.received_count:04d}"
        record = {
            "commandId": command_id,
            "receivedAt": utc_now(),
            "envelope": envelope,
        }

        publish_result = self.server.runtime.publish_envelope(envelope)
        record["publishResult"] = publish_result
        self.server.recent_commands.appendleft(record)
        append_log_record(record)

        if publish_result.get("published"):
            self._send_json(
                202,
                {
                    "accepted": True,
                    "commandId": command_id,
                    "delivery": "published-to-plan-topic",
                    "planTopic": publish_result.get("topic"),
                    "publishedAt": publish_result.get("publishedAt"),
                },
            )
            return

        if self.server.runtime.available:
            self._send_json(
                502,
                {
                    "accepted": False,
                    "commandId": command_id,
                    "delivery": "publish-failed",
                    "error": publish_result.get("reason") or "Unknown ROS2 publish failure.",
                },
            )
            return

        self._send_json(
            503,
            {
                "accepted": False,
                "commandId": command_id,
                "delivery": "ros2-unavailable",
                "error": publish_result.get("reason") or "ROS2 runtime unavailable.",
            },
        )

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

    def _health_payload(self) -> dict[str, Any]:
        runtime = self.server.runtime.snapshot()
        return {
            "ok": runtime["available"],
            "mode": "http-to-ros2-plan-topic",
            "receivedCount": self.server.received_count,
            "logFile": str(LOG_FILE),
            "runtime": runtime,
        }

    def _feedback_payload(self) -> dict[str, Any]:
        runtime = self.server.runtime.snapshot()
        return {
            "status": "ok" if runtime["available"] else "degraded",
            "lastCommandId": self.server.recent_commands[0]["commandId"] if self.server.recent_commands else None,
            "recentCommands": list(self.server.recent_commands),
            "lastStateMessage": runtime["lastStateMessage"],
            "lastStateAt": runtime["lastStateAt"],
            "lastPublishAt": runtime["lastPublishAt"],
            "lastPublishError": runtime["lastPublishError"],
            "rosAvailable": runtime["available"],
            "planTopic": runtime["planTopic"],
            "stateTopic": runtime["stateTopic"],
            "logFile": str(LOG_FILE),
        }


def append_log_record(record: dict[str, Any]) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    parser = argparse.ArgumentParser(description="ROS2 command bridge sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8892)
    parser.add_argument("--plan-topic", default=DEFAULT_PLAN_TOPIC)
    parser.add_argument("--state-topic", default=DEFAULT_STATE_TOPIC)
    parser.add_argument("--node-name", default=DEFAULT_NODE_NAME)
    args = parser.parse_args()

    runtime = Ros2PublisherRuntime(
        plan_topic=args.plan_topic,
        state_topic=args.state_topic,
        node_name=args.node_name,
    )
    server = Ros2BridgeServer((args.host, args.port), Ros2BridgeHandler, runtime)
    print(f"ROS2 sidecar listening on http://{args.host}:{args.port}")
    print(f"Repo root: {ROOT_DIR}")
    print(f"Logging commands to: {LOG_FILE}")
    print(f"Plan topic: {args.plan_topic}")
    print(f"State topic: {args.state_topic}")
    print(f"ROS available: {runtime.available}")

    try:
        server.serve_forever()
    finally:
        runtime.close()


if __name__ == "__main__":
    main()
