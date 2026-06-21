# DOGZILLA Navigation Notes

Read this for SLAM, Nav2, waypoints, saved map origin, pose, robot movement, and route dispatch.

## Source-of-truth order

1. Local Yahboom docs under `docs/DOGZILLA-main`, especially `14.Lidar course`.
2. Repo configs and code listed below.
3. Live Pi/bridge/Nav2 state when behavior depends on the robot.

Do not use generic ROS assumptions when local DOGZILLA docs or live evidence disagree.

## Yahboom documented flow

Relevant docs:

- `docs/DOGZILLA-main/14.Lidar course/1. Introduction and use of radar.pdf`
- `docs/DOGZILLA-main/14.Lidar course/Robot dog mapping.pdf`
- `docs/DOGZILLA-main/14.Lidar course/Robot Dog Navigation.pdf`
- `docs/DOGZILLA-main/14.Lidar course/5. Patrol.pdf`

Stable facts captured in repo docs:

- DOGZILLA uses ORADAR/MS200 LiDAR on HAT UART `/dev/ttyAMA1`.
- Mapping/localization is Cartographer-based.
- DOGZILLA has no physical chassis odometer; Cartographer/localization supplies odom-style data.
- Yahboom navigation docs point to `localization_imu_odom.launch.py` and `navigation2.launch.py`.
- **IMU is unreliable**: Both Cartographer lua configs set `TRAJECTORY_BUILDER_2D.use_imu_data = false` because the DOGZILLA IMU endpoint (`/imu`) does not reliably produce data. Cartographer operates in laser-only mode with `use_online_correlative_scan_matching = true` as fallback. If IMU is ever restored, re-enable with caution and test that the full TF chain (`odom->base_link`, `map->base_link`) becomes resolvable.

## Current Robo-Doge navigation model

Robo-Doge uses `app_map` waypoints to decouple saved waypoints from Cartographer's raw `map` origin.

```text
capture live map pose
-> mapPoseToAppPose()
-> save waypoint frame: app_map
-> dispatch resolves app_map back to current map pose
-> Nav2 NavigateToPose
```

Key files:

| File | Role |
| --- | --- |
| `lib/dogzilla-map-frame.mjs` | `mapPoseToAppPose()` and `appPoseToMapPose()` |
| `scripts/capture-dogzilla-map-pose.mjs` | Captures current pose into `config/robot-waypoints.json` |
| `scripts/set-dogzilla-map-origin.mjs` | Saves current pose as map origin |
| `scripts/migrate-waypoints-to-appmap.mjs` | Migrates old raw-map entries |
| `lib/dogzilla-waypoint-navigation-launcher.mjs` | Starts/checks waypoint navigation and auto-saves origin |
| `lib/robot-command-compiler.mjs` | Resolves waypoint pose for dispatch |
| `lib/dogzilla-navigation-readiness.mjs` | Readiness evaluation |
| `sidecars/dogzilla_lib_bridge/nav2_client.py` | Nav2 client inside direct bridge path |
| `sidecars/dogzilla_navigation/start-navigation-in-container.sh` | Container-side Nav2 install/param/filter/launch script |
| `sidecars/dogzilla_map_pose/save-map-pose-in-container.sh` | Saves explicit SLAM maps with unique map IDs |

## Map identity contract

- Saved maps are identity-bearing artifacts. `save-map-pose-in-container.sh` writes a unique `robodoge_home_<timestamp>` map ID into `robodoge_home_map.json`; bridge health exposes that ID plus fingerprint.
- `start-map-pose-in-container.sh` and `start-navigation-in-container.sh` resolve active `.pbstream` / `.yaml` from `robodoge_home_map.json` before falling back to legacy `robodoge_home.*` paths.
- Saving is refused while Cartographer is in localization mode unless `DOGZILLA_MAP_SAVE_ALLOW_LOCALIZATION=1` is set. Use explicit SLAM mapping mode for new maps.
- A saved origin is usable only when its `map.id` and `map.fingerprint` match the active map. If active map identity is unavailable, missing, or mismatched, the UI must show raw `map` pose and a stale-map warning, not a confident `app_map` pose.
- Existing waypoints whose map identity is missing or does not match the active map are historical/stale for readiness and dispatch. Do not rewrite them automatically; recapture after the active map and charger origin are stable.

## Waypoint authority

- `config/robot-waypoints.json` is authoritative for real coordinates and trust fields.
- Do not rewrite, downgrade, disable, or "correct" trusted waypoints without explicit user instruction.
- Diagnostics may warn about map identity, bounds, fingerprints, or drift without editing config. Readiness and command dispatch must block missing/stale-map identity even though the source file remains authoritative.
- Notes are never authoritative for dispatch or validation.

Current source inspection shows verified `app_map` waypoints for `living_room`, `kitchen`, `garage`, and `charger` with `mapId: robodoge_home`. Other map-pose entries are unverified in the current file.

## Readiness checks

Fast commands:

See `docs/COMMANDS.md`.

Readiness should progress through:

1. `nav2_msgs` import works, no `No module named 'nav2_msgs'`.
2. `/navigate_to_pose` action server is available.
3. `/odom` message and TF are available.
4. Nav2 lifecycle nodes are active.
5. Filtered scan is available on `/scan_nav2`.
6. `ready: true`.

