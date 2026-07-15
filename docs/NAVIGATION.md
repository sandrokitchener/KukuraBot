# DOGZILLA Navigation Notes

Read this for SLAM, Nav2, waypoints, map localization, pose, robot movement, and route dispatch.

## Source-of-truth order

1. Local Yahboom docs under `docs/DOGZILLA-main`, especially `14.Lidar course`.
2. Repo configs and code listed below.
3. Live Pi, bridge, and Nav2 state when behavior depends on robot.

Do not use generic ROS assumptions when local DOGZILLA docs or live evidence disagree.

## Yahboom documented flow

Relevant docs:

- `docs/DOGZILLA-main/14.Lidar course/1. Introduction use radar.pdf`
- `docs/DOGZILLA-main/14.Lidar course/Robot dog mapping.pdf`
- `docs/DOGZILLA-main/14.Lidar course/Robot Dog Navigation.pdf`
- `docs/DOGZILLA-main/14.Lidar course/5. Patrol.pdf`

Stable facts captured in repo docs:

- DOGZILLA uses ORADAR/MS200 LiDAR on HAT UART `/dev/ttyAMA1`.
- Mapping/localization is Cartographer-based.
- DOGZILLA has no physical chassis odometer; Cartographer/localization supplies odom-style data.
- Yahboom navigation docs point to `localization_imu_odom.launch.py` and `navigation2.launch.py`.
- Both Cartographer lua configs set `TRAJECTORY_BUILDER_2D.use_imu_data = false` because the DOGZILLA IMU endpoint (`/imu`) is not reliable. If IMU is restored, retest the full TF chain before re-enabling it.

## Current Robo-Doge

```text
trusted map -> base_link pose -> save waypoint in map frame with active-map identity -> Nav2 NavigateToPose
```

Key files:

| File | Role |
| --- | --- |
| `lib/dogzilla-map-frame.mjs` | Resolves legacy `app_map` waypoints from their immutable captured pose/origin metadata |
| `scripts/capture-dogzilla-map-pose.mjs` | Captures current pose into `config/robot-waypoints.json` |
| `sidecars/dogzilla_map_pose/relocalize_on_frozen_map.py` | Proves automatic frozen-map matches before localization becomes trusted |
| `lib/robot-command-compiler.mjs` | Resolves waypoint pose and builds dispatch plan |
| `lib/app-service.mjs` | Uses the same resolved runtime/ROS2 config for chat preview and robot dispatch |
| `lib/dogzilla-navigation-readiness.mjs` | App-side readiness evaluation |
| `sidecars/dogzilla_lib_bridge/nav2_client.py` | Direct bridge Nav2 client and runtime truth |
| `sidecars/dogzilla_navigation/start-navigation-in-container.sh` | Container-side Nav2 param/filter/launch script; waits for Pi-owned map-pose TF before Nav2 |
| `sidecars/dogzilla_navigation/tf_odom_publisher.py` | Publishes `/odom`; falls back to synthetic relative odom anchored at first `map->base_link` pose when no `odom` frame exists |
| `sidecars/dogzilla_navigation/scan_self_filter.py` | Masks LiDAR self-hits and publishes `/scan_nav2` |
| `sidecars/dogzilla_navigation/wait-nav2-ready.sh` | Bounded in-container readiness check for `/navigate_to_pose`, `/odom`, and `/scan_nav2` |

## Map and waypoint authority

- `config/robot-waypoints.json` is authoritative for real coordinates and trust fields.
- Registry contract: `activeSet -> sets[set].waypoints[name]`; each `map_pose` stores finite `x`, `y`, `yaw`, `frame`, `verified`, and, for trusted map entries, `mapId` plus `mapFingerprint`. `special` entries remain semantic targets and never dispatch as poses.
- The waypoint API accepts either a live waypoint-safe pose or an explicit `map`-frame pose. Explicit poses must be finite, within active-map bounds, and match supplied active-map ID/fingerprint; waypoint writes replace the JSON file atomically.
- Do not rewrite, downgrade, disable, or "correct" trusted waypoints without explicit user instruction.
- Legacy `app_map` entries are preserved during migration and may resolve only from their immutable `capturedMapPose`; a mutable current origin cannot make stale data trusted. `node scripts/migrate-waypoints-to-appmap.mjs` is dry-run by default, makes a timestamped source backup when applied, and writes the registry atomically.
- Charger-origin records are legacy waypoint metadata only. They do not move the live dot, seed Cartographer, or resolve new waypoints.
- Notes are never authoritative for dispatch or validation.
Active map identity is authoritative for dispatch. New waypoints are stored in the `map` frame with active map ID/fingerprint. Legacy `app_map` waypoints resolve only from immutable `capturedMapPose` or waypoint-owned origin metadata; no mutable current-origin fallback is allowed.

