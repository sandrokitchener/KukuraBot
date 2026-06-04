# DOGZILLALib Bridge

HTTP bridge for direct Yahboom `DOGZILLALib` control when ROS2 Python (`rclpy`) is missing or not ready.

Endpoints:

- `GET /healthz`
- `GET /feedback`
- `GET /actions`
- `GET /preflight`
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
- `shake` / `handshake` / `paw_shake`: action `19`
- `start_dance_loop`: `perform(1)` performance/action rotation mode
- `stop_dance`: `perform(0)` stops performance/action rotation mode

Default mode is dry-run. Start with `--live` or set `DOGZILLA_DIRECT_DRY_RUN=0` only when the robot is on the floor with clearance.

## Yahboom Study Page Defaults

The DOGZILLA study page shows these useful defaults for bridge bring-up:

- Pi 5 ROS2 lane enters Docker with `./run_humble.sh`.
- Chassis/radar/IMU/joint-state bringup uses `ros2 launch bringup Navigation_bringup.launch.py`.
- The default LAN communication group is `ROS_DOMAIN_ID=16`.
- APP mapping docs use camera topic `/usb_cam/imge_raw/compress`.
- APP/control startup can occupy camera/control resources; stop it before live direct-bridge tests.

Vendor import discovery checks repo-local `vendor/DOGZILLALib`, `/home/pi/DOGZILLA`, and `/home/yahboom/DOGZILLA` layouts by default. Override with `DOGZILLA_VENDOR_PATHS` and `DOGZILLA_VENDOR_MODULES` if the image differs.
