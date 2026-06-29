#!/bin/bash
set -eo pipefail

# Start the ORADAR LiDAR driver and rosbridge_server inside the Robo-Doge
# Cartographer/Nav2 container. This replaces the custom HTTP lidar bridge
# (sidecars/dogzilla_lidar_bridge/server.py) with standard rosbridge.

source /opt/ros/humble/setup.bash
source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true

SERIAL_PORT="${DOGZILLA_SERIAL_PORT:-/dev/ttyAMA1}"
BAUDRATE="${DOGZILLA_LIDAR_BAUDRATE:-230400}"
FRAME_ID="${DOGZILLA_LIDAR_FRAME_ID:-laser_frame}"
SCAN_TOPIC="${DOGZILLA_LIDAR_TOPIC:-/scan}"
DEVICE_MODEL="${DOGZILLA_LIDAR_DEVICE_MODEL:-MS200}"
MOTOR_SPEED="${DOGZILLA_LIDAR_MOTOR_SPEED:-10}"
ROSBRIDGE_PORT="${DOGZILLA_ROSBRIDGE_PORT:-9090}"

echo "Starting DOGZILLA rosbridge stack on port ${ROSBRIDGE_PORT}"
echo "LiDAR: ${SERIAL_PORT} @ ${BAUDRATE} -> ${SCAN_TOPIC}"

ros2 run oradar_lidar oradar_scan \
  --ros-args \
  -p port_name:="${SERIAL_PORT}" \
  -p baudrate:="${BAUDRATE}" \
  -p frame_id:="${FRAME_ID}" \
  -p scan_topic:="${SCAN_TOPIC}" \
  -p device_model:="${DEVICE_MODEL}" \
  -p motor_speed:="${MOTOR_SPEED}" &
DRIVER_PID=$!

ros2 launch rosbridge_server rosbridge_websocket_launch.xml port:="${ROSBRIDGE_PORT}" &
ROSBRIDGE_PID=$!

shutdown_stack() {
  echo "Shutting down rosbridge stack..."
  kill "${DRIVER_PID}" "${ROSBRIDGE_PID}" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap shutdown_stack SIGINT SIGTERM

# Exit if either background job finishes.
wait -n
