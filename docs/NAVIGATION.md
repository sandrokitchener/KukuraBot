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

## Waypoint authority

- `config/robot-waypoints.json` is authoritative for real coordinates and trust fields.
- Do not rewrite, downgrade, disable, or "correct" trusted waypoints without explicit user instruction.
- Diagnostics may warn about map identity, bounds, fingerprints, or drift, but stay advisory unless the user asks for a config change.
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

`/state` is the fast liveness probe. `/preflight` is heavier.

## Starting and deploying

Start navigation:

```powershell
npm run dogzilla:start-navigation
```

`scripts/start-dogzilla-navigation-ssh.ps1` copies `sidecars/dogzilla_navigation` and `sidecars/dogzilla_map_pose` to the Pi, then runs `start-navigation-in-container.sh` inside `robodoge-lidar-bridge`.

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
