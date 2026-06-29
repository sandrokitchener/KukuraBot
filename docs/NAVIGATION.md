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
| `lib/dogzilla-waypoint-navigation-launcher.mjs` | Starts/checks waypoint navigation and auto-saves origin |
| `lib/robot-command-compiler.mjs` | Resolves waypoint pose and builds dispatch plan |
| `lib/app-service.mjs` | Uses the same resolved runtime/ROS2 config for chat preview and robot dispatch |
| `lib/dogzilla-navigation-readiness.mjs` | App-side readiness evaluation |
| `sidecars/dogzilla_lib_bridge/nav2_client.py` | Direct bridge Nav2 client and runtime truth |
| `sidecars/dogzilla_navigation/start-navigation-in-container.sh` | Container-side Nav2 install/param/filter/launch script |
| `sidecars/dogzilla_navigation/tf_odom_publisher.py` | Publishes `/odom`; falls back to synthetic relative odom anchored at first `map->base_link` pose when no `odom` frame exists |
| `sidecars/dogzilla_navigation/odom_publisher_supervisor.py` | Keeps the repo `/odom` helper alive |
| `sidecars/dogzilla_navigation/scan_filter_supervisor.py` | Keeps `/scan_nav2` alive |
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
- `navigation.waypointReady` / `navigation.available` may still be `true` when lifecycle nodes are active and `/odom` plus `/scan_nav2` are live. Pi DDS action discovery can briefly miss the action while the stack is otherwise usable.
- `send_goal` still waits for the real `NavigateToPose` action server before accepting a waypoint command. Do not remove that send-time wait.

When startup or preflight says the action server is blocked but lifecycle, `/odom`, and `/scan_nav2` are green in `/healthz`, treat action discovery as diagnostic evidence, not automatic proof that Nav2 is down.

## Waypoint capture requires continuous tracking

DOGZILLA runs Cartographer in laser-only localization mode (`use_imu_data = false`, `use_odometry = false`). The real-time correlative scan matcher searches only a local window around the last known pose; it is not global localization.

The robot must be driven to each waypoint spot before capture so pose tracking stays continuous. Carrying the robot and setting it down can leave `waypointSafe: true` while the pose is wrong because that flag only proves fresh `map`-frame TF, not physical correctness.

If Nav2 cannot drive to a spot, use manual controls. If the robot was carried, restart localization at a known reference such as the charger before driving to the waypoint spot.

## Readiness checks

Fast commands live in `docs/COMMANDS.md`.

Startup/preflight readiness is based on:

1. `nav2_msgs` import works.
2. `/odom` has live samples and odom-to-base TF.
3. Nav2 lifecycle nodes are active.
4. `/scan_nav2` has a live publisher and costmap subscribers.
5. `/navigate_to_pose` action discovery is reported, but Pi DDS discovery misses are tolerated at bridge readiness if the rest of the stack is proven.

The repo odom helper first uses `odom->base_link`; if absent, it anchors the first live `map->base_link` pose and publishes synthetic relative `/odom`. Do not publish raw global map pose as odom.

The scan filter and odom helpers are supervised because child `rclpy` processes can exit or stop publishing while the process still exists. ROS2 CLI readiness calls are bounded because `ros2 topic info` and `ros2 action list` can hang under Pi DDS/daemon load.

## Direct bridge hardware ownership and stop semantics

The direct bridge must own `/dev/ttyAMA0` exclusively during live navigation. Yahboom's `app_dogzilla.py` and `oled_dogzilla.py` (including the `yahboom_oled.service` unit) must be stopped before the bridge starts. `scripts/stop-dogzilla-vendor-app-ssh.ps1` stops the service, kills both processes, and fails if either still holds `/dev/ttyAMA0` open. `scripts/install-dogzilla-boot-services-ssh.ps1` adds `Conflicts=yahboom_oled.service` to `robodoge-direct-bridge.service`, runs an equivalent privileged `ExecStartPre=+` vendor-stop flow, and disables `yahboom_oled.service` after enable.

`/dev/ttyAMA1` remains LiDAR/ROS-owned; do not stop or repurpose it.

The bridge distinguishes two stop paths:

- `emergency_stop` (reason `emergency_stop`): latches `/nav2/cmd_vel` blocked until an explicit unlatch path is used. A subsequent `locomotion.goto` does **not** silently clear this safety block.
- `command_preempt` (reason `command_preempt`): cancels the active Nav2 goal and stops robot motion, but does **not** latch `/nav2/cmd_vel` blocked. A fresh `locomotion.goto` clears any stale command-preempt gate at start.

## Pi load-shed modes

The direct bridge owns a single navigation-mode state to keep Pi load low unless the robot is actively localizing or navigating:

| Mode | Running | Stopped |
| --- | --- | --- |
| `idle` | direct bridge, audio, optional camera/YOLO | Cartographer, Nav2, scan filter |
| `localize` | `idle` + Cartographer/map-pose | Nav2, scan filter |
| `navigate` | `localize` + Nav2 + scan filter + gait adapter | — |
| `sleep` | direct bridge only (audio/camera optional) | Cartographer, Nav2, scan filter, YOLO |

Control modes via the bridge:

- `GET /mode` returns current mode and transition history.
- `POST /mode` with `{"mode": "localize|navigate|idle|sleep"}` transitions the stack.
- `locomotion.goto` automatically requests `navigate` mode if not already in `navigate` or `localize`.
- After `DOGZILLA_NAV_MODE_IDLE_DELAY_SEC` (default 300 s) of inactivity the bridge demotes toward `idle`.
- Default at startup is `navigate` for compatibility; set `DOGZILLA_DEFAULT_NAV_MODE=idle` to keep the Pi cool at boot.

`/healthz-lite` and `/healthz` now include compact feedback: `navMode`, `loadAverage`, `gaitBlocked`, and `gaitBlockedReason`. Use `/healthz-lite` for frequent UI polls; full `/healthz` is for diagnostics or failures only.

## Starting and deploying

`start-map-pose` and `start-navigation` are wrapped in a 3-attempt retry loop (`lib/dogzilla-start-retry.mjs`, backoff 0/2s/5s) for startup and command-time repair.

```powershell
npm run dogzilla:start-navigation
```

App startup and command-time waypoint repair start map-pose localization before Nav2. `lib/dogzilla-waypoint-navigation-launcher.mjs` and `lib/robot-sidecar-client.mjs` use `start-map-pose` first because Nav2 launch needs live Cartographer map pose.

`scripts/start-dogzilla-map-pose-ssh.ps1` copies the map-pose sidecar, reads saved origin, and runs `docker exec robodoge-map-pose` to publish initial pose. `scripts/start-dogzilla-navigation-ssh.ps1` copies `sidecars/dogzilla_navigation` and `sidecars/dogzilla_map_pose` to the Pi, then runs `start-navigation-in-container.sh` inside `robodoge-rosbridge`.

Startup scripts are Windows PowerShell-driven SSH launchers. Avoid PowerShell heredocs sent through SSH, serialize apt work through startup locks, and use parent-safe `pgrep` stop loops for background services.

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

In UI Mini Map > Navigation Setup:

1. Localize on Map.
2. Mark Origin.
3. Save Spot, then Check Ready.
4. Restart Nav when repair is needed.

For a new map, expand "Map a new space": New Map -> drive -> Save Map. Save Map restarts localization against the new map.

`Localize on Map` seeds Cartographer localization from the saved charger origin (`output/app-cache/dogzilla-map-origin.json`), defaulting to `(0, 0, 0)` when no origin exists. It is local refinement, not global relocalization.

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
