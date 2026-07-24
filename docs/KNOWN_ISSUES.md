# Known Issues / Gotchas

Keep this brief. Add only repeated failures, stable setup traps, or current blockers. Do not paste raw logs.

## Current Unknowns

- Live DOGZILLA battery, Pi process state, deployed service versions, and current Nav2 health are Unknown / not confirmed unless probed in the active turn.
- End-to-end live arrival quality for the latest waypoint/Nav2 tuning is Unknown / not confirmed from docs alone.
- Live Pi check found no registered active cooling device, thermal throttling, and repeated bogus `w1` family-0 scans. 1-wire sensor ownership remains unknown; inspect hardware before changing `dtoverlay=w1-gpio`.

## DOGZILLA Navigation

- **Cartographer pose drift is not physical motion.** DOGZILLA has no chassis odometer, and live mapping proved that in-place rotation can make `map -> base_link` appear to translate by more than a meter. Frontier mapping now observes the collision-monitor-guarded `/cmd_vel`, cancels a continuous pure turn after eight seconds, and requires both map displacement and accumulated forward command time before saving a candidate. Operator observation remains the authority for physical translation during supervised trials.
- **Docker goal-split (live verified).** Docker status checks and Docker goal sending used to diverge, so the bridge could report `waypointReady=true` but fail goal sending. `can_send_goal()` now gates `waypointReady`; `/healthz-lite` exposes `canSendGoal`/`nav2Backend`. Keep Docker send-goal enabled unless a live replacement path is verified.
- **Nav2 action discovery can be a false startup blocker.** The direct bridge reports `navigation.actionServerDiscovered` separately from `navigation.waypointReady`. If lifecycle nodes are active and `/odom` plus `/scan_nav2` are live, bridge readiness may be waypoint-ready even when Pi DDS action discovery briefly misses `/navigate_to_pose`. `send_goal` still waits for the real action server before accepting a command. See `docs/NAVIGATION.md`.
- **Map-generation coherence is a current blocker.** Do not treat `waypointReady=true` as map-safe. Active manifests require hashed YAML/PGM; PBSTREAM is optional only for occupancy-only scanner maps. Such maps cannot use Continue Current Map or Cartographer localization; use Map This Floor to start fresh. Any orderly explorer exit saves a candidate, and an occupancy-only active map leaves that candidate in `candidate-ready` instead of restoring a mismatched PBSTREAM. Promote the candidate before normal navigation.
- **Resolved mapping standby blocker:** A stale deployed `DOGZILLA_NAV2_STANDBY_ENABLED=1` made mapping call the lifecycle manager while the new mapping stack was still starting, aborting with `Frontier supervisor launched, but Nav2 could not wake.` Nav mode is now fixed to `navigate`; launchers no longer call navigation power-mode endpoints, and the readiness watcher always requires the full stack.
- **Resolved mapping velocity-chain false negative:** Humble `behavior_server` creates one `/cmd_vel_nav` publisher endpoint per behavior plugin. Readiness must compare the exact unique publisher node identities, not raw endpoint count; duplicate endpoints from the same trusted node are valid, while any publisher from another node still fails closed.
- **Resolved stalled-frontier cancel hard stop:** A slow or missing Nav2 `CancelGoal` response used to terminate frontier exploration after ten seconds. Cancellation is now best-effort for an already quarantined destination; the explorer selects another frontier and the replacement `NavigateToPose` goal preempts the old destination. Explicit Stop Early still finishes even when cancellation is unacknowledged.
- **Mapping restore must clear systemd start limits:** Before restarting normal map-pose and Nav2 ownership, the autonomous mapping supervisor resets failed state for both services. Without this, a prior readiness restart loop can leave `robodoge-navigation.service` at `start-limit-hit` and strand rollback.
- **Resolved startup blocker: `/odom` and `/scan_nav2` did not stay ready long enough for waypoint commands.** Normal navigation now requires Cartographer's real `odom->base_link`; synthetic relative odom is disabled unless an alternate configuration explicitly enables it.
- **Do not switch normal navigation to AMCL without live proof.** Live AMCL-only test left Nav2 without a `map` frame (`map->odom` missing) while scan messages were dropped by TF filters. Normal Pi boot keeps Cartographer as the single localization source for Nav2.
- **Fresh TF does not prove physical location after carrying the robot.** Pi-owned Cartographer must prove localization against the active frozen PBSTREAM before Nav2 becomes waypoint-ready. A completed recovery with zero accepted constraints and Cartographer `0 additional constraints` is a terminal scene/map mismatch, not an in-progress wait; confirm the robot is physically inside the active mapped area and collect distinctive scans before retrying. Do not lower or bypass the 45% constraint threshold or the two-distinct-node proof. Charger-origin data is never localization authority. App startup, health polling, and waypoint dispatch hide/block rather than guessing or auto-repairing.
- **Continue Current Map handoff rule.** Continue must never navigate to `resumePose`; that field is history/search hint only. Its explicit SSH launcher must use the dedicated `continue_mapping` container; starting systemd's `auto` container and then executing the same startup script again creates duplicate Cartographer/relocalizer races. After bounded recovery matches the map, Cartographer reloads every saved trajectory frozen and starts a new mapping trajectory from the fresh recovered map pose relative to the root map-frame trajectory. Health records the matched and map-anchor trajectory IDs separately. Do not require exactly one frozen trajectory or anchor a global map pose to a later trajectory's local frame.
- **Nav2 collision gate is mandatory.** Hardware velocity must remain `/cmd_vel_nav` -> velocity smoother `/cmd_vel_raw` -> lifecycle-managed `nav2_collision_monitor` -> gait adapter `/cmd_vel`. The monitor consumes `/scan_nav2`, stops for front/rear envelope intrusions, and fails closed on stale scan input. Do not remap smoother output directly to `/cmd_vel`.
- **Pi LiDAR timestamp jitter.** DOGZILLA scan delivery can report roughly 0.55s header-age gaps while the topic still runs near 10Hz. The collision monitor therefore defaults to a 0.75s source timeout (`DOGZILLA_NAV2_COLLISION_SOURCE_TIMEOUT`) and still stops for longer gaps; do not disable the monitor or rewrite scan timestamps.
- **No app-side Nav2 repair loop:** Nav2/map-pose lifetime belongs to Pi boot/systemd. App startup, server health polling, and waypoint dispatch must not auto-run `start-map-pose`, `start-navigation`, reinstall Nav2/Cartographer packages, recreate containers, or tear containers down on timeout. The Pi navigation service continuously checks fresh data/TF/lifecycle plus the named final gait edge and uses bounded systemd restart only after sustained degradation. Missing packages remain image/setup failures. Use manual repair controls only when an operator asks.
- **Resolved Nav2 readiness restart loop:** ROS launch children may discard the launcher environment token. Readiness still requires the recorded boot ID, owner PID/start time, process-group leader/start time, mode, and leader token, but does not reject an otherwise valid stack because a child is tokenless. The 120-second readiness ceiling, two-second stability gate, safety checks, and bounded systemd restart remain unchanged.
- **Resolved stale goal-backend cache:** After rosbridge/container recovery, a fresh Pi readiness snapshot can briefly outrun the direct bridge's cached goal backend. `/healthz-lite` performs one existing backend refresh only for that contradiction, then returns the refreshed cached state; ordinary healthy polling stays lightweight.
- **TF chain blocker:** Missing `odom->base_link/base_footprint` is a hard normal-start failure. The repo's synthetic `map->base_link` compatibility shim is explicit-only; it permanently retires when the named real authority appears and cannot reclaim the frame.
- **ROS2 daemon hangs and probe load:** `ros2 topic info`, `ros2 topic list`, or `ros2 action list` can hang under Pi DDS/daemon load. Do not poll startup readiness by repeatedly spawning these commands; use one bounded `rclpy` graph node so the probe does not delay Nav2 activation.
- **Windows mapping actions require non-interactive SSH:** Every direct `ssh` call in nested map-pose/Nav2 wait loops must use `-n`. Node keeps child stdin open; an interactive nested SSH probe can hang after Cartographer is ready, preventing Nav2 launch until the HTTP action and mapping supervisor time out.
- **No auto-retry for stuck route:** `stuck` nav status in UI is inspection-only. Per user direction, do not add auto-retry stuck behavior without explicit instruction.
- **Battery hard stop (enforced):** Live mapping on 2026-07-21 showed the DOGZILLA hardware going limp at its own `25%` threshold, so the direct bridge now warns at `35%`, blocks and stops motion at `30%`, and requires recovery to `35%`. It accepts only a fresh integer battery percentage from `1` to `100` and treats readings older than `15s` as stale. Motion commands, the Nav2 gait adapter, and emergency-stop clear fail closed while battery state is unavailable, invalid, stale, cutoff, or recovering. Tune only through `DOGZILLA_BATTERY_WARNING_PERCENT`, `DOGZILLA_BATTERY_CUTOFF_PERCENT`, `DOGZILLA_BATTERY_RECOVERY_PERCENT`, and `DOGZILLA_BATTERY_MAX_AGE_SEC`.
- **UART split:** Direct DOGZILLALib bridge uses robot control UART `/dev/ttyAMA0`; LiDAR/rosbridge stays on HAT UART `/dev/ttyAMA1`. If battery is unavailable while isolated `DOGZILLA().read_battery()` works, check `/etc/robodoge/dogzilla.env` for `DOGZILLA_ROBOT_SERIAL_PORT=/dev/ttyAMA0` and `DOGZILLA_SERIAL_PORT=/dev/ttyAMA1`.

