import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest


REPO_ROOT = Path(__file__).parents[1]


def load_selector_module():
    path = REPO_ROOT / "sidecars" / "dogzilla_map_pose" / "select_resume_map.py"
    spec = importlib.util.spec_from_file_location("dogzilla_resume_map_selector", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_map(directory: Path, map_id: str, *, candidate: bool) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    pbstream = directory / "map.pbstream"
    pgm = directory / "map.pgm"
    yaml = directory / "map.yaml"
    pbstream.write_bytes(f"pbstream:{map_id}".encode())
    pgm.write_bytes(b"P5\n1 1\n255\n\x00")
    yaml.write_text(
        "image: map.pgm\nresolution: 0.05\norigin: [0.0, 0.0, 0.0]\n",
        encoding="utf-8",
    )
    metadata = directory / ("candidate.json" if candidate else "robodoge_home_map.json")
    metadata.write_text(
        json.dumps(
            {
                "id": map_id,
                "state": "candidate" if candidate else "active",
                "savedAt": "2026-07-21T16:16:40Z",
                "pbstream": str(pbstream),
                "pgm": str(pgm),
                "yaml": str(yaml),
                "artifacts": {
                    "pbstream": {"path": str(pbstream), "sha256": sha256(pbstream)},
                    "pgm": {"path": str(pgm), "sha256": sha256(pgm)},
                    "yaml": {"path": str(yaml), "sha256": sha256(yaml)},
                },
            }
        ),
        encoding="utf-8",
    )
    return metadata


class ResumeMapSelectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        validator_dir = self.root / "sidecars" / "dogzilla_lib_bridge"
        validator_dir.mkdir(parents=True)
        shutil.copy2(
            REPO_ROOT / "sidecars" / "dogzilla_lib_bridge" / "map_metadata.py",
            validator_dir / "map_metadata.py",
        )
        self.module = load_selector_module()

    def tearDown(self):
        self.temp.cleanup()

    def test_newer_verified_candidate_is_selected_without_touching_active_map(self):
        maps = self.root / "maps"
        active = write_map(maps, "active-map", candidate=False)
        candidate = write_map(maps / "candidates" / "candidate-new", "candidate-new", candidate=True)
        os.utime(active, (100, 100))
        os.utime(candidate, (200, 200))
        active_before = active.read_bytes()

        selected = self.module.select_resume_map(self.root)

        self.assertEqual(selected["source"], "candidate")
        self.assertEqual(selected["id"], "candidate-new")
        self.assertEqual(Path(selected["metadata"]), candidate.resolve())
        self.assertEqual(active.read_bytes(), active_before)

    def test_tampered_newer_candidate_falls_back_to_verified_active_map(self):
        maps = self.root / "maps"
        active = write_map(maps, "active-map", candidate=False)
        candidate = write_map(maps / "candidates" / "candidate-bad", "candidate-bad", candidate=True)
        (candidate.parent / "map.pbstream").write_bytes(b"tampered")
        os.utime(active, (100, 100))
        os.utime(candidate, (200, 200))

        selected = self.module.select_resume_map(self.root)

        self.assertEqual(selected["source"], "active")
        self.assertEqual(selected["id"], "active-map")


if __name__ == "__main__":
    unittest.main()
