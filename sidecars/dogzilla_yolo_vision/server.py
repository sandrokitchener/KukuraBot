#!/usr/bin/env python3
"""DOGZILLA Pi-local YOLO ONNX annotated MJPEG stream."""

from __future__ import annotations

import argparse
import ast
import json
import math
import os
import socket
import sys
import threading
import time
import zlib
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen

try:
    import cv2
    import numpy as np
    import onnxruntime as ort
except Exception as error:  # pragma: no cover - exercised on Pi startup
    print(f"Missing required vision dependency: {error}", file=sys.stderr, flush=True)
    raise


BOUNDARY = "frame"
DEFAULT_COLORS = [
    (0, 220, 255),
    (0, 180, 0),
    (255, 120, 0),
    (220, 0, 255),
    (0, 90, 255),
    (255, 220, 0),
]
WAKE_COMMAND = "$010F040115#"
DEFAULT_STALE_HEALTH_SECONDS = 2.0
PERSON_BARK_COOLDOWN = 5.0  # minimum seconds between person-triggered barks
PERSON_BARK_CONFIDENCE = 0.8  # confidence threshold to trigger bark


@dataclass
class Detection:
    label: str
    class_id: int
    confidence: float
    box: list[float]


@dataclass
class VisionState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    worker: "VisionWorker | None" = None
    latest_raw_frame: Any = None
    latest_jpeg: bytes | None = None
    latest_detections: list[Detection] = field(default_factory=list)
    latest_frame_at: float = 0.0
    latest_error: str = ""
    frames: int = 0
    inferences: int = 0
    inference_ms: float = 0.0
    model_loaded: bool = False
    labels: list[str] = field(default_factory=list)
    capture_restarts: int = 0
    last_person_bark_at: float = 0.0


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True


class YoloOnnxDetector:
    def __init__(self, model_path: str, labels_path: str, input_size: int, confidence: float, iou: float):
        self.model_path = model_path
        self.input_size = input_size
        self.confidence = confidence
        self.iou = iou
        self.session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.output_names = [output.name for output in self.session.get_outputs()]
        self.labels = load_labels(labels_path, self.session)

    def detect(self, frame: np.ndarray) -> tuple[list[Detection], float]:
        start = time.perf_counter()
        tensor, ratio, pad = letterbox(frame, self.input_size)
        outputs = self.session.run(self.output_names, {self.input_name: tensor})
        detections = parse_yolo_outputs(
            outputs,
            frame.shape[1],
            frame.shape[0],
            ratio,
            pad,
            self.labels,
            self.confidence,
            self.iou,
        )
        elapsed_ms = (time.perf_counter() - start) * 1000
        return detections, elapsed_ms


