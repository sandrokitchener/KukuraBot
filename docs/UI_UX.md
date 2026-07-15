# Robo-Doge UX / Navigation Improvement Plan

## Goal

Make the robot console safer and easier to operate by showing the operator:

1. Is the robot connected?
2. Where is it?
3. What is it doing?
4. What can I safely do next?
5. Did the last command work?

This is not a visual redesign plan. The priority is operator confidence, state clarity, and evidence capture around Nav2 instability.

## Current UX Findings

- The left rail looks navigable, but most icons are inert spans. This can make users think there are missing sections or hidden navigation.
- The chat command box is the primary action surface, but it is available before the user sees clear navigation readiness or pose confidence.
- Robot status, map, mapping workflow, diagnostics, logs, settings, help, and snapshots are split across tabs, drawers, and details panels.
- Navigation health dots are compact but too cryptic. When readiness is absent, the chain can disappear instead of showing `unknown`.
- Critical navigation setup lives behind the collapsed `Mapping` panel, so the required flow is easy to miss.
- Similar-looking actions have very different consequences: `Localize on Map`, `Mark Origin`, `New Map`, and `Save Map`.
- Map identity and charger-origin actions can invalidate waypoints, but that consequence is not visible at the button site.
- `Restart Nav` is a manual operator control in the Navigation Setup panel; normal app startup and waypoint dispatch must not invoke it.
- Dangerous maintenance actions are hidden in a disclosure, but once opened they are still one-click actions.
- Emergency stop is too buried. It should be visible near robot operation controls, not only under Settings.
- Runtime feedback and errors live away from the command/map workflow, so the user may not see why a command failed.
- Disabled waypoint/navigation controls rely on `title` text for the reason, which is weak on mobile and touch devices.
- Mobile chat/audio views can hide robot state, map, and camera while commands can still be issued.

## Architecture Principle

Do not solve Nav2 instability with prettier status text.

The interface should show evidence from the real readiness chain and preserve low-level causes such as `ECONNREFUSED`, lifecycle timeouts, action-server absence, missing `/odom`, missing TF, missing `/scan_nav2`, stale map identity, or untrusted pose.

## Track 1: UX Operator Flow

### Persistent Operator Status

Add a compact status area visible from the main control screens:

- Connection state
- Current task: `IDLE`, `MOVING`, `SCANNING`, `PATROLLING`, `TALKING`, `THINKING`, `TRICK`, `BLOCKED`, or `ERROR`
- Navigation phase: ready, finding waypoint, moving, stuck, blocked, unknown
- Battery or power state when available
- Last telemetry update age
- Last command sent
- Last command result
- Safety/error state

Use existing robot state, navigation status, dispatch result, and telemetry data. Avoid adding a new summary that can disagree with source evidence.

### Safe Next Action

Show one clear next action near the status area:

- Disconnected: `Check robot link`
- Pose missing/untrusted: `Localize on Map`
- Nav2 missing: `Restart Nav`
- Stale waypoints: `Check waypoint readiness`
- Ready: `Send movement command`
- Moving/stuck/error: `Emergency stop`

If an action is disabled, show the blocker as visible text, not only a tooltip.

### Navigation Structure

- Keep main tabs simple: `Overview` and `Camera`.
- Make Overview the operator home: status, map, task, manual controls, last command, and safe next action.
- Keep Diagnostics for service recovery and bridge checks plus one-shot Pi load/performance check. The Pi load button opens a separate window and calls `/api/dogzilla/pi-performance` once for CPU load, memory usage, temperature, uptime, and throttle flags; do not convert it into polling without an explicit operator need.
- Keep Settings for runtime/model/operator preferences.
- Keep Help for workflow explanation.
- Remove or convert inert rail icons so every visible navigation element either does something or is clearly decorative.

### Dangerous Actions

Add confirmations for high-impact actions:

- `Mark Origin`
- `New Map`
- `Save Map`
- `Stop vendor app`
- `Stop bridges`
- `Deploy bridge code`

Confirmation text should name the consequence, not just ask a generic question. Example: saving a new map identity can make old app-map waypoints stale until recaptured.

### Emergency Stop

Move Emergency Stop to a persistent robot-operation area. It should remain reachable during:

- command entry
- map view
- manual control
- robot movement
- connection and manual recovery states
- mobile chat/audio views

## Track 2: Nav2 Stability Evidence

### Problem

Nav2/map-pose ownership belongs to Pi boot services, not app startup or command dispatch. The app should show which part of the Nav2 chain is down or flapping, but normal UI/server paths must not self-heal, repair, restart, or reinstall Nav2.

### State Transition Capture

Add a lightweight Nav2 stability tracker that records transitions, not every poll.

Track transitions like:

