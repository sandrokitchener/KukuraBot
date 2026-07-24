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
| `sidecars/dogzilla_navigation/tf_odom_publisher.py` | Publishes `/odom` from the real `odom->base_link`; an explicit-only synthetic fallback retires permanently when real authority appears |
| `sidecars/dogzilla_navigation/scan_self_filter.py` | Masks LiDAR self-hits and publishes `/scan_nav2` |
| `sidecars/dogzilla_navigation/wait-nav2-ready.sh` | Bounded or continuous in-container validation of lifecycle, fresh sensor/TF data, action server, scan use, and exact ROS velocity ownership |

## Map and waypoint authority

- `config/robot-waypoints.json` is authoritative for real coordinates and trust fields.
- Registry contract: `activeSet -> sets[set].waypoints[name]`; each `map_pose` stores finite `x`, `y`, `yaw`, `frame`, `verified`, and, for trusted map entries, `mapId` plus `mapFingerprint`. `special` entries remain semantic targets and never dispatch as poses.
- The waypoint API accepts either a live waypoint-safe pose or an explicit `map`-frame pose. Explicit poses must be finite, within active-map bounds, and match supplied active-map ID/fingerprint; waypoint writes replace the JSON file atomically.
- Waypoint capture depends on that trusted current pose, not Nav2 dispatch readiness. Keep capture available during transient Nav2 blockers and let the waypoint API return the precise pose/map validation error.
- Do not rewrite, downgrade, disable, or "correct" trusted waypoints without explicit user instruction.
- Legacy `app_map` entries are preserved during migration and may resolve only from their immutable `capturedMapPose`; a mutable current origin cannot make stale data trusted. `node scripts/migrate-waypoints-to-appmap.mjs` is dry-run by default, makes a timestamped source backup when applied, and writes the registry atomically.
- Charger-origin records are legacy waypoint metadata only. They do not move the live dot, seed Cartographer, or resolve new waypoints.
- Notes are never authoritative for dispatch or validation.
Active map identity is authoritative for dispatch. New waypoints are stored in the `map` frame with active map ID/fingerprint. Legacy `app_map` waypoints resolve only from immutable `capturedMapPose` or waypoint-owned origin metadata; no mutable current-origin fallback is allowed.

The active-map manifest is also a fail-closed runtime contract. It must contain a non-empty map ID plus path and SHA-256 metadata for the YAML and PGM; PBSTREAM path/hash metadata is required whenever a PBSTREAM is declared. Every artifact must exist and match its hash, and the YAML `image` reference must resolve to the same PGM named by the manifest. The app, direct bridge, map-pose launcher, and Nav2 launcher reject missing, partial, altered, or YAML-to-PGM-incoherent manifests instead of guessing from filenames.

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
   The in-container Nav2 readiness watcher must receive the active mapping-mode flag. Passing normal mode makes it require the intentionally absent `map_server` and tear down a healthy mapping stack after the startup timeout.
3. `frontier_explorer.py` chooses reachable, clear free cells adjacent to unknown space, then sends only `NavigateToPose` actions. It never publishes direct velocity.
   Its map subscription must match Cartographer's reliable/transient-local QoS, while `/scan_nav2` must use best-effort/volatile QoS; mismatched defaults leave the explorer at zero goals.
   Clearance rejects occupied cells but permits unknown cells beside a sufficiently large free patch; requiring every clearance cell to be known-free rejects every frontier by definition. Continue Current Map rejects a global match that jumps more than 2 m from the saved pose hint, preventing a stable but wrong look-alike match from duplicating walls over the frozen map. Heading is not compared because a carried quadruped may legitimately be set down facing another direction; the three-node, 55%-minimum frozen-map constraint proof remains authoritative.
   Nav2 action results are authoritative for goal failure. Before the first goal, the supervisor reuses `wait-nav2-ready.sh` in mapping/one-shot mode and will restore localization without sending a frontier if the complete lifecycle, sensor, TF, action, collision-gate, and gait chain is not ready. A 90-second hard ceiling cancels an attempt that never returns a Nav2 result and excludes its 0.5 m neighborhood; map-frame distance does not cancel a moving goal because Cartographer corrections are not physical odometry. The explorer also watches the collision-monitor-guarded `/cmd_vel`: rotation-dominant commands above the gait deadbands are canceled after eight accumulated seconds and excluded, while forward-plus-turn commands remain allowed. Failed/stalled goal entries retain their reason, and the supervisor preserves the latest mapping Nav2 log before normal navigation overwrites it. Reachable frontiers hidden only by exclusions are reported as stopped, not complete coverage.
   Mapping-mode DWB inserts the installed `PreferForward` critic after obstacle rejection (`DOGZILLA_NAV2_MAPPING_PREFER_FORWARD_SCALE`, default `20.0`). It penalizes trajectories that turn excessively so a safe forward arc wins, but it does not remove zero-linear trajectories or bypass the collision monitor; a necessary in-place pivot remains available and is still bounded by the explorer's rotation watchdogs.
   Mapping also keeps `min_vel_x=0` for those pivots while requiring any nonzero translation to reach `DOGZILLA_NAV2_MAPPING_MIN_SPEED_XY` (default `0.13 m/s`, DOGZILLA `xStep 4`). This prevents low-amplitude shuffling on wood without hiding the effective forward speed from DWB or the collision monitor.
   Mapping status records `successfulGoalCount` only from a terminal Nav2 `SUCCEEDED` result; goal acceptance or partial movement does not count as a reached frontier. The explorer selects the nearest safe frontier in the robot's forward half-plane and sends one goal at a time. Cartographer map-frame yaw remains diagnostic only; the independent eight-second rotation-dominant command cutoff prevents sustained spinning.
