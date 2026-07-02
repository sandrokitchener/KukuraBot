# DOGZILLA Navigation Notes

Read this for SLAM, Nav2, waypoints, saved map origin, pose, robot movement, and route dispatch.

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
capture live map pose -> mapPoseToAppPose() -> save waypoint frame: app_map -> dispatch resolves app_map back to current map pose -> Nav2 NavigateToPose
```

Key files:

| File | Role |
| --- | --- |
| `lib/dogzilla-map-frame.mjs` | `mapPoseToAppPose()` and `appPoseToMapPose()` |
| `scripts/capture-dogzilla-map-pose.mjs` | Captures current pose into `config/robot-waypoints.json` |
| `scripts/set-dogzilla-map-origin.mjs` | Saves current pose as map origin |
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
- Do not rewrite, downgrade, disable, or "correct" trusted waypoints without explicit user instruction.
- Diagnostics may warn about drift or stale origin without editing config.
- Notes are never authoritative for dispatch or validation.
- Current verified `app_map` waypoints include `living_room`, `kitchen`, `garage`, and `charger` with `mapId: robodoge_home`.

Map-identity fingerprint checks no longer block dispatch by themselves. If saved origin is missing, the app can fall back to the current map pose, but physical alignment may still be wrong and should be recaptured when it drifts.

## Topic contract

Two independent topics carry occupancy grids on the DOGZILLA Pi:

| Topic | Publisher | Purpose |
| --- | --- | --- |
| `/map` | Nav2 `map_server` | Static saved map (`.yaml`), used by Nav2 |
| `/map_cartographer` | Cartographer occupancy grid | Live SLAM/localization grid for app minimap truth |

The live Cartographer grid contains raw probabilities (`0-100`), while saved `.pgm` output is thresholded into free/unknown/occupied. `public/robot-map.js` thresholds live cells so the minimap looks like the saved map:

- `-1` -> unknown.
- `0-50` -> free.
- `51-64` -> unknown.
- `65-100` -> occupied.

## Direct bridge Nav2 readiness

Direct bridge runtime truth distinguishes action discovery from waypoint-ready stack truth:

- `navigation.actionServerDiscovered` reports whether `/navigate_to_pose` was visible in the ROS graph during the latest discovery check.
- `navigation.waypointReady` / `navigation.available` require `can_send_goal()` to be true — the active backend must be able to actually send goals. If Docker goal sending is disabled or the host action client is missing, `waypointReady` is `false` even when lifecycle nodes, `/odom`, and `/scan_nav2` are live.
- `send_goal` still waits for the real `NavigateToPose` action server before accepting a waypoint command. Do not remove that send-time wait.
- App command preflight keeps full `/healthz` lifecycle status diagnostic when direct bridge command path is usable (`canSendGoal=true`, action server visible, `/odom` live with TF, `/scan_nav2` available). In that state dispatch proceeds and bridge `send_goal` is authority.

When startup or preflight says the action server is blocked but lifecycle, `/odom`, and `/scan_nav2` are green in `/healthz`, treat action discovery as diagnostic evidence, not automatic proof that Nav2 is down.

## Waypoint capture requires continuous tracking

DOGZILLA runs Cartographer in laser-only localization mode (`use_imu_data = false`, `use_odometry = false`). The real-time correlative scan matcher searches only a local window around the last known pose; it is not global localization.

The robot must be driven to each waypoint spot before capture so pose tracking stays continuous. Carrying the robot and setting it down can leave `waypointSafe: true` while the pose is wrong because that flag only proves fresh `map`-frame TF, not physical correctness.

If Nav2 cannot drive to a spot, use manual controls. If the robot was carried, restart localization at a known reference such as the charger before driving to the waypoint spot.

## Readiness checks

`robodoge-rosbridge.service` must prove at least one live `/scan` `LaserScan` sample at startup and continue watchdog checks. Process ownership of `/dev/ttyAMA1` or a visible `/scan` publisher is not enough, because Cartographer can advertise dependencies yet never produce `map->base_link` without real scan samples.

Fast commands live in `docs/COMMANDS.md`.

Startup/preflight readiness is based on:

1. `nav2_msgs` import works.
2. `/odom` has live samples and odom-to-base TF.
3. Nav2 lifecycle nodes are active.
4. `/scan_nav2` has a live publisher and costmap subscribers.
5. `/navigate_to_pose` action discovery is reported, but Pi DDS discovery misses are tolerated at bridge readiness if the rest of the stack is proven.

For direct-bridge `locomotion.goto`, `obstacleAvoidance.mode = "nav2_costmap"` must validate `/scan_nav2`, not raw `/scan`. Raw `/scan` remains for rosbridge/LiDAR transport and non-Nav2 avoidance flows only.

The app rosbridge client intentionally subscribes only to throttled `/scan`, `/tf`, `/tf_static`, and `/odom` by default. Do not add `/map_cartographer` back to default `rosbridgeTopics`; full occupancy grids are large JSON payloads and can make `rosbridge_websocket` memory climb on the Pi.

The repo odom helper first uses `odom->base_link`; if absent, it anchors the first live `map->base_link` pose and publishes synthetic relative `/odom`. Do not publish raw global map pose as odom.

The scan filter and odom helper run as direct background processes inside the rosbridge container. ROS2 CLI calls are bounded because `ros2 topic info` and `ros2 action list` can hang under Pi DDS/daemon load.

Nav2 startup must not fail solely on a short `ros2 topic info /scan_nav2` miss. The scan filter gate waits up to 45 seconds and accepts either publisher discovery or a one-message `/scan_nav2` sample before launching Nav2; otherwise DDS discovery lag can leave only partial helpers running and no lifecycle nodes.

## Direct bridge hardware ownership and stop semantics

The direct bridge must own `/dev/ttyAMA0` exclusively during live navigation. Yahboom's `app_dogzilla.py` and `oled_dogzilla.py` (including the `yahboom_oled.service` unit) must be stopped before the bridge starts. `scripts/stop-dogzilla-vendor-app-ssh.ps1` stops the service, kills both processes, and fails if either still holds `/dev/ttyAMA0` open. `scripts/install-dogzilla-boot-services-ssh.ps1` adds `Conflicts=yahboom_oled.service` to `robodoge-direct-bridge.service`, runs an equivalent privileged `ExecStartPre=+` vendor-stop flow, and disables `yahboom_oled.service` after enable.

`/dev/ttyAMA1` remains LiDAR/ROS-owned; do not stop or repurpose it.

The bridge distinguishes two stop paths:

- `emergency_stop` (reason `emergency_stop`): latches `/nav2/cmd_vel` blocked until an explicit unlatch path is used. A subsequent `locomotion.goto` does **not** silently clear this safety block.
- `command_preempt` (reason `command_preempt`): cancels the active Nav2 goal and stops robot motion, but does **not** latch `/nav2/cmd_vel` blocked. A fresh `locomotion.goto` clears any stale command-preempt gate before readiness checks. `_execute_command_preempt()` also defensively clears any stale `command_preempt` block before returning.

## Navigation execution contract

The async goto path uses a normalized app-facing delivery contract:

| `delivery` | Meaning |
| --- | --- |
| `"accepted"` | Nav2 `NavigateToPose` goal was accepted by the action server. Background motion monitor started. HTTP 202. |
| `"rejected"` | Prerequisites failed, goal was rejected, or promote timeout hit. HTTP 422. Includes `error` and `blockers`. |

The original internal delivery name (e.g. `"Nav2 NavigateToPose"`) is preserved under `deliveryDetail` for diagnostics.

**Single goal send invariant:** The synchronous phase sends the goal exactly once. The background thread (`_monitor_background_motion`) only monitors motion — it must NOT call `runtime.execute()` or `nav2_client.send_goal()` again.

**Motion status values** (set by the background monitor):

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
- `POST /mode` with `{"mode": "localize|navigate|idle|sleep"}` updates bridge logical mode only. It must not start, stop, reinstall, recreate, or delete Nav2/map-pose services.
- `locomotion.goto` talks to already-running Pi-owned Nav2, waits bounded readiness (45 s timeout, 2 s poll, latest blockers returned on timeout), and sends goal synchronously.
- If Nav2 is unavailable, app/server reports blockers. It does not auto-repair or auto-start navigation.
- Default startup mode is `navigate`, matching the Pi boot contract: Nav2 should already be running before the app starts.

Pi boot/systemd owns normal map-pose/Nav2 lifetime. `robodoge-rosbridge.service` keeps the shared ROS container running, `robodoge-map-pose.service` starts Cartographer localization, and `robodoge-navigation.service` runs `sidecars/dogzilla_navigation/start-navigation-in-container.sh` inside `robodoge-rosbridge`. `npm start`, `npm run dev:lan`, command dispatch, and server health polling do not request `/mode navigate` as startup repair and do not call `start-map-pose` or `start-navigation`.

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

`scripts/start-dogzilla-map-pose-ssh.ps1` copies the map-pose sidecar, reads saved origin, and runs `docker exec robodoge-map-pose` to publish initial pose. `scripts/start-dogzilla-navigation-ssh.ps1` copies `sidecars/dogzilla_navigation` and `sidecars/dogzilla_map_pose` to the Pi, then runs `start-navigation-in-container.sh` inside `robodoge-rosbridge`.

Startup scripts are Windows PowerShell-driven SSH launchers. Avoid PowerShell heredocs sent through SSH, serialize apt work through startup locks, and use parent-safe `pgrep` stop loops for background services.

Normal app startup and command-time waypoint dispatch do not start map-pose or Nav2. `lib/robot-sidecar-client.mjs` reports readiness blockers when the Pi-owned stack is down. Use the manual scripts below only for explicit operator repair or SLAM mapping workflows.

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
npm run dogzilla:set-origin
npm run dogzilla:validate-waypoints
```