## Topic contract

Two independent topics carry occupancy grids on the DOGZILLA Pi:

| Topic | Publisher | Purpose |
| --- | --- | --- |
| `/map` | Nav2 `map_server` | Default static map for navigation and normal minimap polling |
| `/map_cartographer` | Cartographer occupancy grid | Explicit SLAM-only grid for advanced mapping sessions |

The live Cartographer grid contains raw probabilities (`0-100`), while saved `.pgm` output is thresholded into free/unknown/occupied. `public/robot-map.js` thresholds live cells so the minimap looks like the saved map:

- `-1` -> unknown.
- `0-50` -> free.
- `51-64` -> unknown.
- `65-100` -> occupied.

## Autonomous floor mapping

`Map This Floor` is an explicit mapping-only workflow. It is not enabled during normal AMCL/Nav2 operation.

1. Start the robot in clear, level open space and confirm the safety prompt.
2. Cartographer runs in mapping mode. Nav2 runs without `map_server` or AMCL and uses `/map_cartographer` as its global static costmap layer.
   Mapping must replace the systemd-owned localization container with a dedicated mapping container; force-restarting Cartographer through `docker exec` can make systemd restore localization before the explorer starts. The supervisor ready signal is sent only after action, odom, and filtered-scan readiness have each been observed; these DDS checks are latched across retries because Pi discovery can miss individual probes.
3. `frontier_explorer.py` chooses reachable, clear free cells adjacent to unknown space, then sends only `NavigateToPose` actions. It never publishes direct velocity.
   Its map subscription must match Cartographer's reliable/transient-local QoS, while `/scan_nav2` must use best-effort/volatile QoS; mismatched defaults leave the explorer at zero goals.
   Clearance rejects occupied cells but permits unknown cells beside a sufficiently large free patch; requiring every clearance cell to be known-free rejects every frontier by definition.
   A failed frontier is quarantined within 0.75 m so exploration tries another region instead of exhausting retries on one unreachable goal. Any successful goal clears that quarantine. Goal timeout means 45 seconds without at least 0.1 m of approach, with a five-minute hard ceiling; six distinct consecutive failed regions stop the run.
4. It stops on stale SLAM or scan data, missing `map -> base_link` TF, repeated Nav2 failures, goal timeout, goal limit, no safe frontier, or the Finish Mapping stop file. Any orderly explorer exit saves a candidate before cleanup, including a safety stop after repeated frontier failures, so partial SLAM work remains reviewable instead of being discarded.
5. Finish Mapping saves `maps/candidates/<id>/` only. It restores the previous map only when that active manifest has a verified Cartographer PBSTREAM. For an occupancy-only scanner map, it stops in `candidate-ready`; promote the candidate to resume localization/navigation.
6. Use Candidate Map is a separate, confirmed promotion step. Candidate metadata records SHA-256 for all three artifacts; promotion rejects missing or altered artifacts, updates `robodoge_home.*` through the persistent `robodoge-rosbridge` container (the mapping workflow may have stopped `robodoge-map-pose`), clears the stored origin, and restarts localization and Nav2. Review the live map before finishing and recapture waypoints if geometry moved.

Finish Mapping succeeds only when the supervisor is still active and its result proves a candidate was saved. A finished or failed explorer session must return a direct error instead of waiting on or accepting an old result file. Windows-launched SSH commands are non-interactive (`ssh -n`) so an open Node stdin pipe cannot keep the HTTP action pending after the remote command exits.

