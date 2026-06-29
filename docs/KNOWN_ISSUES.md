# Known Issues / Gotchas

Keep this brief. Add only repeated failures, stable setup traps, or current blockers. Do not paste raw logs.

## Current Unknowns

- Live DOGZILLA battery, Pi process state, deployed service versions, and current Nav2 health are Unknown / not confirmed unless probed in the active turn.
- End-to-end live arrival quality for the latest waypoint/Nav2 tuning is Unknown / not confirmed from docs alone.

## DOGZILLA Navigation

- **Nav2 action discovery can be a false startup blocker.** The direct bridge reports `navigation.actionServerDiscovered` separately from `navigation.waypointReady`. If lifecycle nodes are active and `/odom` plus `/scan_nav2` are live, bridge readiness may be waypoint-ready even when Pi DDS action discovery briefly misses `/navigate_to_pose`. `send_goal` still waits for the real action server before accepting a command. See `docs/NAVIGATION.md`.
- **Resolved startup blocker: `/odom` and `/scan_nav2` did not stay ready long enough for waypoint commands.** The repo `/odom` and `/scan_nav2` helpers now run under supervisors. `/odom` uses `odom->base_link` when available, otherwise synthetic relative odom anchored at first `map->base_link`.
- **Single-shot start failure:** One SSH hiccup in `start-map-pose` or `start-navigation` could leave Nav2 down for the session. `lib/dogzilla-start-retry.mjs` wraps both actions in a 3-attempt loop.
- **TF chain blocker:** If no physical `odom->base_link/base_footprint` TF exists, startup may use repo synthetic `/odom` anchored from `map->base_link`. This is a DOGZILLA compatibility shim, not wheel odometry. If physical odom is restored later, prefer real odom and retest Nav2 motion.
- **ROS2 daemon hangs:** `ros2 topic info`, `ros2 topic list`, or `ros2 action list` can hang under Pi DDS/daemon load. Startup scripts should use bounded calls and restart the daemon before probing.
- **No auto-retry for stuck route:** `stuck` nav status in UI is inspection-only. Per user direction, do not add auto-retry stuck behavior without explicit instruction.
- **Battery hard stop:** Unhealthy or low battery robot state should stop live motion validation. Local tests can still prove plumbing.
- **UART split:** Direct DOGZILLALib bridge uses robot control UART `/dev/ttyAMA0`; LiDAR/rosbridge stays on HAT UART `/dev/ttyAMA1`. If battery is unavailable while isolated `DOGZILLA().read_battery()` works, check `/etc/robodoge/dogzilla.env` for `DOGZILLA_ROBOT_SERIAL_PORT=/dev/ttyAMA0` and `DOGZILLA_SERIAL_PORT=/dev/ttyAMA1`.

## Waypoint Data

- `config/robot-waypoints.json` is authoritative. Do not let validators or heuristics silently rewrite, disable, or downgrade trusted entries.
- Notes are human comments only. Navigation validation should use structured fields.
- Current verified `app_map` entries include `living_room`, `kitchen`, `garage`, and `charger` in `robodoge_home`; other map entries remain unverified in the current file.
- If saved origin is missing, the app can fall back using current map pose directly. Waypoints remain authoritative, but recapture if physical alignment drifts.
- For waypoint capture, drive the robot to the spot. Carrying it can make Cartographer laser-only localization lose track while `waypointSafe` still reports true.

## Startup / Runtime

- **CRLF shell failure:** If Windows Git checkouts introduce CRLF into `.sh` files, Bash can abort before Cartographer or Nav2 starts. `.gitattributes` forces LF for `*.sh` and `*.lua`; `Repair-RemoteScriptLineEndings` normalizes remote files after each `scp`.
- **PowerShell SSH heredoc failure:** Do not embed `python3 - <<'PY'` multi-line Bash heredocs in PowerShell strings sent through `ssh`. Use `python3 -c`, checked-in remote scripts, or one-line shell snippets.
- **Background restart self-kill:** Plain `pkill -f sidecars/.../server.py` inside the same SSH command can match its launcher. Background starters should use a `pgrep` loop that skips `$$` and `$PPID`.
- **Concurrent apt/startup locks:** Map-pose and Nav2 startup may install ROS packages. Serialize through startup locks plus `/tmp/robodoge-apt.lock`.
- `npm start` runs `scripts/start-clean.mjs`, stops local processes/listeners on Robo-Doge ports, then imports `run.mjs`.
- Port conflicts around `3037`, `8891`-`8895`, `9090`, and `5037` can be stale Node/Python/ADB processes.

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
