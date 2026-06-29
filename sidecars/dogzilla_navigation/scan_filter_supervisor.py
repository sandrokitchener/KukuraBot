#!/usr/bin/env python3
"""Supervisor for the DOGZILLA scan self-filter.

Monitors the ``/scan_nav2`` topic and auto-restarts the
``scan_self_filter.py`` process when publishers disappear.  Uses exponential
backoff (capped at 60 s) after repeated restart failures, so the supervisor
never permanently gives up.

Usage::

    python3 scan_filter_supervisor.py \
        --filter-script <path> \
        --input-topic /scan \
        --output-topic /scan_nav2 \
        --check-interval 3 \
        --max-restarts 5
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import threading
import time
from typing import Optional


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Supervisor for DOGZILLA scan self-filter.")
    parser.add_argument("--filter-script", required=True, help="Path to scan_self_filter.py")
    parser.add_argument("--input-topic", default="/scan")
    parser.add_argument("--output-topic", default="/scan_nav2")
    parser.add_argument("--mask-start-deg", type=float, default=135.0)
    parser.add_argument("--mask-end-deg", type=float, default=255.0)
    parser.add_argument("--mask-range-m", type=float, default=0.35)
    parser.add_argument("--check-interval", type=float, default=10.0, help="Seconds between publisher checks")
    parser.add_argument("--max-restarts", type=int, default=5, help="Max consecutive restarts before giving up")
    parser.add_argument("--restart-cooldown", type=float, default=10.0, help="Seconds to wait after a restart before checking again")
    parser.add_argument("--remote-root", default=os.environ.get("REMOTE_ROOT", "/home/pi/robodoge"))
    parser.add_argument("--log-file", default="", help="Path to supervisor log file (default: stderr only)")
    return parser.parse_args(argv)


def log(message: str, log_file: str = "") -> None:
    line = f"[scan-supervisor] {message}"
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


def start_stderr_drain(proc: subprocess.Popen, buffer: list[str]) -> threading.Thread:
    """Start a daemon thread that drains stderr from the child process into *buffer*."""
    def _drain() -> None:
        try:
            for line in iter(proc.stderr.readline, b""):
                if isinstance(line, bytes):
                    line = line.decode("utf-8", errors="replace")
                buffer.append(line)
        except (ValueError, OSError):
            pass

    t = threading.Thread(target=_drain, daemon=True)
    t.start()
    return t


def start_filter(args: argparse.Namespace) -> subprocess.Popen:
    """Start the scan_self_filter.py process."""
    cmd = [
        sys.executable,
        args.filter_script,
        "--input-topic", args.input_topic,
        "--output-topic", args.output_topic,
        "--mask-start-deg", str(args.mask_start_deg),
        "--mask-end-deg", str(args.mask_end_deg),
        "--mask-range-m", str(args.mask_range_m),
    ]
    log_file = os.path.join(args.remote_root, "logs", "scan-self-filter.log") if args.remote_root else ""
    proc = subprocess.Popen(
        cmd,
        stdout=open(log_file, "a") if log_file else subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        preexec_fn=os.setpgrp if hasattr(os, "setpgrp") else None,
    )
    log(f"Started scan filter (pid={proc.pid})")
    return proc


def terminate_filter(proc: subprocess.Popen) -> None:
    """Terminate a filter process gracefully, then force-kill if needed."""
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
    log_file = args.log_file

    log("Starting scan filter supervisor", log_file)
    log(f"  input={args.input_topic} output={args.output_topic} check={args.check_interval}s max_restarts={args.max_restarts}", log_file)

    proc = start_filter(args)
    last_stderr: list[str] = []
    _stderr_drain = start_stderr_drain(proc, last_stderr)
    consecutive_restarts = 0
    last_restart_time = 0.0

    def collect_stderr() -> str:
        if not last_stderr:
            return ""
        text = "".join(last_stderr).strip()
        last_stderr.clear()
        return text

    def backoff_delay(attempt: int) -> float:
        """Exponential backoff capped at 60s: 10, 20, 40, 60, 60, ..."""
        delay = min(args.restart_cooldown * (2 ** (attempt - args.max_restarts)), 60.0)
        return max(delay, 1.0)

    try:
        while True:
            time.sleep(args.check_interval)

            # Check if the filter process is still alive
            if proc.poll() is not None:
                exit_code = proc.returncode
                stderr_text = collect_stderr()
                reason = f"code={exit_code}"
                if stderr_text:
                    reason += f" stderr={stderr_text}"
                log(f"Scan filter exited ({reason})", log_file)

                consecutive_restarts += 1
                if consecutive_restarts >= args.max_restarts:
                    delay = backoff_delay(consecutive_restarts)
                    log(
                        f"Scan filter crashed {consecutive_restarts} times; "
                        f"entering backoff (sleep {delay:.0f}s before retry)",
                        log_file,
                    )
                    time.sleep(delay)
                else:
                    log(f"Restarting scan filter (attempt {consecutive_restarts}/{args.max_restarts})", log_file)
                    if args.restart_cooldown > 0:
                        time.sleep(args.restart_cooldown)
                proc = start_filter(args)
                last_stderr.clear()
                _stderr_drain = start_stderr_drain(proc, last_stderr)
                last_restart_time = time.monotonic()
                continue

            # Check publisher count on the output topic
            pub_count = check_publisher_count(args.output_topic)
            if pub_count > 0:
                # Reset consecutive restart counter after a stable period (30s)
                if consecutive_restarts > 0 and (time.monotonic() - last_restart_time) > 30.0:
                    consecutive_restarts = 0
                continue

            # No publishers — filter may have stalled or input stopped
            log(f"No publishers on {args.output_topic} (filter still alive pid={proc.pid})", log_file)

            # Give it a grace period — the input /scan might just be temporarily silent
            time.sleep(2.0)
            pub_count = check_publisher_count(args.output_topic)
            if pub_count > 0:
                continue

            # Filter is alive but not publishing — treat as hard child failure
            stderr_text = collect_stderr()
            reason = f"alive-but-not-publishing"
            if stderr_text:
                reason += f" stderr={stderr_text}"
            log(f"Scan filter stalled ({reason}); restarting", log_file)
            terminate_filter(proc)
            consecutive_restarts += 1
            if consecutive_restarts >= args.max_restarts:
                delay = backoff_delay(consecutive_restarts)
                log(
                    f"Scan filter restarted {consecutive_restarts} times; "
                    f"entering backoff (sleep {delay:.0f}s before retry)",
                    log_file,
                )
                time.sleep(delay)
            else:
                log(f"Restarting scan filter (attempt {consecutive_restarts}/{args.max_restarts})", log_file)
                if args.restart_cooldown > 0:
                    time.sleep(args.restart_cooldown)
            proc = start_filter(args)
            last_stderr.clear()
            _stderr_drain = start_stderr_drain(proc, last_stderr)
            last_restart_time = time.monotonic()

    except KeyboardInterrupt:
        log("Shutting down scan filter supervisor", log_file)
    finally:
        terminate_filter(proc)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
