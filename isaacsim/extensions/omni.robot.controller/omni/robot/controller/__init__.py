from __future__ import annotations

import sys
from pathlib import Path

import omni.ext


ROOT_DIR = Path(r"C:\Users\sandr\OneDrive\Documents\Robo-Doge")
RUNTIME_DIR = ROOT_DIR / "isaacsim" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import robot_controller_startup


class RobotControllerExtension(omni.ext.IExt):
    def on_startup(self, ext_id):
        print(f"[robot controller ext] startup: {ext_id}")
        robot_controller_startup.start()

    def on_shutdown(self):
        print("[robot controller ext] shutdown")
        robot_controller_startup.stop()
