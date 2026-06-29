# DOGZILLA Rosbridge Sidecar

Standard `rosbridge_server` sidecar for DOGZILLA. Replaces the custom HTTP lidar bridge (`sidecars/dogzilla_lidar_bridge`) with a rosbridge websocket connection.

Pipeline:

```text
ORADAR MS200 ROS2 driver -> /scan -> rosbridge_server websocket:9090 -> Questing Beast Node backend
Cartographer -> /map_cartographer -> rosbridge_server websocket:9090 -> Questing Beast Mini Map
```

Entrypoint: `start-rosbridge-in-container.sh`

This script runs inside the `robodoge/ros-humble-cartographer:1.0` container alongside Cartographer (`robodoge-map-pose`) and Nav2 (`robodoge-navigation`). It launches:

- `ros2 run oradar_lidar oradar_scan` on `/dev/ttyAMA1`
- `ros2 launch rosbridge_server rosbridge_websocket_launch.xml` on port 9090

The Node backend connects to `ws://<pi-ip>:9090` and subscribes to `/scan`, `/tf`, `/tf_static`, `/odom`, and `/map_cartographer` via `lib/rosbridge-client.mjs`.