4. It stops on stale SLAM or scan data, missing `map -> base_link` TF, goal limit, no safe frontier, or the Stop Early request. A failed or stalled destination is excluded for the rest of that mapping pass and the explorer immediately selects another frontier; there is no failure budget or timed quarantine. Goal cancellation is best-effort: if Nav2 does not acknowledge it, the explorer still advances and the next `NavigateToPose` goal preempts the old destination instead of ending the mapping pass. Nav2 first performs the checked-in short-backup, costmap-clear, and wait recovery tree, with in-place spin disabled. Automatic candidate save also requires observed robot displacement; a zero-motion explorer exit restores localization without promoting a no-op candidate. Any orderly explorer exit saves a candidate before cleanup, so partial SLAM work remains reviewable instead of being discarded.
5. Automatic completion and Stop Early both save `maps/candidates/<id>/` only when the session has translation-backed movement evidence. DOGZILLA has no chassis odometer, so `map -> base_link` displacement alone is not physical-motion proof: Cartographer can report apparent translation while the robot only rotates. Candidate save therefore requires both maximum session map displacement and at least one second of guarded `/cmd_vel` above the gait's forward deadband. A mixed forward-plus-turn gait counts as translation and remains independently subject to the rotation-dominance guard; pure rotation never qualifies. It restores the previous map only when that active manifest has a verified Cartographer PBSTREAM. For an occupancy-only scanner map, it stops in `candidate-ready`; promote the candidate to resume localization/navigation.
6. Use New Map is a separate, confirmed promotion step. Candidate metadata records SHA-256 for all three artifacts; promotion rejects missing or altered artifacts, updates `robodoge_home.*` through the persistent `robodoge-rosbridge` container (the mapping workflow may have stopped `robodoge-map-pose`), clears the stored origin, and restarts localization and Nav2. Review the live map before promoting and recapture waypoints if geometry moved.

Stop Early succeeds only when the supervisor is still active and its result proves a candidate was saved. A finished or failed explorer session must return a direct error instead of waiting on or accepting an old result file. Converter discovery must consume the full `ros2 pkg executables` output when `pipefail` is enabled; `grep -q` can close the pipe early and falsely report that conversion is unavailable. Windows-launched SSH commands are non-interactive (`ssh -n`) so an open Node stdin pipe cannot keep the HTTP action pending after the remote command exits.

Map-control button state comes from Pi-owned `autonomous-mapping.active`, ready, status, and result files exposed by the direct bridge. Mapping counts as active only after the ready signal exists and the marker's supervisor PID still belongs to `autonomous_mapping_supervisor.sh`; the hidden transient starting unit reserves the launch during the Cartographer handoff. Initial load and recurring `/api/robot/health?lite=1` polling must restore starting/active/candidate state: a 202 start remains Starting until active health is reported, active mapping disables Map This Floor and Continue Current Map, enables Stop Early, and a self-stopped session with a saved candidate disables Stop Early and enables Use New Map.
Candidate review reads the newest hash-verified saved PGM through the direct bridge `/map/candidate` endpoint. It does not reuse `/map_cartographer`, promote the draft, rotate it, or change waypoint authority.

Map save captures a fresh `map -> base_link` pose while Cartographer is still in `mapping` or `continue_mapping`, before `/write_state` and before localization restoration. Candidate promotion preserves this `resumePose` only as history and an optional global-matching search hint; it is never a destination or localization proof.

The UI makes continuation source explicit. **Resume Draft Map** uses the newest hash-verified unpromoted candidate, while **Extend Active Map** uses the map currently authoritative for navigation. Both perform no pre-mapping drive. Candidate selection is read-only and does not promote the candidate, alter waypoint authority, or overwrite `robodoge_home.*`. After battery/gait safety and duplicate-job checks, the workflow reserves the job, stops Nav2, and runs bounded global scan matching against the selected frozen PBSTREAM from the robot's current location. A successful match supplies a fresh recovered `map -> base_link` pose. Cartographer then reloads every saved trajectory as frozen and starts a new mapping trajectory at that recovered pose, anchored to the root map-frame trajectory; a later matched trajectory is recorded as proof but is not incorrectly treated as the map coordinate frame. Failure leaves the active map unchanged, stops the mapping supervisor, restores one normal localization process, releases the recovery lock, and leaves Nav2 blocked until localization trust is proven again. The robot may start anywhere inside the mapped area, but LiDAR still needs enough distinctive, unchanged geometry to prove the match.

