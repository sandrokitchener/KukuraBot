from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_MAP_METADATA_FILE = Path(os.environ.get("DOGZILLA_MAP_METADATA_FILE", str(ROOT_DIR / "maps" / "robodoge_home_map.json")))
DEFAULT_MAP_YAML_FILE = Path(os.environ.get("DOGZILLA_MAP_YAML_FILE", str(ROOT_DIR / "maps" / "robodoge_home.yaml")))


def normalize_resume_pose(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or str(value.get("frame") or "").strip().lstrip("/") != "map":
        return None
    try:
        x = float(value["x"])
        y = float(value["y"])
        yaw = float(value["yaw"])
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(number) for number in (x, y, yaw)):
        return None
    captured_at = str(value.get("capturedAt") or "").strip()
    if not captured_at:
        return None
    return {"frame": "map", "x": x, "y": y, "yaw": yaw, "capturedAt": captured_at}


def read_active_map_metadata(
    metadata_path: Path = DEFAULT_MAP_METADATA_FILE,
    default_yaml_path: Path = DEFAULT_MAP_YAML_FILE,
) -> dict[str, Any]:
    info: dict[str, Any] = {}
    try:
        if metadata_path.exists():
            info = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return {
            "available": False,
            "metadataFile": str(metadata_path),
            "error": f"map_metadata_read_failed:{error}",
        }

    if not metadata_path.exists():
        return {
            "available": False,
            "metadataFile": str(metadata_path),
            "error": "active_map_manifest_missing",
        }

    artifacts = info.get("artifacts")
    if not isinstance(artifacts, dict):
        return {
            "available": False,
            "metadataFile": str(metadata_path),
            "error": "active_map_manifest_artifacts_missing",
        }

    artifact_paths: dict[str, Path] = {}
    for key in ("yaml", "pgm"):
        artifact = artifacts.get(key)
        if not isinstance(artifact, dict):
            return {"available": False, "metadataFile": str(metadata_path), "error": f"active_map_artifact_missing:{key}"}
        value = str(artifact.get("path") or info.get(key) or "").strip()
        expected_hash = str(artifact.get("sha256") or "").strip()
        path = Path(value)
        if not value or len(expected_hash) != 64:
            return {"available": False, "metadataFile": str(metadata_path), "error": f"active_map_artifact_manifest_invalid:{key}"}
        if not path.is_absolute():
            path = metadata_path.parent / path
        if not path.is_file() or sha256_file(path) != expected_hash:
            return {"available": False, "metadataFile": str(metadata_path), "error": f"active_map_artifact_hash_mismatch:{key}"}
        artifact_paths[key] = path

    pbstream = artifacts.get("pbstream")
    if isinstance(pbstream, dict):
        value = str(pbstream.get("path") or info.get("pbstream") or "").strip()
        expected_hash = str(pbstream.get("sha256") or "").strip()
        if value or expected_hash:
            path = Path(value)
            if not value or len(expected_hash) != 64:
                return {"available": False, "metadataFile": str(metadata_path), "error": "active_map_artifact_manifest_invalid:pbstream"}
            if not path.is_absolute():
                path = metadata_path.parent / path
            if not path.is_file() or sha256_file(path) != expected_hash:
                return {"available": False, "metadataFile": str(metadata_path), "error": "active_map_artifact_hash_mismatch:pbstream"}
            artifact_paths["pbstream"] = path

    yaml_path = artifact_paths["yaml"]
    try:
        yaml_info = read_ros_map_yaml(yaml_path)
        resolution = float(yaml_info["resolution"])
        origin = yaml_info["origin"]
        pgm_path = artifact_paths["pgm"]
        width_cells, height_cells = read_pgm_size(pgm_path)
        pbstream_path = artifact_paths.get("pbstream")
        files = {
            "yaml": file_identity(yaml_path),
            "pgm": file_identity(pgm_path),
        }
        if pbstream_path is not None and pbstream_path.exists():
            files["pbstream"] = file_identity(pbstream_path)
        fingerprint = hash_map_identity(files, resolution, origin, width_cells, height_cells)
        min_x = origin[0]
        min_y = origin[1]
        max_x = min_x + width_cells * resolution
        max_y = min_y + height_cells * resolution
        result = {
            "available": True,
            "id": str(info.get("id") or yaml_path.stem),
            "metadataFile": str(metadata_path),
            "yaml": str(yaml_path),
            "pgm": str(pgm_path),
            "pbstream": str(pbstream_path) if pbstream_path is not None else "",
            "savedAt": str(info.get("savedAt") or ""),
            "resolution": resolution,
            "origin": origin,
            "widthCells": width_cells,
            "heightCells": height_cells,
            "widthMeters": width_cells * resolution,
            "heightMeters": height_cells * resolution,
            "bounds": {
                "minX": min_x,
                "maxX": max_x,
                "minY": min_y,
                "maxY": max_y,
            },
            "fingerprint": fingerprint,
            "files": files,
        }
        resume_pose = normalize_resume_pose(info.get("resumePose"))
        if resume_pose:
            result["resumePose"] = resume_pose
        return result
    except (OSError, ValueError, KeyError) as error:
        return {
            "available": False,
            "metadataFile": str(metadata_path),
            "yaml": str(yaml_path),
            "error": f"map_metadata_invalid:{error}",
        }


