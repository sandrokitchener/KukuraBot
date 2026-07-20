#!/usr/bin/env python3
"""DOGZILLA Pi-local sound cue bridge."""

from __future__ import annotations

import argparse
import audioop
import json
import os
import random
import shutil
import subprocess
import tempfile
import time
import wave
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


BARK_FILES = [
    "robot-bark-normal-092.wav",
    "robot-bark-normal-097.wav",
    "robot-bark-normal-103.wav",
    "robot-bark-normal-108.wav",
]

DEFAULT_CUES = {
    "bark": BARK_FILES,
    "mapping-start": ["mapping-start.wav"],
    "thinking-start": [
        "robot-think-whimper-1.wav",
        "robot-think-whimper-2.wav",
        "robot-think-pant-1.wav",
    ],
    "confirm": BARK_FILES,
}


class AudioState:
    def __init__(self, sounds_dir: Path, player: str, aplay_device: str, volume: Any = None):
        self.sounds_dir = sounds_dir
        self.player = player
        self.aplay_device = aplay_device
        self.volume = normalize_volume(volume)
        self.last_cue = ""
        self.last_error = ""
        self.play_count = 0
        self.active_processes: list[subprocess.Popen] = []
        self.temp_files: dict[int, Path] = {}


class AudioHandler(BaseHTTPRequestHandler):
    server_version = "RoboDogeAudioCue/1.0"

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self.send_json(HTTPStatus.OK, health_payload(self.server.state))
            return
        if self.path == "/volume":
            self.send_json(HTTPStatus.OK, {"ok": True, "volume": self.server.state.volume})
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/volume":
            try:
                body = self.read_json()
                self.server.state.volume = normalize_volume(body.get("volume"))
                self.send_json(HTTPStatus.OK, {"ok": True, "volume": self.server.state.volume})
            except Exception as error:
                self.server.state.last_error = str(error)
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)})
            return

        if self.path != "/cue":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        try:
            body = self.read_json()
            cue = str(body.get("cue", "")).strip()
            if not cue:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Missing cue"})
                return

            result = play_cue(self.server.state, cue, body.get("volume"))
            status = HTTPStatus.OK if result.get("ok") else HTTPStatus.BAD_GATEWAY
            self.send_json(status, result)
        except Exception as error:
            self.server.state.last_error = str(error)
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)})

    def read_json(self) -> dict[str, Any]:
        size = int(self.headers.get("content-length", "0") or "0")
        if size <= 0:
            return {}
        return json.loads(self.rfile.read(size).decode("utf-8"))

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", flush=True)


def health_payload(state: AudioState) -> dict[str, Any]:
    return {
        "ok": bool(resolve_player(state.player)),
        "player": resolve_player(state.player) or "",
        "aplayDevice": state.aplay_device,
        "soundsDir": str(state.sounds_dir),
        "availableCues": sorted(DEFAULT_CUES.keys()) + ["thinking-stop"],
        "lastCue": state.last_cue,
        "lastError": state.last_error,
        "playCount": state.play_count,
        "volume": state.volume,
    }


def play_cue(state: AudioState, cue: str, volume: Any = None) -> dict[str, Any]:
    cleanup_processes(state)
    if volume is None:
        volume_value = state.volume
    else:
        volume_value = normalize_volume(volume)
    state.volume = volume_value
    if cue == "thinking-stop":
        stop_active(state)
        state.last_cue = cue
        state.last_error = ""
        return {"ok": True, "cue": cue, "stopped": True, "volume": volume_value}

    files = DEFAULT_CUES.get(cue)
    if not files:
        return {"ok": False, "cue": cue, "error": f"Unknown cue: {cue}"}

    if volume_value <= 0.0:
        if cue in ("thinking-start", "confirm", "bark", "mapping-start"):
            stop_active(state)
        state.last_cue = cue
        state.last_error = ""
        return {"ok": True, "cue": cue, "muted": True, "volume": volume_value}

    player = resolve_player(state.player)
    if not player:
        return {"ok": False, "cue": cue, "error": f"Audio player not found: {state.player}"}

    sound_file = state.sounds_dir / random.choice(files)
    if not sound_file.exists():
        return {"ok": False, "cue": cue, "error": f"Sound file missing: {sound_file}"}

    if cue in ("thinking-start", "confirm", "bark", "mapping-start"):
        stop_active(state)

    try:
        playback_file = prepare_playback_file(state, sound_file, volume_value)
        command = build_play_command(player, playback_file, state.aplay_device)
        process = subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        time.sleep(0.05)
        if process.poll() not in (None, 0):
            stderr = ""
            if process.stderr:
                stderr = process.stderr.read().decode("utf-8", errors="replace").strip()
            state.last_error = stderr or f"Audio player exited with code {process.returncode}"
            return {"ok": False, "cue": cue, "error": state.last_error}

        state.active_processes.append(process)
        if playback_file != sound_file:
            state.temp_files[process.pid] = playback_file
        state.last_cue = cue
        state.last_error = ""
        state.play_count += 1
        return {"ok": True, "cue": cue, "file": str(sound_file), "pid": process.pid, "volume": volume_value}
    except Exception as error:
        state.last_error = str(error)
        return {"ok": False, "cue": cue, "error": str(error)}


