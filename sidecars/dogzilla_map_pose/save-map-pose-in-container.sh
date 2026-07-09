#!/usr/bin/env bash
set -eo pipefail

REMOTE_ROOT="${REMOTE_ROOT:-/home/pi/robodoge}"
ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-16}"
DOGZILLA_MAP_PBSTREAM="${DOGZILLA_MAP_PBSTREAM:-$REMOTE_ROOT/maps/robodoge_home.pbstream}"
DOGZILLA_MAP_RESOLUTION="${DOGZILLA_MAP_RESOLUTION:-0.05}"
DOGZILLA_MAP_METADATA="${DOGZILLA_MAP_METADATA:-$REMOTE_ROOT/maps/robodoge_home_map.json}"
export ROS_DOMAIN_ID

mkdir -p "$REMOTE_ROOT/maps" "$REMOTE_ROOT/logs"

# shellcheck disable=SC1091
source /opt/ros/humble/setup.bash
# shellcheck disable=SC1091
source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true

if ! ros2 service list | grep -qx "/write_state"; then
  echo "Cartographer /write_state service is not available. Start map-pose mapping/localization first." >&2
  exit 2
fi

MODE_FILE="$REMOTE_ROOT/maps/robodoge_map_pose_mode.json"
current_mode="$(python3 - "$MODE_FILE" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    print(json.loads(path.read_text(encoding="utf-8")).get("mode", ""))
except Exception:
    print("")
PY
)"

if [ "$current_mode" = "localization" ] && [ "${DOGZILLA_MAP_SAVE_ALLOW_LOCALIZATION:-0}" != "1" ]; then
  echo "Refusing to save map while Cartographer is in localization mode. Start SLAM mapping first, then save the new map." >&2
  exit 2
fi

map_id="${DOGZILLA_MAP_ID:-robodoge_home_$(date -u +%Y%m%dT%H%M%SZ)}"
map_stem="$REMOTE_ROOT/maps/$map_id"
target_pbstream="$map_stem.pbstream"
tmp_pbstream="$target_pbstream.tmp"
rm -f "$tmp_pbstream"

ros2 service call /write_state cartographer_ros_msgs/srv/WriteState \
  "{filename: '$tmp_pbstream', include_unfinished_submaps: true}" \
  > "$REMOTE_ROOT/logs/map-pose-save.log" 2>&1

if [ ! -s "$tmp_pbstream" ]; then
  echo "Cartographer did not write $tmp_pbstream" >&2
  cat "$REMOTE_ROOT/logs/map-pose-save.log" >&2 || true
  exit 2
fi

mv "$tmp_pbstream" "$target_pbstream"

conversion_status="skipped"
if command -v cartographer_pbstream_to_ros_map >/dev/null 2>&1; then
  cartographer_pbstream_to_ros_map \
    -pbstream_filename "$target_pbstream" \
    -map_filestem "$map_stem" \
    -resolution "$DOGZILLA_MAP_RESOLUTION" \
    >> "$REMOTE_ROOT/logs/map-pose-save.log" 2>&1 \
    && conversion_status="ok" \
    || conversion_status="error"
elif ros2 pkg executables cartographer_ros 2>/dev/null | grep -q "cartographer_pbstream_to_ros_map"; then
  ros2 run cartographer_ros cartographer_pbstream_to_ros_map \
    -pbstream_filename "$target_pbstream" \
    -map_filestem "$map_stem" \
    -resolution "$DOGZILLA_MAP_RESOLUTION" \
    >> "$REMOTE_ROOT/logs/map-pose-save.log" 2>&1 \
    && conversion_status="ok" \
    || conversion_status="error"
fi

if [ "$conversion_status" != "ok" ] || [ ! -s "$map_stem.yaml" ] || [ ! -s "$map_stem.pgm" ]; then
  echo "Cartographer saved $target_pbstream, but Nav2 map conversion did not produce $map_stem.yaml and $map_stem.pgm." >&2
  echo "Refusing to update $DOGZILLA_MAP_METADATA so the active default map stays unchanged." >&2
  cat "$REMOTE_ROOT/logs/map-pose-save.log" >&2 || true
  exit 2
fi

cp "$target_pbstream" "$REMOTE_ROOT/maps/robodoge_home.pbstream"
cp "$map_stem.yaml" "$REMOTE_ROOT/maps/robodoge_home.yaml"
cp "$map_stem.pgm" "$REMOTE_ROOT/maps/robodoge_home.pgm"

previous_metadata="$DOGZILLA_MAP_METADATA.previous"
if [ -s "$DOGZILLA_MAP_METADATA" ]; then
  cp "$DOGZILLA_MAP_METADATA" "$previous_metadata"
else
  rm -f "$previous_metadata"
fi

cat > "$DOGZILLA_MAP_METADATA" <<JSON
{
  "id": "$map_id",
  "pbstream": "$target_pbstream",
  "yaml": "$map_stem.yaml",
  "pgm": "$map_stem.pgm",
  "savedAt": "$(date -Iseconds)",
  "resolution": $DOGZILLA_MAP_RESOLUTION,
  "sourceMode": "${current_mode:-unknown}",
  "activeAlias": "robodoge_home",
  "rosMapConversion": "$conversion_status"
}
JSON

python3 - "$REMOTE_ROOT" "$previous_metadata" "$target_pbstream" "$map_stem.yaml" "$map_stem.pgm" <<'PY'
import json
import sys
from pathlib import Path

remote_root = Path(sys.argv[1])
metadata_path = Path(sys.argv[2])
keep = {str(Path(value).resolve()) for value in sys.argv[3:] if value}

try:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
except Exception:
    metadata = {}

for key in ("pbstream", "yaml", "pgm"):
    path = metadata.get(key)
    if not path:
        continue
    candidate = Path(path)
    if str(candidate.resolve()) not in keep:
        try:
            candidate.unlink(missing_ok=True)
        except OSError:
            pass

for candidate in (remote_root / "maps").glob("robodoge_home_*"):
    if candidate.suffix not in {".pbstream", ".yaml", ".pgm"}:
        continue
    if str(candidate.resolve()) in keep:
        continue
    try:
        candidate.unlink(missing_ok=True)
    except OSError:
        pass

(remote_root / "output" / "app-cache" / "dogzilla-map-origin.json").unlink(missing_ok=True)
metadata_path.unlink(missing_ok=True)
PY

printf '{"status":"ok","id":"%s","pbstream":"%s","yaml":"%s","rosMapConversion":"%s"}\n' "$map_id" "$target_pbstream" "$map_stem.yaml" "$conversion_status"