class VisionWorker(threading.Thread):
    def __init__(self, state: VisionState, args: argparse.Namespace):
        super().__init__(daemon=True)
        self.state = state
        self.args = args
        self.stop_event = threading.Event()
        self.detector: YoloOnnxDetector | None = None

    def stop(self) -> None:
        self.stop_event.set()

    def run(self) -> None:
        capture_thread = threading.Thread(target=self.capture_loop, daemon=True)
        capture_thread.start()
        self.inference_loop()

    def capture_loop(self) -> None:
        while not self.stop_event.is_set():
            control_socket: socket.socket | None = None
            try:
                if is_http_camera(self.args.camera_url):
                    control_socket = open_camera_control_session(self.args)

                for frame in read_camera_frames(
                    self.args.camera_url,
                    self.args.camera_timeout,
                    self.args.camera_read_retries,
                    self.args.camera_drain_frames,
                    self.args.stale_frame_limit,
                ):
                    if self.stop_event.is_set():
                        return

                    with self.state.lock:
                        detections = list(self.state.latest_detections)
                        inference_ms = self.state.inference_ms

                    annotated = draw_detections(frame, detections, inference_ms)
                    encode_ok, jpeg = cv2.imencode(".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), self.args.jpeg_quality])
                    if not encode_ok:
                        raise RuntimeError("Could not encode annotated JPEG frame.")

                    with self.state.lock:
                        self.state.latest_raw_frame = frame.copy()
                        self.state.latest_jpeg = jpeg.tobytes()
                        self.state.latest_frame_at = time.time()
                        self.state.latest_error = ""
                        self.state.frames += 1

                    time.sleep(max(0.0, 1.0 / max(1.0, self.args.max_fps)))
            except Exception as error:
                with self.state.lock:
                    self.state.latest_error = str(error)
                    self.state.capture_restarts += 1
                time.sleep(self.args.restart_delay)
            finally:
                if control_socket:
                    control_socket.close()

    def inference_loop(self) -> None:
        next_inference_at = 0.0
        while not self.stop_event.is_set():
            try:
                if self.detector is None:
                    self.detector = YoloOnnxDetector(
                        self.args.model,
                        self.args.labels,
                        self.args.imgsz,
                        self.args.confidence,
                        self.args.iou,
                    )
                    with self.state.lock:
                        self.state.model_loaded = True
                        self.state.labels = self.detector.labels

                with self.state.lock:
                    frame = None if self.state.latest_raw_frame is None else self.state.latest_raw_frame.copy()

                if frame is None:
                    time.sleep(0.05)
                    continue

                now = time.monotonic()
                if now < next_inference_at:
                    time.sleep(next_inference_at - now)
                    with self.state.lock:
                        frame = None if self.state.latest_raw_frame is None else self.state.latest_raw_frame.copy()
                    if frame is None:
                        continue

                inference_started_at = time.monotonic()
                detections, inference_ms = self.detector.detect(frame)
                next_inference_at = inference_started_at + (1.0 / max(1.0, self.args.inference_fps))
                with self.state.lock:
                    self.state.latest_detections = detections
                    self.state.inference_ms = inference_ms
                    self.state.inferences += 1
                    # Person detection -> bark gate
                    if self.args.audio_cue_url:
                        now = time.time()
                        if now - self.state.last_person_bark_at >= PERSON_BARK_COOLDOWN:
                            for d in detections:
                                if d.label.lower() == "person" and d.confidence >= PERSON_BARK_CONFIDENCE:
                                    self.state.last_person_bark_at = now
                                    threading.Thread(target=post_audio_cue, args=(self.args.audio_cue_url,), daemon=True).start()
                                    break

            except Exception as error:
                with self.state.lock:
                    self.state.latest_error = str(error)
                time.sleep(self.args.restart_delay)


class VisionHandler(BaseHTTPRequestHandler):
    server_version = "RoboDogeYoloVision/1.0"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            self.send_json(HTTPStatus.OK, health_payload(self.server.state, self.server.args))
            return
        if parsed.path == "/detections":
            self.send_json(HTTPStatus.OK, detections_payload(self.server.state))
            return
        if parsed.path == "/stream.mjpg":
            self.stream_mjpeg()
            return

        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def stream_mjpeg(self) -> None:
        ensure_worker(self.server.state, self.server.args)
        deadline = time.time() + self.server.args.first_frame_timeout
        while time.time() < deadline:
            with self.server.state.lock:
                frame = self.server.state.latest_jpeg
                error = self.server.state.latest_error
            if frame:
                break
            if error:
                time.sleep(0.2)
            else:
                time.sleep(0.05)
        else:
            with self.server.state.lock:
                error = self.server.state.latest_error or "No annotated frame available."
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": error})
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={BOUNDARY}")
        self.send_header("Cache-Control", "no-store, no-transform")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        last_sent_at = 0.0
        while True:
            with self.server.state.lock:
                frame = self.server.state.latest_jpeg
                frame_at = self.server.state.latest_frame_at
            if frame and frame_at != last_sent_at:
                try:
                    self.wfile.write(f"--{BOUNDARY}\r\n".encode("ascii"))
                    self.wfile.write(b"Content-Type: image/jpeg\r\n")
                    self.wfile.write(f"Content-Length: {len(frame)}\r\n\r\n".encode("ascii"))
                    self.wfile.write(frame)
                    self.wfile.write(b"\r\n")
                    self.wfile.flush()
                    last_sent_at = frame_at
                except (BrokenPipeError, ConnectionResetError):
                    return
            time.sleep(max(0.01, 1.0 / max(1.0, self.server.args.stream_fps)))

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", flush=True)


def ensure_worker(state: VisionState, args: argparse.Namespace) -> None:
    with state.lock:
        worker = state.worker
        if worker and worker.is_alive():
            return
        worker = VisionWorker(state, args)
        state.worker = worker
        worker.start()


def health_payload(state: VisionState, args: argparse.Namespace) -> dict[str, Any]:
    ensure_worker(state, args)
    with state.lock:
        age = time.time() - state.latest_frame_at if state.latest_frame_at else None
        stale = age is None or age > args.stale_health_seconds
        error = state.latest_error
        if stale and state.latest_jpeg is not None and not error:
            error = f"Camera frame is stale; latest age {age:.2f}s."
        return {
            "ok": state.latest_jpeg is not None and not error and not stale,
            "modelLoaded": state.model_loaded,
            "model": args.model,
            "cameraUrl": args.camera_url,
            "cameraExists": camera_source_exists(args.camera_url),
            "cameraResolvedPath": resolve_camera_source_path(args.camera_url),
            "labels": state.labels,
            "frames": state.frames,
            "inferences": state.inferences,
            "detections": len(state.latest_detections),
            "latestFrameAgeSec": age,
            "staleFrame": stale,
            "staleHealthSeconds": args.stale_health_seconds,
            "inferenceMs": state.inference_ms,
            "captureRestarts": state.capture_restarts,
            "error": error,
            "streamUrl": "/stream.mjpg",
            "detectionsUrl": "/detections",
        }


def detections_payload(state: VisionState) -> dict[str, Any]:
    with state.lock:
        return {
            "ok": state.latest_jpeg is not None and not state.latest_error,
            "frameAt": state.latest_frame_at,
            "inferenceMs": state.inference_ms,
            "detections": [detection_to_json(d) for d in state.latest_detections],
            "error": state.latest_error,
        }


def detection_to_json(detection: Detection) -> dict[str, Any]:
    return {
        "label": detection.label,
        "classId": detection.class_id,
        "confidence": round(detection.confidence, 4),
        "box": [round(value, 2) for value in detection.box],
    }


def open_camera_control_session(args: argparse.Namespace) -> socket.socket | None:
    if not args.camera_control_host or not args.camera_control_port:
        return None

    try:
        sock = socket.create_connection((args.camera_control_host, args.camera_control_port), timeout=args.camera_control_timeout)
        sock.sendall(args.camera_wake_command.encode("utf-8"))
        return sock
    except Exception as error:
        raise RuntimeError(f"Camera control wake failed: {error}") from error


def read_camera_frames(source: str, timeout: float, read_retries: int = 0, drain_frames: int = 4, stale_frame_limit: int = 36):
    source = resolve_camera_source(source)
    if is_http_camera(source):
        yield from read_mjpeg_frames(source, timeout)
        return

    capture_source: int | str = int(source) if source.isdigit() else source
    capture = cv2.VideoCapture(capture_source, cv2.CAP_V4L2)
    failed_reads = 0
    repeated_frames = 0
    previous_signature: int | None = None
    try:
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter.fourcc("M", "J", "P", "G"))
        if not capture.isOpened():
            raise RuntimeError(f"Could not open camera device: {source}")
        while True:
            ok, frame = read_latest_camera_frame(capture, drain_frames)
            if not ok or frame is None:
                failed_reads += 1
                if failed_reads > max(0, read_retries):
                    raise RuntimeError(f"Camera device did not return a frame after {failed_reads} reads: {source}")
                time.sleep(0.05)
                continue
            failed_reads = 0
            signature = frame_signature(frame)
            if stale_frame_limit > 0 and signature == previous_signature:
                repeated_frames += 1
                if repeated_frames >= stale_frame_limit:
                    raise RuntimeError(f"Camera device returned {repeated_frames + 1} identical frames; reopening stale capture: {source}")
            else:
                repeated_frames = 0
                previous_signature = signature
            yield frame
    finally:
        capture.release()