def build_play_command(player: str, sound_file: Path, aplay_device: str) -> list[str]:
    if Path(player).name != "aplay":
        return [player, str(sound_file)]

    command = [player, "-q"]
    if aplay_device:
        command.extend(["-D", aplay_device])
    command.append(str(sound_file))
    return command


def prepare_playback_file(state: AudioState, sound_file: Path, volume: float) -> Path:
    if volume >= 0.995:
        return sound_file

    temp_handle = tempfile.NamedTemporaryFile(
        prefix="robodoge-audio-",
        suffix=".wav",
        delete=False,
    )
    temp_path = Path(temp_handle.name)
    temp_handle.close()

    try:
        with wave.open(str(sound_file), "rb") as source:
            params = source.getparams()
            frames = source.readframes(source.getnframes())
        scaled = audioop.mul(frames, params.sampwidth, volume)
        with wave.open(str(temp_path), "wb") as target:
            target.setparams(params)
            target.writeframes(scaled)
        return temp_path
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def normalize_volume(value: Any) -> float:
    try:
        volume = float(value)
    except (TypeError, ValueError):
        return 1.0
    if volume > 1.0 and volume <= 100.0:
        volume = volume / 100.0
    return max(0.0, min(1.0, volume))


def stop_active(state: AudioState) -> None:
    for process in list(state.active_processes):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                process.kill()
    cleanup_processes(state)


def cleanup_processes(state: AudioState) -> None:
    live_processes = []
    for process in state.active_processes:
        if process.poll() is None:
            live_processes.append(process)
            continue
        temp_file = state.temp_files.pop(process.pid, None)
        if temp_file:
            temp_file.unlink(missing_ok=True)
    state.active_processes = live_processes


def resolve_player(player: str) -> str:
    if os.path.isabs(player) and os.access(player, os.X_OK):
        return player
    return shutil.which(player) or ""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="DOGZILLA Pi speaker cue bridge")
    parser.add_argument("--host", default=os.getenv("DOGZILLA_AUDIO_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("DOGZILLA_AUDIO_PORT", "8895")))
    parser.add_argument("--sounds-dir", default=os.getenv("DOGZILLA_AUDIO_SOUNDS_DIR", "public/sounds"))
    parser.add_argument("--player", default=os.getenv("DOGZILLA_AUDIO_PLAYER", "aplay"))
    parser.add_argument("--aplay-device", default=os.getenv("DOGZILLA_AUDIO_APLAY_DEVICE", ""))
    parser.add_argument("--default-volume", type=float, default=float(os.getenv("DOGZILLA_AUDIO_VOLUME", "1.0")))
    return parser


def main() -> int:
    args = build_parser().parse_args()
    state = AudioState(Path(args.sounds_dir), args.player, args.aplay_device, args.default_volume)
    server = ThreadingHTTPServer((args.host, args.port), AudioHandler)
    server.state = state  # type: ignore[attr-defined]
    print(f"DOGZILLA audio cue bridge listening on http://{args.host}:{args.port}", flush=True)
    print(f"Sounds: {state.sounds_dir}", flush=True)
    print(f"Player: {resolve_player(state.player) or state.player}", flush=True)
    if state.aplay_device:
        print(f"aplay device: {state.aplay_device}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
