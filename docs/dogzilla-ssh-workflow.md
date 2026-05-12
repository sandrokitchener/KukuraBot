# DOGZILLA SSH Workflow

Goal: avoid SD-card guessing. Use the stock DOGZILLA image, get its IP, then do inspection, code sync, and bridge startup over SSH.

## First Connection

Yahboom images usually expose SSH for the `pi` user. When the dog is on your LAN and you know the IP:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-dogzilla-ssh-key.ps1 -Host <DOGZILLA_IP>
```

If prompted, enter the vendor image password once. The script installs this local key into `~/.ssh/authorized_keys` without overwriting existing keys:

```text
C:\Users\sandr\.ssh\robodoge_pi_ed25519
```

After that, open a shell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dogzilla-ssh.ps1 -Host <DOGZILLA_IP>
```

For later sessions, `-Host` can be omitted if `output\pi-ssh\config` still points at the same dog:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dogzilla-ssh.ps1
```

## Inventory Before Changes

Capture OS, ROS2, vendor paths, running services, devices, and import probes:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\inspect-dogzilla-ssh.ps1 -Host <DOGZILLA_IP>
```

Output lands in:

```text
output\dogzilla-inventory\
```

Run this before disabling services or launching our bridge live.

## Terminal Smoke Test

Run the day-1 dry-run path outside the app:

```powershell
scripts\smoke-test-dogzilla.bat <DOGZILLA_IP>
```

It checks SSH, captures inventory, syncs bridge code, starts the direct bridge in dry-run mode, and probes `/healthz`.

## Sync Bridge Code

Copy only bridge-side code and bridge docs to the dog:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-dogzilla-bridges.ps1 -Host <DOGZILLA_IP>
```

Default remote workspace:

```text
/home/pi/robodoge
```

Synced paths:

- `sidecars/ros2_bridge`
- `sidecars/dogzilla_lib_bridge`
- `ros2/dogzilla_bridge`
- selected `config/` robot files
- DOGZILLA bridge docs

This does not copy the full desktop app.

## Start A Bridge Over SSH

Direct DOGZILLALib bridge, dry-run first:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-dogzilla-bridge-ssh.ps1 -Host <DOGZILLA_IP> -Bridge direct
```

Live direct control only after bench checks:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-dogzilla-bridge-ssh.ps1 -Host <DOGZILLA_IP> -Bridge direct -Live
```

ROS2 sidecar bridge:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-dogzilla-bridge-ssh.ps1 -Host <DOGZILLA_IP> -Bridge ros2
```

The script syncs first unless `-NoSync` is supplied.

Defaults:

- direct bridge: `0.0.0.0:8893`
- ROS2 sidecar: `0.0.0.0:8892`
- `ROS_DOMAIN_ID=16` when the remote shell has no domain set

## Use Localhost Instead Of LAN Ports

Keep this terminal open:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\forward-dogzilla-ports.ps1 -Host <DOGZILLA_IP>
```

Then probe from Windows through SSH tunnel:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\probe-dogzilla-bridge.ps1 -BridgeBaseUrl http://127.0.0.1:8893 -Command health
```

For ROS2 sidecar:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\probe-dogzilla-bridge.ps1 -BridgeBaseUrl http://127.0.0.1:8892 -Command health
```

## Day-1 Order

1. `install-dogzilla-ssh-key.ps1`
2. `smoke-test-dogzilla.bat <DOGZILLA_IP>`
3. Use the app Connection Center router button for bridge checks and restarts.
4. Only then consider `-Live`, with the robot lifted or clear.