Map-control button state comes from Pi-owned `autonomous-mapping.active`, ready, status, and result files exposed by the direct bridge. Mapping counts as active only after the ready signal exists and the marker's supervisor PID still belongs to `autonomous_mapping_supervisor.sh`; the hidden transient starting unit reserves the launch during the Cartographer handoff. Initial load and recurring `/api/robot/health?lite=1` polling must restore active/candidate state: active mapping disables Map This Floor and Continue Current Map, enables Finish Mapping, and a self-stopped session with a saved candidate disables Finish Mapping and enables Use Candidate Map.

Map save captures a fresh `map -> base_link` pose while Cartographer is still in `mapping` or `continue_mapping`, before `/write_state` and before localization restoration. Candidate promotion preserves this `resumePose` only as history and an optional global-matching search hint; it is never a destination or localization proof.

Continue Current Map performs no pre-mapping drive. After battery/gait safety and duplicate-job checks, it reserves the job, stops Nav2, and runs bounded global scan matching against the frozen active PBSTREAM from the robot's current location. A successful match supplies a fresh recovered `map -> base_link` pose. Cartographer then reloads every saved trajectory as frozen and starts a new mapping trajectory at that recovered pose, anchored to the root map-frame trajectory; a later matched trajectory is recorded as proof but is not incorrectly treated as the map coordinate frame. Failure leaves the active map unchanged, stops the mapping supervisor, restores one normal localization process, releases the recovery lock, and leaves Nav2 blocked until localization trust is proven again. The robot may start anywhere inside the mapped area, but LiDAR still needs enough distinctive, unchanged geometry to prove the match.

Nav2 velocity now has an independent last-line collision gate: controllers publish `/cmd_vel_nav`, the smoother publishes `/cmd_vel_raw`, `nav2_collision_monitor` consumes `/scan_nav2` and publishes guarded `/cmd_vel`, and only `/cmd_vel` reaches the gait adapter. The stop polygon covers front and rear around the robot; stale LiDAR fails closed. DOGZILLA's Pi scan timestamps have observed ~0.55 s scheduling jitter, so the default collision source timeout is 0.75 s (`DOGZILLA_NAV2_COLLISION_SOURCE_TIMEOUT`) — still fail-closed for longer gaps. Keep the collision monitor in the navigation lifecycle manager and never route smoother output directly to hardware.

The mapping launcher explicitly posts `navigate` to the direct bridge after starting mapping Nav2. A same-mode `navigate` request cancels any pending standby timer so an old timer cannot pause the replacement lifecycle manager during exploration.

This workflow still requires live Pi validation before unattended use. Test collision stopping, stair boundaries, scan freshness, Cartographer TF, Nav2 action results, and real robot motion in an empty, bounded area first.

## Direct bridge Nav2 readiness

Direct bridge runtime truth distinguishes action discovery from waypoint-ready stack truth:

- `navigation.actionServerDiscovered` reports whether `/navigate_to_pose` was visible in the ROS graph during the latest discovery check.
- `navigation.waypointReady` / `navigation.available` require `can_send_goal()` to be true — the active backend must be able to actually send goals. If Docker goal sending is disabled or the host action client is missing, `waypointReady` is `false` even when lifecycle nodes, `/odom`, and `/scan_nav2` are live.
- `send_goal` still waits for the real `NavigateToPose` action server before accepting a waypoint command. Do not remove that send-time wait.
- App command preflight keeps full `/healthz` lifecycle status diagnostic when direct bridge command path is usable (`canSendGoal=true`, action server visible, `/odom` live with TF, `/scan_nav2` available). In that state dispatch proceeds and bridge `send_goal` is authority.

When startup or preflight says the action server is blocked but lifecycle, `/odom`, and `/scan_nav2` are green in `/healthz`, treat action discovery as diagnostic evidence, not automatic proof that Nav2 is down.

## Waypoint capture requires continuous tracking

DOGZILLA runs Cartographer in laser-only localization mode (`use_imu_data = false`, `use_odometry = false`). Normal tracking uses a local scan-matching window; `Relocalize on Map` is the separate bounded global matcher for carried or otherwise lost robots.

