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

`run.mjs` is the managed launcher. `scripts/start-clean.mjs` resets stale local Robo-Doge processes and ports, then imports `run.mjs`.

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
| `sidecars/` | Python/ROS/DOGZILLA support services |

## Runtime targets

Configured by `config/robot-runtime.json`.

| Target id | Kind | Current meaning |
| --- | --- | --- |
| `dogzilla_direct` | `dogzilla-direct` | Pi-hosted DOGZILLALib bridge at `10.0.4.32:8893` |
| `ros2_real` | `ros2-bridge` | ROS2 HTTP bridge path |
| `isaacsim` | `isaacsim` | Isaac sidecar and simulator target |

Current config default is `dogzilla_direct`, with `dryRun: false` and `requiresOperatorConfirmation: false`. Treat live safety as task-specific; verify current config before changing movement behavior.

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
| `8895` | DOGZILLA audio cue |
| `8896` | DOGZILLA LiDAR/map pose |

## Tests

Use `npm test` for the Node test suite. Python sidecar tests live under `test/test_*.py`; current package script does not run them directly unless invoked separately.

## More detail

- Commands: `docs/COMMANDS.md`
- Archived API details: `docs/archive/api-architecture.md`
- Archived setup: `docs/archive/setup-guide.md`
- Archived sim vs real background: `docs/archive/sim-vs-real-runtime.md`
