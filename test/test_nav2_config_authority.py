from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT_DIR = Path(__file__).resolve().parents[1]
START_SCRIPT = ROOT_DIR / "sidecars" / "dogzilla_navigation" / "start-navigation-in-container.sh"
CONFIG_PATH = ROOT_DIR / "config" / "robot-obstacle-avoidance.json"


class Nav2ConfigAuthorityTests(unittest.TestCase):
    def test_stale_environment_cannot_override_canonical_tuning(self):
        source = START_SCRIPT.read_text(encoding="utf-8")
        start_marker = 'nav2_config_env="$(python3 - "$DOGZILLA_NAV2_CONFIG" <<\'PY\'\n'
        end_marker = '\nPY\n)"; then'
        start = source.index(start_marker) + len(start_marker)
        snippet = source[start : source.index(end_marker, start)]

        canonical = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        environment = os.environ.copy()
        environment["DOGZILLA_NAV2_ROBOT_RADIUS"] = "999.0"
        result = subprocess.run(
            [sys.executable, "-", str(CONFIG_PATH)],
            input=snippet,
            text=True,
            capture_output=True,
            env=environment,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        assignments = dict(
            line.split("=", 1) for line in result.stdout.splitlines() if "=" in line
        )
        self.assertEqual(
            assignments["DOGZILLA_NAV2_ROBOT_RADIUS"],
            str(canonical["nav2RobotRadius"]),
        )
        self.assertNotEqual(assignments["DOGZILLA_NAV2_ROBOT_RADIUS"], "999.0")

    def test_supported_unfiltered_scan_config_routes_amcl_to_raw_scan(self):
        source = START_SCRIPT.read_text(encoding="utf-8")
        config_start_marker = 'nav2_config_env="$(python3 - "$DOGZILLA_NAV2_CONFIG" <<\'PY\'\n'
        config_end_marker = '\nPY\n)"; then'
        config_start = source.index(config_start_marker) + len(config_start_marker)
        config_snippet = source[
            config_start : source.index(config_end_marker, config_start)
        ]

        config_result = subprocess.run(
            [sys.executable, "-", str(CONFIG_PATH)],
            input=config_snippet,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(config_result.returncode, 0, config_result.stderr)
        generated_environment = os.environ.copy()
        for line in config_result.stdout.splitlines():
            fields = shlex.split(line)
            if not fields or "=" not in fields[0]:
                continue
            name, value = fields[0].split("=", 1)
            generated_environment[name] = value
        generated_environment.update(
            {
                "DOGZILLA_NAV2_SCAN_FILTER_ENABLED": "0",
                "DOGZILLA_NAV2_SCAN_FILTER_TOPIC": "/scan_nav2",
                "DOGZILLA_NAV2_MAPPING_MODE": "0",
            }
        )

        generator_start_marker = (
            'python3 - "$DOGZILLA_NAV2_BASE_PARAMS" "$DOGZILLA_NAV2_PARAMS" <<\'PY\'\n'
        )
        generator_start = source.index(generator_start_marker) + len(
            generator_start_marker
        )
        generator_snippet = source[
            generator_start : source.index("\nPY\n", generator_start)
        ]

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path = root / "base.yaml"
            target_path = root / "generated.yaml"
            source_path.write_text("{}\n", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, "-", str(source_path), str(target_path)],
                input=generator_snippet,
                text=True,
                capture_output=True,
                env=generated_environment,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            generated = yaml.safe_load(target_path.read_text(encoding="utf-8"))

        self.assertEqual(generated["amcl"]["ros__parameters"]["scan_topic"], "/scan")
        self.assertEqual(
            generated["collision_monitor"]["ros__parameters"]["scan"]["topic"],
            "/scan",
        )


if __name__ == "__main__":
    unittest.main()