The robot must be driven to each waypoint spot before capture so pose tracking stays continuous. Carrying the robot and setting it down can leave `waypointSafe: true` while the pose is wrong because that flag only proves fresh `map`-frame TF, not physical correctness.

If Nav2 cannot drive to a spot, use manual controls. If the robot was carried, run `Relocalize on Map`. When automatic frozen-map matching cannot prove a safe match, localization stays untrusted: the floor-plan dot remains hidden and waypoint navigation remains blocked instead of guessing a pose.

## Readiness checks

`robodoge-rosbridge.service` must prove at least one live `/scan` `LaserScan` sample at startup and continue watchdog checks. Process ownership of `/dev/ttyAMA1` or a visible `/scan` publisher is not enough, because Cartographer can advertise dependencies yet never produce `map->base_link` without real scan samples.

Fast commands live in `docs/COMMANDS.md`.

Startup/preflight readiness is based on:

1. `nav2_msgs` import works.
2. `/odom` has live samples and odom-to-base TF.
3. Nav2 lifecycle nodes are active.
4. `/scan_nav2` has a live publisher and costmap subscribers.
5. `/navigate_to_pose` action discovery is reported, but Pi DDS discovery misses are tolerated at bridge readiness if the rest of the stack is proven.

The operator Nav chain keeps these signals distinct: `LiDAR` is raw `/scan` health, `Localization` is a fresh waypoint-safe `map->base_link` pose, and `Filtered scan` is Nav2's `/scan_nav2` publisher/subscriber readiness. Missing probe data is `unknown`, not failed. When the active map lacks the verified Cartographer PBSTREAM required for localization, show that root blocker and suppress downstream Nav2 symptoms until the map is promoted.

For direct-bridge `locomotion.goto`, `obstacleAvoidance.mode = "nav2_costmap"` must validate `/scan_nav2`, not raw `/scan`. Raw `/scan` remains for rosbridge/LiDAR transport and non-Nav2 avoidance flows only.

The app rosbridge client intentionally subscribes only to throttled `/scan`, `/tf`, `/tf_static`, and `/odom` by default. Do not add `/map_cartographer` back to default `rosbridgeTopics`; full occupancy grids are large JSON payloads and can make `rosbridge_websocket` memory climb on the Pi.

The repo odom helper first uses `odom->base_link`; if absent, it anchors the first live `map->base_link` pose and publishes synthetic relative `/odom`. Do not publish raw global map pose as odom.

The scan filter and odom helper run as direct background processes inside the rosbridge container. Nav2 readiness latches action/odom/scan discovery across 40 bounded, parallel probe rounds (120 seconds worst case); ROS2 CLI calls are capped at 2 seconds because `ros2 topic info` and `ros2 action list` can hang under Pi DDS/daemon load.

Nav2 startup must not fail solely on a short `ros2 topic info /scan_nav2` miss. The scan filter gate waits up to 45 seconds and accepts either publisher discovery or a one-message `/scan_nav2` sample before launching Nav2; otherwise DDS discovery lag can leave only partial helpers running and no lifecycle nodes.

## Direct bridge hardware ownership and stop semantics

The direct bridge must own `/dev/ttyAMA0` exclusively during live navigation. Yahboom's `app_dogzilla.py` and `oled_dogzilla.py` (including the `yahboom_oled.service` unit) must be stopped before the bridge starts. `scripts/stop-dogzilla-vendor-app-ssh.ps1` stops the service, kills both processes, and fails if either still holds `/dev/ttyAMA0` open. `scripts/install-dogzilla-boot-services-ssh.ps1` adds `Conflicts=yahboom_oled.service` to `robodoge-direct-bridge.service`, runs an equivalent privileged `ExecStartPre=+` vendor-stop flow, and disables `yahboom_oled.service` after enable.

`/dev/ttyAMA1` remains LiDAR/ROS-owned; do not stop or repurpose it.

The bridge distinguishes two stop paths:

- `emergency_stop` (reason `emergency_stop`): latches `/nav2/cmd_vel` blocked until an explicit unlatch path is used. A subsequent `locomotion.goto` does **not** silently clear this safety block.
- `command_preempt` (reason `command_preempt`): cancels the active Nav2 goal and stops robot motion, but does **not** latch `/nav2/cmd_vel` blocked. A fresh `locomotion.goto` clears any stale command-preempt gate before readiness checks. `_execute_command_preempt()` also defensively clears any stale `command_preempt` block before returning.

The app Stop button mirrors live `/healthz-lite` latch state. It is red and labeled `Stop` when clear; while `gaitBlockedReason=emergency_stop`, it becomes gray and says `Stopped`. Clicking `Stopped` sends the explicit `clear_emergency_stop` command and never relies on a waypoint command to unlatch safety. The button starts and falls back to disabled `Unknown` whenever live latch state cannot be confirmed; click results never update it optimistically.

## Navigation execution contract

The async goto path uses a normalized app-facing delivery contract:

| `delivery` | Meaning |
| --- | --- |
| `"accepted"` | Nav2 `NavigateToPose` goal was accepted by the action server. Background motion monitor started. HTTP 202. |
| `"rejected"` | Prerequisites failed, goal was rejected, or promote timeout hit. HTTP 422. Includes `error` and `blockers`. |

The original internal delivery name (e.g. `"Nav2 NavigateToPose"`) is preserved under `deliveryDetail` for diagnostics.

**Single goal send invariant:** The synchronous phase sends the goal exactly once. The background thread (`_monitor_background_motion`) only monitors motion — it must NOT call `runtime.execute()` or `nav2_client.send_goal()` again.

**Motion status values** (set by the background monitor):

Operator UI status must use current runtime evidence: `motionStatus: "moving"` for walking, fresh connected `/scan` frames for live LiDAR, initialized speech provider/microphone state for speech readiness, and verified bridge health for repair. Do not report live, ready, repaired, walking, or idle from elapsed time, cached scan presence, config presence, command acceptance, process launch, PID, or launcher exit alone.

| `motionStatus` | Meaning |
| --- | --- |
| `"moving"` | Gait adapter count increased OR odom timestamp advanced. Goal acceptance alone is NOT `"moving"`. |
| `"no-motion"` | Goal accepted but neither gait nor odom changed within the window. |
| `"cancelled"` | Navigation cancel event was set. |
| `"failed"` | Background monitor threw an exception. `monitorError` field contains the detail. |

Live acceptance proof is `delivery: "accepted"` plus `goalAccepted: true` and then `motionStatus: "moving"` from gait/odom evidence. That proves Nav2 dispatch and motion start, not full arrival. If the robot starts walking then loses battery/current, stop the test and treat arrival quality as unverified until charged.

The motion monitor uses lightweight cached state only — `runtime.nav2_gait_adapter_count` (in-memory counter) and `nav2_client._odom_snapshot()` (reads cached fields). It does NOT call `_refresh_status(force=True)` or Docker probes in a loop.

**Readiness invariant:** `waypointReady=true` requires `can_send_goal()` to be true. If Docker goal sending is disabled or the host action client is missing, `waypointReady` is `false` even if the lifecycle/odom/scan stack is otherwise active.

**Promote timeout:** `DOGZILLA_NAV2_PROMOTE_TIMEOUT_SEC=45` (poll every `DOGZILLA_NAV2_PROMOTE_POLL_SEC=2` s). If the timeout hits, the response includes the latest blockers collected during polling (action missing, odom missing, lifecycle inactive, scan missing, cannot send goal, etc.), not a generic timeout message.

`/healthz-lite` exposes: `navMode`, `loadAverage`, `gaitBlocked`, `gaitBlockedReason`, `nav2Ready`, `waypointReady`, `nav2Backend`, `canSendGoal`. Use `/healthz-lite` for frequent UI polls; full `/healthz` is for diagnostics or failures only.

## Navigation Modes And SLAM Ownership

The direct bridge exposes navigation-mode state (`idle` / `localize` / `navigate` / `sleep`) for UI and command gating. These modes are logical state in the app/bridge layer; Pi boot/systemd owns the running Cartographer/Nav2/scan-filter processes.

Control modes via bridge:

- `GET /mode` returns current mode transition history.
- `POST /mode` with `{"mode": "localize|navigate|idle|sleep"}` updates bridge mode and, when standby is enabled, Nav2 lifecycle state. It must not start, stop, reinstall, recreate, or delete Nav2/map-pose services.
- When `DOGZILLA_NAV2_STANDBY_ENABLED=1`, `idle`, `localize`, and `sleep` pause Nav2 through `/lifecycle_manager_navigation/manage_nodes`; Cartographer, LiDAR, rosbridge, and systemd service ownership remain active. `navigate` resumes Nav2. `idle`/`localize` waypoint dispatch auto-wakes; `sleep` still requires explicit wake.
- Posting the current `navigate` mode is meaningful: it cancels a pending idle demotion. Keep this behavior for long-running operator-owned mapping sessions.
- `locomotion.goto` talks to already-running Pi-owned Nav2, waits bounded readiness (45 s timeout, 2 s poll, latest blockers returned on timeout), and sends goal synchronously.
- If Nav2 is unavailable, app/server reports blockers. It does not auto-repair or auto-start navigation.
- Default startup mode is `navigate`, matching the Pi boot contract: Nav2 should already be running before the app starts.

Pi boot/systemd owns normal map-pose/Nav2 lifetime. `robodoge-rosbridge.service` keeps the shared ROS container running, `robodoge-map-pose.service` starts Cartographer localization, and `robodoge-navigation.service` runs `sidecars/dogzilla_navigation/start-navigation-in-container.sh` inside `robodoge-rosbridge` with `DOGZILLA_LOCALIZATION_BACKEND=cartographer`. `npm start`, `npm run dev:lan`, command dispatch, and server health polling do not request `/mode navigate` as startup repair and do not call `start-map-pose` or `start-navigation`.

Startup scripts must not install ROS packages during normal boot. If Nav2, Cartographer, or `nav2_msgs` dependencies are missing, the Pi-owned service should fail loud so the image/setup can be fixed explicitly.

SLAM is the explicit exception: the operator-owned New Map / Save Map workflow uses `start-map-pose-mapping` and `save-map-pose` to switch Cartographer into mapping mode, save the new map, then restart localization against that map. That flow is intentional and separate from normal app startup or waypoint dispatch.

## Velocity smoother bypass

If Nav2 accepts a goal but `/cmd_vel` stays silent (dog does not move), the velocity smoother may be stalling. Bypass it by pointing the gait adapter at raw controller output:

```bash
export DOGZILLA_NAV2_GAIT_SMOOTHER_BYPASS=1
```

This sets `DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC=/cmd_vel_nav` (raw controller output) instead of `/cmd_vel` (smoothed output). Only enable this after confirming Nav2 accepts goals; tune the smoother after movement is restored.

`/healthz-lite` includes compact feedback: `navMode`, `loadAverage`, `gaitBlocked`, `gaitBlockedReason`, `nav2Ready`, `waypointReady`, `nav2Backend`, `canSendGoal`. Full `/healthz` is for diagnostics or failures only.
## Starting and deploying

Manual repair scripts still use bounded retry (`lib/dogzilla-start-retry.mjs`, backoff 0/2s/5s), but normal app/server startup does not call them.

```powershell
npm run dogzilla:start-navigation
```

Normal app startup and command-time waypoint dispatch do not start map-pose or Nav2. `lib/robot-sidecar-client.mjs` reports readiness blockers when the Pi-owned stack is down. Use the manual scripts below only for explicit operator repair.

`scripts/start-dogzilla-map-pose-ssh.ps1` copies the map-pose sidecar and starts bounded Cartographer localization. `scripts/start-dogzilla-navigation-ssh.ps1` copies `sidecars/dogzilla_navigation` and `sidecars/dogzilla_map_pose` to the Pi, then runs `start-navigation-in-container.sh` inside `robodoge-rosbridge` with `DOGZILLA_LOCALIZATION_BACKEND=cartographer`.

Startup scripts are Windows PowerShell-driven SSH launchers. Avoid PowerShell heredocs sent through SSH, serialize apt work through startup locks, and use parent-safe `pgrep` stop loops for background services.

