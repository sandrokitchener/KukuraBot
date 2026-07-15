import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "sidecars" / "dogzilla_lib_bridge" / "map_metadata.py"
SPEC = importlib.util.spec_from_file_location("dogzilla_map_metadata", MODULE_PATH)
map_metadata = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(map_metadata)


class DogzillaMapMetadataTests(unittest.TestCase):
    def test_hashed_occupancy_map_without_pbstream_is_valid_and_tamper_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            yaml_path = root / "robodoge_home.yaml"
            pgm_path = root / "robodoge_home.pgm"
            metadata_path = root / "robodoge_home_map.json"
            yaml_path.write_text(
                "image: robodoge_home.pgm\nresolution: 0.05\norigin: [0, 0, 0]\n",
                encoding="utf-8",
            )
            pgm_path.write_bytes(b"P5\n2 2\n255\n\x00\x00\x00\x00")
            metadata_path.write_text(json.dumps({
                "id": "scanner-map",
                "resumePose": {
                    "frame": "map",
                    "x": 1.25,
                    "y": -0.75,
                    "yaw": 0.4,
                    "capturedAt": "2026-07-12T12:00:00Z",
                },
                "yaml": yaml_path.name,
                "pgm": pgm_path.name,
                "artifacts": {
                    "yaml": {"path": yaml_path.name, "sha256": hashlib.sha256(yaml_path.read_bytes()).hexdigest()},
                    "pgm": {"path": pgm_path.name, "sha256": hashlib.sha256(pgm_path.read_bytes()).hexdigest()},
                },
            }), encoding="utf-8")

            result = map_metadata.read_active_map_metadata(metadata_path, yaml_path)
            self.assertTrue(result["available"])
            self.assertEqual(result["pbstream"], "")
            self.assertEqual(result["resumePose"]["x"], 1.25)

            pgm_path.write_bytes(pgm_path.read_bytes() + b"tampered")
            result = map_metadata.read_active_map_metadata(metadata_path, yaml_path)
            self.assertFalse(result["available"])
            self.assertEqual(result["error"], "active_map_artifact_hash_mismatch:pgm")


if __name__ == "__main__":
    unittest.main()
