# ROS2 Bridge Sidecar

Thin HTTP bridge that accepts app command envelopes and republishes them onto a ROS2 plan topic.

Current contract:

- `GET /healthz`
- `GET /feedback`
- `POST /commands`

Default ROS topics:

- command plan: `/dogzilla/command_plan`
- state feedback: `/dogzilla/state`

The sidecar publishes `std_msgs/msg/String` plan JSON when `rclpy` is available.
If `rclpy` is missing, the sidecar reports degraded health so the app can show operator feedback instead of silently dropping commands.
