#!/usr/bin/env bash
set -euo pipefail

ROS_DISTRO="humble"
INSTALL_ROOT="/opt/robodoge"
REPO_URL=""
SKIP_ROS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ros-distro)
      ROS_DISTRO="$2"
      shift 2
      ;;
    --install-root)
      INSTALL_ROOT="$2"
      shift 2
      ;;
    --repo-url)
      REPO_URL="$2"
      shift 2
      ;;
    --skip-ros)
      SKIP_ROS=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

run() {
  echo "+ $*"
  "$@"
}

need_cmd sudo
need_cmd bash

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
else
  echo "Cannot read /etc/os-release" >&2
  exit 1
fi

if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "22.04" ]]; then
  cat >&2 <<EOF
This bootstrap is tuned for Ubuntu Server 22.04 64-bit on Raspberry Pi.
Detected: ${PRETTY_NAME:-unknown}

For Raspberry Pi OS 64-bit, use the Docker lane from docs/pi-ssh-ros2-bringup.md.
EOF
  exit 2
fi

run sudo apt update
run sudo apt install -y curl ca-certificates gnupg lsb-release locales software-properties-common git python3-pip python3-venv

run sudo locale-gen en_US en_US.UTF-8
run sudo update-locale LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
export LANG=en_US.UTF-8

if [[ "$SKIP_ROS" -eq 0 ]]; then
  run sudo add-apt-repository -y universe
  run sudo apt update

  if ! dpkg-query -W -f='${Status}' ros2-apt-source 2>/dev/null | grep -q "install ok installed"; then
    ROS_APT_SOURCE_VERSION="$(curl -fsSL https://api.github.com/repos/ros-infrastructure/ros-apt-source/releases/latest | grep -F "tag_name" | awk -F'"' '{print $4}')"
    curl -fsSL -o /tmp/ros2-apt-source.deb "https://github.com/ros-infrastructure/ros-apt-source/releases/download/${ROS_APT_SOURCE_VERSION}/ros2-apt-source_${ROS_APT_SOURCE_VERSION}.${UBUNTU_CODENAME:-jammy}_all.deb"
    run sudo dpkg -i /tmp/ros2-apt-source.deb
  fi

  run sudo apt update
  run sudo apt install -y "ros-${ROS_DISTRO}-ros-base" ros-dev-tools python3-colcon-common-extensions python3-rosdep

  if [[ ! -f /etc/ros/rosdep/sources.list.d/20-default.list ]]; then
    run sudo rosdep init || true
  fi
  run rosdep update

  if ! grep -q "/opt/ros/${ROS_DISTRO}/setup.bash" "$HOME/.bashrc"; then
    echo "source /opt/ros/${ROS_DISTRO}/setup.bash" >> "$HOME/.bashrc"
  fi
fi

run sudo mkdir -p /etc/robodoge
sudo tee /etc/robodoge/robodoge.env >/dev/null <<EOF
DOGZILLA_CONTROL_MODE=custom
DOGZILLA_SAFE_START=1
DOGZILLA_DRY_RUN=1
DOGZILLA_PLAN_TOPIC=/dogzilla/command_plan
DOGZILLA_STATE_TOPIC=/dogzilla/state
DOGZILLA_ROS_DOMAIN_ID=30
DOGZILLA_BRIDGE_HOST=0.0.0.0
DOGZILLA_BRIDGE_PORT=8892
DOGZILLA_HW_ADAPTER=documented_python
EOF

if [[ -n "$REPO_URL" ]]; then
  if [[ -d "$INSTALL_ROOT/.git" ]]; then
    run git -C "$INSTALL_ROOT" pull --ff-only
  else
    run sudo mkdir -p "$INSTALL_ROOT"
    run sudo chown "$USER:$USER" "$INSTALL_ROOT"
    if [[ -n "$(find "$INSTALL_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
      echo "Install root exists and is not empty: $INSTALL_ROOT" >&2
      exit 3
    fi
    run git clone "$REPO_URL" "$INSTALL_ROOT"
  fi

  if [[ -d "$INSTALL_ROOT/ros2" && "$SKIP_ROS" -eq 0 ]]; then
    # shellcheck disable=SC1091
    source "/opt/ros/${ROS_DISTRO}/setup.bash"
    pushd "$INSTALL_ROOT/ros2" >/dev/null
    run rosdep install --from-paths . --ignore-src -r -y
    run colcon build --symlink-install
    popd >/dev/null
  fi
fi

cat <<EOF

Robo-Doge Pi bootstrap complete.

Next checks:
  source /opt/ros/${ROS_DISTRO}/setup.bash
  ros2 --help
  cat /etc/robodoge/robodoge.env
EOF
