# DOGZILLA Map Pose

Cartographer config for a real DOGZILLA map-frame pose from live MS200 scans.

Source docs:

- `docs/DOGZILLA-main/14.Lidar course/1. Introduction and use of radar.pdf`: starts MS200 and verifies `/scan`.
- `docs/DOGZILLA-main/14.Lidar course/Robot dog mapping.pdf`: uses Cartographer mapping and saves `.pbstream` with `/write_state`.
- `docs/DOGZILLA-main/14.Lidar course/Robot Dog Navigation.pdf`: uses saved `.pbstream` and `.yaml` for navigation/localization.
- `docs/DOGZILLA-main/14.Lidar course/5. Patrol.pdf`: DOGZILLA has no chassis odometer; Cartographer supplies pose and patrol reads TF.

This config starts Cartographer so the lidar bridge can read `map -> base_link` from `/tf`. It does not use scan-odom, timed motion, or fake app-side pose.

Persistent map behavior:

- Default startup mode is `auto`.
- If `$REMOTE_ROOT/maps/robodoge_home.pbstream` exists, `auto` starts localization-only mode against that saved map.
- If no saved map exists, `auto` fails instead of silently generating a new map.
- Start mapping only with `DOGZILLA_MAP_POSE_MODE=mapping` or the app's explicit `Start mapping mode` action.
- Save the current Cartographer state with the app's `Save SLAM map` action or `scripts/save-dogzilla-map-pose-ssh.ps1`.
- Waypoints should be stored in Cartographer `map` coordinates. The robot can start from a different physical position, but the saved map frame remains the waypoint contract.

Start after the lidar bridge container is running:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-dogzilla-map-pose-ssh.ps1 -Host 10.0.4.32
```

Start a new mapping session explicitly:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-dogzilla-map-pose-ssh.ps1 -Host 10.0.4.32 -Mode mapping
```

Save the current map:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\save-dogzilla-map-pose-ssh.ps1 -Host 10.0.4.32
```

Expected proof:

```text
GET http://10.0.4.32:8896/pose
frame: map
source: tf:map->base_link
waypointSafe: true
```
