# GPT Plan: Android Scan Backend, Processing, And Robot Load

## Mission

Implement server-side scan intake, temporary storage, map processing, robot delivery, and map-load verification for the Android scan flow.

Target flow:

```text
Server receives raw map -> saves raw temp files -> processes map -> saves processed temp files -> sends processed map to robot -> robot loads map for navigation
```

## Scope

Work on backend/server and robot deployment only. Do not build Android UI.

Likely files:

- `server.mjs`
- `lib/http-dogzilla-routes.mjs` or a small new route module
- `lib/dogzilla-connection-center.mjs`
- `scripts/*.ps1`
- `sidecars/dogzilla_map_pose/*.sh`
- `test/*.test.mjs`
- `docs/NAVIGATION.md`
- `docs/ANDROID_APP.md`

Reuse existing DOGZILLA map-save and localization patterns where possible.

## Android Contract To Satisfy

Implement:

```http
POST /api/android/scans/send-to-robot
Content-Type: multipart/form-data
```

Fields:

- `rawMap`: required uploaded file/blob
- `metadata`: required JSON string
- `preview`: optional uploaded image

Success response:

```json
{
  "ok": true,
  "sessionId": "scan_...",
  "state": "loaded",
  "map": {
    "fingerprint": "...",
    "widthCells": 0,
    "heightCells": 0,
    "resolution": 0.05
  }
}
```

Failure response:

```json
{
  "ok": false,
  "state": "failed",
  "error": "human-readable reason"
}
```

## Temp Storage

Use filesystem storage only. No database.

Base path:

```text
output/app-cache/android-scan-sessions/
```

Per-session layout:

```text
output/app-cache/android-scan-sessions/
  <sessionId>/
    manifest.json
    raw/
      map.raw
      metadata.json
      preview.png
    processed/
      map.yaml
      map.pgm
      map.pbstream optional
      metadata.json
```

`manifest.json` should track:

- `sessionId`
- `state`
- `createdAt`
- `raw`
- `processed`
- `error`
- `mapFingerprint`
- `robotLoadVerifiedAt`

Use a simple generated session id such as `scan_<timestamp>_<random>`.

## Processing Requirements

1. Validate upload:
   - `rawMap` exists and is non-empty.
   - `metadata` is valid JSON.
   - resolution, dimensions, origin, and frame are present or safely defaulted.

2. Save raw upload before processing:
   - Write raw file.
   - Write normalized `metadata.json`.
   - Write optional preview if provided.

3. Process raw map into robot-ready artifacts:
   - Produce at least `map.yaml` and `map.pgm`.
   - Produce `map.pbstream` only if scanner format supports it.
   - Produce processed `metadata.json`.

4. Validate processed artifacts:
   - YAML exists and points to PGM.
   - PGM exists and is non-empty.
   - resolution is positive.
   - width/height are positive.
   - fingerprint is computed from processed artifacts.

5. If processing fails, leave raw session folder for debugging and do not touch robot active map.

## Robot Delivery Requirements

1. Copy processed map to a robot staging path first.
2. Validate staged files on the robot before promotion.
3. Promote to active map only after staging validation passes.
4. Preserve previous active map if copy, validation, promotion, or reload fails.
5. Restart or reload localization/Nav2 map loading using existing DOGZILLA scripts and patterns.
6. Verify robot active map fingerprint matches processed session fingerprint.
7. Return `ok: true` only after fingerprint verification succeeds.

## Existing Behavior To Preserve

- Do not rewrite `config/robot-waypoints.json`.
- Do not silently mark old waypoints trusted for the new map.
- Do not add full occupancy-grid polling to default rosbridge topics.
- Do not start Nav2 from normal app startup paths.
- Keep operator-owned SLAM/New Map behavior separate from Android upload flow.

## Implementation Tasks

1. Add multipart request handling for `POST /api/android/scans/send-to-robot`.
2. Add small scan-session helper for:
   - create session folder
   - save raw upload
   - write manifest
   - update state/error
   - write processed artifacts
3. Add map processor function:
   - input: raw file path + metadata
   - output: processed artifact paths + normalized map metadata
4. Add processed-map validator.
5. Add robot staging/promote action.
6. Add active-map verification by fingerprint.
7. Add failure cleanup policy:
   - Keep failed session files.
   - Do not promote partial maps.
   - Do not delete previous active map.
8. Add focused tests for:
   - missing raw map
   - invalid metadata
   - processing failure
   - validation failure
   - robot send failure
   - successful process/send/load
9. Update docs:
   - `docs/ANDROID_APP.md`: backend receives Android scan and deploys robot map.
   - `docs/NAVIGATION.md`: Android-uploaded maps are separate from live SLAM Save Map, and waypoint trust must be rechecked.

## Acceptance Criteria

- Server accepts Android multipart scan upload.
- Raw map and metadata are saved under a temporary session folder.
- Processed map artifacts are saved under the same session folder.
- Server refuses invalid or empty processed maps.
- Robot active map is changed only after processed artifacts validate.
- Previous active map survives any failure.
- Success response includes session id and active map fingerprint.
- Tests cover happy path and failure paths.

## Do Not Do

- Do not build Android UI.
- Do not add a database.
- Do not rewrite waypoint config.
- Do not delete old active maps as part of this first pass.
- Do not mix this with desktop/web scan controls.
- Do not make normal app startup start or repair Nav2.
