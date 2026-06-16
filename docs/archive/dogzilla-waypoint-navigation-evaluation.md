<!-- Archive detail doc. Do not read by default. Current summary lives in docs/NAVIGATION.md and docs/KNOWN_ISSUES.md. -->

# DOGZILLA Waypoint Navigation Evaluation

Date: 2026-06-07

## 2026-06-07 Live Navigation Update

Nav2 has been installed and started inside the `robodoge-lidar-bridge` container with Robo-Doge's custom DOGZILLA navigation launcher.

Live proof after start:

- `/navigate_to_pose [nav2_msgs/action/NavigateToPose]` exists.
- `/bt_navigator` provides the `NavigateToPose` action server.
- `/cmd_vel` has one subscriber from Yahboom `yahboom_base`.
- `/map` has one `nav_msgs/msg/OccupancyGrid` publisher from `nav2_map_server`.
- Nav2 lifecycle nodes report `active`.
- DOGZILLA Direct Bridge health reports `navigation.primary: "nav2"` and `nav2.available: true`.

2026-06-08 follow-up against known-good `slam_toolbox`/Nav2 assumptions found a second blocker: `/odom` had zero publishers in the live ROS graph. A `NavigateToPose` action server can exist without a usable odometry feed, but map waypoint motion is not safe or reliable in that state. The app and bridge now treat waypoint-ready as Nav2 action server plus live `/odom`, not action server alone.

2026-06-08 later live repair:

- Cartographer already publishes TF `odom -> base_link`.
- Robo-Doge now starts one TF-derived `nav_msgs/msg/Odometry` publisher on `/odom` when that TF exists.
- DOGZILLA Direct Bridge waits briefly for DDS discovery before declaring `/odom` missing.
- Live bridge health now reports `navigation.primary: "nav2"`, `navigation.waypointReady: true`, `nav2.odom.publisherCount: 1`.

2026-06-08 `slam_toolbox` comparison follow-up:

- Upstream `slam_toolbox` treats saved pose-graph identity as durable map state. Robo-Doge's equivalent is the Cartographer `.pbstream` plus generated Nav2 `.yaml`/`.pgm` and active map fingerprint.
- `npm run dogzilla:validate-waypoints` now reports both `ok` for the waypoint source and `readyForMapWaypoints` for live operator readiness.
- `GET /api/dogzilla/waypoint-readiness` returns the same read-only report for the app, and the mini-map meta line shows the first blockers.
- `readyForMapWaypoints` requires Nav2 waypoint readiness, a saved charger origin tied to the active map identity, at least one ready map waypoint, and zero invalid map waypoints.
- This keeps a real Nav2 server from being mistaken for a trustworthy route when the app origin or waypoint registry is stale.

Current remaining blockers are:

- Recapture/clean dummy or mismatched entries in `config/robot-waypoints.json` against the current saved map.
- Reset and resave the charger origin against the current map so `app_map 0,0,0` matches the dock.
- Tune/verify Nav2 params for DOGZILLA instead of assuming the upstream TurtleBot-sized defaults are final.

## `slam_toolbox` Comparison

Known-good `slam_toolbox`/Nav2 shape:

- SLAM/localization subscribes to laser scan and odometry, then publishes `map -> odom` and `/map`.
- Saved pose-graph/localization mode reloads the prior map state instead of silently starting a fresh map.
- Localization can start near a dock, from a selected graph node, or from a map-frame pose estimate.
- Saved graph services distinguish display maps from lossless map state: `save_map` writes an image map; `serialize_map` writes pose-graph data for continued mapping/localization.
- Nav2 consumes `/map`, `map -> odom`, `odom -> base_link`, `/odom`, `/scan`, and a robot-specific costmap/controller config.

Current Robo-Doge shape:

- We are using Cartographer, not `slam_toolbox`, but the frame contract is now similar: `/scan` from ORADAR, Cartographer `map -> odom`, Cartographer `odom -> base_link`, TF-derived `/odom`, Nav2 `/map`, and `/navigate_to_pose`.
- We load a saved frozen `.pbstream` by default and refuse accidental fresh mapping unless mapping mode is explicitly requested. This is the Cartographer version of the `slam_toolbox` saved pose-graph rule.
- We fingerprint the active map and require matching identity on saved origins and map waypoints before treating them as ready.
- The remaining mismatch is that Nav2 currently launches with the stock Nav2 bringup params unless overridden. Those defaults are useful for getting a real server online, but they are not proof of DOGZILLA-specific controller quality.

## Verdict

Robo-Doge can now read a real map-frame pose from Cartographer, show it in the app, compile named waypoints into `locomotion.goto` plans, and reach a real Nav2 `NavigateToPose` action server.

Robo-Doge still should not be trusted with arbitrary named-room waypoints until `config/robot-waypoints.json` is cleaned and recaptured against the current saved map. Current map pose is localization evidence. Nav2 is now the navigator, but bad target coordinates can still send the robot to the wrong place.