- `ready -> bridge_timeout`
- `ready -> action_missing`
- `ready -> odom_missing`
- `ready -> tf_missing`
- `ready -> lifecycle_unproven`
- `ready -> scan_nav2_missing`
- `ready -> map_pose_untrusted`
- `ready -> waypoint_stale`
- `blocked -> ready`
- `blocked -> degraded`

Each event should include:

- timestamp
- previous state
- next state
- source: startup monitor, `/api/robot/state`, `/healthz`, command dispatch, or manual diagnostic
- blocker text
- readiness step that failed
- probe duration when available
- bridge destination URL
- command retry action when available

Persist transition events to:

```text
output/app-cache/nav2-events.ndjson
```

Only write when state changes or the blocker changes. Do not log every poll.

State-snapshot stability should use cached bridge health for display continuity and require two consecutive failing /api/robot/state samples before leaving ready; command dispatch failures still record immediately.

### API Shape

Extend `/api/robot/state` with a compact stability object:

```json
{
  "nav2Stability": {
    "state": "ready",
    "currentBlocker": null,
    "lastReadyAt": "2026-06-23T00:00:00.000Z",
    "lastFailureAt": null,
    "lastRepairAt": null,
    "recentEvents": []
  }
}
```

Valid states:

- `ready`
- `degraded`
- `disconnected`
- `blocked`
- `unknown`

### UI Evidence

Show Nav2 stability near the map/status area:

- Current state
- Last ready time
- Last failure time
- Current blocker
- Recent transition summary

Use evidence labels:

- `Bridge unreachable: ECONNREFUSED 10.0.4.32:8893`
- `Action server missing`
- `/odom missing`
- `TF missing`
- `Lifecycle not proven`
- `/scan_nav2 missing`
- `Map pose untrusted`

Avoid generic `Disconnected` unless the evidence is truly transport failure.

### Probe Interference Check

The startup monitor currently checks every 12 seconds. If the Pi is slow, repeated health, lifecycle, SSH, or startup probes may increase load and look like random Nav2 flapping. `APP_DOGZILLA_STARTUP_MONITOR=0` disables only this log monitor; it does not stop rosbridge reconnects. The rosbridge client retries its WebSocket every 3 seconds after an unintentional close.

Add an explicit verification step:

- compare behavior with the monitor enabled and disabled
- compare Nav2 transition frequency and command success

Do not document or rely on `APP_DOGZILLA_STARTUP_MONITOR_INTERVAL_MS` until code adds support for it. Reconnect frequency is controlled by `RosbridgeClient.reconnectIntervalMs` (default 3 seconds).

## Implementation Order

1. ~~Create this UX plan and keep it updated as project knowledge.~~ (Done)
2. ~~Add Nav2 transition tracker and event log.~~ (Done - `lib/dogzilla-nav2-stability.mjs`)
3. ~~Expose `nav2Stability` through `/api/robot/state`.~~ (Done)
4. ~~Add the Operator Status strip using existing state plus `nav2Stability`.~~ (Done)
5. ~~Replace dot-only nav health with labeled full-chain state.~~ (Done)
6. ~~Make disabled next-action reasons visible.~~ (Done - visible blocker text in operator status strip)
7. ~~Move Emergency Stop into the persistent robot-operation area.~~ (Done)
8. ~~Add confirmations for dangerous actions.~~ (Done - custom modal)
9. ~~Clean up inert rail icons and drawer navigation confusion.~~ (Done - removed inert spans)
10. ~~Revisit mobile chat/audio views so robot state and Emergency Stop remain visible while commands can be sent.~~ (Done - operator status strip and E-stop visible in all mobile views)

## Test Plan

### Local Tests

Run:

```powershell
node --check public/app.js
node --check server.mjs
node --test test/frontend-modules.test.mjs
node --test test/dogzilla-navigation-status.test.mjs test/robot-sidecar-client.test.mjs test/system-healthz.test.mjs
```

### Live Validation

Use live checks only when robot is powered and reachable:

```powershell
npm run dogzilla:probe-nav
Invoke-RestMethod -TimeoutSec 8 http://127.0.0.1:3037/api/robot/state
Invoke-RestMethod -TimeoutSec 45 http://10.0.4.32:8893/healthz
ssh -F output/pi-ssh/config dogzilla "tail -n 20 /home/pi/robodoge/sidecars/dogzilla_lib_bridge/command_log.ndjson"
```

Validate:

- UI state matches live readiness evidence.
- `nav2-events.ndjson` records only transitions.
- Manual recovery controls show the failed prerequisite and the operator action path.
- A waypoint command shows accepted/moving/blocked state in the main operator area.
- Emergency Stop stays visible while the robot is moving.

## Non-Goals

- Do not redesign the visual brand.
- Do not rewrite trusted waypoint data automatically.
- Do not hide detailed errors behind generic connected/disconnected language.
- Do not change Nav2 tuning until event evidence identifies the failure mode.
- Do not add new dependencies unless a concrete implementation blocker appears.