def read_latest_camera_frame(capture, drain_frames: int):
    if drain_frames <= 0:
        return capture.read()
    for _ in range(max(0, drain_frames)):
        if not capture.grab():
            break
    return capture.retrieve()


def frame_signature(frame: np.ndarray) -> int:
    return zlib.crc32(np.ascontiguousarray(frame).data)


def read_mjpeg_frames(url: str, timeout: float):
    request = Request(url, headers={"Accept": "multipart/x-mixed-replace,image/jpeg,*/*"})
    with urlopen(request, timeout=timeout) as response:
        buffer = b""
        while True:
            chunk = response.read(8192)
            if not chunk:
                raise RuntimeError("Camera stream closed before next frame.")
            buffer += chunk
            start = buffer.find(b"\xff\xd8")
            end = buffer.find(b"\xff\xd9", start + 2)
            if start >= 0 and end >= 0:
                jpeg = buffer[start:end + 2]
                buffer = buffer[end + 2:]
                frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
                if frame is None:
                    raise RuntimeError("Camera stream returned undecodable JPEG.")
                yield frame
            if len(buffer) > 5_000_000:
                buffer = buffer[-1_000_000:]


def is_http_camera(source: str) -> bool:
    return source.startswith("http://") or source.startswith("https://")


def camera_source_exists(source: str) -> bool | None:
    source = resolve_camera_source(source)
    if not source or source.isdigit() or is_http_camera(source):
        return None
    return Path(source).exists()