The earlier `map-pose-closed-loop` movement fallback was the wrong tool for waypoint navigation. It could turn and step based on pose error, but it was not a real planner/controller with costmaps, recovery behavior, or obstacle-aware path following. It is now blocked for normal waypoint dispatch; Nav2 or an equivalent proved navigation server is required.

## Current Pipeline

1. User asks for a destination.
2. `lib/app-service.mjs` builds the prompt context from command schema plus waypoint config.
3. `lib/robot-command-compiler.mjs` resolves the waypoint from `config/robot-waypoints.json`.
4. A map waypoint compiles to:

```json
{
  "kind": "locomotion.goto",
  "params": {
    "targetKind": "waypoint",
    "frame": "map",
    "x": 0,
    "y": 0,
    "yaw": 0,
    "obstacleAvoidance": {
      "required": true,
      "mode": "nav2_costmap",
      "lidarTopic": "/scan"
    }
  }
}
```

5. `lib/robot-sidecar-client.mjs` probes bridge health before dispatch.
6. `sidecars/dogzilla_lib_bridge/server.py` sends `NavigateToPose` only if a Nav2 action server is available.
7. If Nav2 is missing, the app returns `navigation-unavailable` and does not send the waypoint.

That block is intentional. It prevents the robot from entering the old loop where it alternated left/right while facing a wall.

## Live Evidence

Read-only checks against DOGZILLA showed this graph shape:

| Check | Result | Meaning |
| --- | --- | --- |
| `/pose` from lidar/map-pose bridge | `frame: "map"`, source `tf:map->base_link`, `waypointSafe: true` | Localization feed exists. |
| Docker container | `robodoge-lidar-bridge`, Yahboom ROS Humble image | ROS client environment exists. |
| `ros2 action list -t` before Nav2 start | no actions | No action server was running. |
| `ros2 action list -t` after Nav2 start | `/navigate_to_pose [nav2_msgs/action/NavigateToPose]` | Real waypoint action server exists. |
| ROS nodes | `/cartographer_node`, `/oradar_ros`, `/robodoge_lidar_bridge`, TF helpers | Mapping/localization side exists. |
| ROS topics | `/scan`, `/tf`, `/tf_static`, Cartographer topics; `/odom` has 1 TF-derived publisher | Pose/scan graph satisfies the basic Nav2 odometry prerequisite. |
| Nav2 packages before install | `nav2_msgs` only | Message definitions existed; Nav2 stack did not. |
| Nav2 packages after install | `navigation2`, `nav2_bringup`, planner/controller/BT/map-server packages | Nav2 binaries exist. |
| Nav2 server after start | `/bt_navigator` serves `/navigate_to_pose` | Map waypoint executor exists. |
| Yahboom nav packages | expected section-14 packages missing in current image | Documented launch path cannot be assumed installed. |

Important caveat: pose samples taken while the robot was being moved or picked up are not valid evidence of localization swings. The reliable conclusion is narrower: current live graph has pose data, `/odom`, and a Nav2 action server; waypoint data and origin identity are still not trustworthy enough for arbitrary room commands.

## Why Charger 0,0 Became About -3,3

There are two coordinate frames in play:

| Frame | Purpose |
| --- | --- |
| `map` | Raw Cartographer/Yahboom map frame. Its origin can change when a new map is built or loaded differently. |
| `app_map` | Robo-Doge display frame where the charger can be treated as `0,0,0`. |

The app stores a transform in `output/app-cache/dogzilla-map-origin.json`. When that saved origin no longer matches the current Cartographer map, charger display coordinates drift. That is how a charger that used to show as `0,0,0` can later show around `-3,3`.

Correct fix: put DOGZILLA at the charger while map localization is healthy, then press `Reset charger origin: save current pose as 0,0` above the mini-map. After building or replacing a map, repeat that reset and recapture real waypoints.

## Waypoint Data Problems

`config/robot-waypoints.json` is not reliable enough for live navigation yet:

| Waypoint | Problem |
| --- | --- |
| `living_room` | Structured fields currently mark `verified: true` at raw `map 0,0`; confirm that is intended for the active map before using it live. |
| `kitchen` | Structured pose fields are the source of truth. Any stale note text must be ignored by validators and dispatch. |
| many others | Structured `verified: false` entries at `0,0,0`; keep them out of live navigation until their structured fields are captured and verified. |

This means even after a real navigator exists, some named targets can still be wrong. `verified: true` must mean "captured in this exact saved map and arrival tested", and only structured fields may decide that. Notes are human comments only and must never be authoritative for navigation or validation.

## Already Good

