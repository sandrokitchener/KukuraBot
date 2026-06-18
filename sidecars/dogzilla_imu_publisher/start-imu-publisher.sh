#!/usr/bin/env bash
set -eo pipefail

REMOTE_ROOT="${REMOTE_ROOT:-/home/pi/robodoge}"
ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-16}"
export ROS_DOMAIN_ID
export DOGZILLA_IMU_BRIDGE_URL="${DOGZILLA_IMU_BRIDGE_URL:-http://127.0.0.1:8893/imu}"
export DOGZILLA_IMU_RATE_HZ="${DOGZILLA_IMU_RATE_HZ:-50}"

source /opt/ros/humble/setup.bash
source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true

cd "$REMOTE_ROOT/sidecars/dogzilla_imu_publisher"

nohup python3 imu_publisher.py \
  > "$REMOTE_ROOT/logs/imu-publisher.log" 2>&1 &

echo "DOGZILLA IMU publisher started (PID $!) — bridge=$DOGZILLA_IMU_BRIDGE_URL rate=${DOGZILLA_IMU_RATE_HZ}Hz"