Nav2 velocity now has an independent last-line collision gate: controllers publish `/cmd_vel_nav`, the smoother publishes `/cmd_vel_raw`, `nav2_collision_monitor` consumes `/scan_nav2` and publishes guarded `/cmd_vel`, and only `/cmd_vel` reaches the gait adapter. The collision monitor must be the sole publisher on `/cmd_vel`; an extra or unidentified publisher makes readiness fail. The stop polygon covers front and rear around the robot; stale LiDAR fails closed. DOGZILLA's Pi scan timestamps have observed ~0.55 s scheduling jitter, so the default collision source timeout is 0.75 s (`DOGZILLA_NAV2_COLLISION_SOURCE_TIMEOUT`) — still fail-closed for longer gaps. Keep the collision monitor in the navigation lifecycle manager and never route smoother output directly to hardware.
Mapping pauses frontier dispatch after two seconds of stale `/scan_nav2`, cancels the current goal without excluding its location, and waits up to 120 seconds for recovery (`DOGZILLA_MAPPING_SCAN_PAUSE_SEC`, `DOGZILLA_MAPPING_SCAN_TIMEOUT_SEC`). The collision monitor still stops motion after 0.75 seconds, so the longer recovery window only preserves the stationary session; it does not permit blind motion.
The mapping-mode Nav2 readiness watcher uses a dedicated 120-second recovery grace (`DOGZILLA_NAV2_MAPPING_READINESS_GRACE_SEC`) instead of the normal-navigation 20-second grace. Mapping deliberately ignores an inherited generic `DOGZILLA_NAV2_READINESS_GRACE_SEC`, because the rosbridge container may retain the normal 20-second value; allowing that value to win kills the mapping process group—and its scan filter—during a transient Pi DDS graph miss while the explorer is safely paused.
Collision-monitor base-shift correction stays disabled: it projects scan points using `odom` between sensor time and current time, but DOGZILLA's `odom` is Cartographer scan matching rather than physical chassis odometry. Enabling it produced a `PolygonStop` while 80 consecutive raw scans contained zero points inside the unchanged stop polygon.

The mapping launcher posts `navigate` to the direct bridge after starting mapping Nav2 as a compatibility assertion. The bridge returns normal mode without calling Nav2 lifecycle services; this assertion cannot pause, resume, or abort the new mapping stack.

This workflow still requires live Pi validation before unattended use. Test collision stopping, stair boundaries, scan freshness, Cartographer TF, Nav2 action results, and real robot motion in an empty, bounded area first.

## Direct bridge Nav2 readiness

Direct bridge runtime truth distinguishes action discovery from waypoint-ready stack truth:

- The app treats the bridge's top-level `navigation.waypointReady` boolean as the dispatch authority; nested `navigation.nav2` fields remain diagnostic and cannot override a false localization lockout. It still fails closed when the same payload explicitly reports odom, lifecycle, or scan unavailable. When talking to an older bridge without the boolean, it falls back to those reported high-level fields without hard-coding ROS node names.
- `navigation.actionServerDiscovered` reports whether `/navigate_to_pose` was visible in the ROS graph during the latest discovery check.
- `navigation.waypointReady` / `navigation.available` require `can_send_goal()` to be true — the active backend must be able to actually send goals. If Docker goal sending is disabled or the host action client is missing, `waypointReady` is `false` even when lifecycle nodes, `/odom`, and `/scan_nav2` are live.
- `send_goal` still waits for the real `NavigateToPose` action server before accepting a waypoint command. Do not remove that send-time wait.
- App command preflight keeps full `/healthz` lifecycle status diagnostic when direct bridge command path is usable (`canSendGoal=true`, action server visible, `/odom` live with TF, `/scan_nav2` available). In that state dispatch proceeds and bridge `send_goal` is authority.

When startup or preflight says the action server is blocked but lifecycle, `/odom`, and `/scan_nav2` are green in `/healthz`, treat action discovery as diagnostic evidence, not automatic proof that Nav2 is down.

## Waypoint capture requires continuous tracking

DOGZILLA runs Cartographer in laser-only localization mode (`use_imu_data = false`, `use_odometry = false`). Normal tracking uses a local scan-matching window; `Relocalize on Map` is the separate bounded global matcher for carried or otherwise lost robots.

Relocalization trust does not require stationary `odom -> base_link` stability. That transform can jitter during laser-only matching and its old captured value was unused. Trust instead requires at least three distinct frozen-map constraint matches at 55% or better, a recovered `map -> base_link` pose, stable normal-localization handoff, and preservation within 0.25 m / 0.25 rad. The 55% floor is intentionally fail-closed: live 45.4-47.6% matches placed the robot near a stale hint in repeated geometry and produced a false trusted pose. Deploy the relocalizer and recovery Lua threshold together. The explicit Windows localization launcher proves Nav2 inactive through systemd, then passes `--no-pause-nav2`; do not restore a duplicate lifecycle-service pause check on that path.

The robot must be driven to each waypoint spot before capture so pose tracking stays continuous. Carrying the robot and setting it down can leave `waypointSafe: true` while the pose is wrong because that flag only proves fresh `map`-frame TF, not physical correctness.