- App pose no longer falls back to odom or synthetic scan pose for waypoint truth.
- Map pose bridge exposes `waypointSafe: true` only for `map` frame pose.
- Waypoint dispatch adds required LiDAR avoidance metadata.
- DOGZILLA Direct Bridge refuses map waypoint dispatch when Nav2 is unavailable.
- Local app waypoint dispatch now blocks when Nav2 exists but `/odom` has no publisher.
- The bridge code now reports `nav2.waypointReady` and refuses direct goto when Nav2 odometry prerequisites fail.
- Navigation startup now starts a TF-derived `/odom` publisher when Cartographer already exposes `odom -> base_link`; otherwise it fails loud instead of claiming readiness from action-server presence alone.
- DOGZILLA Direct Bridge waits for `/odom` discovery before reporting waypoint readiness, avoiding false `No publishers on /odom` health results.
- UI has a clear charger-origin reset button above the mini-map.
- Charger-origin capture now refuses to save if active map identity is unavailable, so new origins must carry the current map id and fingerprint.
- `npm run dogzilla:set-origin` uses the same active-map identity rule and writes map identity into the saved origin.
- Tests cover the Direct Bridge Nav2 block and Android/web parity for the origin button.

## Still Missing

- Fresh waypoint captures against the current saved map.
- Put DOGZILLA physically on the charger and press `Reset charger origin: save current pose as 0,0`; the current saved origin is still an old identity-less file and should be replaced only when the robot is actually at the charger.
- Lifecycle/readiness state for localization, planner, controller, map, and base driver.
- Clean waypoint inventory with map id, origin id, capture time, and tested arrival status.
- DOGZILLA-specific Nav2 parameter tuning and a short open-space arrival test.
- End-to-end live arrival test in open space.

## Reliability Plan

### 1. Keep Unsafe Fallback Disabled

Do not re-enable DOGZILLALib map-pose closed-loop movement for map waypoints. It is not enough to "face target and step". It can get stuck oscillating in front of walls and has no path planner.

Required behavior:

- If `NavigateToPose` server is missing, block waypoint dispatch.
- UI should say "map pose available, waypoint navigator missing".
- Bridge health should report `navigation.primary: "unavailable"` until a real server appears.

### 2. Keep Starting A Real Navigator

Preferred target:

```text
NavigateToPose action server
action name: /navigate_to_pose
frame: map
input: geometry pose from named waypoint
output: accepted/rejected/result feedback
```

Yahboom section-14 docs point at:

```text
ros2 launch yahboom_dog_cartographer localization_imu_odom.launch.py load_state_filename:=/home/yahboom/yahboomcar_ws/maps/mymap.pbstream
ros2 launch yahboom_dog_navigation2 navigation2.launch.py use_sim_time:=False map:=/home/yahboom/yahboomcar_ws/maps/mymap.yaml
```

The current deployed path installs upstream ROS Humble Nav2 packages in the Yahboom container and starts a Robo-Doge launch file that uses Cartographer for localization instead of starting AMCL. Verify each run with:

```text
ros2 action list -t
ros2 node list
ros2 topic info /cmd_vel
ros2 lifecycle nodes
npm run dogzilla:validate-waypoints
```

### 3. Add Strong Map Identity

Every origin and waypoint should carry:

- `mapId`
- saved map path
- `.pbstream` hash or mtime
- `.yaml` hash or mtime
- `originId`
- `capturedAt`
- `capturedFrom`

If current map identity differs from waypoint identity, the app should show "stale waypoint for old map" and block live dispatch.

### 4. Clean Waypoints

Rules:

- `verified: true` only after live arrival test passes.
- Dummy notes force `verified: false`.
- `0,0,0` map poses force `verified: false` unless waypoint is explicitly the charger origin.
- Captured note must match stored numeric pose.
- Waypoint capture should save raw `map` pose plus display `app_map` pose.

### 5. Expand Readiness Checks

Bridge health should expose one compact navigation readiness object:

```json
{
  "navigator": {
    "kind": "nav2",
    "ready": true,
    "action": "/navigate_to_pose"
  },
  "localization": {
    "frame": "map",
    "fresh": true
  },
  "base": {
    "commandTopic": "/cmd_vel",
    "subscriberCount": 1
  },
  "map": {
    "id": "robodoge_home",
    "matchesWaypoints": true
  },
  "avoidance": {
    "required": true,
    "running": true
  }
}
```

Dispatch should require all green for map waypoints.

### 6. Test Ladder

Run in this order:

1. Compile dry-run: "go to kitchen" resolves expected waypoint and frame.
2. Static readiness: Nav2 action server present, localization fresh, base command subscriber present.
3. Origin sanity: charger at `app_map 0,0,0` after reset.
4. Short open-space goal: 0.5 m away, no wall nearby.
5. Cancellation: stop command cancels active navigation.
6. Obstacle test: object in path causes planner/avoidance behavior, not blind pushing.
7. Restart test: reboot Pi/container, map identity and origin still match.
8. Real waypoint arrival: capture one waypoint, send it, verify arrival tolerance and final pose.

## Concrete Next Build Work

1. Keep `scripts/start-dogzilla-navigation-ssh.ps1` in the normal recovery flow so Nav2 can be restarted on demand.
2. Add map identity metadata to origin capture and waypoint capture.
3. Mark dummy or mismatched waypoints unverified.
4. Add a UI readiness label that distinguishes:
   - `Map pose ready`
   - `Waypoint navigator missing`
   - `Ready for map waypoints`
5. Add a pre-dispatch check that blocks stale-map or unverified named waypoints.
6. Run the test ladder with one freshly captured waypoint before trusting named-room navigation.
