# DOGZILLA Lidar Bridge

Pi-local ROS2 LaserScan bridge for DOGZILLA lidar evidence in the app.

Pipeline:

```text
ORADAR ROS2 driver -> /scan -> HTTP JSON -> Questing Beast Mini Map
```

Endpoints:

- `GET /healthz`
- `GET /scan`

The bridge runs inside the Yahboom ROS Humble Docker image because the lidar driver and `sensor_msgs` runtime live there. It starts the ORADAR MS200 driver by default and reports `no-scan` loudly if no `LaserScan` frames arrive.
