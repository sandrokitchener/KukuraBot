#!/usr/bin/env bash
set -Eeuo pipefail

REMOTE_ROOT="${REMOTE_ROOT:-/home/pi/robodoge}"
CANDIDATE_ID="${DOGZILLA_MAP_CANDIDATE_ID:-}"
MAPS_DIR="$REMOTE_ROOT/maps"

if [ -z "$CANDIDATE_ID" ]; then
  CANDIDATE_ID="$(find "$MAPS_DIR/candidates" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort | tail -n 1)"
fi
if ! [[ "$CANDIDATE_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "Candidate id is missing or invalid." >&2
  exit 2
fi

candidate_dir="$MAPS_DIR/candidates/$CANDIDATE_ID"
candidate_metadata="$candidate_dir/candidate.json"
if [ ! -s "$candidate_metadata" ]; then
  echo "Candidate metadata missing: $candidate_metadata" >&2
  exit 2
fi

stage_dir="$(mktemp -d "$MAPS_DIR/.candidate-promotion-${CANDIDATE_ID}.XXXXXX")"
backup_dir="$MAPS_DIR/.promotion-backups/$(date -u +%Y%m%dT%H%M%SZ)-$CANDIDATE_ID"
activation_started=0
promotion_complete=0

restore_active_map() {
  if [ "$activation_started" != "1" ] || [ "$promotion_complete" = "1" ]; then
    return
  fi
  echo "Candidate promotion failed during activation; restoring previous active map." >&2
  for name in robodoge_home.pbstream robodoge_home.yaml robodoge_home.pgm robodoge_home_map.json; do
    rm -f "$MAPS_DIR/$name"
    if [ -e "$backup_dir/$name" ]; then
      cp -a "$backup_dir/$name" "$MAPS_DIR/$name"
    fi
  done
}

cleanup() {
  restore_active_map
  rm -rf "$stage_dir"
}
trap cleanup EXIT

python3 - "$candidate_metadata" "$candidate_dir" "$stage_dir" "$MAPS_DIR" "$CANDIDATE_ID" <<'PY'
import json
import re
import shutil
import sys
import hashlib
from datetime import datetime, timezone
from pathlib import Path

metadata_path, candidate_dir, stage_dir, maps_dir = map(Path, sys.argv[1:5])
candidate_id = sys.argv[5]
candidate_dir = candidate_dir.resolve()
stage_dir = stage_dir.resolve()
maps_dir = maps_dir.resolve()

try:
    candidate = json.loads(metadata_path.read_text(encoding="utf-8"))
except Exception as error:
    raise SystemExit(f"Candidate metadata is invalid: {error}")

def candidate_file(key: str) -> Path:
    value = candidate.get(key)
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(f"Candidate metadata missing {key}")
    path = Path(value)
    if not path.is_absolute():
        path = candidate_dir / path
    try:
        path = path.resolve(strict=True)
        path.relative_to(candidate_dir)
    except (OSError, ValueError) as error:
        raise SystemExit(f"Candidate {key} must resolve inside {candidate_dir}: {error}")
    if not path.is_file() or path.stat().st_size == 0:
        raise SystemExit(f"Candidate {key} is missing or empty: {path}")
    expected_hash = ((candidate.get("artifacts") or {}).get(key) or {}).get("sha256")
    if not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
        raise SystemExit(f"Candidate metadata missing SHA-256 for {key}")
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
        raise SystemExit(f"Candidate {key} SHA-256 mismatch")
    return path

pbstream = candidate_file("pbstream")
yaml = candidate_file("yaml")
pgm = candidate_file("pgm")

shutil.copy2(pbstream, stage_dir / "robodoge_home.pbstream")
shutil.copy2(pgm, stage_dir / "robodoge_home.pgm")
yaml_text = yaml.read_text(encoding="utf-8")
rewritten_yaml, image_count = re.subn(
    r"(?m)^(\s*image\s*:\s*).*$",
    r"\1robodoge_home.pgm",
    yaml_text,
)
if image_count != 1:
    raise SystemExit(f"Candidate YAML must contain exactly one image entry; found {image_count}")
(stage_dir / "robodoge_home.yaml").write_text(rewritten_yaml, encoding="utf-8")

active_metadata = dict(candidate)
active_metadata.update({
    "id": str(candidate.get("id") or candidate_id),
    "candidateId": candidate_id,
    "pbstream": str(maps_dir / "robodoge_home.pbstream"),
    "yaml": str(maps_dir / "robodoge_home.yaml"),
    "pgm": str(maps_dir / "robodoge_home.pgm"),
    "activeAlias": "robodoge_home",
    "promotedAt": datetime.now(timezone.utc).isoformat(),
    "state": "active",
})
active_metadata["artifacts"] = {
    key: {"path": str(maps_dir / name), "sha256": hashlib.sha256((stage_dir / name).read_bytes()).hexdigest()}
    for key, name in (("pbstream", "robodoge_home.pbstream"), ("yaml", "robodoge_home.yaml"), ("pgm", "robodoge_home.pgm"))
}
(stage_dir / "robodoge_home_map.json").write_text(
    json.dumps(active_metadata, indent=2) + "\n", encoding="utf-8"
)

if not re.search(r"(?m)^\s*image\s*:\s*robodoge_home\.pgm\s*$", rewritten_yaml):
    raise SystemExit("Staged YAML does not reference robodoge_home.pgm")
for name in ("robodoge_home.pbstream", "robodoge_home.pgm", "robodoge_home.yaml"):
    path = stage_dir / name
    if not path.is_file() or path.stat().st_size == 0:
        raise SystemExit(f"Staged map artifact is missing or empty: {path}")
verified = json.loads((stage_dir / "robodoge_home_map.json").read_text(encoding="utf-8"))
for key, name in (("pbstream", "robodoge_home.pbstream"), ("yaml", "robodoge_home.yaml"), ("pgm", "robodoge_home.pgm")):
    if verified.get(key) != str(maps_dir / name):
        raise SystemExit(f"Staged metadata {key} does not point to active alias")
PY

mkdir -p "$backup_dir"
for name in robodoge_home.pbstream robodoge_home.yaml robodoge_home.pgm robodoge_home_map.json; do
  if [ -e "$MAPS_DIR/$name" ]; then
    cp -a "$MAPS_DIR/$name" "$backup_dir/$name"
  fi
done

activation_started=1
for name in robodoge_home.pbstream robodoge_home.yaml robodoge_home.pgm robodoge_home_map.json; do
  mv "$stage_dir/$name" "$MAPS_DIR/$name"
done

rm -f "$REMOTE_ROOT/output/app-cache/dogzilla-map-origin.json"
rm -f "$MAPS_DIR/autonomous-mapping-result.json"
promotion_complete=1
printf '{"status":"ok","id":"%s","state":"active"}\n' "$CANDIDATE_ID"
