# DOGZILLA Map Pose

Cartographer config for a real DOGZILLA map-frame pose from live MS200 scans.

Source docs:

- `docs/DOGZILLA-main/14.Lidar course/1. Introduction and use of radar.pdf`: starts MS200 and verifies `/scan`.
- `docs/DOGZILLA-main/14.Lidar course/Robot dog mapping.pdf`: uses Cartographer mapping and saves `.pbstream` with `/write_state`.
- `docs/DOGZILLA-main/14.Lidar course/Robot Dog Navigation.pdf`: uses saved `.pbstream` and `.yaml` for navigation/localization.
- `docs/DOGZILLA-main/14.Lidar course/5. Patrol.pdf`: DOGZILLA has no chassis odometer; Cartographer supplies pose and patrol reads TF.

This config starts live laser-only Cartographer SLAM so the lidar bridge can read `map -> base_link` from `/tf`. It does not use scan-odom, timed motion, or fake app-side pose.

Start after the lidar bridge container is running:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-dogzilla-map-pose-ssh.ps1 -Host 10.0.4.32
```

Expected proof:

```text
GET http://10.0.4.32:8896/pose
frame: map
source: tf:map->base_link
waypointSafe: true
```
