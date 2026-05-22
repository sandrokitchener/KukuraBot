# DOGZILLA Pi Safety Policy

Current DOGZILLA eero IP: `10.0.4.32`.
Hotspot fallback observed earlier: `192.168.8.88`.

## Non-Negotiable Rules

- Do not delete, overwrite, move, chmod, or edit anything under `/home/pi/DOGZILLA` without explicit user approval.
- Do not restart, disable, mask, remove, or edit Yahboom/vendor services without explicit user approval.
- Do not install apt/pip/docker packages on the Pi without explicit user approval.
- Keep all Robo-Doge files under `/home/pi/robodoge` unless the user explicitly approves another path.
- Keep bridge starts dry-run by default. Do not pass `-Live` unless the robot is powered safely and the user explicitly asks for live motion.
- Keep `DOGZILLA_WIFI` network config as fallback. Do not delete it.

## Allowed Without Extra Approval

- Read-only SSH inspection.
- Read-only Docker image inspection.
- Syncing Robo-Doge bridge files into `/home/pi/robodoge`.
- Starting/stopping Robo-Doge dry-run bridge processes from `/home/pi/robodoge`.
- Capturing baseline snapshots into local `output/`.

## Current Revert Boundary

Robo-Doge-owned remote paths:

- `/home/pi/robodoge`
- Robo-Doge bridge processes matching:
  - `sidecars/dogzilla_lib_bridge/server.py`
  - `sidecars/ros2_bridge/server.py`

Vendor-owned paths to preserve:

- `/home/pi/DOGZILLA`
- Yahboom app server on port `6500`
- Yahboom TCP server on `192.168.8.88:6000`
- `yahboom_oled.service`
- `jupyter.service`
- `wayvnc.service`
- `NetworkManager.service`
- Docker images/containers unless explicitly approved

## Revert Procedure

1. Run `scripts/snapshot-dogzilla-pi-state.ps1 -Host 10.0.4.32`.
2. Review the snapshot in `output/dogzilla-baseline/`.
3. Dry-run Robo-Doge cleanup:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\revert-robodoge-pi.ps1 -Host 10.0.4.32
```

4. If the plan only touches Robo-Doge-owned files/processes, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\revert-robodoge-pi.ps1 -Host 10.0.4.32 -Apply
```

This does not restore a full SD-card image. For full original-state recovery, clone the microSD card before deeper vendor-stack changes.