Startup prints these as separate terminal gates before app launch:
Nav2 action server, `/odom` odom samples, `odom->base_link/base_footprint` TF,
Nav2 lifecycle nodes, `/scan_nav2` filtered scan, and map-frame pose. `npm
start` blocks before spawning the app when DOGZILLA waypoint navigation remains
unready. Standalone `node server.mjs` applies the same gate before listen. Use
`APP_DOGZILLA_STARTUP_REQUIRE_NAV=0` only for non-navigation debugging.

`/state` is the fast liveness probe. `/preflight` is heavier.

Direct-bridge Nav2 checks intentionally allow slow Pi lifecycle responses:
`DOGZILLA_NAV2_LIFECYCLE_WAIT_TIMEOUT` defaults to 12 seconds and
`DOGZILLA_NAV2_DOCKER_STATUS_TIMEOUT` defaults to 30 seconds. Do not lower them
without proving command-time `/controller_server/get_state`,
`/planner_server/get_state`, `/bt_navigator/get_state`, and
`/behavior_server/get_state` responses stay fast under load.

If dispatch fails with `Nav2 lifecycle nodes are not active:
controller_server, planner_server, bt_navigator, behavior_server`, verify the
command-time path before changing waypoints or restarting Nav2. `/healthz` is a
snapshot and `/commands` re-probes prerequisites before sending a goal; those can
temporarily disagree when lifecycle services are slow. Check that `/healthz`
reports `lifecycleWaitTimeoutSec: 12` and `dockerStatusTimeoutSec: 30`, then
tail `/home/pi/robodoge/sidecars/dogzilla_lib_bridge/command_log.ndjson` and
query the four lifecycle services inside `robodoge-lidar-bridge`.

## Starting and deploying

Start navigation:

```powershell
npm run dogzilla:start-navigation
```

App startup and command-time waypoint repair must start map-pose localization before Nav2. `lib/dogzilla-startup-watchdog.mjs`, `lib/dogzilla-waypoint-navigation-launcher.mjs`, and `lib/robot-sidecar-client.mjs` use `start-map-pose` first, then `start-navigation`, because Nav2 launch can fail when `/pose` is HTTP 503 / `no-pose`.

`scripts/start-dogzilla-navigation-ssh.ps1` copies `sidecars/dogzilla_navigation` and `sidecars/dogzilla_map_pose` to the Pi, then runs `start-navigation-in-container.sh` inside `robodoge-lidar-bridge`.

Startup scripts are Windows-PowerShell driven SSH launchers. Keep remote snippets
CRLF-proof: avoid PowerShell heredocs sent through SSH, serialize apt work with
the shared startup locks, and use parent-safe `pgrep` stop loops for background
services. Map-pose localization chooses the no-IMU `_noimu` Cartographer config
before launch; do not move config selection after Cartographer starts.

Map workflow:

```powershell
npm run dogzilla:start-map-pose        # localize against active saved map, no map mutation
# In UI Mini Map > Mapping: Localize on saved map
# In UI Mini Map > Mapping: Set charger origin here
# In UI Mini Map > Mapping: Save waypoint here, then Check waypoint readiness
# In UI Mini Map > Mapping: Start new SLAM map / Save new map identity for explicit new-map mode
npm run dogzilla:set-origin            # recapture origin after active map changes
npm run dogzilla:validate-waypoints
```

After saving a new SLAM map, existing origins and app-map waypoints should report stale until recaptured against the new active map identity.

SSH config:

```text
output/pi-ssh/config
alias: dogzilla
host: 10.0.4.32
user: pi
```

Manual Nav2 message fix if needed:

```powershell
scp -F output/pi-ssh/config scripts/install-nav2-msgs-in-container.sh dogzilla:/home/pi/robodoge/
ssh -F output/pi-ssh/config dogzilla "docker exec robodoge-lidar-bridge sudo bash /home/pi/robodoge/install-nav2-msgs-in-container.sh"
ssh -F output/pi-ssh/config dogzilla "sudo systemctl restart robodoge-direct-bridge.service; sleep 5"
```

Deploy changed direct-bridge Nav2 client:

```powershell
scp -F output/pi-ssh/config sidecars/dogzilla_lib_bridge/nav2_client.py dogzilla:/home/pi/robodoge/sidecars/dogzilla_lib_bridge/nav2_client.py
ssh -F output/pi-ssh/config dogzilla "rm -f /home/pi/robodoge/sidecars/dogzilla_lib_bridge/__pycache__/nav2_client.cpython-311.pyc"
ssh -F output/pi-ssh/config dogzilla "sudo systemctl restart robodoge-direct-bridge.service; sleep 5"
node scripts/probe-dogzilla-nav-readiness.mjs
```

## Tuning

`config/robot-obstacle-avoidance.json` carries Nav2 tuning knobs, including robot radius, inflation, scan filter mask, yaw tolerance, XY tolerance, controller/planner frequency, and movement allowance.

Current config makes final yaw effectively non-blocking with `yawGoalTolerance: 6.283`.

## Known live-work rules

- For "spins and goes nowhere", inspect live costmap, scan, timeout, and recovery evidence before changing planner assumptions or waypoint data.
- Local tests prove plumbing, not live route correctness.
- If the robot is low battery or unhealthy, pause live motion retries and continue only local code/tests.
- If robot heads the wrong way, verify translation direction and heading/orientation early.

## More detail

- `docs/COMMANDS.md`
- `docs/archive/dogzilla-real-map-pose.md`
- `docs/archive/waypoint-mapping-guide.md`
- `docs/archive/dogzilla-waypoint-navigation-evaluation.md`
