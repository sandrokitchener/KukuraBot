# Robo-Doge Agent Instructions

## DOGZILLA / Yahboom Source Of Truth

- For DOGZILLA robot behavior, navigation, LiDAR, mapping, patrol, obstacle avoidance, and waypoint work, check `C:\Users\sandr\OneDrive\Documents\Robo-Doge\docs\DOGZILLA-main` before inventing a new approach.
- Treat the local Yahboom PDFs under `C:\Users\sandr\OneDrive\Documents\Robo-Doge\docs\DOGZILLA-main\14.Lidar course` as the first source of truth for how Yahboom expects the robot stack to be started and used.
- For LiDAR/navigation tasks, review the relevant PDFs first, especially:
  - `1. Introduction and use of radar.pdf`
  - `2. Obstacle avoidance.pdf`
  - `3.Lidar Tracking.pdf`
  - `4.Lidar guard.pdf`
  - `5. Patrol.pdf`
  - `Get robot dog joint data.pdf`
  - `Robot dog mapping.pdf`
  - `Robot Dog Navigation.pdf`
- Try the documented Yahboom flow before adding repo-specific workarounds, fallback sidecars, custom launch glue, or guessed ROS wiring.
- If the documented flow fails, capture the exact command, error, and runtime state, then make the smallest repo change needed to bridge from Yahboom's intended workflow to this app.
- For LiDAR scope, stay on the DOGZILLA HAT UART path (`/dev/ttyAMA1`) unless the user explicitly changes the hardware target.

## DOGZILLA Waypoint Config Authority

- Treat `config/robot-waypoints.json` as the absolute source of truth for waypoint coordinates and trust fields.
- If coordinates or verification/trust fields are present in the JSON config, agents must treat those config values as true unless the user explicitly says otherwise.
- Diagnostics may warn about map identity, notes, fingerprints, bounds, or drift, but must not override, downgrade, rewrite, disable, or "correct" configured coordinates or trust state without explicit user instruction.

## app_map Frame Waypoint System (Path B)

Waypoints are stored in `app_map` frame (not raw `map` frame) to decouple from Cartographer's ephemeral origin.

### How it works

1. **At capture time**: `scripts/capture-dogzilla-map-pose.mjs` fetches the robot's `map`-frame pose from the pose bridge, then calls `mapPoseToAppPose()` from `lib/dogzilla-map-frame.mjs` to transform coordinates to `app_map` frame (relative to the saved map origin). The waypoint is stored with `frame: "app_map"`. The original map-frame pose is preserved in `capturedMapPose` metadata.

2. **On startup**: `lib/dogzilla-waypoint-navigation-launcher.mjs:autoSaveDogzillaMapOrigin()` auto-saves the map origin when Nav2 becomes ready (only if no origin file exists yet). This ensures `app_map` waypoints can always be resolved.

3. **At dispatch**: `lib/robot-command-compiler.mjs:resolveNavigationPose()` detects `frame === "app_map"` and calls `appPoseToMapPose()` to convert back to the current `map` frame using the saved origin. This means waypoints stay valid even when Cartographer restarts with a different origin.

### Key files

| File | Role |
|------|------|
| `lib/dogzilla-map-frame.mjs` | `mapPoseToAppPose()` and `appPoseToMapPose()` — the coordinate transform math |
| `scripts/capture-dogzilla-map-pose.mjs` | Captures live pose, converts to `app_map` before storing |
| `scripts/migrate-waypoints-to-appmap.mjs` | One-time migration of existing `map`-frame waypoints to `app_map` |
| `scripts/set-dogzilla-map-origin.mjs` | Manual map origin save (used if auto-save fails) |
| `lib/dogzilla-waypoint-navigation-launcher.mjs` | Auto-saves map origin on Nav2 startup |
| `lib/app-service.mjs` | Frontend display — `app_map` waypoints shown directly |
| `lib/robot-command-compiler.mjs` | `app_map` → `map` conversion at dispatch time |

### Workflow

1. Start the stack (LiDAR, Nav2, pose bridge).
2. The app auto-saves the map origin on first Nav2 health check (or run `node scripts/set-dogzilla-map-origin.mjs` manually).
3. Place the robot at a physical spot and run: `node scripts/capture-dogzilla-map-pose.mjs <name> --spot "<description>"`
4. The captured waypoint is stored in `app_map` frame — stable across Cartographer restarts.
5. To migrate existing `map`-frame waypoints: `node scripts/migrate-waypoints-to-appmap.mjs --no-dry-run` (replaces map coords with app_map; sets verified=false; adds recapture note).

### If the map origin is lost

- The origin file is at `output/app-cache/dogzilla-map-origin.json`
- If deleted or stale, `resolveNavigationPose()` will reject `app_map` waypoints with a clear warning
- Re-run `set-dogzilla-map-origin.mjs` or restart the app (auto-save triggers on startup)
