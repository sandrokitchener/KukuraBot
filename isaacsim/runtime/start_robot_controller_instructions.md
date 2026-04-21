# Robot Controller Startup

## Current Options

There are three realistic ways to load the robot controller into Isaac Sim:

1. Script Editor in the running UI
2. Launch-time Python script using Isaac Sim's Python environment
3. An Isaac extension that autoloads on startup

## Recommendation

Short term:

- use a launch-time startup script or Script Editor

Long term:

- convert to a tiny Isaac extension and autoload it

## Why

The sidecar is already receiving commands.
The missing piece is the code running inside the live Isaac UI session.

The startup script we added:

- `isaacsim/runtime/robot_controller_startup.py`

does that job, but it must be executed in Isaac's Python environment.

## Manual Script Editor Path

Run in Isaac Script Editor:

```python
import sys
sys.path.insert(0, r"C:\Users\sandr\OneDrive\Documents\Robo-Doge\isaacsim\runtime")
import robot_controller_startup
robot_controller_startup.start()
```

## Next Better Path

Create a launcher or extension so the above starts automatically.

This avoids manual copy/paste each session.

## Supporting docs

- Script Editor: https://docs.isaacsim.omniverse.nvidia.com/latest/development_tools/omniverse_script_editor.html
- Isaac Python environment: https://docs.isaacsim.omniverse.nvidia.com/latest/installation/install_python.html
- Kit app update events: https://docs.omniverse.nvidia.com/dev-guide/latest/python-snippets/events/subscribe-app-update-event.html
