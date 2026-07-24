#!/usr/bin/env python3
"""Select the newest verified mapping source without promoting a candidate."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any


def _is_inside(path: Path, directory: Path) -> bool:
    try:
        path.resolve().relative_to(directory.resolve())
        return True
    except ValueError:
        return False


def _read_verified_map(metadata_path: Path, validator_dir: Path) -> dict[str, Any] | None:
    sys.path.insert(0, str(validator_dir))
    try:
        from map_metadata import read_active_map_metadata
    finally:
        sys.path.pop(0)

    result = read_active_map_metadata(metadata_path)
    return result if result.get("available") is True and result.get("pbstream") else None


def _read_verified_candidate(metadata_path: Path, validator_dir: Path) -> dict[str, Any] | None:
    try:
        raw = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if raw.get("state") != "candidate":
        return None
    verified = _read_verified_map(metadata_path, validator_dir)
    if verified is None:
        return None
    candidate_dir = metadata_path.parent.resolve()
    for key in ("yaml", "pgm", "pbstream"):
        value = str(verified.get(key) or "").strip()
        if not value or not _is_inside(Path(value), candidate_dir):
            return None
    return verified


def select_resume_map(remote_root: Path, source: str = "auto") -> dict[str, Any]:
    maps_dir = remote_root / "maps"
    validator_dir = remote_root / "sidecars" / "dogzilla_lib_bridge"
    active_metadata = maps_dir / "robodoge_home_map.json"
    active = _read_verified_map(active_metadata, validator_dir)
    active_mtime = active_metadata.stat().st_mtime if active is not None else float("-inf")

    candidates: list[tuple[float, Path, dict[str, Any]]] = []
    for metadata_path in (maps_dir / "candidates").glob("*/candidate.json"):
        verified = _read_verified_candidate(metadata_path, validator_dir)
        if verified is not None:
            candidates.append((metadata_path.stat().st_mtime, metadata_path, verified))

    if source == "active":
        if active is None:
            raise RuntimeError("The active map is not hash-verified and cannot be extended.")
        return {
            "source": "active",
            "id": active.get("id"),
            "metadata": str(active_metadata.resolve()),
            "pbstream": str(Path(active["pbstream"]).resolve()),
            "savedAt": active.get("savedAt"),
        }

    if candidates:
        candidate_mtime, metadata_path, candidate = max(candidates, key=lambda item: item[0])
        if active is None or candidate_mtime > active_mtime:
            return {
                "source": "candidate",
                "id": candidate.get("id"),
                "metadata": str(metadata_path.resolve()),
                "pbstream": str(Path(candidate["pbstream"]).resolve()),
                "savedAt": candidate.get("savedAt"),
            }

    if source == "candidate":
        raise RuntimeError("No hash-verified draft map newer than the active map is available to resume.")

    if active is None:
        raise RuntimeError("No hash-verified active map or newer candidate is available to resume.")
    return {
        "source": "active",
        "id": active.get("id"),
        "metadata": str(active_metadata.resolve()),
        "pbstream": str(Path(active["pbstream"]).resolve()),
        "savedAt": active.get("savedAt"),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--remote-root", default="/home/pi/robodoge")
    parser.add_argument("--source", choices=("auto", "active", "candidate"), default="auto")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        print(json.dumps(select_resume_map(Path(args.remote_root), args.source), sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
