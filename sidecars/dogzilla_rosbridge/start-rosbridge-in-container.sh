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
SCAN_STARTUP_TIMEOUT_SEC="${DOGZILLA_SCAN_STARTUP_TIMEOUT_SEC:-20}"
SCAN_WATCHDOG_TIMEOUT_SEC="${DOGZILLA_SCAN_WATCHDOG_TIMEOUT_SEC:-8}"
SCAN_WATCHDOG_INTERVAL_SEC="${DOGZILLA_SCAN_WATCHDOG_INTERVAL_SEC:-20}"

wait_for_scan_sample() {
  local timeout_sec="$1"
  python3 - "$SCAN_TOPIC" "$timeout_sec" <<'PY'
import sys
import time

import rclpy
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan

topic = sys.argv[1]
timeout_sec = float(sys.argv[2])
got_sample = False

rclpy.init(args=None)
node = rclpy.create_node("robodoge_scan_sample_probe")

def on_scan(_msg):
    global got_sample
    got_sample = True

node.create_subscription(LaserScan, topic, on_scan, qos_profile_sensor_data)
deadline = time.time() + timeout_sec
while time.time() < deadline and not got_sample:
    rclpy.spin_once(node, timeout_sec=0.1)

node.destroy_node()
rclpy.shutdown()
raise SystemExit(0 if got_sample else 1)
PY
}

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

if wait_for_scan_sample "$SCAN_STARTUP_TIMEOUT_SEC"; then
  echo "LiDAR scan sample received on ${SCAN_TOPIC}."
else
  echo "No LiDAR scan sample on ${SCAN_TOPIC} after ${SCAN_STARTUP_TIMEOUT_SEC}s; restarting rosbridge stack." >&2
  kill "${DRIVER_PID}" "${ROSBRIDGE_PID}" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 1
fi

scan_watchdog() {
  while true; do
    sleep "$SCAN_WATCHDOG_INTERVAL_SEC"
    if ! wait_for_scan_sample "$SCAN_WATCHDOG_TIMEOUT_SEC"; then
      echo "LiDAR scan watchdog missed ${SCAN_TOPIC} sample for ${SCAN_WATCHDOG_TIMEOUT_SEC}s; restarting rosbridge stack." >&2
      return 1
    fi
  done
}
scan_watchdog &
WATCHDOG_PID=$!

# Exit if any background job finishes or scan liveness fails.
wait -n "${DRIVER_PID}" "${ROSBRIDGE_PID}" "${WATCHDOG_PID}"
status=$?
kill "${DRIVER_PID}" "${ROSBRIDGE_PID}" "${WATCHDOG_PID}" 2>/dev/null || true
wait 2>/dev/null || true
exit "$status"