If Nav2 cannot drive to a spot, use manual controls. If the robot was carried, run `Relocalize on Map`. When automatic frozen-map matching cannot prove a safe match, localization stays untrusted: the floor-plan dot remains hidden and waypoint navigation remains blocked instead of guessing a pose. For the distinct-match timeout, move the robot with Manual Control to a recognizable, asymmetric place already present on the saved map, clear the LiDAR view, face roughly the mapped direction, and retry. If relocalization fails from two different known mapped spots, the environment and saved map no longer agree closely enough; build and promote a new map.

## Readiness checks

`robodoge-rosbridge.service` must prove at least one live `/scan` `LaserScan` sample at startup and continue watchdog checks. Process ownership of `/dev/ttyAMA1` or a visible `/scan` publisher is not enough, because Cartographer can advertise dependencies yet never produce `map->base_link` without real scan samples.

Fast commands live in `docs/COMMANDS.md`.

Active navigation readiness is based on continuous, exact evidence:

1. The launch owner and direct-bridge gait edge are alive.
2. `/odom` and `/scan_nav2` have fresh samples, with fresh `odom -> base_link`, `map -> odom`, and composed `map -> base_link` transforms.
3. Every lifecycle node selected for the backend exposes its lifecycle service and reports active.
4. `/scan_nav2` has a live `collision_monitor` subscriber. Its namespace and all costmap consumer names remain diagnostic because valid Nav2 compositions differ.
5. Every velocity edge has exact endpoint ownership: controller/behavior -> `/cmd_vel_nav` -> velocity smoother -> `/cmd_vel_raw` -> collision monitor -> `/cmd_vel` -> gait adapter.
6. `/navigate_to_pose` is live before active navigation is declared ready or a goal is accepted.

The operator Nav chain keeps these signals distinct: `LiDAR` is raw `/scan` health, `Localization` is a fresh waypoint-safe `map->base_link` pose, and `Filtered scan` is Nav2's `/scan_nav2` publisher/subscriber readiness. Missing probe data is `unknown`, not failed. When the active map lacks the verified Cartographer PBSTREAM required for localization, show that root blocker and suppress downstream Nav2 symptoms until the map is promoted.

For direct-bridge `locomotion.goto`, `obstacleAvoidance.mode = "nav2_costmap"` must validate `/scan_nav2`, not raw `/scan`. Raw `/scan` remains for rosbridge/LiDAR transport and non-Nav2 avoidance flows only.

The app rosbridge client intentionally subscribes only to throttled `/scan`, `/tf`, `/tf_static`, and `/odom` by default. Do not add `/map_cartographer` back to default `rosbridgeTopics`; full occupancy grids are large JSON payloads and can make `rosbridge_websocket` memory climb on the Pi.

The repo odom helper prefers Cartographer's `odom->base_link` and can anchor relative odom from the trusted `map->base_link` pose when that real transform is absent. The fallback is relative to its startup pose, never raw global map pose, and retires permanently when a named real `/tf` authority appears. The Nav2 launcher must name `cartographer_node` as that authority; leaving it blank keeps synthetic and real transforms alive together, makes the costmap pose jump, and can trigger Nav2 spin recovery. Localization trust and fresh-transform gates still apply.

The scan filter and odom helper are supervised children of the Nav2 launch. The persistent readiness watcher publishes an atomic `logs/navigation-readiness.json` snapshot for lightweight bridge health; missing or older-than-six-second snapshots fail closed. Readiness uses one persistent `rclpy` node, requires two continuous seconds of fresh end-to-end evidence, and continuously revalidates every lifecycle node launched by the selected mode/backend, including the velocity smoother and collision monitor. Do not restore repeated `ros2 topic info` or `ros2 action list` subprocess probes because their process/DDS churn can delay Nav2 itself on the Pi.

Nav2 startup must not fail solely on a short `ros2 topic info /scan_nav2` miss. The scan filter gate waits up to 45 seconds and accepts either publisher discovery or a one-message `/scan_nav2` sample before launching Nav2; otherwise DDS discovery lag can leave only partial helpers running and no lifecycle nodes.

## Direct bridge hardware ownership and stop semantics

The direct bridge must own `/dev/ttyAMA0` exclusively during live navigation. Yahboom's `app_dogzilla.py` and `oled_dogzilla.py` (including the `yahboom_oled.service` unit) must be stopped before the bridge starts. `scripts/stop-dogzilla-vendor-app-ssh.ps1` stops the service, kills both processes, and fails if either still holds `/dev/ttyAMA0` open. `scripts/install-dogzilla-boot-services-ssh.ps1` adds `Conflicts=yahboom_oled.service` to `robodoge-direct-bridge.service`, runs an equivalent privileged `ExecStartPre=+` vendor-stop flow, and disables `yahboom_oled.service` after enable.

`/dev/ttyAMA1` remains LiDAR/ROS-owned; do not stop or repurpose it.

