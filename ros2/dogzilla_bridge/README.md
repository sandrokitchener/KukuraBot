# dogzilla_bridge Scaffold

This directory is a placeholder for a future ROS2 bridge package.

Nothing here is runnable yet. That is intentional.

## Why keep it this small

- we do not fully know the best ROS2 shape yet
- we have not bench-verified Yahboom internals on the real robot
- we want editable structure now without locking ourselves into the wrong package design

## What is here

- `config/bridge.params.yaml` as a dummy parameter file

## Likely future contents

- adapter module for DOGZILLA Python control library
- validator for motion and pose limits
- compiler from app command to robot action
- `rclpy` bridge node
- dry-run mode for local testing

Until then, treat this directory as a parking spot for ROS2 work.
