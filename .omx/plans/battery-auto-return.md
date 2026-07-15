# Battery auto-return plan

## Outcome

When the Pi sees two consecutive fresh battery readings at or below 30%, Questing Beast cancels its current task and uses existing Nav2 waypoint navigation to walk to a verified `charger` staging waypoint. It then stops and waits for manual plug-in. If safe navigation is unavailable, it stops in place and reports the blocker instead of guessing.

Autonomous electrical docking is out of scope until the robot has charging contacts plus a close-range alignment sensor. Existing `charger_origin` records are map-frame metadata, not dispatchable waypoints.

Manufacturer constraints: charging uses a physical plug on the robot's bottom interface, inserting it cuts power output and shuts down the Raspberry Pi, the power switch should be off while charging, and charging should be supervised. `read_Battery()` returns integer percent `1-100`; `0` means read failure, not empty. The manual's nominal lie-down point is below 9%, but the observed physical collapse near 25% is the controlling safety evidence for this robot.

## Safety policy

- Run the monitor inside `robodoge-direct-bridge.service` on the Pi so browser/desktop closure cannot disable it.
- Default trigger: fresh battery `<= 30%`, confirmed by 2 consecutive reads 5 seconds apart.
- Trigger once per discharge cycle; re-arm only after a fresh reading reaches `>= 35%`.
- During return, reject external motion commands. Still allow emergency stop and the internally tagged battery-return goal.
- Require trusted localization, active-map-valid verified charger waypoint, Nav2 `waypointReady`, and LiDAR costmap avoidance before movement.
- Use Nav2 result completion, not goal acceptance or first-motion evidence, as arrival proof.
- On arrival: stop, play one cue, expose `awaiting_manual_charge`, and tell operator to save work, power off, and connect charger. Do not auto-shutdown before operator reaches robot.
- On missing/stale battery, missing waypoint, untrusted localization, Nav2 failure, timeout, or emergency stop: cancel navigation, apply safe stop, latch failure, expose exact reason, and do not retry-loop.
- Field-tune trigger upward if the farthest expected route cannot arrive with at least 3 percentage points above the observed 25% collapse zone. Keep 30% only if live testing proves that reserve.

## Implementation sequence

1. Capture and prove charger staging waypoint
   - Place a normal `charger` waypoint 0.5-1.0 m from the charger, with turning clearance and final heading suitable for manual plug-in.
   - Save it through existing waypoint capture flow; do not reuse or rewrite `charger_origin`.
   - Verify active-map identity, `verified: true`, bounds, localization trust, and a manual round-trip from the farthest normal operating area.

2. Add Pi-owned return controller
   - In `sidecars/dogzilla_lib_bridge/server.py`, add one daemon monitor owned by `BridgeServer`/`DogzillaRuntime`; reuse `_battery_safety_snapshot()`, `_execute_goto()`, cancellation, LiDAR checks, and safe-stop paths.
   - Load selected waypoint from existing `config/robot-waypoints.json`; add no new config file or dependency.
   - Configure with `/etc/robodoge/dogzilla.env` values: `DOGZILLA_AUTO_RETURN_ENABLED`, `DOGZILLA_AUTO_RETURN_PERCENT` (30), `DOGZILLA_AUTO_RETURN_RECOVERY_PERCENT` (35), `DOGZILLA_AUTO_RETURN_CONFIRM_SAMPLES` (2), and `DOGZILLA_AUTO_RETURN_WAYPOINT` (`charger`).
   - Add minimal states: `disabled`, `armed`, `returning`, `arrived`, `failed`. Persist only current state in memory; restart re-evaluates fresh battery and waypoint readiness.
   - Dispatch a tagged `locomotion.goto` with `waitForResult: true`; do not duplicate the HTTP handler's async goal-monitor path.

3. Enforce priority and observability
   - While `returning`, let battery-return own navigation. New external goto/manual/trick commands return a structured `battery-return-active` rejection.
   - Add `batteryReturn` to `/state`, `/healthz-lite`, and `/feedback`: state, threshold, confirmed samples, waypoint, started/completed timestamps, final battery, and blocker/result.
   - Show one operator banner and optional existing audio cue on trigger/failure/arrival; no new UI panel.

4. Install safely
   - Update `scripts/install-dogzilla-boot-services-ssh.ps1` to write disabled-safe defaults to `/etc/robodoge/dogzilla.env`.
   - Deploy bridge/config changes to Pi, restart only `robodoge-direct-bridge.service`, verify deployed hashes and active service, then enable auto-return only after charger waypoint proof.

## Tests

- Python unit tests with fake battery sequences: no trigger above 30; one low sample does not trigger; two fresh low samples trigger exactly once; invalid/zero/stale samples never start blind navigation; recharge to 35 re-arms.
- Controller tests: verified charger goal reaches `_execute_goto()` once; unverified/missing/out-of-map waypoint, untrusted localization, unavailable Nav2, timeout, and emergency stop all produce safe stop plus stable failure state.
- Priority tests: external movement is blocked during return; emergency stop remains allowed; internally tagged return goal is allowed; no retry storm after failure.
- Status contract tests for `/state`, `/healthz-lite`, `/feedback`, and operator banner.
- Existing focused suites: `test/test_dogzilla_lib_bridge.py`, navigation contract tests, robot sidecar/status tests, syntax checks, and `git diff --check`.

## Live acceptance

1. Bench: robot supported or in open space; simulate threshold above current charge. Confirm one trigger, correct target, no duplicate goals, and emergency-stop cancellation.
2. Short route: start 1-2 m from charger at safe charge, temporarily set trigger above current reading, confirm physical arrival and final safe stop, then restore 30%.
3. Worst route: start at farthest intended operating point with trusted localization. Confirm arrival, obstacle avoidance, no falls, and at least 28% remaining. If reserve is lower, raise trigger to 35% and repeat.
4. Restart/browser-off: close UI and restart desktop server while Pi service remains active; confirm Pi-owned monitor still returns the robot.
5. Failure drill: make Nav2 unavailable at trigger; confirm robot does not wander, safely stops, and exposes actionable failure.

Completion requires local tests, deployed hash/service proof, and visible live arrival. Goal acceptance alone is insufficient.
