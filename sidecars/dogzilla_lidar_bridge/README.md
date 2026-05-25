# DOGZILLA Lidar Bridge

Pi-local ROS2 LaserScan bridge for DOGZILLA lidar evidence in the app.

Pipeline:

```text
ORADAR MS200 ROS2 driver -> /scan -> HTTP JSON -> Questing Beast Mini Map
```

Endpoints:

- `GET /healthz`
- `GET /scan`
- `GET /diagnostics`

The bridge runs inside the Yahboom ROS Humble Docker image because the lidar drivers and `sensor_msgs` runtime live there. Yahboom's DOGZILLA S2 lessons use the ORADAR MS200 driver and publish `/scan` from inside Docker with `ROS_DOMAIN_ID=16`.

The default serial device is `/dev/ttyAMA1` at `230400`, matching `/root/yahboomcar_ws/src/oradar_lidar/launch/ms200_scan.launch.py`. The YDLidar path remains available only as an explicit fallback with `--driver ydlidar --serial-port /dev/ttyUSB0 --baudrate 115200`.

`no-scan` and `/diagnostics` responses include the driver log, ROS graph diagnostics, serial-device diagnostics, and next read-only checks. This distinguishes:

- no HTTP bridge
- no ROS `/scan` publisher
- `/scan` advertised, but no `LaserScan` frames received
- USB serial adapter present or missing
- stable `/dev/serial/by-id` mapping and read/write access

The last case usually means the driver opened the UART but is not receiving valid raw packets. Motor spin proves the lidar has power; it does not prove the Pi is receiving scan packets on the serial RX path. Check the lidar model/protocol, TX/RX wiring, and the mounted serial device before debugging the app renderer.

Read-only desktop probe:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\probe-dogzilla-lidar.ps1 -Host <DOGZILLA_IP>
```
