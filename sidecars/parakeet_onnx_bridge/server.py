from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_MODEL_ID = os.environ.get("PARAKEET_ONNX_MODEL_ID", "nemo-parakeet-tdt-0.6b-v3")
SOURCE_MODEL_URL = os.environ.get(
    "PARAKEET_ONNX_SOURCE_URL",
    "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx",
)
MODEL_ALIASES = {
    "nvidia/parakeet-tdt-0.6b-v3": DEFAULT_MODEL_ID,
    "istupakov/parakeet-tdt-0.6b-v3-onnx": DEFAULT_MODEL_ID,
}


class ParakeetOnnxBridgeServer(ThreadingHTTPServer):
    model = None
    model_id = ""
    model_lock = None
    last_error = ""
    request_count = 0


class ParakeetOnnxBridgeHandler(BaseHTTPRequestHandler):
    server_version = "ParakeetOnnxBridge/0.1"

    def do_GET(self):
        if self.path == "/healthz":
            self._send_json(
                200,
                {
                    "ok": True,
                    "status": "ready" if self.server.model is not None else "idle",
                    "backend": "onnx-asr",
                    "modelId": self.server.model_id or DEFAULT_MODEL_ID,
                    "sourceModelUrl": SOURCE_MODEL_URL,
                    "device": "onnxruntime",
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

        model_id = normalize_model_id(payload.get("modelId"))
        language = payload.get("language") if isinstance(payload.get("language"), str) else ""
        task = payload.get("task") if isinstance(payload.get("task"), str) else ""
        timestamps = payload.get("timestamps", True)

        try:
            result = self.server_transcribe(
                audio_bytes=audio_bytes,
                model_id=model_id,
                language=language,
                task=task,
                timestamps=bool(timestamps),
            )
        except Exception as error:
            self.server.last_error = f"{type(error).__name__}: {error}"
            self._send_json(
                500,
                {
                    "error": self.server.last_error,
                    "modelId": model_id,
                    "backend": "onnx-asr",
                },
            )
            return

        self.server.request_count += 1
        self._send_json(200, result)

    def log_message(self, fmt, *args):
        return

    def server_transcribe(self, *, audio_bytes, model_id, language, task, timestamps):
        model = load_model(self.server, model_id)

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            temp_path = Path(handle.name)
            handle.write(audio_bytes)

        try:
            output = model.recognize(str(temp_path))
        finally:
            temp_path.unlink(missing_ok=True)

        return {
            "text": extract_text(output),
            "timestamps": extract_timestamps(output) if timestamps else None,
            "modelId": model_id,
            "sourceModelUrl": SOURCE_MODEL_URL,
            "backend": "onnx-asr",
            "device": "onnxruntime",
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


def load_model(server, model_id):
    with server.model_lock:
        if server.model is not None and server.model_id == model_id:
            return server.model

        import onnx_asr

        model = onnx_asr.load_model(model_id)
        server.model = model
        server.model_id = model_id
        server.last_error = ""
        return server.model


def normalize_model_id(value):
    requested = value.strip() if isinstance(value, str) and value.strip() else DEFAULT_MODEL_ID
    return MODEL_ALIASES.get(requested, requested)


def extract_text(output):
    if isinstance(output, str):
        return output

    if hasattr(output, "text") and isinstance(output.text, str):
        return output.text

    if isinstance(output, dict):
        text = output.get("text")
        if isinstance(text, str):
            return text

    return str(output)


def extract_timestamps(output):
    if hasattr(output, "timestamps"):
        return make_json_safe(output.timestamps)

    if hasattr(output, "timestamp"):
        return make_json_safe(output.timestamp)

    if isinstance(output, dict):
        return make_json_safe(output.get("timestamps") or output.get("timestamp"))

    return None


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


def require_runtime_dependencies():
    if importlib.util.find_spec("onnx_asr") is not None:
        return

    print(
        "Missing Python dependency: onnx_asr. Install with: pip install \"onnx-asr[cpu,hub]\"",
        file=sys.stderr,
    )
    raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser(description="Parakeet TDT ONNX speech bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8893)
    args = parser.parse_args()

    require_runtime_dependencies()

    server = ParakeetOnnxBridgeServer((args.host, args.port), ParakeetOnnxBridgeHandler)
    server.model_lock = threading.Lock()
    print(f"Parakeet ONNX bridge listening on http://{args.host}:{args.port}")
    print(f"Repo root: {ROOT_DIR}")
    print(f"Default ONNX model: {DEFAULT_MODEL_ID}")
    print(f"Source model URL: {SOURCE_MODEL_URL}")
    server.serve_forever()


if __name__ == "__main__":
    main()
