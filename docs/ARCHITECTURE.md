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

Command schema uses `command: "vision"` plus boolean `enabled` for explicit YOLO state changes; object-search remains `command: "detect"` with `object_to_detect`. App-service recognizes explicit YOLO on/off intent before model inference, compiler emits `vision.toggle`, and dispatch uses the shared YOLO toggle service rather than robot bridge `/commands`.
On Pi installations with `robodoge-yolo-vision.service`, the toggle writes `/etc/robodoge/yolo-vision.env` and restarts that unit; success requires live `/healthz` agreement, including `modelLoaded: true` when enabling detection.

`run.mjs` is the managed launcher. `scripts/start-clean.mjs` resets stale local Robo-Doge process ports, then imports `run.mjs`. `server.mjs` serves HTTP/WebSocket, monitors rosbridge reconnects, and reports Nav2 readiness without starting, restarting, reinstalling, or deleting Nav2. In DOGZILLA direct mode, Pi boot/systemd owns map-pose/Nav2 lifetime; the app is a client that reads health, sends goals, cancels goals, and reports blockers. UI Connection Center and `npm run dogzilla:start-navigation` remain explicit manual repair paths only.

## Key entrypoints

| File | Role |
| --- | --- |
| `server.mjs` | HTTP server, static files, CORS, `/healthz`, DOGZILLA/runtime/recon routes, WebSocket upgrade |
| `run.mjs` | Managed startup: support services, direct bridge, Isaac, ROS2 bridge, speech sidecar; does not start Nav2 |
| `public/` | Shared browser UI used by web, Android Tauri, and Electron-loaded backend app |
| `lib/app-service.mjs` | App-facing command/config orchestration |
| `lib/robot-command-compiler.mjs` | Real robot command preview and waypoint pose resolution |
| `lib/isaacsim-command-compiler.mjs` | Isaac Sim preview construction |
| `lib/dogzilla-connection-center.mjs` | In-app DOGZILLA service actions and SSH script wiring |
| `sidecars/` | Python/ROS/DOGZILLA support services |

## Operator UI boundaries

Keep routine controls narrow: Settings owns model, runtime target, performance profile, sound volume, and speech profile; Diagnostics owns aggregate preflight and Pi-load checks, with connection setup and service repair collapsed. Robot Info is the persistent navigation-status surface, and its Nav-chain detail stays operator-expanded; do not duplicate Nav2 blockers into command or minimap overlays. The Overview and Camera tabs share the primary visualization slot; Camera hides the minimap and Map Controls until Overview is restored.

The operator shell uses a fixed full-height black rail beside two light work columns. The left column owns command input, emergency stop, manual control, execution timeline, conversation history, and voice readiness. The right column owns compact robot state, the primary map, the shared Camera slot, and Mapping/Navigation/Waypoints presentation tabs. Rail destinations reuse existing drawers and focus targets; they do not create new backend surfaces. Parsed command JSON, expanded Nav-chain detail, and CPU/Pi diagnostic output remain in Diagnostics.

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

`/commands` uses the Docker ROS backend for goal dispatch;
`DOGZILLA_NAV2_SEND_GOAL_DOCKER_ENABLED` defaults to `1`. The bridge sends the
goal synchronously and returns `202` with `delivery: "accepted"` only after the
Nav2 action server accepts it. The background thread monitors motion only (no
double goal send). `locomotion.goto` auto-promotes from `idle` to `navigate`
with a 45 s bounded readiness wait (`DOGZILLA_NAV2_PROMOTE_TIMEOUT_SEC`), polling
every 2 s and returning the latest blockers on timeout. Callers track
completion through `/feedback`. The background thread updates the same
`commandId` record and reports `motionStatus` values (`"moving"`,
`"no-motion"`, `"cancelled"`, `"failed"`) using lightweight cached state only
(no Docker probes in the monitor loop). Each waypoint dispatch records
stage-level timing and failure attribution for `healthLite`, `scanInfo`,
`fullHealth`, `readiness`, `preempt`, and `command`.

direct bridge owns DOGZILLA navigation-mode state (`idle` / `localize` /
`navigate` / `sleep`) exposed by `GET/POST /mode`, but those modes are
logical app state. Pi boot/systemd owns Cartographer/Nav2/scan-filter
process lifetime. Other app paths read state via `/healthz-lite`; waypoint
dispatch reports blockers when the Pi-owned stack is unavailable.

The `/scan_nav2` scan filter (`scan_self_filter.py`) reads `/scan`, masks the
dog's own rear body (120-260 deg under 0.45 m), and publishes to `/scan_nav2`.
It runs as a direct background process inside the rosbridge container without a
supervisor wrapper.

HTTP `locomotion.goto` commands now default to async acceptance on the direct
bridge (`DOGZILLA_ASYNC_HTTP_GOTO=1` by default). The bridge sends the goal
synchronously, returns `202` with `delivery: "accepted"` only after the Nav2
action server accepts it, then monitors motion in background. Callers track
completion through `/feedback` instead of holding the original POST open.

`config/robot-waypoints.json` remains authoritative waypoint source. Active map
identity gates waypoint dispatch; new entries use explicit `map` poses, while
legacy `app_map` entries resolve only from immutable waypoint-owned map pose
metadata. `/api/robot/state` caps live health probes so UI can show
bridge-offline/localizing/stuck status without waiting on slow full bridge
health request.
DOGZILLA battery reads are transient DOGZILLALib telemetry; the app persists only the last valid reading in `output/app-cache/dogzilla-battery-state.json` so failed reads or app restarts can show `last-known` instead of losing prior monitor state. The Pi direct bridge is the motion-safety authority: it accepts typed integer percent only, applies configurable warning/cutoff/recovery thresholds with stale-data expiry, safe-stops motion, and publishes cause/recovery through `/state` and `/healthz-lite`. Battery UART reads stay synchronous under the shared robot lock; DOGZILLALib 3.1.9 supplies a one-second wall timeout, and the bridge caps then restores its pyserial timeout. Do not reintroduce detached battery-read workers because a timed-out worker can overlap later UART stop commands.

## Config ownership

| Config | Owned behavior |
| --- | --- |
| `config/robot-runtime.json` | Active target, dry-run, performance profile, waypoint/action/motion selections |
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
| `8894` | DOGZILLA camera stream sidecar; raw stream by default, YOLO detection opt-in |
| `8895` | DOGZILLA audio cue (keeps live volume state via `/volume`; direct callers like YOLO use it as fallback) |
| `9090` | DOGZILLA rosbridge (Pi-hosted; throttled scan/TF/odom over WebSocket) |

## Tests

Use `npm test` for the Node test suite. Use `npm run verify` to run both the
Node suite and the Python sidecar tests under `test/test_*.py`.

Control ownership uses the in-memory per-robot lease API at `/api/robot/lease`:
`GET` reports state, `POST` acquires or deliberately takes over, `PATCH` renews,
and `DELETE` releases. Responses carry a monotonic fencing token and expiry;
the default TTL is 10 seconds and can be changed with
`ROBO_DOGE_LEASE_TTL_MS`. Lease state is intentionally process-local, so a
backend restart drops ownership and requires reacquisition.

## More detail

- Commands: `docs/COMMANDS.md`
- Archived API details: `docs/archive/api-architecture.md`
- Archived setup: `docs/archive/setup-guide.md`
- Archived sim vs real background: `docs/archive/sim-vs-real-runtime.md`
