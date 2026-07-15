#!/bin/bash
# Run inside the robodoge-rosbridge container to wait for Nav2 readiness.
# Usage: wait-nav2-ready.sh <ros_domain_id> <remote_root> <scan_topic>
set -eo pipefail
export ROS_DOMAIN_ID="${1:-16}"
REMOTE_ROOT="${2:-/home/pi/robodoge}"
SCAN_TOPIC="${3:-/scan}"
export LD_LIBRARY_PATH="/opt/ros/humble/lib/aarch64-linux-gnu:/opt/ros/humble/lib"
export PYTHONPATH="/opt/ros/humble/lib/python3.10/site-packages:/opt/ros/humble/local/lib/python3.10/dist-packages"
export PATH="/opt/ros/humble/bin:$PATH"
. /opt/ros/humble/setup.sh 2>/dev/null
. /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true
action_ready=false
odom_ready=false
scan_ready=false
for i in $(seq 1 40); do
  action_pid=""
  odom_pid=""
  scan_pid=""
  if ! $action_ready; then
    timeout --kill-after=1 2 ros2 action list 2>/dev/null | grep '^/navigate_to_pose$' >/dev/null &
    action_pid=$!
  fi
  if ! $odom_ready; then
    timeout --kill-after=1 2 ros2 topic info /odom 2>/dev/null | grep 'Publisher count: [1-9]' >/dev/null &
    odom_pid=$!
  fi
  if ! $scan_ready; then
    timeout --kill-after=1 2 ros2 topic info "$SCAN_TOPIC" 2>/dev/null | grep 'Publisher count: [1-9]' >/dev/null &
    scan_pid=$!
  fi
  [ -z "$action_pid" ] || { wait "$action_pid" && action_ready=true || true; }
  [ -z "$odom_pid" ] || { wait "$odom_pid" && odom_ready=true || true; }
  [ -z "$scan_pid" ] || { wait "$scan_pid" && scan_ready=true || true; }
  if $action_ready && $odom_ready && $scan_ready; then
    echo "READY"
    exit 0
  fi
  sleep 1
done
echo "TIMEOUT"
tail -80 "$REMOTE_ROOT/logs/nav2-navigation.log"
exit 1
