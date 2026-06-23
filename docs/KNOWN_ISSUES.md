# Known Issues And Gotchas

Keep this brief. Add only repeated failures, stable setup traps, or current blockers. Do not paste raw logs.

## Current unknowns

- Live DOGZILLA battery, Pi process state, deployed service versions, and current Nav2 health are Unknown / not confirmed unless probed in the active turn.
- End-to-end live arrival quality for the latest waypoint/Nav2 tuning is Unknown / not confirmed from this doc alone.

## DOGZILLA navigation

- Do not diagnose waypoint failures from coordinates alone. First check live readiness and costmap/scan evidence.
- Waypoint readiness is stricter than "Nav2 action server exists": action server, odom/TF, active lifecycle, and filtered scan on `/scan_nav2` all matter.
- **Slow lifecycle probe false blocker**: A waypoint dispatch can fail with `Nav2 lifecycle nodes are not active: controller_server, planner_server, bt_navigator, behavior_server` even when Nav2 is active. Cause: `/commands` performs a fresh lifecycle probe, while `/healthz` is only a snapshot. **Mitigation in place:** `probe_nav2_lifecycle_with_retry` in `sidecars/dogzilla_lib_bridge/nav2_client.py` retries once after 1.5s when any node reports inactive. Use the lifecycle-dispatch recipe in `docs/COMMANDS.md` before restarting Nav2 or changing waypoint data.
- **Single-shot start failure**: Before the retry wrapper, one SSH hiccup in `start-map-pose` or `start-navigation` could leave Nav2 down for the session. **Mitigation in place:** `lib/dogzilla-start-retry.mjs` wraps both actions in a 3-attempt loop (0/2s/5s backoff) at startup (`dogzilla-waypoint-navigation-launcher.mjs`) and command-time repair (`robot-sidecar-client.mjs`).
- **TF chain blocker**: If `/odom` publishes but `odom->base_link/base_footprint` TF is unavailable, Cartographer is likely stuck waiting for IMU. Fix: set `TRAJECTORY_BUILDER_2D.use_imu_data = false` in both `robodoge_dogzilla_laser_only.lua` and `robodoge_dogzilla_laser_only_localization.lua`. The DOGZILLA IMU hardware/endpoint is unreliable; Cartographer runs fine in laser-only mode. After deploying the fix, restart Cartographer (`start-map-pose-in-container.sh` detects running instances and re-copies lua configs).
- **Map identity churn**: If minimap pose, origin, and waypoints disagree, compare active map fingerprint from bridge `/healthz` with `output/app-cache/dogzilla-map-origin.json` and waypoint `mapFingerprint`. New map saves now get unique IDs, localization-mode saves are refused by default, and stale origins/waypoints should block readiness until recaptured. The UI waypoint-readiness panel lists stale waypoints with `Recapture here`; see `docs/NAVIGATION.md`.
- `ros-humble-nav2-msgs` can be missing inside the `robodoge-lidar-bridge` container. Symptom: `No module named 'nav2_msgs'`. See `docs/NAVIGATION.md` for the install script path.
- If DOGZILLA spins, stalls, or returns "No valid trajectories", inspect live costmap/Nav2 logs before changing waypoint data. The `stuck` nav status in the UI is shown for inspection only — there is no auto-retry from stuck (per user direction); the user must intervene.
- If robot moves opposite expected direction, verify heading/orientation and pose interpretation early in the next live run.
- Battery or unhealthy robot state is a hard stop for live motion validation. Local tests can still prove plumbing.

## Waypoint data

- `config/robot-waypoints.json` is authoritative. Do not let validators or heuristics silently rewrite, disable, or downgrade trusted entries.
- Notes are human comments only. Navigation and validation should use structured fields.
- Current verified `app_map` entries include `living_room`, `kitchen`, `garage`, and `charger` in `robodoge_home`; other map entries remain unverified in the current file.
- `app_map` waypoints require `output/app-cache/dogzilla-map-origin.json` or equivalent saved origin state to resolve back into current `map` coordinates.
- `output/app-cache/dogzilla-map-origin.json` saved via `autoSaveDogzillaMapOrigin` now includes the active map identity from bridge health. If Nav2 is up, the saved origin carries `map.id` and `map.fingerprint`, eliminating the `stale-missing-map-identity` status on restart. Identity-bearing origins are preserved by default if the bridge health does not report active map metadata.
- If active map identity is unavailable, or waypoint `mapFingerprint` is missing/differs from active map fingerprint, validator and dispatch mark navigation stale instead of ready. Do not edit the trusted config automatically; recapture on the stable active map.

## Startup/runtime

- **CRLF shell failure**: If Windows Git checkouts introduce CRLF into `.sh` files (`w/crlf` from `git ls-files --eol`), Bash aborts on `pipefail\r` before Cartographer or Nav2 can start. The app's waypoint blocker (map pose exists but no `/navigate_to_pose` action server) is the downstream symptom. Fix: `.gitattributes` forces LF for `*.sh` and `*.lua`; `Repair-RemoteScriptLineEndings` in `dogzilla-ssh-common.ps1` normalizes remote files after each `scp` so even pre-deployed bad files are repaired on the next SSH startup.
- **PowerShell SSH heredoc failure**: Do not embed `python3 - <<'PY'` or multi-line Bash here-docs in PowerShell strings sent through `ssh`. CRLF can make Bash miss the closing delimiter, producing `here-document ... wanted 'PY'` and Python `NameError: name 'PY' is not defined`. Use `python3 -c`, checked-in remote scripts, or one-line shell snippets.
- **Background restart self-kill**: A plain `pkill -f sidecars/.../server.py` inside the same SSH command can match the launcher shell because the future `nohup ... server.py` command is already present in the parent command line. Background starters should use a `pgrep` loop that skips `$$` and `$PPID`.
- **Concurrent apt/startup locks**: Map-pose and Nav2 startup both may install ROS packages. They must serialize through startup locks plus `/tmp/robodoge-apt.lock`; an apt lock error on startup usually means another startup/install is running, not that map files or waypoints are bad.
- **App-up startup self-heal**: The app should not require manual `dogzilla:start-map-pose`, `dogzilla:start-navigation`, or `start-dogzilla-yolo-vision-ssh.ps1` after startup. `run.mjs` checks DOGZILLA support services, direct bridge, and Nav2 waypoint readiness before spawning `server.mjs`; standalone `server.mjs` runs the same watchdog before listen. Startup blocks by default when Nav2 waypoint readiness is not proven. Use `APP_DOGZILLA_STARTUP_REQUIRE_NAV=0` only for non-navigation debugging. The post-startup monitor runs every 12 seconds and surfaces active repair as `navigationStatus.status === 'repairing'`; see `docs/NAVIGATION.md` for timing details. If camera is black, first check YOLO `8894/healthz` freshness (`latestFrameAgeSec`, `staleFrame`, `frames`) because the app camera panel uses the YOLO stream when vision is enabled. The Camera view `Fix black feed` button runs the same `start-yolo` recovery path as Connection Center, including releasing a local `/dev/video*` source before restarting YOLO.
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
