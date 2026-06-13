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

Local Yahboom docs live under:

```text
docs/DOGZILLA-main/14.Lidar course/
```

Section 14 confirms these runtime contracts:

- `1. Introduction and use of radar.pdf`: PI5 enters Docker with `./run_humble.sh`, starts MS200 with `ros2 launch oradar_lidar ms200_scan.launch.py`, and verifies lidar frames with `ros2 topic echo /scan`.
- `Robot dog mapping.pdf`: PI5 starts chassis/radar/IMU/joint status with `ros2 launch bringup Navigation_bringup.launch.py`, starts mapping with `ros2 launch yahboom_bringup Mapping_bring.launch.py`, saves `.pbstream` with Cartographer `/write_state`, and converts it to a ROS map.
- `Robot Dog Navigation.pdf`: PI5 localization is `ros2 launch yahboom_dog_cartographer localization_imu_odom.launch.py load_state_filename:=/home/yahboom/yahboomcar_ws/maps/mymap.pbstream`; navigation is `ros2 launch yahboom_dog_navigation2 navigation2.launch.py use_sim_time:=False map:=/home/yahboom/yahboomcar_ws/maps/mymap.yaml`.
- `5. Patrol.pdf`: DOGZILLA has no chassis odometer; Cartographer supplies odometer data, and patrol code reads TF `odom -> base_footprint` for distance and heading.

The host Debian system has no native ROS2 install. Yahboom shipped ROS2 Humble inside Docker images:

```text
yahboomtechnology/ros-humble:3.6
yahboomtechnology/ros-humble:3.5
```

Relevant launch files found by Docker inspection:

```text
/root/yahboomcar_ws/src/yahboom_bringup/launch/Mapping_bring.launch.py
/root/yahboomcar_ws/src/yahboom_bringup/launch/Navigation_bringup.launch.py
/root/yahboomcar_ws/src/yahboom_bringup/launch/Catographer.launch.py
/root/yahboomcar_ws/src/yahboom_bringup/launch/Catographer_localization.launch.py
/root/yahboomcar_ws/src/yahboom_base/launch/yahboom_base.launch.py
/root/yahboomcar_ws/src/oradar_lidar/launch/ms200_scan.launch.py
```

Observed stack:

- `Navigation_bringup.launch.py` includes `rf2o_laser_odometry`, `Catographer_localization`, `localization_server`, and `navigation_server`.
- `Catographer.launch.py` uses `cartographer_ros` with `/scan`.
- `Catographer_localization.launch.py` uses `cartographer_ros` with `/scan` remapped to `/scan` and IMU to `/imu/data_raw`.
- Yahboom's active DOGZILLA launch path uses ORADAR MS200 through the HAT UART on `/dev/ttyAMA1`, frame `laser_frame`, baud `230400`, and topic `/scan`.
- Yahboom's MS200/microROS course also documents an ESP32-S3 control-board path where the MS200 connects to the microROS board's UART1 at 230400 and publishes `sensor_msgs/msg/LaserScan` on `/scan` through a micro-ROS agent:
  - https://www.yahboom.net/public/upload/upload-html/1708418639/Read%20radar%20data.html
  - https://www.yahboom.net/public/upload/upload-html/1706695369/Publish%20lidar%20data%20topics.html

## Blockers

- The Pi exposes `/dev/ttyAMA1`; Yahboom's ORADAR MS200 node now publishes `LaserScan` frames on `/scan`.
- Live probe on 2026-06-04: the lidar bridge reported fresh `/scan` frames, but `/tf`, `/tf_static`, and `/odom` each had `0` publishers. `/pose` therefore correctly reported `no-pose` instead of inventing a position.
- The available Yahboom ROS Humble images (`3.6` and `3.5`) expose `bringup`, `yahboom_bringup`, and `tf_publisher`, but `ros2 pkg list` did not show the section-14 navigation/localization packages `yahboom_dog_cartographer`, `yahboom_dog_navigation2`, `cartographer_ros`, `rf2o_laser_odometry`, or `localization_server`.
- No saved `.pbstream` or ROS map `.yaml` was found on the Pi or in either Yahboom image. Until a real Cartographer/map localization source is installed and running, `/pose` must remain unavailable.
- Live repair on 2026-06-04 installed `ros-humble-cartographer-ros` in the running Yahboom Docker container, started a laser-only Cartographer SLAM config from `sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only.lua`, and started the vendor ORADAR static TF `base_link -> laser_frame` (`0 0 0.18 0 0 0`). `/pose` then returned `frame: "map"`, `source: "tf:map->base_link"`, and `waypointSafe: true`.
- Current Robo-Doge persistent map contract: `start-map-pose` defaults to saved-map localization using `$REMOTE_ROOT/maps/robodoge_home.pbstream`. It refuses to create a fresh map when that file is missing. Use the explicit mapping action (`start-map-pose-mapping` or `-Mode mapping`) to build a new map, then save it with `save-map-pose`.
- Camera `cv2.VideoCapture(0..5)` did not open, though vendor Flask stream exists on port `6500`.
- Opening the vendor `/video_feed` stream can monopolize or hang the vendor Flask app. The Robo-Doge UI now lazy-loads the stream only while the Camera tab is active.
- Running the Docker ROS2 mapping/navigation stack would require device mounts and launch testing. Ask before changing/running anything beyond read-only inspection.

## Current Lidar Observability

The Robo-Doge lidar bridge now exposes explicit no-motion diagnostics:

```text
GET http://<dogzilla-ip>:8896/healthz
GET http://<dogzilla-ip>:8896/scan
GET http://<dogzilla-ip>:8896/diagnostics
GET http://<dogzilla-ip>:8896/pose
```

`/diagnostics` reports:

- active driver choice (`oradar`)
- HAT UART path and permissions
- ROS publisher/subscriber graph for `/scan`
- received frame count and latest frame age
- driver log tail
- next read-only checks

Read-only Windows probe:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\probe-dogzilla-lidar.ps1 -Host <DOGZILLA_IP>
```

The probe hits bridge HTTP endpoints, then uses SSH only for read-only device/process/log checks.

Working map-pose starter:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-dogzilla-map-pose-ssh.ps1 -Host 10.0.4.32
```

This starts the real Cartographer TF source used by `/pose`; it must not be replaced with scan-odom or app-side synthetic pose. By default it loads the saved `.pbstream` and localizes against it.

Explicit mapping and save commands:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-dogzilla-map-pose-ssh.ps1 -Host 10.0.4.32 -Mode mapping
powershell -ExecutionPolicy Bypass -File scripts\save-dogzilla-map-pose-ssh.ps1 -Host 10.0.4.32
```

## Exposed Pose Feed

The lidar/ROS bridge exposes `/pose` from the Yahboom ROS2 navigation conventions:

- TF buffer lookup of `map -> base_link` / `map -> base_footprint`.
- TF buffer lookup of `odom -> base_link` / `odom -> base_footprint`.
- Direct `/tf`, `/tf_static`, and `/odom` subscriptions when those messages are available.

`map` frame pose is waypoint-safe and is copied into app `robot.state.pose`. `odom` frame pose is exposed only as telemetry and in the mini-map readout. Section 14 patrol docs use `odom -> base_footprint` for route-relative distance/turning, while navigation docs require a saved `.pbstream` plus `.yaml` map for actual target navigation. Do not save odom-only readouts as permanent waypoints.

## Integration Plan

1. Keep current `/state` battery/IMU feed live in the app.
2. Resolve the physical/firmware lidar data path so `/scan` carries `sensor_msgs/msg/LaserScan` frames, not just an advertised publisher.
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
