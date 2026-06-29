# Robo-Doge Architecture

Compact map for coding agents. For subsystem details, read the subsystem doc after this file.

## Purpose

Robo-Doge is a local control console for Questing Beast / Yahboom DOGZILLA. The desktop backend owns model calls, command parsing, runtime target selection, robot-side sidecars, telemetry, audio cues, camera/LiDAR proxying, map pose, and packaged desktop/mobile shells.

## Main runtime flow

```text
public/ UI or packaged shell
-> server.mjs
-> model profile / command schema / waypoint context
-> parsed command JSON
-> preview builders for Isaac + real robot
-> active runtime dispatch
-> sidecar or robot bridge
```

`run.mjs` managed launcher. `scripts/start-clean.mjs` resets stale local Robo-Doge process ports, then imports `run.mjs`. `server.mjs` serves HTTP/WebSocket, monitors rosbridge reconnects, and runs a low-frequency Nav2 repair watchdog for DOGZILLA direct mode after startup. `run.mjs` still triggers initial Nav2 startup via `startNav2Background()`; UI Connection Center and `npm run dogzilla:start-navigation` remain manual repair paths.

## Key entrypoints

| File | Role |
| --- | --- |
| `server.mjs` | HTTP server, static files, CORS, `/healthz`, DOGZILLA/runtime/recon routes, WebSocket upgrade |
| `run.mjs` | Managed startup: required DOGZILLA services, direct bridge, waypoint navigation, Isaac, ROS2 bridge, speech sidecar |
| `public/` | Shared browser UI used by web, Android Tauri, and Electron-loaded backend app |
| `lib/app-service.mjs` | App-facing command/config orchestration |
| `lib/robot-command-compiler.mjs` | Real robot command preview and waypoint pose resolution |
| `lib/isaacsim-command-compiler.mjs` | Isaac Sim preview construction |
| `lib/dogzilla-connection-center.mjs` | In-app DOGZILLA service actions and SSH script wiring |
| `lib/dogzilla-startup-watchdog.mjs` | App-up DOGZILLA self-heal loop for YOLO/audio/lidar/map-pose, direct bridge, and Nav2 |
| `sidecars/` | Python/ROS/DOGZILLA support services |

## Runtime targets

Configured by `config/robot-runtime.json`.

| Target id | Kind | Current meaning |
| --- | --- | --- |
| `dogzilla_direct` | `dogzilla-direct` | Pi-hosted DOGZILLALib bridge at `10.0.4.32:8893` |
| `ros2_real` | `ros2-bridge` | ROS2 HTTP bridge path |
| `isaacsim` | `isaacsim` | Isaac sidecar and simulator target |

Current config default is `dogzilla_direct`, with `dryRun: false` and `requiresOperatorConfirmation: false`. Treat live safety as task-specific; verify current config before changing movement behavior.

Isaac Sim is a simulator target and sidecar only. It is not a real DOGZILLA
sensor and must not participate in DOGZILLA navigation readiness or degrade
real-world health when the active target is `dogzilla_direct`.

For DOGZILLA waypoint dispatch, the desktop-side preflight is staged so the
command never waits on a slow full `/healthz` when the fast probes are already
green:

1. `GET /healthz-lite` proves bridge reachability (2 s timeout).
2. `GET /nav2/scan_info` forces a live refresh of `/scan_nav2` publisher state
   (4 s timeout).
3. Full `GET /healthz` is fetched only when map/lifecycle/odom detail is still
   needed, capped at 6 s so it cannot hold the command open for tens of seconds.
   If it times out while the fast probes are green, dispatch proceeds with a
   warning and skips map-identity/pose validation for that request.

`/commands` still re-probes Nav2 action, `/odom`/TF, lifecycle nodes, and
`/scan_nav2` before sending a goal, and `locomotion.goto` remains async-by-default
(`DOGZILLA_ASYNC_HTTP_GOTO=1`): the bridge returns `202` acceptance quickly and
callers track completion through `/feedback`. Each waypoint dispatch records
stage-level timing and failure attribution for `healthLite`, `scanInfo`,
`fullHealth`, `readiness`, `preempt`, and `command`.

The `/scan_nav2` scan filter (`scan_self_filter.py`) is supervised by
`scan_filter_supervisor.py`, which captures stderr from the child process and
treats "alive but not publishing" as a hard failure triggering restart. After
repeated failures the supervisor keeps running with capped exponential backoff,
because it is launched inside the rosbridge container rather than managed by a
dedicated restart unit. The filter prints traceback before exiting nonzero on
rclpy context errors so the supervisor logs the fault reason.

HTTP `locomotion.goto` commands now default to async acceptance on the direct
bridge (`DOGZILLA_ASYNC_HTTP_GOTO=1` by default). The bridge returns `202` with
`navigation-accepted` and finishes Nav2 execution in background, while callers
track completion through `/feedback` instead of holding the original POST open.

Map identity no longer dispatch gate after rosbridge simplification.
`config/robot-waypoints.json` remains authoritative waypoint source; saved
origin state plus current rosbridge `map` pose resolve app-map waypoints at
runtime. `/api/robot/state` caps live health probes so UI can show
bridge-offline/localizing/stuck status without waiting on slow full bridge
health request.
DOGZILLA battery reads are transient DOGZILLALib telemetry; the app persists only the last valid reading in `output/app-cache/dogzilla-battery-state.json` so failed reads or app restarts can show `last-known` instead of losing prior monitor state.

## Config ownership

| Config | Owned behavior |
| --- | --- |
| `config/robot-runtime.json` | Active target, dry-run, waypoint/action/motion selections |
| `config/dogzilla-connection.json` | Pi host, SSH alias, bridge ports, camera/vision/audio/lidar endpoints |
| `config/robot-waypoints.json` | Authoritative real DOGZILLA waypoint registry |
| `config/isaacsim-waypoints.json` | Isaac waypoint registry with same semantic names where possible |
| `config/robot-obstacle-avoidance.json` | Nav2 and map-navigation tuning knobs |
| `config/model-profiles.json` | Model provider profiles, including local and Android-facing profiles |

## Sidecar ports

| Port | Service |
| --- | --- |
| `3037` | Main app server |
| `8891` | Isaac bridge |
| `8892` | ROS2 bridge |
| `8893` | DOGZILLA direct bridge |
| `8894` | DOGZILLA YOLO vision |
| `8895` | DOGZILLA audio cue (keeps live volume state via `/volume`; direct callers like YOLO use it as fallback) |
| `9090` | DOGZILLA rosbridge (Pi-hosted; scan/TF/map over WebSocket) |

## Tests

Use `npm test` for the Node test suite. Python sidecar tests live under `test/test_*.py`; current package script does not run them directly unless invoked separately.

## More detail

- Commands: `docs/COMMANDS.md`
- Archived API details: `docs/archive/api-architecture.md`
- Archived setup: `docs/archive/setup-guide.md`
- Archived sim vs real background: `docs/archive/sim-vs-real-runtime.md`