Battery health polling is rate-limited to the configured refresh interval and must use a refreshing bridge endpoint during motion. A cached high reading may cover a short transient serial/format failure, while cached values at or below the cutoff (or below the recovery threshold after a prior battery block) still block immediately. Read-only diagnostic snapshots do not mutate the gait safety latch.

The software motion cutoff is `30%`, above DOGZILLA's observed hardware limp threshold of `25%`; motion remains latched off until a fresh reading reaches `35%`. This is a physical stability gate, not a mapping-completeness heuristic.

The bridge distinguishes two stop paths:

- `emergency_stop` (reason `emergency_stop`): latches `/nav2/cmd_vel` blocked until an explicit unlatch path is used. A subsequent `locomotion.goto` does **not** silently clear this safety block.
- `command_preempt` (reason `command_preempt`): cancels the active Nav2 goal, stops robot motion, and gates late Nav2 velocity messages. Manual motion remains available. The gate clears after a fresh `locomotion.goto` is accepted, or on the first fresh nonzero velocity from a Pi-proven active autonomous-mapping session; battery and emergency-stop blocks never clear this way.

Safety reasons are independent latches, not one replaceable string. Shutdown, emergency stop, startup protection, unknown fail-closed reasons, battery safety, and command preemption have deterministic priority for operator display; clearing or recovering one reason cannot erase another. Emergency-stop clear removes only the emergency reason and reports any remaining block.

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

Operator UI status must use current runtime evidence: `motionStatus: "commanding"` for nonzero gait commands, fresh connected `/scan` frames for live LiDAR, initialized speech provider/microphone state for speech readiness, and verified bridge health for repair. Do not report live, ready, repaired, walking, or idle from elapsed time, cached scan presence, config presence, command acceptance, process launch, PID, or launcher exit alone.

| `motionStatus` | Meaning |
| --- | --- |
| `"commanding"` | Gait adapter accepted at least one nonzero command. This proves command activity, not physical movement. |
| `"no-command"` | Goal accepted but no nonzero gait command arrived within the window. |
| `"cancelled"` | Navigation cancel event was set. |
| `"failed"` | Background monitor threw an exception. `monitorError` field contains the detail. |

Live command proof is `delivery: "accepted"` plus `goalAccepted: true` and then `motionStatus: "commanding"`. This proves Nav2 dispatch and nonzero gait-command activity, not physical movement or arrival. Physical motion needs separate observed displacement evidence.

The motion monitor uses only `runtime.nav2_gait_nonzero_command_count`. It does not treat an advancing odom timestamp as movement and does not run Docker probes in a loop.

**Readiness invariant:** `waypointReady=true` requires `can_send_goal()` to be true. If Docker goal sending is disabled or the host action client is missing, `waypointReady` is `false` even if the lifecycle/odom/scan stack is otherwise active.

`/healthz-lite` exposes: `navMode`, `loadAverage`, `gaitBlocked`, `gaitBlockedReason`, `nav2Ready`, `waypointReady`, `nav2Backend`, `canSendGoal`. It remains cached during ordinary healthy polling, but may perform one backend recovery probe when a fresh Pi readiness snapshot proves Nav2 and NavigateToPose live while the bridge cache still reports `canSendGoal=false`. Use `/healthz-lite` for frequent UI polls; full `/healthz` is for diagnostics or failures only.

## Always-On Navigation And SLAM Ownership

Navigation has one normal state: `navigate`. Battery-saving Nav2 standby, automatic demotion, and logical sleep gates are removed. Pi boot/systemd owns the running Cartographer/Nav2/scan-filter processes.

Compatibility behavior:

- `GET /mode` returns `navigate`, `transitioning=false`, and empty history.
- `POST /mode` accepts `navigate` as an idempotent no-op. `idle`, `localize`, and `sleep` return `navigation_always_on`.
- No mode endpoint calls `/lifecycle_manager_navigation/manage_nodes` or starts, stops, reinstalls, recreates, or deletes Pi services.
- `locomotion.goto` talks directly to already-running Pi-owned Nav2 and sends the goal synchronously after normal safety/readiness validation.
- If Nav2 is unavailable, app/server reports blockers. It does not auto-repair or auto-start navigation; the Pi-owned service supervisor handles sustained runtime degradation.
- Startup mode is always `navigate`, matching the Pi boot contract: Nav2 should already be running before the app starts.

Pi boot/systemd owns normal map-pose/Nav2 lifetime. `robodoge-rosbridge.service` keeps the shared ROS container running, `robodoge-map-pose.service` starts Cartographer localization, and `robodoge-navigation.service` runs `sidecars/dogzilla_navigation/start-navigation-in-container.sh` inside `robodoge-rosbridge` with `DOGZILLA_LOCALIZATION_BACKEND=cartographer`. The navigation wrapper records an atomic 0600 owner generation (boot ID, random token, PID start times, and isolated process group); readiness validates that generation continuously, including the recorded process-group leader token, while allowing ROS launch children to scrub the launcher token. A lifetime `flock` prevents a detached mapping launch and the normal service from owning Nav2 together. The detached mapping launcher accepts readiness only after it observes a fresh mapping-mode owner token, so an existing normal graph or an inner lock refusal cannot satisfy the probe. `npm start`, `npm run dev:lan`, command dispatch, and server health polling do not request `/mode navigate` as startup repair and do not call `start-map-pose` or `start-navigation`.

