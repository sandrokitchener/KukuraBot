# ROS2 Bridge Sidecar

Thin HTTP bridge that accepts app command envelopes and republishes them onto a ROS2 plan topic.

Current contract:

- `GET /healthz`
- `GET /feedback`
- `GET /study-hints`
- `POST /commands`

Default ROS topics:

- command plan: `/dogzilla/command_plan`
- state feedback: `/dogzilla/state`

The sidecar publishes `std_msgs/msg/String` plan JSON when `rclpy` is available.
If `rclpy` is missing, the sidecar reports degraded health so the app can show operator feedback instead of silently dropping commands.

Yahboom DOGZILLA study-page defaults now surface in `/healthz` and `/study-hints`:

- default `ROS_DOMAIN_ID=16` unless `ROS_DOMAIN_ID` or `DOGZILLA_ROS_DOMAIN_ID` is already set
- Pi 5 Docker entry: `./run_humble.sh`
- bringup launch: `ros2 launch bringup Navigation_bringup.launch.py`
- keyboard test: `ros2 run teleop_twist_keyboard teleop_twist_keyboard`
- APP camera topic shown by docs: `/usb_cam/imge_raw/compress`