## Waypoint Data

- `config/robot-waypoints.json` is authoritative. Do not let validators or heuristics silently rewrite, disable, or downgrade trusted entries.
- Notes are human comments only. Navigation validation should use structured fields.
- New waypoints use raw `map` coordinates plus active map identity. Legacy `app_map` waypoints require immutable `capturedMapPose` or waypoint-owned origin metadata; missing resolution data blocks dispatch instead of falling back to a mutable current origin.
- For waypoint capture, drive the robot to the spot. Carrying it can make Cartographer laser-only localization lose track while `waypointSafe` still reports true.

## Startup / Runtime

- **CRLF shell failure:** If Windows Git checkouts introduce CRLF into `.sh` files, Bash can abort before Cartographer or Nav2 starts. `.gitattributes` forces LF for `*.sh` and `*.lua`; `Repair-RemoteScriptLineEndings` normalizes remote files after each `scp`.
- **PowerShell SSH heredoc failure:** Do not embed `python3 - <<'PY'` multi-line Bash heredocs in PowerShell strings sent through `ssh`. Use `python3 -c`, checked-in remote scripts, or one-line shell snippets.
- **Background restart self-kill:** Plain `pkill -f sidecars/.../server.py` inside the same SSH command can match its launcher. Background starters should use a `pgrep` loop that skips `$$` and `$PPID`.
- **Concurrent apt/startup locks:** Map-pose and Nav2 startup may install ROS packages. Serialize through startup locks plus `/tmp/robodoge-apt.lock`.
- `npm start` runs `scripts/start-clean.mjs`, stops local processes/listeners on Robo-Doge ports, then imports `run.mjs`.
- Port conflicts around `3037`, `8891`-`8895`, `9090`, and `5037` can be stale Node/Python/ADB processes.