The normal service continuously enforces the same readiness contract used at startup: a validated owner PID/token/start-time generation, fresh `/odom` and filtered scan messages, fresh `odom -> base_link`, `map -> odom`, and `map -> base_link`, complete lifecycle-service evidence, active critical lifecycle nodes, a live action server, the collision monitor's scan subscription, every exact velocity-chain publisher/subscriber, and the read-only direct-bridge gait health edge. No standby mode relaxes this contract. Readiness and recovery each require two continuous healthy seconds. Twenty continuous unhealthy seconds fail the launch. Systemd then waits 30 seconds before restart and permits at most three starts in 15 minutes. Safety blocks such as emergency stop or low battery remain healthy infrastructure and do not trigger restart churn.

Before a long-lived readiness watcher can tear down Nav2, a fresh independent readiness process must confirm the same failure. This prevents a stale RMW graph cache in one watcher from killing a healthy stack while retaining every safety gate; a failed fresh check still stops Nav2 normally. The atomic readiness snapshot records every gate and the current blocker list so detached mapping failures remain diagnosable and repeatable. The direct bridge accepts both legacy schema 1 and current schema 2 readiness snapshots; rejecting schema 2 leaves otherwise-ready post-mapping odom/scan state falsely stale.

Cartographer remains the preferred `odom -> base_link` TF authority. The `/odom` helper publishes from that transform and, for this laser-only robot, uses a relative `map -> base_link` fallback when Cartographer does not expose `odom -> base_link`; the fallback retires permanently when the named real authority appears and never reclaims the frame.

Startup scripts must not install ROS packages during normal boot. If Nav2, Cartographer, or `nav2_msgs` dependencies are missing, the Pi-owned service should fail loud so the image/setup can be fixed explicitly.

SLAM is the explicit exception: the operator-owned New Map / Save Map workflow stops and proves normal Nav2 inactive before switching Cartographer into mapping mode, saves the new map, then restarts localization against that map. That flow is intentional and separate from normal app startup or waypoint dispatch.

## Velocity command safety chain

The production command path is fixed: `/cmd_vel_nav` -> velocity smoother -> `/cmd_vel_raw` -> lifecycle-managed collision monitor -> `/cmd_vel` -> gait adapter. Readiness checks publisher and subscriber identity plus multiplicity on every edge; duplicate same-name endpoints fail. Collision monitor is the exclusive `/cmd_vel` publisher. There is no normal-launch smoother or collision-monitor bypass. Diagnose a silent edge from the readiness failure detail and `navigation-systemd.log`; do not route controller output directly to hardware.

During autonomous mapping only, the frontier explorer is a read-only `/cmd_vel` observer for progress and rotation-dominance telemetry. Mapping readiness therefore accepts exactly the gait adapter alone during startup or the gait adapter plus `robodoge_frontier_explorer` after exploration begins; any other consumer still fails the velocity-chain gate.

`/healthz-lite` includes compact feedback: `navMode`, `loadAverage`, `gaitBlocked`, `gaitBlockedReason`, `nav2Ready`, `waypointReady`, `nav2Backend`, `canSendGoal`. Full `/healthz` is for diagnostics or failures only.
## Starting and deploying

Manual repair scripts still use bounded retry (`lib/dogzilla-start-retry.mjs`, backoff 0/2s/5s), but normal app/server startup does not call them.

```powershell
npm run dogzilla:start-navigation
```

Normal app startup and command-time waypoint dispatch do not start map-pose or Nav2. `lib/robot-sidecar-client.mjs` reports readiness blockers when the Pi-owned stack is down. Use the manual scripts below only for explicit operator repair.

`scripts/start-dogzilla-map-pose-ssh.ps1` copies the map-pose sidecar plus the shared active-map validator and starts bounded Cartographer localization. `scripts/start-dogzilla-navigation-ssh.ps1` syncs the navigation/map-pose sidecars, shared active-map validator, and canonical tuning, refuses a normal restart while either host mapping transaction unit or the container runtime lock is owned, then restarts `robodoge-navigation.service`. Mapped tuning values always come from `config/robot-obstacle-avoidance.json`; stale `DOGZILLA_NAV2_*` tuning environment values cannot override it. Only explicit mapping mode uses the detached container-launch exception.

Startup scripts are Windows PowerShell-driven SSH launchers. Avoid PowerShell heredocs sent through SSH, serialize apt work through startup locks, and use parent-safe `pgrep` stop loops for background services.

After acquiring the lifetime owner lock, `start-navigation-in-container.sh` stops stale Nav2, AMCL, and helper processes before starting a new stack. Systemd stop targets the recorded normal-owner process group after validating its leader generation token and every member's isolated `setsid` session; child processes are not required to preserve the token in their own environment. Before that process group exists, cleanup terminates helper children carrying the random owner token and returns success only after proving the runtime lock free. It must not use a shared-container-wide `pkill` that could kill detached mapping. Leaving an old `map_server` active makes the new lifecycle manager collide on `/map_server` and abort bringup even when the replacement map loads correctly.

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