`start-navigation-in-container.sh` must stop any stale Nav2 launch, AMCL, and Nav2 lifecycle executables before starting a new stack. Leaving an old `map_server` active makes the new lifecycle manager collide on `/map_server` and abort bringup even when the replacement map loads correctly.

## Cartographer/Nav2 Docker image

The rosbridge/map-pose containers share custom image `robodoge/ros-humble-cartographer:1.0`, based on `yahboomtechnology/ros-humble:3.6` with Cartographer, Nav2, and `ros-humble-rosbridge-server` pre-installed. Pre-baking avoids repeated multi-minute apt installs and dpkg-lock races after Pi reboots.

Key files:

| File | Role |
| --- | --- |
| `sidecars/dogzilla_map_pose/Dockerfile` | Image definition |
| `scripts/build-dogzilla-docker-image-ssh.ps1` | Builds image on Pi |
| `scripts/install-dogzilla-boot-services-ssh.ps1` | Deploys systemd units using the image |

## Map workflow

```powershell
npm run dogzilla:start-map-pose
npm run dogzilla:validate-waypoints
```

In UI Mini Map > Map Controls:

Map Controls keeps mapping, alignment, waypoint capture, and navigation restart in one panel. `Map This Floor` starts fresh autonomous mapping; `Continue Current Map` globally relocalizes at the robot's current position, starts a new mapping trajectory on the verified frozen PBSTREAM, and runs the same frontier explorer without first walking to a saved point. Finish Mapping saves either session as a reviewable candidate. The operator UI no longer exposes origin capture or the redundant waypoint-readiness button.

Use the primary Build / Save Map row for SLAM: Start New Map -> drive slow overlapping loops -> Save Map. Save Map promotes the new default only after Cartographer writes `.pbstream` and conversion produces Nav2 `.yaml`/`.pgm`; otherwise the previous default stays active. Successful Save Map restarts localization against the saved map.

`Relocalize on Map` performs bounded global scan matching against the active frozen PBSTREAM. The active manifest's `resumePose` is only a search hint; it never grants trust. Recovery temporarily consumes every scan, adds at most one node per second, and preserves its recovered trajectory when handing state to normal localization. The recovery `FinishTrajectory` RPC and its finished-state poll use the longer finish timeout so Cartographer's final optimization can settle under Pi load. Trust still requires at least three distinct cross-trajectory constraint matches at or above 55%; fresh TF alone is insufficient. Nav2 must be proven inactive or paused before TF changes; prior active state is restored only after normal localization produces stable fresh map TF without losing the recovered pose, while intentionally inactive state remains inactive. Failure keeps localization untrusted, hides the floor-plan dot, and blocks waypoint navigation.

The UI map panel must make SLAM state explicit: Start New Map switches the mini-map into top-down mode, shows occupancy-grid, live LiDAR, and waypoint layer states, then keeps Save Map available for the active SLAM session. If the grid is not ready yet, the save action should fail with bridge evidence instead of silently staying grayed out. Use the Manual Control forward-gait slider for slow mapping passes; it scales only positive forward gamepad motion before `/api/robot/manual-control` dispatch.

During an active SLAM pass, `/api/dogzilla/map?stream=slam` subscribes to configured `lidar.mapTopic` (`/map_cartographer` by default); normal map polling must not add full occupancy grids to the default rosbridge topic list.

## Waypoint recapture

When a saved waypoint no longer aligns with physical space, recapture it explicitly. Cartographer laser-only localization does not require Nav2 or odometry, but it cannot globally relocalize after the robot is carried.

Drive the robot to the physical waypoint spot, wait for trusted localization plus `waypointSafe: true`, then use `Recapture here`. The endpoint overwrites that waypoint in `config/robot-waypoints.json` in the active `map` frame with current map identity.

There is no batch recapture: the robot must physically be at each waypoint spot. Recapture is always explicit; waypoints are never silently rewritten or downgraded.

## Waypoint registry controls

The Map Controls waypoint registry exposes rename, confirmed delete, and revalidate actions. Rename moves the existing definition without changing its pose or provenance. Delete removes only the named entry after browser confirmation. Revalidate requires live active-map metadata and the existing pose to pass the same map-bounds validator; it then refreshes map metadata and marks the entry verified. Stale entries remain visible but are not dispatchable until revalidated or recaptured.

