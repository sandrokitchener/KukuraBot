from __future__ import annotations

import argparse
import base64
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_MODEL_ID = os.environ.get("PARAKEET_MODEL_ID", "nvidia/parakeet-tdt-0.6b-v3")


class ParakeetBridgeServer(ThreadingHTTPServer):
    model = None
    model_id = ""
    model_device = ""
    model_lock = None
    last_error = ""
    request_count = 0


class ParakeetBridgeHandler(BaseHTTPRequestHandler):
    server_version = "ParakeetBridge/0.1"

    def do_GET(self):
        if self.path == "/healthz":
            self._send_json(
                200,
                {
                    "ok": True,
                    "status": "ready" if self.server.model is not None else "idle",
                    "modelId": self.server.model_id or DEFAULT_MODEL_ID,
                    "device": self.server.model_device or "unloaded",
                    "requestCount": self.server.request_count,
                    "lastError": self.server.last_error,
                    "rootDir": str(ROOT_DIR),
                },
            )
            return

        self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            self._send_json(404, {"error": "Not found"})
            return

        payload = self._read_json_body()
        if not payload:
            self._send_json(400, {"error": "Missing JSON payload"})
            return

        audio_base64 = payload.get("audioBase64")
        if not isinstance(audio_base64, str) or not audio_base64.strip():
            self._send_json(400, {"error": "Missing audioBase64"})
            return

        try:
            audio_bytes = base64.b64decode(audio_base64)
        except Exception:
            self._send_json(400, {"error": "audioBase64 is not valid base64"})
            return

        model_id = payload.get("modelId") if isinstance(payload.get("modelId"), str) else DEFAULT_MODEL_ID
        language = payload.get("language") if isinstance(payload.get("language"), str) else ""
        task = payload.get("task") if isinstance(payload.get("task"), str) else ""
        device = payload.get("device") if isinstance(payload.get("device"), str) else "auto"
        timestamps = payload.get("timestamps", True)

        try:
            result = self.server_transcribe(
                audio_bytes=audio_bytes,
                model_id=model_id,
                language=language,
                task=task,
                device=device,
                timestamps=bool(timestamps),
            )
        except Exception as error:
            self.server.last_error = f"{type(error).__name__}: {error}"
            self._send_json(
                500,
                {
                    "error": self.server.last_error,
                    "modelId": model_id,
                },
            )
            return

        self.server.request_count += 1
        self._send_json(200, result)

    def log_message(self, fmt, *args):
        return

    def server_transcribe(self, *, audio_bytes, model_id, language, task, device, timestamps):
        model, resolved_device = load_model(self.server, model_id, device)

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            temp_path = Path(handle.name)
            handle.write(audio_bytes)

        try:
            output = model.transcribe([str(temp_path)], timestamps=timestamps)[0]
        finally:
            temp_path.unlink(missing_ok=True)

        timestamp_payload = getattr(output, "timestamp", None)

        return {
            "text": extract_text(output),
            "timestamps": make_json_safe(timestamp_payload) if timestamps else None,
            "modelId": model_id,
            "device": resolved_device,
            "language": language,
            "task": task,
        }

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


def load_model(server, model_id, device):
    with server.model_lock:
        resolved_device = resolve_device(device)

        if server.model is not None and server.model_id == model_id and server.model_device == resolved_device:
            return server.model, server.model_device

        import nemo.collections.asr as nemo_asr

        model = nemo_asr.models.ASRModel.from_pretrained(model_name=model_id)

        if hasattr(model, "to"):
            model = model.to(resolved_device)

        if hasattr(model, "eval"):
            model.eval()

        server.model = model
        server.model_id = model_id
        server.model_device = resolved_device
        server.last_error = ""
        return server.model, server.model_device


def resolve_device(device):
    requested = (device or "auto").strip().lower()

    if requested and requested != "auto":
        return requested

    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def extract_text(output):
    if hasattr(output, "text") and isinstance(output.text, str):
        return output.text

    if isinstance(output, str):
        return output

    return str(output)


def make_json_safe(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value

    if isinstance(value, dict):
        return {str(key): make_json_safe(item) for key, item in value.items()}

    if isinstance(value, (list, tuple)):
        return [make_json_safe(item) for item in value]

    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            pass

    if hasattr(value, "__dict__"):
        return {
            key: make_json_safe(item)
            for key, item in vars(value).items()
            if not key.startswith("_")
        }

    return str(value)


def main():
    parser = argparse.ArgumentParser(description="Parakeet TDT speech bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8892)
    args = parser.parse_args()

    server = ParakeetBridgeServer((args.host, args.port), ParakeetBridgeHandler)
    server.model_lock = threading.Lock()
    print(f"Parakeet bridge listening on http://{args.host}:{args.port}")
    print(f"Repo root: {ROOT_DIR}")
    print(f"Default model: {DEFAULT_MODEL_ID}")
    server.serve_forever()


if __name__ == "__main__":
    main()
