# DOGZILLA Real Map And Pose Notes

## Current Working Feed

The Pi direct bridge exposes read-only robot state:

```text
GET http://10.0.4.32:8893/state
```

Default field currently fed into the app:

- battery

The direct bridge leaves roll, pitch, yaw, motor readback, and raw IMU as `null`/empty by default because vendor serial reads can block for seconds when the controller or robot battery is unhealthy. Attitude and slower fields are opt-in bridge settings for bench testing, not map pose.

This is telemetry, not map pose. The mini-map must keep pose as `null` until a real localization source publishes `x`, `y`, and `theta`.

## Real Map/Pose Candidate

The host Debian system has no native ROS2 install. Yahboom shipped ROS2 Humble inside Docker images:

```text
yahboomtechnology/ros-humble:3.6
yahboomtechnology/ros-humble:3.5
```

Relevant launch files found by read-only Docker inspection:

```text
/root/yahboomcar_ws/src/yahboom_bringup/launch/Mapping_bring.launch.py
/root/yahboomcar_ws/src/yahboom_bringup/launch/Navigation_bringup.launch.py
/root/yahboomcar_ws/src/yahboom_bringup/launch/Catographer.launch.py
/root/yahboomcar_ws/src/yahboom_bringup/launch/Catographer_localization.launch.py
/root/yahboomcar_ws/src/yahboom_base/launch/yahboom_base.launch.py
/root/yahboomcar_ws/src/yahboomcar_ydlidar/params/ydlidar.yaml
```

Observed stack:

- `Navigation_bringup.launch.py` includes `rf2o_laser_odometry`, `Catographer_localization`, `localization_server`, and `navigation_server`.
- `Catographer.launch.py` uses `cartographer_ros` with `/scan`.
- `Catographer_localization.launch.py` uses `cartographer_ros` with `/scan` remapped to `/scan` and IMU to `/imu/data_raw`.
- YDLidar config expects `/dev/ttyUSB0`, frame `laser_frame`, baud `230400`.

## Blockers

- No `/dev/ttyUSB0` or USB lidar device was visible during inspection.
- `lsusb` showed only root hubs at that time.
- Camera `cv2.VideoCapture(0..5)` did not open, though vendor Flask stream exists on port `6500`.
- Opening the vendor `/video_feed` stream can monopolize or hang the vendor Flask app. The Robo-Doge UI now lazy-loads the stream only while the Camera tab is active.
- Running the Docker ROS2 mapping/navigation stack would require device mounts and launch testing. Ask before changing/running anything beyond read-only inspection.

## Integration Plan

1. Keep current `/state` battery/IMU feed live in the app.
2. When lidar is visible, run Docker ROS2 read-only topic checks with explicit approval.
3. Find a stable pose topic, likely from Cartographer/localization:
   - `/tf` or `/tf_static` transform `map -> base_link` / `base_footprint`
   - `/odom`
   - localization server pose topic if present
4. Add a small bridge adapter that converts the chosen pose source into app `robot.state`:

```json
{
  "type": "robot.state",
  "uuid": "dogzilla-local",
  "name": "DOGZILLA Direct Bridge",
  "pose": { "x": 0, "y": 0, "theta": 0 },
  "task": "IDLE",
  "timestamp": "2026-05-20T00:00:00Z",
  "seq": 1
}
```

5. Keep pose `null` until the source is verified.

## Explicit Non-Option

Do not implement waypoint movement as timed/dead-reckoned scripts such as "drive forward for N seconds, turn, then drive again." Robo-Doge waypoint navigation requires a real pose/localization source and a navigation executor that can reason about the robot's position.