The matching API routes are `PATCH`/`DELETE /api/dogzilla/waypoints/:name` and `POST /api/dogzilla/waypoints/:name/revalidate`. `config/robot-waypoints.json` remains the authoritative store.

## Chat waypoint dispatch

Chat command handling must use the same resolved runtime and ROS2 config for preview and dispatch. The direct DOGZILLA target should not stop at "Robot preview ready" when `dispatchOnChat` is enabled and a ready waypoint command compiles. Verify with `robotDispatch.status`, not just assistant text. Follow requests remain unsupported until the operator resolves to a dispatchable map waypoint; do not emit `behavior.follow_*` plans to the bridge.

## Tuning

`config/robot-obstacle-avoidance.json` carries Nav2 tuning knobs, including robot radius, inflation, scan filter mask, yaw tolerance, XY tolerance, controller/planner frequency, and movement allowance. Current config makes final yaw effectively non-blocking with `yawGoalTolerance: 6.283`.

Autonomous gait is hard-limited to the earlier conservative behavior: forward stride cannot exceed `8`, lateral commands and Nav2 Y velocity are always zero, and gait stays `walk/slow` with trot disabled. Runtime/environment overrides cannot re-enable strafing or exceed the stride ceiling. Prior larger/crab steps made DOGZILLA fall.

Direct-bridge relative motion keeps non-gamepad lateral movement disabled by default (`DOGZILLA_LOCOMOTION_MAX_LATERAL_STEP=0`), while explicit gamepad input has a separate conservative cap (`DOGZILLA_MANUAL_MAX_LATERAL_STEP=1`). This manual exception does not enable Nav2 lateral motion.

Cartographer fresh-mapping configs use widened online correlative scan matching (`linear_search_window = 0.6`, `angular_search_window = 45 deg`, constraint scores `0.65`) because DOGZILLA has no reliable wheel odom/IMU; narrow `0.1 m / 15 deg` matching can collapse a whole-house drive into a first-room trajectory.

## Known live-work rules

- For "spins/goes nowhere", inspect live costmap, scan, timeout, and recovery evidence before changing planner assumptions or waypoint data.
- Local tests prove plumbing, not live route correctness.
- If robot is low battery or unhealthy, pause live motion retries and continue only local code/tests.
- If robot heads the wrong way, verify translation direction and heading/orientation early.
- For waypoint capture, drive the robot to the spot. Carrying it can leave `waypointSafe` true while pose is wrong.

## Cartographer load notes

`DOGZILLA_MAP_POSE_OCCUPANCY_GRID=auto` starts `cartographer_occupancy_grid_node` only for `mapping` / `continue_mapping`. Keep localization mode grid-off by default; force grid only when debugging live SLAM/localization display.

The autonomous mapping explorer runs under transient host systemd supervision. Normal completion or Finish Mapping saves a candidate when possible, then restores localization and Nav2. Explorer failure, timeout, or restore failure still stops mapping Nav2 processes so a stale mapping session cannot leave the Pi at mapping load indefinitely.

Cartographer localization configs keep same scan-match window but process half of rangefinder messages, publish submaps/trajectory less often, optimize less often, and sample pose-graph constraints less aggressively. Do not set `TRAJECTORY_BUILDER.pure_localization` on this Humble Cartographer build; live test showed it aborts startup with `Key 'pure_localization' was used the wrong number of times`. Preserve split: mapping configs favor recovery/coverage, localization configs favor lower Pi CPU while keeping `map->odom/base_link` fresh enough for Nav2.

Continue Current Map is one remote `docker exec` transaction. A nonzero relocalization result must not trigger a second exec or a second global relocalization during rollback. Failed recovery cleans orphaned recovery-namespace Cartographer processes, restores one normal localization process, releases its lock, and leaves Nav2 blocked until localization trust is proven again.

## More detail

- `docs/COMMANDS.md`
- `docs/archive/dogzilla-real-map-pose.md`
- `docs/archive/waypoint-mapping-guide.md`
- `docs/archive/dogzilla-waypoint-navigation-evaluation.md`

