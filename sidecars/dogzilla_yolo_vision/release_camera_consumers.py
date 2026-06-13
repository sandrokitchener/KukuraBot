#!/usr/bin/env python3
"""Release DOGZILLA camera consumers before YOLO takes exclusive capture."""

from __future__ import annotations

import argparse
import glob
import os
import signal
import subprocess
import time
from pathlib import Path


DESKTOP_CAMERA_CONSUMERS = {"pipewire", "wireplumber"}
VENDOR_CAMERA_PATTERN = "/home/pi/DOGZILLA/app_dogzilla/app_dogzilla.py"


def main() -> int:
    args = build_parser().parse_args()
    camera_source = resolve_camera_source(args.camera_source)
    camera_realpath = os.path.realpath(camera_source) if camera_source else ""

    stopped: list[str] = []
    stopped.extend(stop_vendor_camera_app())
    if camera_realpath:
        stopped.extend(stop_desktop_camera_consumers(camera_realpath))

    if stopped:
        time.sleep(args.settle_seconds)
        for item in stopped:
            print(item, flush=True)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Release processes that hold the DOGZILLA camera device.")
    parser.add_argument("--camera-source", default=os.getenv("DOGZILLA_YOLO_CAMERA_URL", "auto"))
    parser.add_argument("--settle-seconds", type=float, default=1.0)
    return parser


def stop_vendor_camera_app() -> list[str]:
    stopped: list[str] = []
    for row in pgrep(VENDOR_CAMERA_PATTERN):
        pid = parse_pid(row)
        if not pid or pid in (os.getpid(), os.getppid()):
            continue
        if terminate_pid(pid):
            stopped.append(f"stopped vendor camera app {pid}")
    return stopped


def stop_desktop_camera_consumers(camera_realpath: str) -> list[str]:
    stopped: list[str] = []
    for pid_dir in Path("/proc").iterdir():
        if not pid_dir.name.isdigit():
            continue
        pid = int(pid_dir.name)
        if pid in (os.getpid(), os.getppid()):
            continue
        comm = read_text(pid_dir / "comm")
        if comm not in DESKTOP_CAMERA_CONSUMERS:
            continue
        if not process_holds_path(pid_dir, camera_realpath):
            continue
        if terminate_pid(pid):
            stopped.append(f"stopped camera desktop consumer {comm} {pid}")
    return stopped


def process_holds_path(pid_dir: Path, realpath: str) -> bool:
    fd_dir = pid_dir / "fd"
    try:
        fd_names = os.listdir(fd_dir)
    except OSError:
        return False
    for fd_name in fd_names:
        try:
            target = os.path.realpath(os.readlink(fd_dir / fd_name))
        except OSError:
            continue
        if target == realpath:
            return True
    return False


def terminate_pid(pid: int) -> bool:
    try:
        os.kill(pid, signal.SIGTERM)
        return True
    except ProcessLookupError:
        return False
    except PermissionError as error:
        print(f"could not stop pid {pid}: {error}", flush=True)
        return False


def pgrep(pattern: str) -> list[str]:
    try:
        return subprocess.check_output(["pgrep", "-af", pattern], text=True).splitlines()
    except subprocess.CalledProcessError:
        return []


def parse_pid(row: str) -> int | None:
    try:
        return int(row.split()[0])
    except (IndexError, ValueError):
        return None


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def resolve_camera_source(source: str) -> str:
    if source != "auto":
        return source
    for pattern in ("/dev/v4l/by-id/*video-index0", "/dev/video0", "/dev/video1", "/dev/video2", "/dev/video3"):
        for candidate in sorted(glob.glob(pattern)):
            if os.path.exists(candidate):
                return candidate
    return "/dev/video0"


if __name__ == "__main__":
    raise SystemExit(main())
