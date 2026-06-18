# Known Issues And Gotchas

Keep this brief. Add only repeated failures, stable setup traps, or current blockers. Do not paste raw logs.

## Current unknowns

- Live DOGZILLA battery, Pi process state, deployed service versions, and current Nav2 health are Unknown / not confirmed unless probed in the active turn.
- End-to-end live arrival quality for the latest waypoint/Nav2 tuning is Unknown / not confirmed from this doc alone.

## DOGZILLA navigation

- Do not diagnose waypoint failures from coordinates alone. First check live readiness and costmap/scan evidence.
- Waypoint readiness is stricter than "Nav2 action server exists": action server, odom/TF, active lifecycle, and filtered scan on `/scan_nav2` all matter.
- **TF chain blocker**: If `/odom` publishes but `odom->base_link/base_footprint` TF is unavailable, Cartographer is likely stuck waiting for IMU. Fix: set `TRAJECTORY_BUILDER_2D.use_imu_data = false` in both `robodoge_dogzilla_laser_only.lua` and `robodoge_dogzilla_laser_only_localization.lua`. The DOGZILLA IMU hardware/endpoint is unreliable; Cartographer runs fine in laser-only mode. After deploying the fix, restart Cartographer (`start-map-pose-in-container.sh` detects running instances and re-copies lua configs).
- `ros-humble-nav2-msgs` can be missing inside the `robodoge-lidar-bridge` container. Symptom: `No module named 'nav2_msgs'`. See `docs/NAVIGATION.md` for the install script path.
- If DOGZILLA spins, stalls, or returns "No valid trajectories", inspect live costmap/Nav2 logs before changing waypoint data.
- If robot moves opposite expected direction, verify heading/orientation and pose interpretation early in the next live run.
- Battery or unhealthy robot state is a hard stop for live motion validation. Local tests can still prove plumbing.

## Waypoint data

- `config/robot-waypoints.json` is authoritative. Do not let validators or heuristics silently rewrite, disable, or downgrade trusted entries.
- Notes are human comments only. Navigation and validation should use structured fields.
- Current verified `app_map` entries include `living_room`, `kitchen`, `garage`, and `charger` in `robodoge_home`; other map entries remain unverified in the current file.
- `app_map` waypoints require `output/app-cache/dogzilla-map-origin.json` or equivalent saved origin state to resolve back into current `map` coordinates.

## Startup/runtime

- `npm start` runs `scripts/start-clean.mjs`, which stops local processes/listeners on Robo-Doge ports before importing `run.mjs`.
- The user previously preferred the slower blocking startup over UI-first startup because it was more trustworthy. Be careful before making startup non-blocking.
- Port conflicts around `3037`, `8891`-`8896`, and `5037` can be caused by stale Node/Python/ADB processes.

## Android/Tauri

- Android is a control surface for the PC backend. It does not run Node, PowerShell, SSH, ROS2, or DOGZILLA sidecars locally.
- On Windows without Developer Mode, Tauri Android builds can fail on JNI symlinks. `scripts/build-android-apk.mjs` falls back by copying `libapp_lib.so` and running Gradle.
- APK build success does not prove the app is installed on the phone. Verify with `adb shell dumpsys package com.robodoge.console` when install state matters.

## Electron

- Packaged Electron uses `asar: false` and includes `electron/`, `public/`, `config/`, `lib/`, `sidecars/`, `scripts/`, `run.mjs`, `server.mjs`, and `cli.mjs`.
- `scripts/build-electron-desktop.mjs` repairs Moonshine VAD packaging by copying top-level `@ricky0123/vad-web` into the nested Moonshine expected path if needed.
- If the launcher cannot find the service root, set `ROBO_DOGE_ROOT` to the repo path.

## Isaac Sim

- Existing DOGZILLA CAD/USD payloads are useful for visuals and proxy-rig work, not confirmed as a clean articulated robot model.
- Imported assets may have poor semantic part names. Do not assume servo pivots or link hierarchy can be recovered automatically.