Map Controls keeps mapping, alignment, waypoint capture, and navigation restart in one panel. `Map This Floor` starts fresh autonomous mapping; `Continue Current Map` globally relocalizes at the robot's current position, starts a new mapping trajectory on the verified frozen PBSTREAM, and runs the same frontier explorer without first walking to a saved point. Coverage completion saves either session as a reviewable candidate automatically; Stop Early is the secondary manual action. The operator UI no longer exposes origin capture or the redundant waypoint-readiness button.

Use the primary Build / Save Map row for SLAM: Start New Map -> drive slow overlapping loops -> Save Map. Save Map promotes the new default only after Cartographer writes `.pbstream` and conversion produces Nav2 `.yaml`/`.pgm`; otherwise the previous default stays active. Successful Save Map restarts localization against the saved map.

`Relocalize on Map` performs bounded global scan matching against the active frozen PBSTREAM. The active manifest's `resumePose` is only a search hint; it never grants trust. Recovery temporarily consumes every scan, adds at most one node per second, and preserves its recovered trajectory when handing state to normal localization. The recovery `FinishTrajectory` RPC and its finished-state poll use the longer finish timeout so Cartographer's final optimization can settle under Pi load. Recovery accepts Cartographer matches at or above 55%, and trust requires at least three distinct cross-trajectory constraint matches plus stable fresh TF; weaker sparse-room matches remain untrusted because repeated geometry can place the robot at a wrong map location. Nav2 must be proven inactive or paused before TF changes; prior active state is restored only after normal localization produces stable fresh map TF without losing the recovered pose, while intentionally inactive state remains inactive. Failure keeps localization untrusted, hides the floor-plan dot, and blocks waypoint navigation.

The UI map panel must make SLAM state explicit: Start New Map switches the mini-map into top-down mode, shows occupancy-grid, live LiDAR, and waypoint layer states, then keeps Save Map available for the active SLAM session. If the grid is not ready yet, the save action should fail with bridge evidence instead of silently staying grayed out. Use the Manual Control forward-gait slider for slow mapping passes; it scales only positive forward gamepad motion before `/api/robot/manual-control` dispatch.

During an active SLAM pass, `/api/dogzilla/map?stream=slam` subscribes to configured `lidar.mapTopic` (`/map_cartographer` by default); normal map polling must not add full occupancy grids to the default rosbridge topic list.

The frontier explorer allows the first Cartographer occupancy grid the existing 120-second startup/action budget. After the first grid arrives, the shorter configured map timeout remains the stale-data watchdog. The Pi can need more than 15 seconds to publish its first fresh grid, so applying the steady-state timeout during startup can abort a healthy mapping session before motion begins.

Autonomous mapping requests an orderly candidate save when fresh bridge telemetry reaches the configured battery warning threshold, preserving the remaining margin above the motion cutoff for Cartographer save and localization restore. Candidate saving calls Cartographer `/write_state` directly with a bounded timeout; a one-shot service-list discovery result must not veto an otherwise live save.

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

`config/robot-obstacle-avoidance.json` carries Nav2 tuning knobs, including robot radius, inflation, scan filter mask, yaw tolerance, XY tolerance, controller/planner frequency, and movement allowance. Current config makes final yaw effectively non-blocking with `yawGoalTolerance: 6.283`; startup applies both tolerances to Nav2's loaded goal checkers as well as DWB, otherwise `general_goal_checker` keeps its upstream `0.25` rad yaw requirement and curves toward map yaw zero instead of completing.

Autonomous gait keeps the operator-approved wood-floor limits from the 2026-07-21 mapping run: immutable `linearFullScale=0.26`, forward stride no greater than `8`, and zero lateral/Nav2 Y motion. During autonomous mapping only, the direct bridge uses Yahboom's standard `trot/normal` gait; normal waypoint navigation remains `walk/slow`. Startup, resume, and recovery share this direct-bridge conversion; stale runtime/environment values cannot restore the slidey `0.15` scale, re-enable strafing, or exceed the stride ceiling. Prior larger/crab steps made DOGZILLA fall.

Autonomous corner recovery uses a checked-in Humble NavigateToPose behavior tree that tries a short `BackUp` (`0.20 m` at `0.13 m/s`) before clearing/replanning and waiting. The recovery tree contains no `Spin`, preventing repeated multi-minute recovery spins. The explorer does not publish recovery motion: it sends one frontier goal, watches guarded `/cmd_vel`, and skips the destination after Nav2 failure, the 90-second absolute ceiling, or eight accumulated seconds of rotation-dominant commands. Cartographer map-frame pose remains diagnostic because scan-matching corrections can move it while the robot translates. Keep the static collision polygon unchanged because it remains the safety path for every Nav2 command.

