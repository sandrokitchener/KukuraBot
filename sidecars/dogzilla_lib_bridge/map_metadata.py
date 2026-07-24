from __future__ import annotations

import base64
import hashlib
import json
import math
import os
from functools import lru_cache
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

    map_id = str(info.get("id") or "").strip()
    if not map_id:
        return {
            "available": False,
            "metadataFile": str(metadata_path),
            "error": "active_map_id_missing",
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
        yaml_image = str(yaml_info.get("image") or "").strip()
        if not yaml_image:
            return {
                "available": False,
                "metadataFile": str(metadata_path),
                "yaml": str(yaml_path),
                "error": "active_map_yaml_image_missing",
            }
        yaml_image_path = Path(yaml_image)
        if not yaml_image_path.is_absolute():
            yaml_image_path = yaml_path.parent / yaml_image_path
        pgm_path = artifact_paths["pgm"]
        if yaml_image_path.resolve() != pgm_path.resolve():
            return {
                "available": False,
                "metadataFile": str(metadata_path),
                "yaml": str(yaml_path),
                "pgm": str(pgm_path),
                "error": "active_map_yaml_image_mismatch",
            }
        resolution = float(yaml_info["resolution"])
        origin = yaml_info["origin"]
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
            "id": map_id,
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
        elif key == "negate":
            result["negate"] = int(value)
        elif key in {"occupied_thresh", "free_thresh"}:
            result[key] = float(value)
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


def _pgm_token(handle) -> bytes:
    token = bytearray()
    while True:
        char = handle.read(1)
        if not char:
            return bytes(token)
        if char == b"#" and not token:
            handle.readline()
            continue
        if char.isspace():
            if token:
                return bytes(token)
            continue
        token.extend(char)


def read_pgm_pixels(path: Path) -> tuple[int, int, int, bytes]:
    with path.open("rb") as handle:
        magic = _pgm_token(handle)
        width = int(_pgm_token(handle))
        height = int(_pgm_token(handle))
        maximum = int(_pgm_token(handle))
        if magic not in {b"P5", b"P2"} or width < 1 or height < 1 or not 0 < maximum <= 255:
            raise ValueError(f"invalid PGM header in {path}")
        pixels = handle.read(width * height) if magic == b"P5" else bytes(
            int(_pgm_token(handle)) for _ in range(width * height)
        )
    if len(pixels) != width * height:
        raise ValueError(f"truncated PGM data in {path}")
    return width, height, maximum, pixels


def _path_is_inside(path: Path, directory: Path) -> bool:
    try:
        path.resolve().relative_to(directory.resolve())
        return True
    except ValueError:
        return False


def _candidate_signature(metadata_path: Path, raw: dict[str, Any]) -> tuple[tuple[str, int, int], ...]:
    paths = [metadata_path]
    artifacts = raw.get("artifacts") if isinstance(raw.get("artifacts"), dict) else {}
    for key in ("yaml", "pgm", "pbstream"):
        artifact = artifacts.get(key) if isinstance(artifacts.get(key), dict) else {}
        value = str(artifact.get("path") or raw.get(key) or "").strip()
        if value:
            path = Path(value)
            paths.append(path if path.is_absolute() else metadata_path.parent / path)
    signature = []
    for path in paths:
        stat = path.stat()
        signature.append((str(path.resolve()), stat.st_size, stat.st_mtime_ns))
    return tuple(signature)


@lru_cache(maxsize=8)
def _read_candidate_occupancy_grid_cached(
    metadata_path_text: str,
    _signature: tuple[tuple[str, int, int], ...],
) -> dict[str, Any]:
    metadata_path = Path(metadata_path_text)
    raw = json.loads(metadata_path.read_text(encoding="utf-8"))
    if raw.get("state") != "candidate":
        raise ValueError("candidate manifest state is invalid")
    metadata = read_active_map_metadata(metadata_path)
    if metadata.get("available") is not True:
        raise ValueError(str(metadata.get("error") or "candidate map is not verified"))
    candidate_dir = metadata_path.parent
    if any(not _path_is_inside(Path(str(metadata.get(key) or "")), candidate_dir) for key in ("yaml", "pgm", "pbstream")):
        raise ValueError("candidate artifacts must stay inside their candidate directory")

    yaml_info = read_ros_map_yaml(Path(metadata["yaml"]))
    width, height, maximum, pixels = read_pgm_pixels(Path(metadata["pgm"]))
    negate = bool(int(yaml_info.get("negate", 0)))
    occupied_threshold = float(yaml_info.get("occupied_thresh", 0.65))
    free_threshold = float(yaml_info.get("free_thresh", 0.196))
    cells = bytearray()
    occupied = free = unknown = 0
    min_col, min_row, max_col, max_row = width, height, -1, -1
    for row in range(height - 1, -1, -1):
        for col in range(width):
            pixel = pixels[row * width + col]
            probability = pixel / maximum if negate else (maximum - pixel) / maximum
            if probability > occupied_threshold:
                cell = 100
                occupied += 1
            elif probability < free_threshold:
                cell = 0
                free += 1
            else:
                cell = 255
                unknown += 1
            cells.append(cell)
            if cell != 255:
                grid_row = height - 1 - row
                min_col, min_row = min(min_col, col), min(min_row, grid_row)
                max_col, max_row = max(max_col, col), max(max_row, grid_row)

    resolution = float(metadata["resolution"])
    origin_x, origin_y, origin_yaw = (float(value) for value in metadata["origin"][:3])
    result = {
        "ok": True,
        "status": "ok",
        "source": "candidate",
        "candidateId": metadata["id"],
        "width": width,
        "height": height,
        "resolution": resolution,
        "origin": {"x": origin_x, "y": origin_y, "yaw": origin_yaw, "theta": origin_yaw},
        "cells": base64.b64encode(cells).decode("ascii"),
        "cellCount": len(cells),
        "widthMeters": round(width * resolution, 3),
        "heightMeters": round(height * resolution, 3),
        "frameId": "map",
        "topic": "candidate-file",
        "occupiedCount": occupied,
        "freeCount": free,
        "unknownCount": unknown,
        "savedAt": metadata.get("savedAt") or "",
        "fingerprint": metadata.get("fingerprint") or "",
    }
    if max_col >= 0:
        result["bbox"] = {
            "minX": round(origin_x + min_col * resolution, 3),
            "minY": round(origin_y + min_row * resolution, 3),
            "maxX": round(origin_x + (max_col + 1) * resolution, 3),
            "maxY": round(origin_y + (max_row + 1) * resolution, 3),
        }
    return result


def read_latest_candidate_occupancy_grid(maps_dir: Path) -> dict[str, Any]:
    errors: list[str] = []
    metadata_paths = list_unpromoted_candidate_metadata(maps_dir)
    for metadata_path in metadata_paths:
        try:
            raw = json.loads(metadata_path.read_text(encoding="utf-8"))
            return _read_candidate_occupancy_grid_cached(
                str(metadata_path.resolve()),
                _candidate_signature(metadata_path, raw),
            )
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
            errors.append(f"{metadata_path.parent.name}:{error}")
    return {
        "ok": False,
        "status": "no-candidate",
        "error": errors[0] if errors else "No saved candidate map is available.",
    }


def list_unpromoted_candidate_metadata(maps_dir: Path) -> list[Path]:
    active_metadata = maps_dir / "robodoge_home_map.json"
    active_mtime = active_metadata.stat().st_mtime_ns if active_metadata.is_file() else -1
    return sorted(
        (
            path for path in (maps_dir / "candidates").glob("*/candidate.json")
            if path.stat().st_mtime_ns > active_mtime
        ),
        key=lambda path: path.stat().st_mtime_ns,
        reverse=True,
    )


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
    map_id: str = "",
    map_fingerprint: str = "",
) -> dict[str, Any]:
    metadata = read_active_map_metadata(metadata_path, default_yaml_path)
    if frame != "map":
        return {"ok": True, "map": metadata}
    waypoint_identity = {
        "id": str(map_id or "").strip(),
        "fingerprint": str(map_fingerprint or "").strip(),
    }
    if not metadata.get("available") or not isinstance(metadata.get("bounds"), dict):
        return {
            "ok": False,
            "reason": "map-metadata-unavailable",
            "map": metadata,
            "waypointIdentity": waypoint_identity,
            "message": metadata.get("error") or "active map metadata unavailable",
        }
    active_identity = {
        "id": str(metadata.get("id") or "").strip(),
        "fingerprint": str(metadata.get("fingerprint") or "").strip(),
    }
    if not all(waypoint_identity.values()):
        return {
            "ok": False,
            "reason": "map-identity-missing",
            "map": metadata,
            "waypointIdentity": waypoint_identity,
            "message": "waypoint map identity is required; both mapId and mapFingerprint must be present",
        }
    if not all(active_identity.values()):
        return {
            "ok": False,
            "reason": "map-identity-missing",
            "map": metadata,
            "waypointIdentity": waypoint_identity,
            "message": "active map identity is required; both id and fingerprint must be present",
        }
    if waypoint_identity["id"] != active_identity["id"]:
        return {
            "ok": False,
            "reason": "map-id-mismatch",
            "map": metadata,
            "waypointIdentity": waypoint_identity,
            "message": f'waypoint map id "{waypoint_identity["id"]}" does not match active map id "{active_identity["id"]}"',
        }
    if waypoint_identity["fingerprint"] != active_identity["fingerprint"]:
        return {
            "ok": False,
            "reason": "map-fingerprint-mismatch",
            "map": metadata,
            "waypointIdentity": waypoint_identity,
            "message": "waypoint map fingerprint does not match the active map fingerprint",
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
            "waypointIdentity": waypoint_identity,
            "message": f"goal ({x:.2f}, {y:.2f}) outside active map bounds x {min_x:.2f}..{max_x:.2f}, y {min_y:.2f}..{max_y:.2f}",
        }
    return {
        "ok": True,
        "reason": "map-identity-match",
        "map": metadata,
        "waypointIdentity": waypoint_identity,
    }
