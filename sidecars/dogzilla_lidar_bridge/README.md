# DOGZILLA Lidar Bridge

Pi-local ROS2 LaserScan bridge for DOGZILLA lidar evidence in the app.

Pipeline:

```text
ORADAR MS200 ROS2 driver -> /scan -> HTTP JSON -> Questing Beast Mini Map
```

Endpoints:

- `GET /healthz`
- `GET /scan`
- `GET /pose`
- `GET /diagnostics`

The bridge runs inside the Yahboom ROS Humble Docker image because the lidar drivers and `sensor_msgs` runtime live there. Yahboom's DOGZILLA S2 lessons use the ORADAR MS200 driver and publish `/scan` from inside Docker with `ROS_DOMAIN_ID=16`.

The serial device is always the HAT UART path: `/dev/ttyAMA1` at `230400`, matching `/root/yahboomcar_ws/src/oradar_lidar/launch/ms200_scan.launch.py`. Do not add alternate serial paths for DOGZILLA lidar startup.

Local source docs: `docs/DOGZILLA-main/14.Lidar course/1. Introduction and use of radar.pdf` starts MS200 with `ros2 launch oradar_lidar ms200_scan.launch.py` and verifies frames with `ros2 topic echo /scan`. `5. Patrol.pdf` reads TF `odom -> base_footprint`; this is why `/pose` listens for both map-frame and odom-frame TF.

`/pose` reports real ROS localization by default: TF `map/odom -> base_link/base_footprint` or `/odom`. The bridge has an experimental LaserScan-only scan-odom estimator, but it is off by default because tiny scan-matching errors can look like the robot is moving while it is sitting still. Enable it only for debugging with `--scan-odom` or `DOGZILLA_SCAN_ODOM=1`; do not treat scan-odom output as a saved waypoint source.

`no-scan` and `/diagnostics` responses include the driver log, ROS graph diagnostics, serial-device diagnostics, and next read-only checks. This distinguishes:

- no HTTP bridge
- no ROS `/scan` publisher
- `/scan` advertised, but no `LaserScan` frames received
- HAT UART device present or missing
- HAT UART read/write access

The last case usually means the driver opened the UART but is not receiving valid raw packets. Motor spin proves the lidar has power; it does not prove the Pi is receiving scan packets on the serial RX path. Check the lidar model/protocol, TX/RX wiring, and the mounted serial device before debugging the app renderer.

Read-only desktop probe:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\probe-dogzilla-lidar.ps1 -Host <DOGZILLA_IP>
```
