from __future__ import annotations

from pathlib import Path

import omni.usd


ROOT_DIR = Path(r"C:\Users\sandr\OneDrive\Documents\Robo-Doge")
STAGE_PATH = ROOT_DIR / "isaacsim" / "sim_environment.usd"


def main():
    print(f"Opening stage: {STAGE_PATH}")
    omni.usd.get_context().open_stage(str(STAGE_PATH))


if __name__ == "__main__":
    main()