This follows Yahboom's `14.Lidar course/Robot dog mapping.pdf` and `Robot Dog Navigation.pdf`: Cartographer owns mapping, Nav2 owns goal-directed motion, and maps are saved as PBSTREAM plus occupancy artifacts. Robo-Doge adds only frontier goal selection and DOGZILLA-safe recovery around that vendor flow.

Direct-bridge relative motion keeps non-gamepad lateral movement disabled by default (`DOGZILLA_LOCOMOTION_MAX_LATERAL_STEP=0`), while explicit gamepad input has a separate conservative cap (`DOGZILLA_MANUAL_MAX_LATERAL_STEP=1`). This manual exception does not enable Nav2 lateral motion.

Cartographer fresh-mapping configs use widened online correlative scan matching (`linear_search_window = 0.6`, `angular_search_window = 45 deg`, constraint scores `0.65`) because DOGZILLA has no reliable wheel odom/IMU; narrow `0.1 m / 15 deg` matching can collapse a whole-house drive into a first-room trajectory.

Current DWB tuning sets `nav2MinSpeedXy: 0.0`, overriding the older `0.03 m/s` minimum described above. This permits a bounded in-place heading correction before forward travel instead of forcing a walking circle; reverse samples remain disabled and the explorer's eight-second rotation-dominant cutoff remains authoritative. The LiDAR filter also removes returns inside the configured `0.22 m` robot radius in every direction while retaining the narrower legacy angular mask, so a wall one foot away remains visible but the dog's own body cannot poison the costmap.

## Known live-work rules

- For "spins/goes nowhere", inspect live costmap, scan, timeout, and recovery evidence before changing planner assumptions or waypoint data.
- Live operator observation (2026-07-21): the `linearFullScale=0.26`, `walk/slow` profile moved without slipping on wood flooring. A later `0.15` calibration did not reproduce that gait; keep `0.26` as the default and retain the `8` stride ceiling.
- Local tests prove plumbing, not live route correctness.
- Yahboom `DOGZILLALib.turn()` coerces every nonzero magnitude below `30` to `30`. The direct bridge therefore duty-cycles sub-minimum Nav2 turns among zero-turn gait updates; passing a nominal `1-12` continuously makes tiny DWB steering corrections become hard turns. The pulse preserves the requested average turn and sign while the collision monitor still evaluates the original guarded Twist.
- If robot is low battery or unhealthy, pause live motion retries and continue only local code/tests.
- If robot heads the wrong way, verify translation direction and heading/orientation early.
- For waypoint capture, drive the robot to the spot. Carrying it can leave `waypointSafe` true while pose is wrong.

## Cartographer load notes

`DOGZILLA_MAP_POSE_OCCUPANCY_GRID=auto` starts `cartographer_occupancy_grid_node` only for `mapping` / `continue_mapping`. Keep localization mode grid-off by default; force grid only when debugging live SLAM/localization display.

The autonomous mapping explorer runs under transient host systemd supervision. Normal completion or Stop Early saves a candidate when possible after verified movement, then restores localization and Nav2. Explorer failure, timeout, or restore failure still stops mapping Nav2 processes so a stale mapping session cannot leave the Pi at mapping load indefinitely.

Cartographer localization configs keep the widened scan-match window, process every rangefinder message, and retain the five-node pose-graph optimization cadence so the live scan stays registered to the frozen map while the robot travels. Submap and trajectory publication remain throttled to reduce Pi load. Do not set `TRAJECTORY_BUILDER.pure_localization` on this Humble Cartographer build; live test showed it aborts startup with `Key 'pure_localization' was used the wrong number of times`.

Continue Current Map is one remote transaction. Explicit `continue_mapping` launches its dedicated map-pose container, clears stale proof/readiness files, and requires both `robodoge_localization_status.json` with `trusted=true` and the fresh `robodoge_map_pose_ready` startup marker before the caller starts mapping Nav2; an error, exited container, or timeout stops the handoff before stale pose reaches Nav2. The SSH launcher must never start systemd's `auto` entrypoint and then `docker exec` the same long-lived startup script, because that races two relocalizers and Cartographer instances. Normal localization calls only `relocalize_on_frozen_map.py` inside the systemd-owned container; restore-only restarts systemd with a one-shot skip marker, which failure paths must remove if systemd does not consume it. A nonzero relocalization result must not trigger a second exec or a second global relocalization during rollback. Failed recovery cleans orphaned recovery-namespace Cartographer processes, restores one normal localization process, releases its lock, and leaves Nav2 blocked until localization trust is proven again.
After a dedicated `mapping` or `continue_mapping` container reaches its ready condition, the Windows launcher returns immediately. The container entrypoint already owns relocalization and Cartographer startup; executing `relocalize_on_frozen_map.py` again would race the proved mapping handoff, restore normal localization on a second-pass failure, and hide the real failure behind a Nav2 owner-generation error.

## More detail

- `docs/DOGZILLA_HOLONOMIC_MOTION_PLAN.md`
- `docs/COMMANDS.md`
- `docs/archive/dogzilla-real-map-pose.md`
- `docs/archive/waypoint-mapping-guide.md`
- `docs/archive/dogzilla-waypoint-navigation-evaluation.md`