In UI Mini Map > Map Controls:

Primary mapping row: Start New Map, then Save Map. Advanced Setup contains Localize Saved Map, Mark Origin, Save Spot, Check Ready, and Restart Nav.

Use the primary Build / Save Map row for SLAM: Start New Map -> drive slow overlapping loops -> Save Map. Save Map promotes the new default only after Cartographer writes `.pbstream` and conversion produces Nav2 `.yaml`/`.pgm`; otherwise the previous default stays active. Successful Save Map restarts localization against the saved map.

`Localize on Map` seeds Cartographer localization from the saved charger origin (`output/app-cache/dogzilla-map-origin.json` locally, deployed to `/home/pi/robodoge/output/app-cache/dogzilla-map-origin.json` on the Pi), defaulting to no initial pose when no origin exists. It is local refinement, not global relocalization.

## Waypoint recapture

When a saved waypoint no longer aligns with physical space, recapture it explicitly. Cartographer laser-only localization does not require Nav2 or odometry, but it cannot globally relocalize after the robot is carried.

Drive the robot to the physical waypoint spot, wait for `waypointSafe: true`, then use `Recapture here`. The endpoint requires a waypoint-safe pose and overwrites that waypoint in `config/robot-waypoints.json` as `app_map` using the current pose.

There is no batch recapture: the robot must physically be at each waypoint spot. Recapture is always explicit; waypoints are never silently rewritten or downgraded.

