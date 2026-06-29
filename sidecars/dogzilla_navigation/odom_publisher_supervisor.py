#!/usr/bin/env python3
"""Supervisor for the DOGZILLA tf_odom_publisher.

Monitors the ``/odom`` topic and auto-restarts the ``tf_odom_publisher.py``
process when publishers disappear or the process dies.

Usage::

    python3 odom_publisher_supervisor.py \
        --publisher-script <path> \
        --odom-topic /odom \
        --odom-frame odom \
        --base-frame base_link \
        --check-interval 5
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from typing import Optional


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Supervisor for DOGZILLA tf_odom_publisher.")
    parser.add_argument("--publisher-script", required=True, help="Path to tf_odom_publisher.py")
    parser.add_argument("--odom-topic", default="/odom")
    parser.add_argument("--odom-frame", default="odom")
    parser.add_argument("--base-frame", default="base_link")
    parser.add_argument("--check-interval", type=float, default=5.0, help="Seconds between checks")
    parser.add_argument("--max-restarts", type=int, default=10, help="Max consecutive restarts before giving up")
    parser.add_argument("--startup-grace-sec", type=float, default=20.0, help="Seconds before first publisher check (DDS/TF propagation)")
    parser.add_argument("--remote-root", default=os.environ.get("REMOTE_ROOT", "/home/pi/robodoge"))
    return parser.parse_args(argv)


def log(message: str, log_file: str = "") -> None:
    line = f"[odom-supervisor] {message}"
    if log_file:
        try:
            with open(log_file, "a") as f:
                f.write(line + "\n")
        except OSError:
            pass
    print(line, flush=True)


def check_publisher_count(topic: str) -> int:
    """Check the number of publishers on a ROS 2 topic via ``ros2 topic info``."""
    try:
        result = subprocess.run(
            ["ros2", "topic", "info", topic],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        for line in result.stdout.splitlines():
            if "Publisher count:" in line:
                parts = line.split(":")
                if len(parts) >= 2:
                    return int(parts[1].strip())
    except (subprocess.TimeoutExpired, ValueError, OSError):
        pass
    return 0


def start_publisher(args: argparse.Namespace) -> subprocess.Popen:
    """Start the tf_odom_publisher.py process."""
    cmd = [
        sys.executable,
        args.publisher_script,
        "--odom-frame", args.odom_frame,
        "--base-frame", args.base_frame,
        "--topic", args.odom_topic,
    ]
    log_file = os.path.join(args.remote_root, "logs", "tf-odom-publisher.log") if args.remote_root else ""
    proc = subprocess.Popen(
        cmd,
        stdout=open(log_file, "a") if log_file else subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        preexec_fn=os.setpgrp if hasattr(os, "setpgrp") else None,
    )
    log(f"Started odom publisher (pid={proc.pid})")
    return proc


def terminate_publisher(proc: subprocess.Popen) -> None:
    """Terminate a publisher process gracefully, then force-kill if needed."""
    try:
        if proc.poll() is None:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                proc.wait(timeout=2)
    except (OSError, ProcessLookupError):
        try:
            proc.kill()
        except (OSError, ProcessLookupError):
            pass


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    log_file = os.path.join(args.remote_root, "logs", "odom-supervisor.log") if args.remote_root else ""

    log("Starting odom publisher supervisor", log_file)
    log(f"  topic={args.odom_topic} frame={args.odom_frame}->{args.base_frame} check={args.check_interval}s", log_file)

    proc = start_publisher(args)
    consecutive_restarts = 0
    pid_epoch = time.monotonic()

    try:
        while True:
            time.sleep(args.check_interval)

            # Check if the publisher process is still alive
            if proc.poll() is not None:
                exit_code = proc.returncode
                log(f"Odom publisher exited (code={exit_code})", log_file)
                consecutive_restarts += 1
                if consecutive_restarts >= args.max_restarts:
                    log(f"Odom publisher crashed {args.max_restarts} times consecutively; giving up", log_file)
                    break
                log(f"Restarting odom publisher (attempt {consecutive_restarts}/{args.max_restarts})", log_file)
                proc = start_publisher(args)
                pid_epoch = time.monotonic()
                continue

            # Skip publisher count checks during startup/restart grace period
            # DDS discovery and TF propagation can take 10-20s between containers
            elapsed = time.monotonic() - pid_epoch
            if elapsed < args.startup_grace_sec:
                continue

            # Check publisher count on the odom topic
            pub_count = check_publisher_count(args.odom_topic)
            if pub_count > 0:
                if consecutive_restarts > 0 and elapsed > 60.0:
                    consecutive_restarts = 0
                continue

            # No publishers — publisher may have stalled
            log(f"No publishers on {args.odom_topic} (publisher still alive pid={proc.pid})", log_file)

            # Give it a grace period — TF discovery might just be slow
            time.sleep(3.0)
            pub_count = check_publisher_count(args.odom_topic)
            if pub_count > 0:
                continue

            # Publisher is alive but not publishing — restart it
            log("Odom publisher stalled (alive but not publishing); restarting", log_file)
            terminate_publisher(proc)
            consecutive_restarts += 1
            if consecutive_restarts >= args.max_restarts:
                log(f"Odom publisher restarted {args.max_restarts} times; giving up", log_file)
                break
            proc = start_publisher(args)
            pid_epoch = time.monotonic()

    except KeyboardInterrupt:
        log("Shutting down odom publisher supervisor", log_file)
    finally:
        terminate_publisher(proc)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
