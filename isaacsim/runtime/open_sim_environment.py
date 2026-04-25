from __future__ import annotations

import asyncio
from pathlib import Path

import omni.kit.app
import omni.usd
import omni.ui
from pxr import Semantics


ROOT_DIR = Path(r"C:\Users\sandr\OneDrive\Documents\Robo-Doge")
STAGE_PATH = ROOT_DIR / "isaacsim" / "sim_environment.usd"


def main():
    print(f"Opening stage: {STAGE_PATH}")
    omni.usd.get_context().open_stage(str(STAGE_PATH))
    asyncio.ensure_future(_after_stage_open())


async def _after_stage_open():
    await omni.kit.app.get_app().next_update_async()
    _tag_obstacles_for_lidar()
    _hide_editor_ui()


def _tag_obstacles_for_lidar():
    stage = omni.usd.get_context().get_stage()
    if stage is None:
        return

    obstacle_root = stage.GetPrimAtPath("/ObstacleRoom")
    if not obstacle_root.IsValid():
        return

    for prim in obstacle_root.GetChildren():
        if not prim.GetName().startswith("obstacle_"):
            continue
        sem = Semantics.SemanticsAPI.Apply(prim, "Semantics")
        sem.CreateSemanticTypeAttr().Set("class")
        sem.CreateSemanticDataAttr().Set("obstacle")


def _hide_editor_ui():
    for window in omni.ui.Workspace.get_windows():
        name = str(window)
        omni.ui.Workspace.show_window(name, name == "Viewport")


if __name__ == "__main__":
    main()
