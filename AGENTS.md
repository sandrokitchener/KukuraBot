# Robo-Doge Agent Instructions

## DOGZILLA / Yahboom Source Of Truth

- For DOGZILLA robot behavior, navigation, LiDAR, mapping, patrol, obstacle avoidance, and waypoint work, check `C:\Users\sandr\OneDrive\Documents\Robo-Doge\docs\DOGZILLA-main` before inventing a new approach.
- Treat the local Yahboom PDFs under `C:\Users\sandr\OneDrive\Documents\Robo-Doge\docs\DOGZILLA-main\14.Lidar course` as the first source of truth for how Yahboom expects the robot stack to be started and used.
- For LiDAR/navigation tasks, review the relevant PDFs first, especially:
  - `1. Introduction and use of radar.pdf`
  - `2. Obstacle avoidance.pdf`
  - `3.Lidar Tracking.pdf`
  - `4.Lidar guard.pdf`
  - `5. Patrol.pdf`
  - `Get robot dog joint data.pdf`
  - `Robot dog mapping.pdf`
  - `Robot Dog Navigation.pdf`
- Try the documented Yahboom flow before adding repo-specific workarounds, fallback sidecars, custom launch glue, or guessed ROS wiring.
- If the documented flow fails, capture the exact command, error, and runtime state, then make the smallest repo change needed to bridge from Yahboom's intended workflow to this app.
- For LiDAR scope, stay on the DOGZILLA HAT UART path (`/dev/ttyAMA1`) unless the user explicitly changes the hardware target.

## DOGZILLA Waypoint Config Authority

- Treat `config/robot-waypoints.json` as the absolute source of truth for waypoint coordinates and trust fields.
- If coordinates or verification/trust fields are present in the JSON config, agents must treat those config values as true unless the user explicitly says otherwise.
- Diagnostics may warn about map identity, notes, fingerprints, bounds, or drift, but must not override, downgrade, rewrite, disable, or "correct" configured coordinates or trust state without explicit user instruction.