## Chat waypoint dispatch

Chat command handling must use the same resolved runtime and ROS2 config for preview and dispatch. The direct DOGZILLA target should not stop at "Robot preview ready" when `dispatchOnChat` is enabled and a ready waypoint command compiles. Verify with `robotDispatch.status`, not just assistant text.

## Tuning

`config/robot-obstacle-avoidance.json` carries Nav2 tuning knobs, including robot radius, inflation, scan filter mask, yaw tolerance, XY tolerance, controller/planner frequency, and movement allowance. Current config makes final yaw effectively non-blocking with `yawGoalTolerance: 6.283`.

## Known live-work rules

- For "spins/goes nowhere", inspect live costmap, scan, timeout, and recovery evidence before changing planner assumptions or waypoint data.
- Local tests prove plumbing, not live route correctness.
- If robot is low battery or unhealthy, pause live motion retries and continue only local code/tests.
- If robot heads the wrong way, verify translation direction and heading/orientation early.
- For waypoint capture, drive the robot to the spot. Carrying it can leave `waypointSafe` true while pose is wrong.

## More detail

- `docs/COMMANDS.md`
- `docs/archive/dogzilla-real-map-pose.md`
- `docs/archive/waypoint-mapping-guide.md`
- `docs/archive/dogzilla-waypoint-navigation-evaluation.md`

