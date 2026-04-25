from __future__ import annotations

import argparse
from collections import deque
import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
LOG_FILE = Path(__file__).resolve().with_name("command_log.ndjson")
FEEDBACK_FILE = Path(__file__).resolve().with_name("runtime_feedback.json")
MAX_RECENT_COMMANDS = 20


class IsaacBridgeServer(ThreadingHTTPServer):
    def __init__(self, server_address, handler_class):
        super().__init__(server_address, handler_class)
        self.received_count = 0
        self.recent_commands: deque[dict] = deque(maxlen=MAX_RECENT_COMMANDS)


class IsaacBridgeHandler(BaseHTTPRequestHandler):
    server_version = "IsaacBridge/0.2"

    def do_GET(self):
        if self.path == "/healthz":
            self._send_json(
                200,
                {
                    "ok": True,
                    "mode": "command-log-relay",
                    "isaacListener": "external-isaac-runtime",
                    "receivedCount": self.server.received_count,
                    "logFile": str(LOG_FILE),
                    "feedbackFile": str(FEEDBACK_FILE),
                    "runtimeFeedbackAvailable": FEEDBACK_FILE.exists(),
                },
            )
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
        command_id = f"cmd-{self.server.received_count:04d}"
        record = {
            "commandId": command_id,
            "receivedAt": datetime.now(timezone.utc).isoformat(),
            "envelope": envelope,
        }
        self.server.recent_commands.appendleft(record)
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")

        self._send_json(
            202,
            {
                "accepted": True,
                "mode": "command-log-relay",
                "commandId": command_id,
                "delivery": "logged-for-isaac-runtime",
                "logFile": str(LOG_FILE),
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

    def _send_json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _feedback_payload(self):
        runtime_feedback = self._read_runtime_feedback()
        last_command_id = None

        if isinstance(runtime_feedback, dict):
            active_command = runtime_feedback.get("activeCommand")
            last_command = runtime_feedback.get("lastCommand")
            if isinstance(active_command, dict) and active_command.get("commandId"):
                last_command_id = active_command.get("commandId")
            elif isinstance(last_command, dict) and last_command.get("commandId"):
                last_command_id = last_command.get("commandId")

        if last_command_id is None and self.server.recent_commands:
            last_command_id = self.server.recent_commands[0].get("commandId")

        return {
            "status": "ok" if isinstance(runtime_feedback, dict) else "waiting-for-runtime-feedback",
            "lastCommandId": last_command_id,
            "recentCommands": list(self.server.recent_commands),
            "runtimeFeedback": runtime_feedback,
            "lastEvent": runtime_feedback.get("lastEvent") if isinstance(runtime_feedback, dict) else None,
            "feedbackFile": str(FEEDBACK_FILE),
            "logFile": str(LOG_FILE),
        }

    def _read_runtime_feedback(self):
        if not FEEDBACK_FILE.exists():
            return None

        try:
            return json.loads(FEEDBACK_FILE.read_text(encoding="utf-8"))
        except Exception:
            return None


def main():
    parser = argparse.ArgumentParser(description="Isaac Sim command-log relay sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8891)
    args = parser.parse_args()

    server = IsaacBridgeServer((args.host, args.port), IsaacBridgeHandler)
    print(f"Isaac sidecar relay listening on http://{args.host}:{args.port}")
    print(f"Repo root: {ROOT_DIR}")
    print(f"Logging commands to: {LOG_FILE}")
    print(f"Reading runtime feedback from: {FEEDBACK_FILE}")
    server.serve_forever()


if __name__ == "__main__":
    main()