def resolve_camera_source_path(source: str) -> str:
    source = resolve_camera_source(source)
    if not source or source.isdigit() or is_http_camera(source):
        return ""
    try:
        return str(Path(source).resolve(strict=True))
    except OSError:
        return ""


def resolve_camera_source(source: str) -> str:
    if source != "auto":
        return source

    for pattern in ("/dev/v4l/by-id/*video-index0", "/dev/video0", "/dev/video1", "/dev/video2", "/dev/video3"):
        for candidate in sorted(Path("/").glob(pattern.lstrip("/"))):
            if candidate.exists():
                return str(candidate)

    return "/dev/video0"


def letterbox(frame: np.ndarray, size: int) -> tuple[np.ndarray, float, tuple[float, float]]:
    height, width = frame.shape[:2]
    ratio = min(size / width, size / height)
    new_width = int(round(width * ratio))
    new_height = int(round(height * ratio))
    resized = cv2.resize(frame, (new_width, new_height), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    pad_x = (size - new_width) // 2
    pad_y = (size - new_height) // 2
    canvas[pad_y:pad_y + new_height, pad_x:pad_x + new_width] = resized
    rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)
    tensor = rgb.astype(np.float32) / 255.0
    tensor = np.transpose(tensor, (2, 0, 1))[None, :, :, :]
    return np.ascontiguousarray(tensor), ratio, (pad_x, pad_y)


def parse_yolo_outputs(
    outputs: list[np.ndarray],
    frame_width: int,
    frame_height: int,
    ratio: float,
    pad: tuple[float, float],
    labels: list[str],
    confidence_threshold: float,
    iou_threshold: float,
) -> list[Detection]:
    output = outputs[0]
    predictions = np.squeeze(output)
    if predictions.ndim != 2:
        predictions = predictions.reshape((-1, predictions.shape[-1]))
    if predictions.shape[0] < predictions.shape[1] and predictions.shape[0] <= 256:
        predictions = predictions.T

    boxes: list[list[float]] = []
    scores: list[float] = []
    class_ids: list[int] = []

    for row in predictions:
        if row.shape[0] < 6:
            continue

        if row.shape[0] == 6:
            confidence = float(row[4])
            class_id = int(round(float(row[5])))
            if confidence < confidence_threshold:
                continue

            x1, y1, x2, y2 = map(float, row[:4])
            x1 = (x1 - pad[0]) / ratio
            y1 = (y1 - pad[1]) / ratio
            x2 = (x2 - pad[0]) / ratio
            y2 = (y2 - pad[1]) / ratio
            x1 = clamp(x1, 0, frame_width - 1)
            y1 = clamp(y1, 0, frame_height - 1)
            x2 = clamp(x2, 0, frame_width - 1)
            y2 = clamp(y2, 0, frame_height - 1)
            if x2 <= x1 or y2 <= y1:
                continue

            boxes.append([x1, y1, x2, y2])
            scores.append(confidence)
            class_ids.append(class_id)
            continue

        objectness = 1.0
        class_scores = row[4:]
        if row.shape[0] > len(labels) + 4:
            objectness = float(row[4])
            class_scores = row[5:]

        class_id = int(np.argmax(class_scores))
        class_score = float(class_scores[class_id])
        confidence = objectness * class_score
        if confidence < confidence_threshold:
            continue

        x_center, y_center, width, height = map(float, row[:4])
        x1 = (x_center - width / 2 - pad[0]) / ratio
        y1 = (y_center - height / 2 - pad[1]) / ratio
        x2 = (x_center + width / 2 - pad[0]) / ratio
        y2 = (y_center + height / 2 - pad[1]) / ratio
        x1 = clamp(x1, 0, frame_width - 1)
        y1 = clamp(y1, 0, frame_height - 1)
        x2 = clamp(x2, 0, frame_width - 1)
        y2 = clamp(y2, 0, frame_height - 1)
        if x2 <= x1 or y2 <= y1:
            continue

        boxes.append([x1, y1, x2, y2])
        scores.append(confidence)
        class_ids.append(class_id)

    keep = nms(boxes, scores, iou_threshold)
    return [
        Detection(
            label=labels[class_ids[index]] if class_ids[index] < len(labels) else str(class_ids[index]),
            class_id=class_ids[index],
            confidence=scores[index],
            box=boxes[index],
        )
        for index in keep
    ]


