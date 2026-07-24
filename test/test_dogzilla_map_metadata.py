import base64
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
    def test_latest_candidate_is_returned_as_an_occupancy_grid(self):
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "candidates" / "candidate-new"
            candidate.mkdir(parents=True)
            yaml_path = candidate / "map.yaml"
            pgm_path = candidate / "map.pgm"
            pbstream_path = candidate / "map.pbstream"
            metadata_path = candidate / "candidate.json"
            yaml_path.write_text(
                "image: map.pgm\nresolution: 0.5\norigin: [-1, -2, 0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n",
                encoding="utf-8",
            )
            pgm_path.write_bytes(b"P5\n2 2\n255\n" + bytes([0, 254, 205, 0]))
            pbstream_path.write_bytes(b"candidate state")
            metadata_path.write_text(json.dumps({
                "id": "candidate-new",
                "state": "candidate",
                "artifacts": {
                    "yaml": {"path": str(yaml_path), "sha256": hashlib.sha256(yaml_path.read_bytes()).hexdigest()},
                    "pgm": {"path": str(pgm_path), "sha256": hashlib.sha256(pgm_path.read_bytes()).hexdigest()},
                    "pbstream": {"path": str(pbstream_path), "sha256": hashlib.sha256(pbstream_path.read_bytes()).hexdigest()},
                },
            }), encoding="utf-8")

            result = map_metadata.read_latest_candidate_occupancy_grid(Path(tmp))

            self.assertTrue(result["ok"])
            self.assertEqual((result["width"], result["height"]), (2, 2))
            self.assertEqual(list(base64.b64decode(result["cells"])), [255, 100, 100, 0])
            self.assertEqual(result["bbox"], {"minX": -1.0, "minY": -2.0, "maxX": 0.0, "maxY": -1.0})

            (Path(tmp) / "robodoge_home_map.json").write_text("{}", encoding="utf-8")
            promoted = map_metadata.read_latest_candidate_occupancy_grid(Path(tmp))
            self.assertFalse(promoted["ok"])

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

    def test_goal_validation_requires_matching_map_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            yaml_path = root / "active.yaml"
            pgm_path = root / "active.pgm"
            metadata_path = root / "active_map.json"
            yaml_path.write_text(
                "image: active.pgm\nresolution: 0.05\norigin: [-1, -1, 0]\n",
                encoding="utf-8",
            )
            pgm_path.write_bytes(b"P5\n40 40\n255\n" + bytes(1600))
            metadata_path.write_text(json.dumps({
                "id": "active-map",
                "artifacts": {
                    "yaml": {"path": yaml_path.name, "sha256": hashlib.sha256(yaml_path.read_bytes()).hexdigest()},
                    "pgm": {"path": pgm_path.name, "sha256": hashlib.sha256(pgm_path.read_bytes()).hexdigest()},
                },
            }), encoding="utf-8")
            active = map_metadata.read_active_map_metadata(metadata_path, yaml_path)

            matching = map_metadata.validate_goal_inside_active_map(
                "map",
                0.0,
                0.0,
                metadata_path=metadata_path,
                default_yaml_path=yaml_path,
                map_id="active-map",
                map_fingerprint=active["fingerprint"],
            )
            missing = map_metadata.validate_goal_inside_active_map(
                "map",
                0.0,
                0.0,
                metadata_path=metadata_path,
                default_yaml_path=yaml_path,
            )
            wrong_id = map_metadata.validate_goal_inside_active_map(
                "map",
                0.0,
                0.0,
                metadata_path=metadata_path,
                default_yaml_path=yaml_path,
                map_id="old-map",
                map_fingerprint=active["fingerprint"],
            )
            wrong_fingerprint = map_metadata.validate_goal_inside_active_map(
                "map",
                0.0,
                0.0,
                metadata_path=metadata_path,
                default_yaml_path=yaml_path,
                map_id="active-map",
                map_fingerprint="old-fingerprint",
            )

            self.assertTrue(matching["ok"])
            self.assertEqual(matching["reason"], "map-identity-match")
            self.assertEqual(missing["reason"], "map-identity-missing")
            self.assertEqual(wrong_id["reason"], "map-id-mismatch")
            self.assertEqual(wrong_fingerprint["reason"], "map-fingerprint-mismatch")

    def test_active_map_without_explicit_id_is_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            yaml_path = root / "active.yaml"
            pgm_path = root / "active.pgm"
            metadata_path = root / "active_map.json"
            yaml_path.write_text("image: active.pgm\nresolution: 0.05\norigin: [0, 0, 0]\n", encoding="utf-8")
            pgm_path.write_bytes(b"P5\n2 2\n255\n\x00\x00\x00\x00")
            metadata_path.write_text(json.dumps({
                "artifacts": {
                    "yaml": {"path": yaml_path.name, "sha256": hashlib.sha256(yaml_path.read_bytes()).hexdigest()},
                    "pgm": {"path": pgm_path.name, "sha256": hashlib.sha256(pgm_path.read_bytes()).hexdigest()},
                },
            }), encoding="utf-8")

            result = map_metadata.read_active_map_metadata(metadata_path, yaml_path)

            self.assertFalse(result["available"])
            self.assertEqual(result["error"], "active_map_id_missing")

    def test_yaml_image_must_resolve_to_manifest_pgm(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            yaml_path = root / "active.yaml"
            pgm_path = root / "active.pgm"
            other_pgm_path = root / "other.pgm"
            metadata_path = root / "active_map.json"
            pgm_path.write_bytes(b"P5\n2 2\n255\n\x00\x00\x00\x00")
            other_pgm_path.write_bytes(b"P5\n2 2\n255\n\xff\xff\xff\xff")
            yaml_path.write_text(
                "image: other.pgm\nresolution: 0.05\norigin: [0, 0, 0]\n",
                encoding="utf-8",
            )
            metadata_path.write_text(
                json.dumps(
                    {
                        "id": "active-map",
                        "artifacts": {
                            "yaml": {
                                "path": yaml_path.name,
                                "sha256": hashlib.sha256(
                                    yaml_path.read_bytes()
                                ).hexdigest(),
                            },
                            "pgm": {
                                "path": pgm_path.name,
                                "sha256": hashlib.sha256(
                                    pgm_path.read_bytes()
                                ).hexdigest(),
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )

            result = map_metadata.read_active_map_metadata(metadata_path, yaml_path)

            self.assertFalse(result["available"])
            self.assertEqual(result["error"], "active_map_yaml_image_mismatch")


if __name__ == "__main__":
    unittest.main()