def read_ros_map_yaml(path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if key == "image":
            result["image"] = value.strip("'\"")
        elif key == "resolution":
            result["resolution"] = float(value)
        elif key == "origin":
            result["origin"] = [float(part.strip()) for part in value.strip("[]").split(",")]
    if "origin" not in result:
        result["origin"] = [0.0, 0.0, 0.0]
    if len(result["origin"]) < 3:
        result["origin"] = [*result["origin"], 0.0][:3]
    return result


def read_pgm_size(path: Path) -> tuple[int, int]:
    tokens: list[bytes] = []
    with path.open("rb") as handle:
        while len(tokens) < 4:
            line = handle.readline()
            if not line:
                break
            stripped = line.strip()
            if not stripped or stripped.startswith(b"#"):
                continue
            tokens.extend(stripped.split())
    if len(tokens) < 4 or tokens[0] not in {b"P5", b"P2"}:
        raise ValueError(f"invalid PGM header in {path}")
    return int(tokens[1]), int(tokens[2])


def file_identity(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "path": str(path),
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "sha256": sha256_file(path),
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def hash_map_identity(files: dict[str, Any], resolution: float, origin: list[float], width: int, height: int) -> str:
    digest = hashlib.sha256()
    payload = {
        "files": {key: value.get("sha256") for key, value in sorted(files.items())},
        "resolution": resolution,
        "origin": origin,
        "width": width,
        "height": height,
    }
    digest.update(json.dumps(payload, sort_keys=True).encode("utf-8"))
    return digest.hexdigest()


def validate_goal_inside_active_map(
    frame: str,
    x: float,
    y: float,
    source_frame: str = "",
    metadata_path: Path = DEFAULT_MAP_METADATA_FILE,
    default_yaml_path: Path = DEFAULT_MAP_YAML_FILE,
) -> dict[str, Any]:
    metadata = read_active_map_metadata(metadata_path, default_yaml_path)
    if frame != "map":
        return {"ok": True, "map": metadata}
    if not metadata.get("available") or not isinstance(metadata.get("bounds"), dict):
        return {
            "ok": False,
            "reason": "map-metadata-unavailable",
            "map": metadata,
            "message": metadata.get("error") or "active map metadata unavailable",
        }
    bounds = metadata["bounds"]
    min_x = float(bounds["minX"])
    max_x = float(bounds["maxX"])
    min_y = float(bounds["minY"])
    max_y = float(bounds["maxY"])
    if x < min_x or x > max_x or y < min_y or y > max_y:
        return {
            "ok": False,
            "reason": "off-map",
            "map": metadata,
            "message": f"goal ({x:.2f}, {y:.2f}) outside active map bounds x {min_x:.2f}..{max_x:.2f}, y {min_y:.2f}..{max_y:.2f}",
        }
    return {"ok": True, "map": metadata}