def nms(boxes: list[list[float]], scores: list[float], threshold: float) -> list[int]:
    order = sorted(range(len(boxes)), key=lambda index: scores[index], reverse=True)
    keep: list[int] = []
    while order:
        current = order.pop(0)
        keep.append(current)
        order = [index for index in order if box_iou(boxes[current], boxes[index]) < threshold]
    return keep


def box_iou(a: list[float], b: list[float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    intersection = iw * ih
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - intersection
    return intersection / union if union else 0.0


def draw_detections(frame: np.ndarray, detections: list[Detection], inference_ms: float) -> np.ndarray:
    annotated = frame.copy()
    for detection in detections:
        color = DEFAULT_COLORS[detection.class_id % len(DEFAULT_COLORS)]
        x1, y1, x2, y2 = [int(round(value)) for value in detection.box]
        cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)
        label = f"{detection.label} {detection.confidence:.2f}"
        (text_width, text_height), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
        label_y = max(text_height + 8, y1)
        cv2.rectangle(annotated, (x1, label_y - text_height - 8), (x1 + text_width + 8, label_y + baseline), color, -1)
        cv2.putText(annotated, label, (x1 + 4, label_y - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 2, cv2.LINE_AA)

    footer = f"YOLO ONNX | {len(detections)} detections | {inference_ms:.0f} ms"
    cv2.putText(annotated, footer, (10, annotated.shape[0] - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.putText(annotated, footer, (10, annotated.shape[0] - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1, cv2.LINE_AA)
    return annotated


def load_labels(labels_path: str, session: ort.InferenceSession) -> list[str]:
    metadata_names = session.get_modelmeta().custom_metadata_map.get("names", "")
    labels = parse_names(metadata_names)
    if labels:
        return labels

    if labels_path:
        text = Path(labels_path).read_text(encoding="utf-8")
        labels = parse_names(text)
        if labels:
            return labels

    outputs = session.get_outputs()
    class_count = max(0, int(outputs[0].shape[1] if len(outputs[0].shape) > 1 and isinstance(outputs[0].shape[1], int) else 0) - 4)
    return [str(index) for index in range(class_count)]


def parse_names(text: str) -> list[str]:
    if not text:
        return []
    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            value = ast.literal_eval(stripped)
            return normalize_names(value)
        except Exception:
            pass

    for line in stripped.splitlines():
        if line.strip().startswith("names:"):
            value = line.split(":", 1)[1].strip()
            try:
                return normalize_names(ast.literal_eval(value))
            except Exception:
                return [part.strip().strip("'\"") for part in value.strip("[]").split(",") if part.strip()]
    return []


def normalize_names(value: Any) -> list[str]:
    if isinstance(value, dict):
        return [str(value[key]) for key in sorted(value, key=lambda item: int(item) if str(item).isdigit() else str(item))]
    if isinstance(value, list):
        return [str(item) for item in value]
    return []


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def post_audio_cue(url: str) -> None:
    """POST a bark cue to the Pi audio bridge from a daemon thread."""
    try:
        data = json.dumps({"cue": "bark"}).encode("utf-8")
        req = Request(url, data=data, headers={"Content-Type": "application/json"})
        urlopen(req, timeout=2.0)
    except Exception:
        pass  # audio failure must never break vision


def positive_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive finite float")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="DOGZILLA YOLO ONNX annotated camera stream")
    parser.add_argument("--host", default=os.getenv("DOGZILLA_YOLO_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("DOGZILLA_YOLO_PORT", "8894")))
    parser.add_argument("--model", default=os.getenv("DOGZILLA_YOLO_MODEL", "models/dogzilla_yolo/best.onnx"))
    parser.add_argument("--labels", default=os.getenv("DOGZILLA_YOLO_LABELS", "models/dogzilla_yolo/custom.yaml"))
    parser.add_argument("--camera-url", default=os.getenv("DOGZILLA_YOLO_CAMERA_URL", "/dev/video0"))
    parser.add_argument("--camera-control-host", default=os.getenv("DOGZILLA_YOLO_CAMERA_CONTROL_HOST", ""))
    parser.add_argument("--camera-control-port", type=int, default=int(os.getenv("DOGZILLA_YOLO_CAMERA_CONTROL_PORT", "6000")))
    parser.add_argument("--camera-control-timeout", type=positive_float, default=float(os.getenv("DOGZILLA_YOLO_CAMERA_CONTROL_TIMEOUT", "2.5")))
    parser.add_argument("--camera-wake-command", default=os.getenv("DOGZILLA_YOLO_CAMERA_WAKE_COMMAND", WAKE_COMMAND))
    parser.add_argument("--camera-timeout", type=positive_float, default=float(os.getenv("DOGZILLA_YOLO_CAMERA_TIMEOUT", "8")))
    parser.add_argument("--camera-read-retries", type=int, default=int(os.getenv("DOGZILLA_YOLO_CAMERA_READ_RETRIES", "0")))
    parser.add_argument("--camera-drain-frames", type=int, default=int(os.getenv("DOGZILLA_YOLO_CAMERA_DRAIN_FRAMES", "4")))
    parser.add_argument("--stale-frame-limit", type=int, default=int(os.getenv("DOGZILLA_YOLO_STALE_FRAME_LIMIT", "36")))
    parser.add_argument("--imgsz", type=int, default=int(os.getenv("DOGZILLA_YOLO_IMGSZ", "640")))
    parser.add_argument("--confidence", type=float, default=float(os.getenv("DOGZILLA_YOLO_CONF", "0.35")))
    parser.add_argument("--iou", type=float, default=float(os.getenv("DOGZILLA_YOLO_IOU", "0.45")))
    parser.add_argument("--max-fps", type=positive_float, default=float(os.getenv("DOGZILLA_YOLO_MAX_FPS", "12")))
    parser.add_argument("--stream-fps", type=positive_float, default=float(os.getenv("DOGZILLA_YOLO_STREAM_FPS", "12")))
    parser.add_argument("--inference-fps", type=positive_float, default=float(os.getenv("DOGZILLA_YOLO_INFERENCE_FPS", "4")))
    parser.add_argument("--infer-interval", type=positive_float, default=None, help=argparse.SUPPRESS)
    parser.add_argument("--stale-health-seconds", type=positive_float, default=float(os.getenv("DOGZILLA_YOLO_STALE_HEALTH_SECONDS", str(DEFAULT_STALE_HEALTH_SECONDS))))
    parser.add_argument("--jpeg-quality", type=int, default=int(os.getenv("DOGZILLA_YOLO_JPEG_QUALITY", "65")))
    parser.add_argument("--restart-delay", type=positive_float, default=float(os.getenv("DOGZILLA_YOLO_RESTART_DELAY", "2")))
    parser.add_argument("--first-frame-timeout", type=positive_float, default=float(os.getenv("DOGZILLA_YOLO_FIRST_FRAME_TIMEOUT", "15")))
    parser.add_argument("--audio-cue-url", default=os.getenv("DOGZILLA_YOLO_AUDIO_CUE_URL", "http://localhost:8895/cue"))
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.infer_interval is not None:
        args.inference_fps = 1.0 / args.infer_interval
    model = Path(args.model)
    if not model.exists():
        raise SystemExit(f"YOLO ONNX model missing: {model}")

    state = VisionState()
    server = ReusableThreadingHTTPServer((args.host, args.port), VisionHandler)
    server.state = state  # type: ignore[attr-defined]
    server.args = args  # type: ignore[attr-defined]
    print(f"DOGZILLA YOLO vision stream listening on http://{args.host}:{args.port}", flush=True)
    print(f"Model: {args.model}", flush=True)
    print(f"Camera: {args.camera_url}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