- **Raw vendor camera vs direct bridge:** Direct-bridge startup can stop Yahboom `app_dogzilla.py` to free `/dev/ttyAMA0`, which also leaves vendor camera ports `6000/6500` refusing connections. Keep the app-facing camera on the `8894` device sidecar (`vision.enabled=true`); YOLO detection is separate (`vision.detectionEnabled`) and should stay off unless object detection is needed.

- Direct-bridge startup gestures are disabled by default because startup tricks/preempt commands can collide with Pi-owned Nav2 readiness. Use `ROBOT_STARTUP_GESTURE=1` only for intentional startup gesture tests.

## Android / Tauri

- Android is a control surface for the PC backend. It does not run Node, PowerShell, SSH, ROS2, or DOGZILLA sidecars locally.
- On Windows without Developer Mode, Tauri Android builds can fail on JNI symlinks. `scripts/build-android-apk.mjs` falls back by copying `libapp_lib.so` and running Gradle.
- APK build success does not prove app installed on phone. Verify with `adb shell dumpsys package com.robodoge.console` when install state matters.

## Electron

- Packaged Electron uses `asar: false` and includes `electron/`, `public/`, `config/`, `lib/`, `sidecars/`, `scripts/`, `run.mjs`, `server.mjs`, and `cli.mjs`.
- `scripts/build-electron-desktop.mjs` repairs Moonshine VAD packaging by copying top-level `@ricky0123/vad-web` into the nested Moonshine expected path if needed.
- If launcher cannot find service root, set `ROBO_DOGE_ROOT` to repo path.

## Isaac Sim

- Existing DOGZILLA CAD/USD payloads are useful for visuals and proxy-rig work, not confirmed clean articulated robot models.
- Imported assets may have poor semantic part names.
