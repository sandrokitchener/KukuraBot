FROM yahboomtechnology/ros-humble:3.6

# Pre-install ROS packages that startup scripts otherwise apt-install on every
# container restart. This eliminates 2-5 minutes of apt dependency resolution
# and dpkg lock contention after Pi reboots.
#
# Packages required by:
#   - sidecars/dogzilla_map_pose/start-map-pose-in-container.sh
#   - sidecars/dogzilla_navigation/start-navigation-in-container.sh
#   - sidecars/dogzilla_lib_bridge/nav2_client.py (docker-rclpy backend)
#   - sidecars/dogzilla_rosbridge/start-rosbridge-in-container.sh
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg && \
    rm -f /etc/apt/sources.list.d/ros2.list && \
    curl -sSL https://raw.githubusercontent.com/ros/rosdistro/master/ros.key \
      -o /usr/share/keyrings/ros-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/ros-archive-keyring.gpg] http://packages.ros.org/ros2/ubuntu $(. /etc/os-release && echo ${UBUNTU_CODENAME:-${VERSION_CODENAME}}) main" \
      > /etc/apt/sources.list.d/ros2.list && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ros-humble-cartographer-ros \
      ros-humble-cartographer-ros-msgs \
      ros-humble-nav2-msgs \
      ros-humble-nav2-bringup \
      ros-humble-navigation2 \
      ros-humble-rosbridge-server \
    && rm -rf /var/lib/apt/lists/*
