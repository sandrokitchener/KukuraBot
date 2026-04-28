# DOGZILLALib Bridge

HTTP bridge for direct Yahboom `DOGZILLALib` control when ROS2 Python (`rclpy`) is missing or not ready.

Endpoints:

- `GET /healthz`
- `GET /feedback`
- `GET /actions`
- `POST /commands`

`POST /commands` accepts the same app envelope as the ROS2 sidecar. The bridge reads `envelope.canonicalPlan` or `envelope.payload.canonicalPlan`.

Safe known action tests:

- `reset_pose` / `reset`: action `255`
- `startup_stretch` / `stretch`: action `14`
- `three_axis`: action `10`
- `swing`: action `16`
- `pee`: action `11`
- `crawl`: action `3`
- `pray`: action `17`

Default mode is dry-run. Start with `--live` or set `DOGZILLA_DIRECT_DRY_RUN=0` only when the robot is on the floor with clearance.
