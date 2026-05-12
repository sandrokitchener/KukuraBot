# Raspberry Pi SSH and ROS2 Bring-Up

Last validated: May 5, 2026.

Goal: when the robot arrives, Codex only needs the Pi IP address to open a Linux SSH terminal, run setup checks, and start writing/debugging robot-side code.

For the stock Yahboom DOGZILLA image, use [DOGZILLA SSH Workflow](dogzilla-ssh-workflow.md) first. That path installs the SSH key, inventories the vendor image, syncs only bridge code, and starts the bridge over SSH without reflashing the card.

## Current Local Prep

Dedicated SSH key created:

```text
C:\Users\sandr\.ssh\robodoge_pi_ed25519
```

Public key to paste into Raspberry Pi Imager or Ubuntu cloud-init:

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDHjvDaCUKfGG+uJXFu601Y5iK+nNf1JbXQBgQVRgIMC robodoge-pi-codex
```

Windows OpenSSH is available at:

```text
C:\WINDOWS\System32\OpenSSH\ssh.exe
```

## Flash The Pi

Recommended first OS:

- Raspberry Pi 5 or 4, 64-bit.
- Ubuntu Server 22.04 LTS 64-bit.
- Username: `robodoge`.
- Enable SSH.
- Add the public key above.
- Hostname: `robodoge-pi`.

Why this lane: ROS2 Humble deb packages are built for Ubuntu 22.04, including arm64. Official ROS docs call 64-bit Ubuntu on Raspberry Pi the simplest Tier 1 path. Raspberry Pi OS 64-bit can still work, but the official path there is ROS2 in Docker.

## When IP Exists

Open an SSH shell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\connect-robodoge-pi.ps1 -Host <PI_IP>
```

Run a remote check without opening an interactive shell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\connect-robodoge-pi.ps1 -Host <PI_IP> -RemoteCommand "uname -a && cat /etc/os-release"
```

Provision the Pi:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\provision-robodoge-pi.ps1 -Host <PI_IP>
```

That wrapper writes `output\pi-ssh\config`, copies `scripts\bootstrap-robodoge-pi.sh` to the Pi, installs ROS2 Humble on Ubuntu 22.04, writes `/etc/robodoge/robodoge.env`, clones the repo remote when available, and builds `ros2/dogzilla_bridge`.

After the first connection, Codex can use:

```powershell
ssh -F output\pi-ssh\config robodoge-pi
```

## ROS2 Baseline

On Ubuntu 22.04:

```bash
source /opt/ros/humble/setup.bash
ros2 --help
cd /opt/robodoge/ros2
colcon build --symlink-install
source install/local_setup.bash
ros2 launch dogzilla_bridge dogzilla_bridge.launch.py
```

Keep first boot dry-run:

```bash
cat /etc/robodoge/robodoge.env
```

Expected defaults:

```dotenv
DOGZILLA_SAFE_START=1
DOGZILLA_DRY_RUN=1
DOGZILLA_ROS_DOMAIN_ID=30
DOGZILLA_BRIDGE_HOST=0.0.0.0
DOGZILLA_BRIDGE_PORT=8892
```

When the HTTP bridge runs on the Pi, point the desktop app at:

```json
"baseUrl": "http://<PI_IP>:8892"
```

in `config/robot-ros2.json`.

## Raspberry Pi OS Alternate

If the vendor image is Raspberry Pi OS 64-bit, keep it intact first. Use Docker for ROS2 Tier 1 behavior:

```bash
sudo apt update
sudo apt install -y docker.io
sudo usermod -aG docker "$USER"
docker pull ros:humble-ros-core
docker run -it --rm ros:humble-ros-core
```

This is best for exploration, not final hardware control. Device access, systemd services, camera, lidar, and serial ports need explicit Docker mounts and permissions.

## ROS2 Essentials Read

`j3soon/ros2-essentials` is useful as a map for Dockerized ROS2 Humble workspaces, Isaac Sim/Isaac ROS alignment, and reusable module patterns. It is not the first Pi bring-up path for DOGZILLA because its own README warns the repo is under rapid development and its supported deployment targets skew toward x86_64/Jetson/DGX-style workspaces.

Use it later for:

- Docker Compose workspace structure.
- Isaac Sim / real robot policy reuse ideas.
- Arm64 workspace examples.
- Module enablement patterns.

Do not start by grafting it wholesale onto the Pi.

## First Live Session Checklist

1. Confirm SSH:

```bash
whoami
hostname
ip addr
```

2. Confirm OS and ROS2:

```bash
cat /etc/os-release
source /opt/ros/humble/setup.bash
ros2 doctor
```

3. Inventory vendor stack before changing it:

```bash
systemctl list-unit-files --type=service > ~/dogzilla-stock-services.txt
systemctl --type=service --state=running > ~/dogzilla-running-services.txt
crontab -l > ~/dogzilla-crontab.txt 2>/dev/null || true
ps -ef | grep -Ei 'dogzilla|yahboom|ros|voice|lidar' > ~/dogzilla-processes.txt
```

4. Keep recovery real:

- Clone the microSD before disabling vendor services.
- Keep stock image and Yahboom downloads.
- Bring up Robo-Doge in dry-run first.
- Bench-test tiny motion while robot is lifted.

## Sources

- ROS2 Humble Ubuntu deb install: https://docs.ros.org/en/humble/Installation/Ubuntu-Install-Debs.html
- ROS2 on Raspberry Pi: https://docs.ros.org/en/humble/How-To-Guides/Installing-on-Raspberry-Pi.html
- ROS2 RMW implementations: https://docs.ros.org/en/humble/Installation/RMW-Implementations.html
- ROS2 Essentials: https://github.com/j3soon/ros2-essentials
