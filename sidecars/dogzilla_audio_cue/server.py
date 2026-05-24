#!/usr/bin/env python3
"""DOGZILLA Pi-local sound cue bridge."""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


DEFAULT_CUES = {
    "thinking-start": [
        "robot-think-whimper-1.wav",
        "robot-think-whimper-2.wav",
        "robot-think-pant-1.wav",
    ],
    "confirm": [
        "robot-bark-synthetic.wav",
    ],
}


class AudioState:
    def __init__(self, sounds_dir: Path, player: str):
        self.sounds_dir = sounds_dir
        self.player = player
        self.last_cue = ""
        self.last_error = ""
        self.play_count = 0
        self.active_processes: list[subprocess.Popen] = []


class AudioHandler(BaseHTTPRequestHandler):
    server_version = "RoboDogeAudioCue/1.0"

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self.send_json(HTTPStatus.OK, health_payload(self.server.state))
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/cue":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        try:
            body = self.read_json()
            cue = str(body.get("cue", "")).strip()
            if not cue:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Missing cue"})
                return

            result = play_cue(self.server.state, cue)
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
        "soundsDir": str(state.sounds_dir),
        "availableCues": sorted(DEFAULT_CUES.keys()) + ["thinking-stop"],
        "lastCue": state.last_cue,
        "lastError": state.last_error,
        "playCount": state.play_count,
    }


def play_cue(state: AudioState, cue: str) -> dict[str, Any]:
    cleanup_processes(state)
    if cue == "thinking-stop":
        stop_active(state)
        state.last_cue = cue
        state.last_error = ""
        return {"ok": True, "cue": cue, "stopped": True}

    files = DEFAULT_CUES.get(cue)
    if not files:
        return {"ok": False, "cue": cue, "error": f"Unknown cue: {cue}"}

    player = resolve_player(state.player)
    if not player:
        return {"ok": False, "cue": cue, "error": f"Audio player not found: {state.player}"}

    sound_file = state.sounds_dir / random.choice(files)
    if not sound_file.exists():
        return {"ok": False, "cue": cue, "error": f"Sound file missing: {sound_file}"}

    if cue == "thinking-start":
        stop_active(state)

    try:
        process = subprocess.Popen(
            [player, "-q", str(sound_file)] if Path(player).name == "aplay" else [player, str(sound_file)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        state.active_processes.append(process)
        state.last_cue = cue
        state.last_error = ""
        state.play_count += 1
        return {"ok": True, "cue": cue, "file": str(sound_file), "pid": process.pid}
    except Exception as error:
        state.last_error = str(error)
        return {"ok": False, "cue": cue, "error": str(error)}


def stop_active(state: AudioState) -> None:
    for process in list(state.active_processes):
        if process.poll() is None:
            process.terminate()
    cleanup_processes(state)


def cleanup_processes(state: AudioState) -> None:
    state.active_processes = [process for process in state.active_processes if process.poll() is None]


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
    return parser


def main() -> int:
    args = build_parser().parse_args()
    state = AudioState(Path(args.sounds_dir), args.player)
    server = ThreadingHTTPServer((args.host, args.port), AudioHandler)
    server.state = state  # type: ignore[attr-defined]
    print(f"DOGZILLA audio cue bridge listening on http://{args.host}:{args.port}", flush=True)
    print(f"Sounds: {state.sounds_dir}", flush=True)
    print(f"Player: {resolve_player(state.player) or state.player}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
