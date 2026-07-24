from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT_DIR = Path(__file__).resolve().parents[1]
BRIDGE_DIR = ROOT_DIR / "sidecars" / "dogzilla_lib_bridge"

spec = importlib.util.spec_from_file_location("dogzilla_lib_bridge_server", BRIDGE_DIR / "server.py")
dogzilla_lib_bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = dogzilla_lib_bridge
spec.loader.exec_module(dogzilla_lib_bridge)


def ready_nav2_status_stdout() -> str:
    now = time.time()
    return json.dumps({
        "available": True,
        "action": "navigate_to_pose",
        "odom": {
            "topic": "/odom",
            "publisherCount": 1,
            "available": True,
            "messageAvailable": True,
            "lastMessageAt": now,
            "fresh": True,
            "tfAvailable": True,
            "tfFresh": True,
            "tfAgeSec": 0.0,
            "checkedAt": now,
            "frameId": "odom",
            "childFrameId": "base_link",
        },
        "lifecycle": {
            "active": True,
            "requiredNodes": [
                "map_server",
                "controller_server",
                "planner_server",
                "behavior_server",
                "bt_navigator",
                "velocity_smoother",
                "collision_monitor",
            ],
            "nodes": [
                {"name": "map_server", "active": True, "state": "active"},
                {"name": "controller_server", "active": True, "state": "active"},
                {"name": "planner_server", "active": True, "state": "active"},
                {"name": "bt_navigator", "active": True, "state": "active"},
                {"name": "behavior_server", "active": True, "state": "active"},
                {"name": "velocity_smoother", "active": True, "state": "active"},
                {"name": "collision_monitor", "active": True, "state": "active"},
            ],
        },
        "scan": {
            "topic": "/scan_nav2",
            "publisherCount": 1,
            "subscriptionCount": 3,
            "consumerNodes": [
                "/local_costmap/local_costmap",
                "/global_costmap/global_costmap",
                "/collision_monitor",
            ],
            "available": True,
            "messageAvailable": True,
            "lastMessageAt": now,
            "fresh": True,
            "checkedAt": now,
        },
    }) + "\n"


class DogzillaLibBridgeTests(unittest.TestCase):
    def setUp(self):
        self.map_tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.map_tmp.cleanup)
        map_dir = Path(self.map_tmp.name)
        yaml_path = map_dir / "test_map.yaml"
        pgm_path = map_dir / "test_map.pgm"
        metadata_path = map_dir / "test_map.json"
        pgm_path.write_bytes(b"P5\n# test map\n400 400\n255\n" + (b"\x00" * 400 * 400))
        yaml_path.write_text(
            f"image: {pgm_path}\n"
            "resolution: 0.050000\n"
            "origin: [-10.0, -10.0, 0.0]\n"
            "negate: 0\n"
            "occupied_thresh: 0.65\n"
            "free_thresh: 0.196\n",
            encoding="utf-8",
        )
        metadata_path.write_text(json.dumps({
            "id": "test-map",
            "yaml": str(yaml_path),
            "pgm": str(pgm_path),
            "savedAt": "2026-06-08T00:00:00Z",
            "resolution": 0.05,
            "artifacts": {
                "yaml": {"path": str(yaml_path), "sha256": hashlib.sha256(yaml_path.read_bytes()).hexdigest()},
                "pgm": {"path": str(pgm_path), "sha256": hashlib.sha256(pgm_path.read_bytes()).hexdigest()},
            },
        }), encoding="utf-8")

        old_metadata = dogzilla_lib_bridge.DEFAULT_MAP_METADATA_FILE
        old_yaml = dogzilla_lib_bridge.DEFAULT_MAP_YAML_FILE
        old_localization_status = dogzilla_lib_bridge.LOCALIZATION_STATUS_FILE
        old_map_pose_mode = dogzilla_lib_bridge.MAP_POSE_MODE_FILE
        localization_status_path = map_dir / "localization-status.json"
        map_pose_mode_path = map_dir / "map-pose-mode.json"
        localization_status_path.write_text(json.dumps({
            "trusted": True,
            "phase": "tracking",
        }), encoding="utf-8")
        map_pose_mode_path.write_text(json.dumps({"mode": "localization"}), encoding="utf-8")
        dogzilla_lib_bridge.DEFAULT_MAP_METADATA_FILE = metadata_path
        dogzilla_lib_bridge.DEFAULT_MAP_YAML_FILE = yaml_path
        dogzilla_lib_bridge.LOCALIZATION_STATUS_FILE = localization_status_path
        dogzilla_lib_bridge.MAP_POSE_MODE_FILE = map_pose_mode_path
        active_map = dogzilla_lib_bridge.read_active_map_metadata()
        self.map_id = active_map["id"]
        self.map_fingerprint = active_map["fingerprint"]
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "DEFAULT_MAP_METADATA_FILE", old_metadata))
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "DEFAULT_MAP_YAML_FILE", old_yaml))
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "LOCALIZATION_STATUS_FILE", old_localization_status))
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "MAP_POSE_MODE_FILE", old_map_pose_mode))

    def map_goal_params(self, **params):
        return {
            "frame": "map",
            "mapId": self.map_id,
            "mapFingerprint": self.map_fingerprint,
            **params,
        }

    def test_localization_status_fails_closed_without_global_match_proof(self):
        dogzilla_lib_bridge.LOCALIZATION_STATUS_FILE.unlink()

        status = dogzilla_lib_bridge.read_localization_status()
        prerequisites = dogzilla_lib_bridge.get_nav2_waypoint_prerequisites(FakeMissingOdomNav2Client())

        self.assertFalse(status["trusted"])
        self.assertFalse(prerequisites["ok"])
        self.assertIn("Localization proof unavailable", prerequisites["message"])

    def test_nav2_prerequisites_fail_closed_without_snapshot_contract(self):
        prerequisites = dogzilla_lib_bridge.get_nav2_waypoint_prerequisites(object())

        self.assertFalse(prerequisites["ok"])
        self.assertFalse(prerequisites["checked"])
        self.assertEqual(prerequisites["reason"], "nav2_snapshot_unavailable")
        self.assertIn("readiness evidence is unavailable", prerequisites["message"])

    def test_mapping_pose_is_trusted_without_saved_map_relocalization(self):
        dogzilla_lib_bridge.MAP_POSE_MODE_FILE.write_text(
            json.dumps({"mode": "mapping"}), encoding="utf-8"
        )

        status = dogzilla_lib_bridge.read_localization_status()

        self.assertTrue(status["trusted"])
        self.assertFalse(status["required"])
        self.assertEqual(status["phase"], "mapping")

    def test_state_read_aliases_accept_study_page_method_names(self):
        fake = FakeRobot()

        self.assertEqual(dogzilla_lib_bridge.call_first(fake, ["read_Battery", "read_battery"]), 87)
        self.assertEqual(dogzilla_lib_bridge.call_first(fake, ["read_Motor", "read_motor"]), [1, 2, 3])

    def test_preflight_reports_study_page_ros_domain(self):
        checks = dogzilla_lib_bridge.build_preflight_checks()

        self.assertTrue(any("ROS_DOMAIN_ID=16" in check.get("expect", "") for check in checks))
        self.assertTrue(any(check.get("command") == "./run_humble.sh" for check in checks))

    def test_shake_alias_resolves_to_handshake_action(self):
        self.assertEqual(dogzilla_lib_bridge.resolve_action_id({"actionName": "shake"}), 19)
        self.assertEqual(dogzilla_lib_bridge.resolve_action_id({"actionName": "handshake"}), 19)
        self.assertEqual(dogzilla_lib_bridge.resolve_action_id({"actionName": "paw shake"}), 19)
        self.assertEqual(dogzilla_lib_bridge.resolve_action_id({"actionName": "give-paw"}), 19)

    def test_scan_obstacle_counts_uses_front_and_side_sectors(self):
        front, left, right, min_range = dogzilla_lib_bridge.scan_obstacle_counts([
            {"angle": 0.0, "range": 0.4},
            {"angle": 0.1, "range": 0.45},
            {"angle": 0.7, "range": 0.5},
            {"angle": -0.7, "range": 0.5},
            {"angle": 0.0, "range": 0.8},
        ], 0.55)

        self.assertEqual(front, 2)
        self.assertEqual(left, 1)
        self.assertEqual(right, 1)
        self.assertEqual(min_range, 0.4)

    def test_nav2_costmap_lidar_mode_checks_scan_without_vendor_avoidance(self):
        supervisor = dogzilla_lib_bridge.LidarAvoidanceSupervisor()
        calls = []

        def fake_bridge_scan_endpoint():
            calls.append(("bridge-scan",))
            return {"ok": False, "attempt": "dogzilla-scan-endpoint", "error": "scan endpoint unavailable"}

        def fake_candidate_scan_checks(topic):
            calls.append(("scan", topic))
            return [("mock-scan", ["ros2", "topic", "info", topic], False)]

        def fake_run_candidate(label, command, shell):
            calls.append((label, command, shell))
            return {
                "ok": True,
                "stdout": "Type: sensor_msgs/msg/LaserScan\nPublisher count: 1\nSubscription count: 2\n",
                "stderr": "",
            }

        supervisor._check_bridge_scan_endpoint = fake_bridge_scan_endpoint
        supervisor._candidate_scan_checks = fake_candidate_scan_checks
        supervisor._run_candidate = fake_run_candidate

        result = supervisor.ensure_running({
            "required": True,
            "mode": "nav2_costmap",
        })

        self.assertTrue(result["ok"])
        self.assertEqual(result["mode"], "nav2_costmap")
        self.assertEqual(result["lidarTopic"], "/scan_nav2")
        self.assertEqual(result["publisherCount"], 1)
        self.assertEqual(result["subscriptionCount"], 2)
        self.assertIn("not started", result["safety"])
        self.assertEqual(calls[0], ("bridge-scan",))
        self.assertEqual(calls[1], ("scan", "/scan_nav2"))

    def test_nav2_costmap_scan_endpoint_handles_missing_url(self):
        supervisor = dogzilla_lib_bridge.LidarAvoidanceSupervisor()

        result = supervisor._check_bridge_scan_endpoint()

        self.assertFalse(result["ok"])
        self.assertEqual(result["attempt"], "dogzilla-scan-endpoint")
        self.assertIn("DOGZILLA_MAP_SCAN_URL", result["error"])

    def test_nav2_costmap_lidar_mode_accepts_live_bridge_scan_endpoint(self):
        supervisor = dogzilla_lib_bridge.LidarAvoidanceSupervisor()
        calls = []

        def fake_bridge_scan_endpoint():
            return {
                "ok": True,
                "attempt": "dogzilla-scan-endpoint",
                "validRanges": 438,
                "minRange": 0.41,
            }

        def fake_candidate_scan_checks(topic):
            calls.append(("scan", topic))
            return [("mock-scan", ["ros2", "topic", "info", topic], False)]

        supervisor._check_bridge_scan_endpoint = fake_bridge_scan_endpoint
        supervisor._candidate_scan_checks = fake_candidate_scan_checks

        result = supervisor.ensure_running({
            "required": True,
            "mode": "nav2_costmap",
        })

        self.assertTrue(result["ok"])
        self.assertEqual(result["lidarTopic"], "/scan_nav2")
        self.assertEqual(result["attempt"], "dogzilla-scan-endpoint")
        self.assertEqual(result["validRanges"], 438)
        self.assertEqual(calls, [])

    def test_nav2_costmap_lidar_mode_trusts_provided_scan_status(self):
        supervisor = dogzilla_lib_bridge.LidarAvoidanceSupervisor()
        calls = []

        def fake_bridge_scan_endpoint():
            calls.append(("bridge-scan",))
            return {"ok": False, "attempt": "dogzilla-scan-endpoint", "error": "scan endpoint unavailable"}

        supervisor._check_bridge_scan_endpoint = fake_bridge_scan_endpoint

        result = supervisor.ensure_running({
            "required": True,
            "mode": "nav2_costmap",
            "scanStatus": {
                "topic": "/scan_nav2",
                "publisherCount": 1,
                "subscriptionCount": 2,
                "available": True,
                "checkedAt": 123.0,
            },
        })

        self.assertTrue(result["ok"])
        self.assertEqual(result["attempt"], "nav2-scan-status")
        self.assertEqual(result["lidarTopic"], "/scan_nav2")
        self.assertEqual(calls, [])

    def test_non_nav2_lidar_mode_defaults_to_raw_scan_topic(self):
        supervisor = dogzilla_lib_bridge.LidarAvoidanceSupervisor()
        seen = []

        def fake_run_candidate(label, command, shell):
            seen.append((label, command, shell))
            return {"ok": True, "stdout": "", "stderr": ""}

        supervisor._run_candidate = fake_run_candidate
        result = supervisor.ensure_running({
            "required": True,
            "mode": "yahboom_laser",
        })

        self.assertTrue(result["ok"])
        self.assertEqual(result["lidarTopic"], "/scan")
        self.assertTrue(seen)

    def test_parse_ros_topic_count(self):
        self.assertEqual(dogzilla_lib_bridge.parse_ros_topic_count("Publisher count: 3", "Publisher count"), 3)
        self.assertEqual(dogzilla_lib_bridge.parse_ros_topic_count("no topic", "Publisher count"), 0)

    def test_http_goto_is_async_by_default(self):
        self.assertTrue(dogzilla_lib_bridge.DEFAULT_ASYNC_HTTP_GOTO)

    def test_state_read_defaults_to_battery_only(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeStateRobot()
        runtime.dry_run = True
        runtime._lock = threading.Lock()

        state = runtime.read_state()

        self.assertTrue(state["executed"])
        self.assertEqual(state["battery"], 87)
        self.assertIsNone(state["roll"])
        self.assertIsNone(state["pitch"])
        self.assertIsNone(state["yaw"])
        self.assertIsNone(state["motors"])
        self.assertIsNone(state["imuRaw"])

    def test_state_read_treats_zero_battery_as_failed_read(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeZeroBatteryRobot()
        runtime.dry_run = True
        runtime._lock = threading.Lock()

        state = runtime.read_state()

        self.assertTrue(state["executed"])
        self.assertIsNone(state["battery"])
        self.assertIn("failure sentinel 0", state["readErrors"]["battery"])

    def test_low_battery_blocks_motion_and_applies_safe_stop(self):
        runtime = battery_safety_runtime(9)

        result = runtime.execute({
            "kind": "locomotion.relative",
            "params": {"x_step": 8, "y_step": 0, "turn_rate": 0},
        })

        self.assertFalse(result["executed"])
        self.assertEqual(result["delivery"], "battery-safety-blocked")
        self.assertEqual(result["batterySafety"]["status"], "cutoff")
        self.assertIn(("stop",), runtime.robot.calls)

    def test_low_battery_still_allows_neutral_stop(self):
        runtime = battery_safety_runtime(9)

        result = runtime.execute({
            "kind": "locomotion.relative",
            "params": {"x_step": 0, "y_step": 0, "turn_rate": 0},
        })

        self.assertTrue(result["executed"])
        self.assertIn(("stop",), runtime.robot.calls)

    def test_stop_label_cannot_hide_moving_action_id(self):
        runtime = battery_safety_runtime(9)

        result = runtime.execute({
            "kind": "action.once",
            "params": {"actionName": "stop", "actionId": 14},
        })

        self.assertFalse(result["executed"])
        self.assertEqual(result["delivery"], "battery-safety-blocked")
        self.assertNotIn(("action", 14), runtime.robot.calls)

    def test_malformed_action_id_returns_error_without_aborting_execution(self):
        runtime = battery_safety_runtime(100)

        result = runtime.execute({
            "kind": "action.once",
            "params": {"actionId": "not-an-id"},
        })

        self.assertFalse(result["executed"])
        self.assertIn("missing actionId", result["error"])
        self.assertFalse(any(call[0] == "action" for call in runtime.robot.calls))

    def test_battery_read_serializes_stop_and_restores_serial_timeout(self):
        runtime = battery_safety_runtime(100)
        runtime.robot = FakeBlockingBatteryRobot()
        previous_timeout = dogzilla_lib_bridge.DEFAULT_BATTERY_READ_TIMEOUT_SEC
        dogzilla_lib_bridge.DEFAULT_BATTERY_READ_TIMEOUT_SEC = 0.05
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "DEFAULT_BATTERY_READ_TIMEOUT_SEC", previous_timeout))

        read_thread = threading.Thread(
            target=runtime._read_battery_with_timeout,
            args=(runtime.robot,),
        )
        started = time.monotonic()
        read_thread.start()
        self.assertTrue(runtime.robot.read_started.wait(0.2))
        result = runtime._execute_emergency_stop(reason="test")
        read_thread.join(0.2)
        elapsed = time.monotonic() - started

        self.assertTrue(result["executed"])
        self.assertLess(elapsed, 0.3)
        self.assertFalse(read_thread.is_alive())
        self.assertFalse(runtime.robot.uart_overlap)
        self.assertEqual(runtime.robot.ser.timeout, 0.5)
        self.assertIn(("stop",), runtime.robot.calls)

    def test_battery_timeout_restore_failure_still_releases_robot_lock(self):
        runtime = battery_safety_runtime(100)
        runtime.robot.ser = FakeRestoreFailureSerial()

        raw, error = runtime._read_battery_with_timeout(runtime.robot)

        self.assertIsNone(raw)
        self.assertEqual(error, "restore failed")
        self.assertTrue(runtime._lock.acquire(blocking=False))
        runtime._lock.release()

    def test_battery_motion_recovers_only_at_hysteresis_threshold(self):
        runtime = battery_safety_runtime(int(dogzilla_lib_bridge.DEFAULT_BATTERY_CUTOFF_PCT - 1))
        runtime.execute({"kind": "locomotion.relative", "params": {"x_step": 8}})

        runtime.robot.battery = int(dogzilla_lib_bridge.DEFAULT_BATTERY_RECOVERY_PCT - 1)
        runtime.battery_last_read_monotonic = 0
        recovering = runtime.execute({"kind": "locomotion.relative", "params": {"x_step": 8}})
        self.assertFalse(recovering["executed"])
        self.assertEqual(recovering["batterySafety"]["status"], "recovering")

        runtime.robot.battery = int(dogzilla_lib_bridge.DEFAULT_BATTERY_RECOVERY_PCT)
        runtime.battery_last_read_monotonic = 0
        recovered = runtime.execute({"kind": "locomotion.relative", "params": {"x_step": 8}})
        self.assertTrue(recovered["executed"])

    def test_voltage_like_battery_reading_is_not_treated_as_percent(self):
        runtime = battery_safety_runtime(12.4)

        state = runtime.read_state()

        self.assertIsNone(state["battery"])
        self.assertEqual(state["batteryUnit"], "unknown")
        self.assertEqual(state["batterySafety"]["status"], "invalid")
        self.assertFalse(state["batterySafety"]["motionAllowed"])
        self.assertIn("integer percentage", state["readErrors"]["battery"])

    def test_transient_invalid_battery_read_uses_recent_cache_without_blocking(self):
        runtime = battery_safety_runtime(100)
        first = runtime._battery_safety_snapshot(refresh=True)
        self.assertTrue(first["motionAllowed"])

        runtime.robot.battery = 12.4
        runtime.battery_last_read_monotonic = 0
        runtime.battery_last_valid_monotonic = time.monotonic() - dogzilla_lib_bridge.DEFAULT_BATTERY_MAX_AGE_SEC - 1
        safety = runtime._battery_safety_snapshot(refresh=True)

        self.assertTrue(safety["motionAllowed"])
        self.assertEqual(safety["status"], "last-known")
        self.assertEqual(safety["value"], 100.0)

    def test_valid_low_battery_still_blocks_during_transient_grace(self):
        runtime = battery_safety_runtime(100)
        runtime._battery_safety_snapshot(refresh=True)
        runtime.robot.battery = 9
        runtime.battery_last_read_monotonic = 0

        safety = runtime._battery_safety_snapshot(refresh=True)

        self.assertFalse(safety["motionAllowed"])
        self.assertEqual(safety["status"], "cutoff")

    def test_cached_low_battery_cannot_be_overridden_by_transient_grace(self):
        runtime = battery_safety_runtime(9)
        runtime._battery_safety_snapshot(refresh=True)
        runtime.robot.battery = 12.4
        runtime.battery_last_read_monotonic = 0
        runtime.battery_last_valid_monotonic = time.monotonic() - dogzilla_lib_bridge.DEFAULT_BATTERY_MAX_AGE_SEC - 1

        safety = runtime._battery_safety_snapshot(refresh=True)

        self.assertFalse(safety["motionAllowed"])
        self.assertEqual(safety["status"], "cutoff")

    def test_non_refresh_battery_diagnostic_does_not_latch_motion_block(self):
        runtime = battery_safety_runtime(100)
        runtime._battery_safety_snapshot(refresh=True)
        runtime.robot.battery = 12.4
        runtime.battery_last_read_monotonic = 0
        runtime.battery_last_valid_monotonic = time.monotonic() - dogzilla_lib_bridge.DEFAULT_BATTERY_MAX_AGE_SEC - 1

        safety = runtime._battery_safety_snapshot(refresh=False, enforce=False)

        self.assertFalse(safety["motionAllowed"])
        self.assertEqual(safety["status"], "stale")
        self.assertFalse(runtime._nav2_cmd_vel_is_blocked())

    def test_runtime_snapshot_reuses_one_nav2_sample(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.dry_run = True
        runtime.serial_port = "/dev/ttyAMA1"
        runtime.vendor_paths = []
        runtime.import_attempts = []
        runtime.nav2_client = AlternatingNav2Client()
        runtime.lidar_avoidance = FakeLidarAvoidance()

        snapshot = runtime.snapshot()

        self.assertEqual(snapshot["nav2"], snapshot["navigation"]["nav2"])
        self.assertTrue(snapshot["nav2"]["waypointReady"])
        self.assertTrue(snapshot["navigation"]["waypointReady"])
        self.assertEqual(runtime.nav2_client.calls, 1)

    def test_goto_uses_nav2_without_dogzilla_serial_robot(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeNav2Client()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(
                x=1,
                y=-2,
                yaw=7,
                waypoint="living_room",
                arrivalToleranceMeters=0.25,
            ),
        })

        self.assertTrue(result["executed"])
        self.assertEqual(result["delivery"], "accepted")
        self.assertEqual(result["kind"], "locomotion.goto")
        self.assertEqual(result["waypoint"], "living_room")
        self.assertTrue(result["waypointSafe"])
        self.assertAlmostEqual(runtime.nav2_client.goal["yaw"], 7 - 6.283185307179586)

    def test_goto_can_require_verified_nav2_completion(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.dry_run = False
        runtime.nav2_client = FakeNav2Client()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(
                x=1,
                y=-2,
                yaw=0.2,
                waypoint="mapping_resume_pose",
                waitForResult=True,
                resultTimeoutSec=600,
            ),
        })

        self.assertTrue(result["executed"])
        self.assertTrue(result["goalCompleted"])
        self.assertEqual(result["goalStatus"], "succeeded")
        self.assertEqual(result["status"], "arrived")
        self.assertTrue(runtime.nav2_client.goal["waitForResult"])
        self.assertEqual(runtime.nav2_client.goal["resultTimeoutSec"], 600)

    def test_synchronous_goto_clears_command_preempt_at_acceptance_before_result(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.dry_run = False
        runtime.nav2_cmd_vel_blocked = True
        runtime.nav2_cmd_vel_blocked_reason = "command_preempt"
        observations = []

        class ObservedClient(FakeNav2Client):
            def send_goal(self, **kwargs):
                observations.append(runtime._nav2_cmd_vel_block_reason())
                callback = kwargs["on_goal_accepted"]
                accepted = {
                    "executed": True,
                    "delivery": "Nav2 NavigateToPose",
                    "goalAccepted": True,
                    "goalCompleted": False,
                    "goalStatus": "accepted",
                    "goalId": self.goal_id,
                }
                callback(dict(accepted))
                observations.append(runtime._nav2_cmd_vel_block_reason())
                return {
                    **accepted,
                    "goalCompleted": True,
                    "goalStatus": "succeeded",
                }

        runtime.nav2_client = ObservedClient()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(
                x=1,
                y=-2,
                yaw=0.2,
                waypoint="mapping_resume_pose",
                waitForResult=True,
                resultTimeoutSec=600,
            ),
        })

        self.assertTrue(result["executed"])
        self.assertEqual(observations, ["command_preempt", None])
        self.assertFalse(runtime._nav2_cmd_vel_is_blocked())

    def test_rejected_goto_leaves_command_preempt_gate_latched(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.dry_run = False
        runtime.nav2_cmd_vel_blocked = True
        runtime.nav2_cmd_vel_blocked_reason = "command_preempt"
        class RejectingClient(FakeNav2Client):
            def send_goal(self, **_kwargs):
                return {
                    "executed": False,
                    "delivery": "nav2-rejected",
                    "error": "Nav2 NavigateToPose goal rejected",
                }

        runtime.nav2_client = RejectingClient()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(x=1, y=-2, yaw=0.2),
        })

        self.assertFalse(result["executed"])
        self.assertTrue(runtime._nav2_cmd_vel_is_blocked())
        self.assertEqual(runtime._nav2_cmd_vel_block_reason(), "command_preempt")

    def test_goto_does_not_run_a_power_mode_transition(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeNav2Client()
        runtime.nav2_client.snapshot = lambda: {"waypointReady": True}
        original_set_nav_mode = dogzilla_lib_bridge.set_nav_mode
        dogzilla_lib_bridge.set_nav_mode = lambda _mode: self.fail("power mode transition must not run")
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "set_nav_mode", original_set_nav_mode))

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(x=1, y=-2, yaw=0),
        })

        self.assertTrue(result["executed"])
        self.assertNotIn("modeTransition", result)
        self.assertEqual(dogzilla_lib_bridge.get_nav_mode(), "navigate")

    def test_goto_blocks_goal_outside_active_map(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeNav2Client()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(x=11, y=0, yaw=0, waypoint="kitchen"),
        })

        self.assertFalse(result["executed"])
        self.assertEqual(result["delivery"], "waypoint-map-blocked")
        self.assertEqual(result["mapValidation"]["reason"], "off-map")
        self.assertFalse(hasattr(runtime.nav2_client, "goal"))

    def test_goto_blocks_nav2_when_odom_publisher_is_missing(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeMissingOdomNav2Client()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(x=1, y=-2, yaw=0, waypoint="living_room"),
        })

        self.assertFalse(result["executed"])
        self.assertEqual(result["delivery"], "rejected")
        self.assertIn("No publishers on /odom", result["error"])
        self.assertFalse(hasattr(runtime.nav2_client, "goal"))

    def test_goto_invokes_required_lidar_avoidance_before_nav2(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeNav2Client()
        runtime.lidar_avoidance = FakeLidarAvoidance()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(
                x=1,
                y=-2,
                yaw=0.2,
                waypoint="living_room",
                obstacleAvoidance={
                    "required": True,
                    "mode": "yahboom_laser",
                    "lidarTopic": "/scan",
                },
            ),
        })

        self.assertTrue(result["executed"])
        self.assertEqual(result["lidarAvoidance"]["mode"], "yahboom_laser")
        self.assertEqual(runtime.lidar_avoidance.requests[0]["lidarTopic"], "/scan")
        self.assertEqual(runtime.nav2_client.goal["frame"], "map")

    def test_goto_passes_cached_scan_status_to_nav2_costmap_avoidance(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeNav2Client()
        runtime.lidar_avoidance = FakeLidarAvoidance()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(
                x=1,
                y=-2,
                yaw=0.2,
                waypoint="living_room",
                obstacleAvoidance={
                    "required": True,
                    "mode": "nav2_costmap",
                    "lidarTopic": "/scan_nav2",
                },
            ),
        })

        self.assertTrue(result["executed"])
        self.assertEqual(runtime.lidar_avoidance.requests[0]["mode"], "nav2_costmap")
        self.assertEqual(runtime.lidar_avoidance.requests[0]["scanStatus"]["topic"], "/scan_nav2")
        self.assertTrue(runtime.lidar_avoidance.requests[0]["scanStatus"]["available"])

    def test_goto_blocks_nav2_when_required_lidar_avoidance_fails(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeNav2Client()
        runtime.lidar_avoidance = FakeFailedLidarAvoidance()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(
                x=1,
                y=-2,
                yaw=0.2,
                waypoint="living_room",
                obstacleAvoidance={"required": True},
            ),
        })

        self.assertFalse(result["executed"])
        self.assertEqual(result["delivery"], "lidar-avoidance-unavailable")
        self.assertFalse(hasattr(runtime.nav2_client, "goal"))

    def test_goto_allows_temporary_odom_waypoint(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeNav2Client()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": {
                "frame": "odom",
                "x": 0.4,
                "y": 0.0,
                "yaw": 0,
                "waypoint": "local_test",
            },
        })

        self.assertTrue(result["executed"])
        self.assertEqual(result["delivery"], "accepted")
        self.assertEqual(runtime.nav2_client.goal["frame"], "odom")
        self.assertFalse(result["waypointSafe"])

    def test_goto_reports_nav2_unavailable_without_faking_execution(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.robot_error = "serial lib unavailable"
        runtime.robot = None
        runtime.dry_run = False
        runtime.nav2_client = FakeUnavailableNav2Client()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(x=1, y=2, yaw=0, waypoint="living_room"),
        })

        self.assertFalse(result["executed"])
        self.assertEqual(result["delivery"], "rejected")
        self.assertEqual(result["error"], "Nav2 NavigateToPose action server unavailable")

    def test_nav2_command_action_wait_timeout_matches_pi_load(self):
        self.assertGreaterEqual(dogzilla_lib_bridge.DEFAULT_NAV2_WAIT_TIMEOUT, 12.0)



    def test_replacing_navigation_cancel_event_cancels_previous_goto(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        previous = threading.Event()
        runtime.navigation_cancel = previous

        next_event = runtime._replace_navigation_cancel_event()

        self.assertTrue(previous.is_set())
        self.assertFalse(next_event.is_set())
        self.assertIs(runtime.navigation_cancel, next_event)

    def test_nav2_client_uses_docker_backend_when_host_rclpy_is_missing(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.action_name = "navigate_to_pose"
        client.wait_timeout = 2.0
        client.goal_response_timeout = 3.0
        client.host_import_error = "No module named 'rclpy'"
        client.import_error = "No module named 'rclpy'"
        client.docker_import_error = None
        client.server_error = None
        client.backend = "host-rclpy"
        client.available = False
        client.client_available = False
        client.server_available = False
        client._last_status_check = 0.0
        client.docker_container = "robodoge-rosbridge"
        calls = []

        def fake_run_docker_python(script, *, timeout):
            calls.append({"script": script, "timeout": timeout})
            if "dogzilla_direct_nav2_status_client" in script:
                stdout = ready_nav2_status_stdout()
            else:
                stdout = "ok\n"
            return dogzilla_lib_bridge.subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=stdout,
                stderr="",
            )

        client._run_docker_python = fake_run_docker_python
        client._try_enable_docker_backend()

        self.assertFalse(client.available)
        self.assertTrue(client.client_available)
        self.assertFalse(client.server_available)
        self.assertEqual(client.backend, "docker-rclpy")
        self.assertIsNone(client.import_error)
        self.assertEqual(calls[0]["timeout"], 6)
        self.assertIn("nav2_msgs.action", calls[0]["script"])

        snapshot = client.snapshot()

        self.assertTrue(snapshot["available"])
        self.assertTrue(snapshot["clientAvailable"])
        self.assertTrue(snapshot["serverAvailable"])
        self.assertIn("dogzilla_direct_nav2_status_client", calls[1]["script"])
        self.assertEqual(calls[1]["timeout"], dogzilla_lib_bridge.DEFAULT_NAV2_DOCKER_STATUS_TIMEOUT)
        self.assertIn("probe_live_odom", calls[1]["script"])
        self.assertIn("probe_nav2_lifecycle", calls[1]["script"])
        self.assertIn("probe_scan_topic", calls[1]["script"])
        self.assertIn("odomWaitTimeout", calls[1]["script"])

    def test_nav2_client_rejects_publisher_only_odom(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)

        client._set_odom_status_from_payload({
            "topic": "/odom",
            "publisherCount": 1,
            "available": False,
            "messageAvailable": False,
            "tfAvailable": False,
        })
        snapshot = client._odom_snapshot()

        self.assertFalse(client.odom_available)
        self.assertFalse(snapshot["available"])
        self.assertEqual(snapshot["publisherCount"], 1)
        self.assertFalse(snapshot["messageAvailable"])
        self.assertFalse(snapshot["tfAvailable"])
        self.assertIn("no live odometry samples", snapshot["error"])

    def test_nav2_client_snapshot_requires_lifecycle_and_filtered_scan(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        now = time.time()
        client.action_name = "navigate_to_pose"
        client.wait_timeout = 2.0
        client.goal_response_timeout = 3.0
        client.backend = "docker-rclpy"
        client.docker_container = "robodoge-rosbridge"
        client.client_available = True
        client.server_available = True
        client.available = True
        client.import_error = None
        client.host_import_error = None
        client.docker_import_error = None
        client.server_error = None
        client._refresh_status = lambda force=False: None
        client._set_odom_status_from_payload({
            "topic": "/odom",
            "publisherCount": 1,
            "available": True,
            "messageAvailable": True,
            "lastMessageAt": now,
            "fresh": True,
            "tfAvailable": True,
            "tfFresh": True,
            "tfAgeSec": 0.0,
            "checkedAt": now,
        })
        ready_status = json.loads(ready_nav2_status_stdout())
        client._set_lifecycle_status_from_payload(ready_status["lifecycle"])
        client._set_scan_status_from_payload({
            "topic": "/scan_nav2",
            "publisherCount": 1,
            "subscriptionCount": 0,
            "available": False,
        })

        snapshot = client.snapshot()

        self.assertFalse(snapshot["waypointReady"])
        self.assertTrue(snapshot["odom"]["available"])
        self.assertTrue(snapshot["lifecycle"]["active"])
        self.assertFalse(snapshot["scan"]["available"])
        self.assertIn(
            "No Nav2 subscribers visible on /scan_nav2",
            snapshot["blockers"],
        )

    def test_nav2_client_lite_snapshot_skips_status_refresh(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        now = time.time()
        client.action_name = "navigate_to_pose"
        client.wait_timeout = 12.0
        client.goal_response_timeout = 3.0
        client.wait_timeout = 2.0
        client.goal_response_timeout = 3.0
        client.backend = "docker-rclpy"
        client.client_available = True
        client.server_available = True
        client.available = True
        client.import_error = None
        client.host_import_error = None
        client.docker_import_error = None
        client.server_error = None
        client.docker_container = "robodoge-rosbridge"
        client._refresh_status = lambda: self.fail("lite snapshot must not refresh Docker status")
        client._set_odom_status_from_payload({
            "available": True,
            "publisherCount": 1,
            "messageAvailable": True,
            "lastMessageAt": now,
            "fresh": True,
            "tfAvailable": True,
            "tfFresh": True,
            "tfAgeSec": 0.0,
            "checkedAt": now,
        })
        ready_status = json.loads(ready_nav2_status_stdout())
        client._set_lifecycle_status_from_payload(ready_status["lifecycle"])
        client._set_scan_status_from_payload(ready_status["scan"])

        snapshot = client.snapshot(refresh=False)

        self.assertTrue(snapshot["odom"]["available"])
        self.assertTrue(snapshot["lifecycle"]["active"])
        self.assertTrue(snapshot["scan"]["available"])

    def test_nav2_client_refreshes_one_stale_goal_backend_after_fresh_pi_readiness(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.action_name = "navigate_to_pose"
        client.wait_timeout = 12.0
        client.goal_response_timeout = 3.0
        client.backend = "host-rclpy"
        client.client_available = False
        client.server_available = False
        client.available = False
        client.import_error = "No module named 'rclpy'"
        client.host_import_error = "No module named 'rclpy'"
        client.docker_import_error = "No such container: robodoge-rosbridge"
        client.server_error = None
        client.docker_container = "robodoge-rosbridge"
        client._set_odom_status_from_payload(json.loads(ready_nav2_status_stdout())["odom"])
        status = json.loads(ready_nav2_status_stdout())
        client._set_lifecycle_status_from_payload(status["lifecycle"])
        client._set_scan_status_from_payload(status["scan"])
        client._read_persistent_readiness = lambda: {
            "ownerMode": "normal",
            "actionServerAvailable": True,
            "stackActive": True,
            "odomFresh": True,
            "tfFresh": True,
            "scanFresh": True,
            "waypointReady": True,
        }
        refresh_calls = []

        def recover_backend(*, force=False):
            refresh_calls.append(force)
            client.backend = "docker-rclpy"
            client.client_available = True
            client.server_available = True
            client.available = True
            client.import_error = None

        client._refresh_status = recover_backend

        stale = client.snapshot(refresh=False)
        self.assertFalse(stale["canSendGoal"])
        recovered = client.refresh_backend_for_ready_snapshot(stale)

        self.assertEqual(refresh_calls, [True])
        self.assertTrue(recovered["canSendGoal"])
        self.assertTrue(recovered["waypointReady"])

    def test_nav2_client_accepts_schema_two_persistent_readiness(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        nav2_client_module = sys.modules[dogzilla_lib_bridge.Nav2NavigateClient.__module__]
        original_path = nav2_client_module.DEFAULT_NAV2_READINESS_FILE
        with tempfile.TemporaryDirectory() as directory:
            readiness_path = Path(directory) / "navigation-readiness.json"
            readiness_path.write_text(json.dumps({
                "schemaVersion": 2,
                "checkedAt": time.time(),
                "ownerMode": "normal",
                "readinessState": "ready",
                "blockers": [],
                "actionServerAvailable": True,
                "stackActive": True,
                "odomFresh": True,
                "tfFresh": True,
                "scanFresh": True,
                "waypointReady": True,
            }), encoding="utf-8")
            nav2_client_module.DEFAULT_NAV2_READINESS_FILE = str(readiness_path)
            try:
                readiness = client._read_persistent_readiness()
            finally:
                nav2_client_module.DEFAULT_NAV2_READINESS_FILE = original_path

        self.assertIsNotNone(readiness)
        self.assertEqual(readiness["schemaVersion"], 2)
        self.assertTrue(readiness["waypointReady"])

    def test_nav2_client_keeps_ordinary_healthy_poll_cached(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.backend = "docker-rclpy"
        client.client_available = True
        client.server_available = True
        client.available = True
        client._backend_recovery_attempted = False
        client._refresh_status = lambda **_kwargs: self.fail("healthy lite polling must stay cached")
        snapshot = {
            "canSendGoal": True,
            "readiness": {
                "ownerMode": "normal",
                "actionServerAvailable": True,
                "stackActive": True,
                "odomFresh": True,
                "tfFresh": True,
                "scanFresh": True,
                "waypointReady": True,
            },
        }

        self.assertIs(client.refresh_backend_for_ready_snapshot(snapshot), snapshot)

    def test_nav2_snapshot_prefers_backend_and_prerequisite_blockers_over_action_warning(self):
        status = json.loads(ready_nav2_status_stdout())

        stopped_container = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        stopped_container.action_name = "navigate_to_pose"
        stopped_container.wait_timeout = 12.0
        stopped_container.goal_response_timeout = 3.0
        stopped_container.backend = "host-rclpy"
        stopped_container.client_available = False
        stopped_container.server_available = False
        stopped_container.available = False
        stopped_container.import_error = "No such container: robodoge-rosbridge"
        stopped_container.host_import_error = "No module named 'rclpy'"
        stopped_container.docker_import_error = "No such container: robodoge-rosbridge"
        stopped_container.server_error = None
        stopped_container.docker_container = "robodoge-rosbridge"
        stopped_container._set_odom_status_from_payload(status["odom"])
        stopped_container._set_lifecycle_status_from_payload(status["lifecycle"])
        stopped_container._set_scan_status_from_payload(status["scan"])
        stopped_snapshot = stopped_container.snapshot(refresh=False)
        self.assertIn("No such container", stopped_snapshot["blockers"][0])
        self.assertNotIn("action server is not running", stopped_snapshot["blockers"][0].lower())

        inactive = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        inactive.action_name = "navigate_to_pose"
        inactive.wait_timeout = 12.0
        inactive.goal_response_timeout = 3.0
        inactive.backend = "docker-rclpy"
        inactive.client_available = True
        inactive.server_available = False
        inactive.available = False
        inactive.import_error = "Nav2 NavigateToPose action server is not running"
        inactive.host_import_error = None
        inactive.docker_import_error = None
        inactive.server_error = inactive.import_error
        inactive.docker_container = "robodoge-rosbridge"
        lifecycle = dict(status["lifecycle"])
        lifecycle["active"] = False
        lifecycle["error"] = "Nav2 lifecycle nodes are inactive"
        inactive._set_odom_status_from_payload(status["odom"])
        inactive._set_lifecycle_status_from_payload(lifecycle)
        inactive._set_scan_status_from_payload(status["scan"])
        inactive_snapshot = inactive.snapshot(refresh=False)
        self.assertEqual(inactive_snapshot["blockers"][0], "Nav2 lifecycle nodes are inactive")

        missing_action = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        missing_action.action_name = "navigate_to_pose"
        missing_action.wait_timeout = 12.0
        missing_action.goal_response_timeout = 3.0
        missing_action.backend = "docker-rclpy"
        missing_action.client_available = True
        missing_action.server_available = False
        missing_action.available = False
        missing_action.import_error = "Nav2 NavigateToPose action server is not running"
        missing_action.host_import_error = None
        missing_action.docker_import_error = None
        missing_action.server_error = missing_action.import_error
        missing_action.docker_container = "robodoge-rosbridge"
        missing_action._set_odom_status_from_payload(status["odom"])
        missing_action._set_lifecycle_status_from_payload(status["lifecycle"])
        missing_action._set_scan_status_from_payload(status["scan"])
        missing_snapshot = missing_action.snapshot(refresh=False)
        self.assertEqual(missing_snapshot["blockers"], [missing_action.import_error])

    def test_scan_readiness_records_all_subscribers_but_requires_collision_monitor(self):
        endpoints = [
            SimpleNamespace(node_name="dogzilla_direct_nav2_client", node_namespace="/"),
            SimpleNamespace(node_name="rviz2", node_namespace="/"),
            SimpleNamespace(node_name="rosbag2_recorder", node_namespace="/"),
        ]

        self.assertEqual(
            dogzilla_lib_bridge.nav2_client_module.nav2_scan_consumer_nodes(endpoints),
            [
                "/dogzilla_direct_nav2_client",
                "/rosbag2_recorder",
                "/rviz2",
            ],
        )
        self.assertEqual(
            dogzilla_lib_bridge.nav2_client_module.nav2_scan_consumer_status(endpoints)["missingConsumerNodes"],
            ["collision_monitor"],
        )

        endpoints.append(
            SimpleNamespace(node_name="collision_monitor", node_namespace="/robot/nav")
        )
        self.assertEqual(
            dogzilla_lib_bridge.nav2_client_module.nav2_scan_consumer_status(endpoints)["missingConsumerNodes"],
            [],
        )

    def test_required_nav2_lifecycle_nodes_cannot_be_shrunk_by_environment(self):
        required = dogzilla_lib_bridge.nav2_client_module.required_nav2_lifecycle_nodes(
            "controller_server,custom_safety_node",
            mapping_mode=False,
            localization_backend="amcl",
        )

        self.assertEqual(
            required,
            (
                "map_server",
                "controller_server",
                "planner_server",
                "behavior_server",
                "bt_navigator",
                "velocity_smoother",
                "collision_monitor",
                "amcl",
                "custom_safety_node",
            ),
        )

    def test_nav2_status_refresh_deduplicates_concurrent_probes(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.backend = "docker-rclpy"
        client._last_status_check = 0.0
        client._status_refresh_lock = threading.Lock()
        calls = []

        def refresh_docker_status():
            calls.append(True)
            time.sleep(0.05)

        client._refresh_docker_status = refresh_docker_status
        threads = [threading.Thread(target=client._refresh_status) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(len(calls), 1)

    def test_nav2_client_reports_docker_action_server_missing(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.action_name = "navigate_to_pose"
        client.wait_timeout = 2.0
        client.goal_response_timeout = 3.0
        client.host_import_error = "No module named 'rclpy'"
        client.import_error = "No module named 'rclpy'"
        client.docker_import_error = None
        client.server_error = None
        client.client_available = False
        client.server_available = False
        client._last_status_check = 0.0
        client.backend = "host-rclpy"
        client.available = False
        client.docker_container = "robodoge-rosbridge"
        calls = []

        def fake_run_docker_python(script, *, timeout):
            calls.append({"script": script, "timeout": timeout})
            if "dogzilla_direct_nav2_status_client" in script:
                stdout = '{"available": false, "action": "navigate_to_pose"}\n'
            else:
                stdout = "ok\n"
            return dogzilla_lib_bridge.subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=stdout,
                stderr="",
            )

        client._run_docker_python = fake_run_docker_python
        client._try_enable_docker_backend()

        self.assertFalse(client.available)
        self.assertTrue(client.client_available)
        self.assertFalse(client.server_available)
        self.assertEqual(client.backend, "docker-rclpy")
        self.assertIsNone(client.import_error)
        self.assertEqual(len(calls), 1)
        snapshot = client.snapshot()
        self.assertFalse(snapshot["available"])
        self.assertTrue(snapshot["clientAvailable"])
        self.assertFalse(snapshot["serverAvailable"])
        self.assertIn("action server is not running", snapshot["importError"])
        self.assertIn("dogzilla_direct_nav2_status_client", calls[1]["script"])
        self.assertEqual(calls[1]["timeout"], dogzilla_lib_bridge.DEFAULT_NAV2_DOCKER_STATUS_TIMEOUT)

    def test_nav2_client_docker_import_timeout_does_not_raise(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.action_name = "navigate_to_pose"
        client.wait_timeout = 2.0
        client.goal_response_timeout = 3.0
        client.host_import_error = "No module named 'rclpy'"
        client.import_error = "No module named 'rclpy'"
        client.docker_import_error = None
        client.server_error = None
        client.client_available = False
        client.server_available = False
        client._last_status_check = 0.0
        client.backend = "host-rclpy"
        client.available = False
        client.docker_container = "robodoge-rosbridge"

        def fake_run_docker_python(script, *, timeout):
            raise dogzilla_lib_bridge.subprocess.TimeoutExpired(cmd=["docker"], timeout=timeout)

        client._run_docker_python = fake_run_docker_python
        client._try_enable_docker_backend()

        self.assertFalse(client.available)
        self.assertFalse(client.client_available)
        self.assertIn("docker import probe timed out", client.docker_import_error)
        self.assertIn("docker import probe timed out", client.import_error)

    def test_nav2_client_retries_docker_backend_after_container_boots(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.action_name = "navigate_to_pose"
        client.wait_timeout = 2.0
        client.goal_response_timeout = 3.0
        client.host_import_error = "No module named 'rclpy'"
        client.import_error = "No module named 'rclpy'; docker:No such container: robodoge-rosbridge"
        client.docker_import_error = "No such container: robodoge-rosbridge"
        client.server_error = None
        client.client_available = False
        client.server_available = False
        client._last_status_check = 0.0
        client.backend = "host-rclpy"
        client.available = False
        client.docker_container = "robodoge-rosbridge"
        calls = []

        def fake_run_docker_python(script, *, timeout):
            calls.append({"script": script, "timeout": timeout})
            if "dogzilla_direct_nav2_status_client" in script:
                stdout = ready_nav2_status_stdout()
            else:
                stdout = "ok\n"
            return dogzilla_lib_bridge.subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=stdout,
                stderr="",
            )

        client._run_docker_python = fake_run_docker_python

        snapshot = client.snapshot()

        self.assertTrue(snapshot["available"])
        self.assertTrue(snapshot["clientAvailable"])
        self.assertTrue(snapshot["serverAvailable"])
        self.assertTrue(snapshot["waypointReady"])
        self.assertTrue(snapshot["lifecycle"]["active"])
        self.assertTrue(snapshot["scan"]["available"])
        self.assertEqual(snapshot["backend"], "docker-rclpy")
        self.assertIsNone(snapshot["dockerImportError"])
        self.assertIsNone(snapshot["importError"])
        self.assertEqual(calls[0]["timeout"], 6)
        self.assertEqual(snapshot["dockerStatusTimeoutSec"], dogzilla_lib_bridge.DEFAULT_NAV2_DOCKER_STATUS_TIMEOUT)

    def test_docker_send_goal_enabled_by_default(self):
        self.assertTrue(dogzilla_lib_bridge.nav2_client_module.DEFAULT_NAV2_SEND_GOAL_DOCKER_ENABLED)

    def test_nav2_client_sends_goal_through_docker_backend_when_enabled(self):
        previous = dogzilla_lib_bridge.nav2_client_module.DEFAULT_NAV2_SEND_GOAL_DOCKER_ENABLED
        dogzilla_lib_bridge.nav2_client_module.DEFAULT_NAV2_SEND_GOAL_DOCKER_ENABLED = True
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge.nav2_client_module, "DEFAULT_NAV2_SEND_GOAL_DOCKER_ENABLED", previous))

        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.action_name = "navigate_to_pose"
        client.wait_timeout = 2.0
        client.goal_response_timeout = 3.0
        client.backend = "docker-rclpy"
        client.available = True
        client.docker_container = "robodoge-rosbridge"
        calls = []

        def fake_run_docker_python(script, *, timeout):
            calls.append({"script": script, "timeout": timeout})
            return dogzilla_lib_bridge.subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout='{"executed": true, "delivery": "Nav2 NavigateToPose", "goalAccepted": true, "goalId": "00112233445566778899aabbccddeeff", "frame": "map", "x": 1.25, "y": -0.5, "yaw": 0.2}\n',
                stderr="",
            )

        client._run_docker_python = fake_run_docker_python
        result = client.send_goal(frame="map", x=1.25, y=-0.5, yaw=0.2)

        self.assertTrue(result["executed"])
        self.assertEqual(result["delivery"], "Nav2 NavigateToPose")
        self.assertEqual(result["backend"], "docker-rclpy")
        self.assertEqual(result["container"], "robodoge-rosbridge")
        self.assertEqual(calls[0]["timeout"], 30.0)
        self.assertIn("dogzilla_direct_nav2_docker_client", calls[0]["script"])
        self.assertIn('\\"x\\": 1.25', calls[0]["script"])
        self.assertIn("probe_live_odom", calls[0]["script"])
        self.assertIn('if lifecycle.get("active") is not True:', calls[0]["script"])
        self.assertIn('"delivery": "nav2-prerequisite-unavailable"', calls[0]["script"])
        self.assertIn("goal_id = bytes(goal_handle.goal_id.uuid).hex()", calls[0]["script"])
        self.assertEqual(result["goalId"], "00112233445566778899aabbccddeeff")

    def test_host_nav2_acceptance_hook_runs_before_synchronous_result_wait(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.action_name = "navigate_to_pose"
        client.backend = "host-rclpy"
        client.client_available = True
        client.wait_timeout = 2.0
        client.goal_response_timeout = 3.0
        client.odom_available = True
        client.lifecycle_active = True
        client.scan_available = True
        client._refresh_status = lambda: None
        client._wait_for_server_with_retry = lambda timeout_sec: True
        client._refresh_host_prerequisites = lambda: None

        class Goal:
            def __init__(self):
                self.pose = SimpleNamespace(
                    header=SimpleNamespace(frame_id=None, stamp=None),
                    pose=SimpleNamespace(
                        position=SimpleNamespace(x=0.0, y=0.0, z=0.0),
                        orientation=SimpleNamespace(z=0.0, w=0.0),
                    ),
                )

        class DoneFuture:
            def __init__(self, value):
                self.value = value

            def done(self):
                return True

            def result(self):
                return self.value

        result_future = DoneFuture(SimpleNamespace(status=4))
        goal_handle = SimpleNamespace(
            accepted=True,
            goal_id=SimpleNamespace(uuid=bytes.fromhex("00112233445566778899aabbccddeeff")),
            get_result_async=lambda: result_future,
        )
        client._navigate_to_pose_type = SimpleNamespace(Goal=Goal)
        client._node = SimpleNamespace(
            get_clock=lambda: SimpleNamespace(
                now=lambda: SimpleNamespace(to_msg=lambda: SimpleNamespace())
            )
        )
        client._action_client = SimpleNamespace(send_goal_async=lambda _goal: DoneFuture(goal_handle))
        call_order = []
        client.wait_for_goal_result = lambda goal_id, *, timeout: (
            call_order.append(("result", goal_id, timeout))
            or {
                "executed": True,
                "delivery": "Nav2 NavigateToPose",
                "goalAccepted": True,
                "goalCompleted": True,
                "goalStatus": "succeeded",
                "goalId": goal_id,
            }
        )

        result = client.send_goal(
            frame="map",
            x=1.0,
            y=2.0,
            yaw=0.25,
            wait_for_result=True,
            result_timeout=45.0,
            on_goal_accepted=lambda accepted: call_order.append(
                ("accepted", accepted["goalId"])
            ),
        )

        self.assertTrue(result["goalCompleted"])
        self.assertEqual(
            call_order,
            [
                ("accepted", "00112233445566778899aabbccddeeff"),
                ("result", "00112233445566778899aabbccddeeff", 45.0),
            ],
        )

    def test_host_nav2_rejection_does_not_run_acceptance_hook(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.action_name = "navigate_to_pose"
        client.backend = "host-rclpy"
        client.client_available = True
        client.wait_timeout = 2.0
        client.goal_response_timeout = 3.0
        client.odom_available = True
        client.lifecycle_active = True
        client.scan_available = True
        client._refresh_status = lambda: None
        client._wait_for_server_with_retry = lambda timeout_sec: True
        client._refresh_host_prerequisites = lambda: None

        class Goal:
            def __init__(self):
                self.pose = SimpleNamespace(
                    header=SimpleNamespace(frame_id=None, stamp=None),
                    pose=SimpleNamespace(
                        position=SimpleNamespace(x=0.0, y=0.0, z=0.0),
                        orientation=SimpleNamespace(z=0.0, w=0.0),
                    ),
                )

        rejected_handle = SimpleNamespace(accepted=False)
        client._navigate_to_pose_type = SimpleNamespace(Goal=Goal)
        client._node = SimpleNamespace(
            get_clock=lambda: SimpleNamespace(
                now=lambda: SimpleNamespace(to_msg=lambda: SimpleNamespace())
            )
        )
        client._action_client = SimpleNamespace(
            send_goal_async=lambda _goal: SimpleNamespace(
                done=lambda: True,
                result=lambda: rejected_handle,
            )
        )
        accepted_calls = []

        result = client.send_goal(
            frame="map",
            x=1.0,
            y=2.0,
            yaw=0.25,
            wait_for_result=True,
            on_goal_accepted=lambda accepted: accepted_calls.append(accepted),
        )

        self.assertFalse(result["executed"])
        self.assertEqual(result["delivery"], "nav2-rejected")
        self.assertEqual(accepted_calls, [])

    def test_nav2_client_waits_for_docker_goal_result_when_requested(self):
        previous = dogzilla_lib_bridge.nav2_client_module.DEFAULT_NAV2_SEND_GOAL_DOCKER_ENABLED
        dogzilla_lib_bridge.nav2_client_module.DEFAULT_NAV2_SEND_GOAL_DOCKER_ENABLED = True
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge.nav2_client_module, "DEFAULT_NAV2_SEND_GOAL_DOCKER_ENABLED", previous))

        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.action_name = "navigate_to_pose"
        client.wait_timeout = 2.0
        client.goal_response_timeout = 3.0
        client.backend = "docker-rclpy"
        client.available = True
        client.docker_container = "robodoge-rosbridge"
        calls = []
        call_order = []

        def fake_run_docker_python(script, *, timeout):
            calls.append({"script": script, "timeout": timeout})
            return dogzilla_lib_bridge.subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout='{"executed": true, "delivery": "Nav2 NavigateToPose", "goalAccepted": true, "goalCompleted": false, "goalStatus": "accepted", "goalId": "00112233445566778899aabbccddeeff"}\n',
                stderr="",
            )

        client._run_docker_python = fake_run_docker_python
        client._wait_for_goal_result_via_docker = lambda goal_id, *, timeout: (
            call_order.append(("result", goal_id, timeout))
            or {
                "executed": True,
                "delivery": "Nav2 NavigateToPose",
                "goalAccepted": True,
                "goalCompleted": True,
                "goalStatus": "succeeded",
                "goalId": goal_id,
            }
        )
        result = client.send_goal(
            frame="map", x=1.25, y=-0.5, yaw=0.2,
            wait_for_result=True, result_timeout=600,
            on_goal_accepted=lambda accepted: call_order.append(
                ("accepted", accepted["goalId"])
            ),
        )

        self.assertTrue(result["goalCompleted"])
        self.assertEqual(result["goalStatus"], "succeeded")
        self.assertEqual(calls[0]["timeout"], 30.0)
        self.assertNotIn('request["waitForResult"]', calls[0]["script"])
        self.assertEqual(
            call_order,
            [
                ("accepted", "00112233445566778899aabbccddeeff"),
                ("result", "00112233445566778899aabbccddeeff", 600),
            ],
        )

    def test_docker_nav2_goal_timeout_returns_structured_error(self):
        previous = dogzilla_lib_bridge.nav2_client_module.DEFAULT_NAV2_SEND_GOAL_DOCKER_ENABLED
        dogzilla_lib_bridge.nav2_client_module.DEFAULT_NAV2_SEND_GOAL_DOCKER_ENABLED = True
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge.nav2_client_module, "DEFAULT_NAV2_SEND_GOAL_DOCKER_ENABLED", previous))

        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.action_name = "navigate_to_pose"
        client.wait_timeout = 2.0
        client.goal_response_timeout = 3.0
        client.backend = "docker-rclpy"
        client.available = True
        client.docker_container = "robodoge-rosbridge"

        def fake_run_docker_python(script, *, timeout):
            raise dogzilla_lib_bridge.subprocess.TimeoutExpired(cmd=["docker"], timeout=timeout)

        client._run_docker_python = fake_run_docker_python
        result = client.send_goal(frame="map", x=1.25, y=-0.5, yaw=0.2)

        self.assertFalse(result["executed"])
        self.assertEqual(result["delivery"], "nav2-docker-timeout")
        self.assertIn("30.0s", result["error"])
        self.assertEqual(result["backend"], "docker-rclpy")

    def test_action_loop_calls_dogzilla_perform_mode(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()

        start = runtime.execute({"kind": "action.loop", "params": {"enabled": True, "trick": "dance"}})
        stop = runtime.execute({"kind": "action.loop", "params": {"enabled": False, "trick": "stop_dance"}})

        self.assertTrue(start["executed"])
        self.assertEqual(start["kind"], "action.loop")
        self.assertTrue(start["enabled"])
        self.assertFalse(stop["enabled"])
        self.assertEqual(runtime.robot.calls, [("perform", 1), ("perform", 0)])

    def test_action_once_stops_performance_mode_before_single_action(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()

        result = runtime.execute({"kind": "action.once", "params": {"actionId": 12, "trick": "sit"}})

        self.assertTrue(result["executed"])
        self.assertTrue(result["performanceStopped"])
        self.assertEqual(runtime.robot.calls, [("perform", 0), ("action", 12)])

    def test_manual_locomotion_sets_trot_before_forward_move(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()

        result = runtime.execute({
            "kind": "locomotion.relative",
            "params": {
                "x_step": 12,
                "y_step": 0,
                "turn_rate": 0,
                "gait": "trot",
                "pace": "normal",
            },
        })

        self.assertTrue(result["executed"])
        self.assertEqual(result["kind"], "locomotion.relative")
        self.assertEqual(runtime.robot.calls, [
            ("pace", "normal"),
            ("gait_type", "trot"),
            ("move", "x", 12.0),
            ("move", "y", 0.0),
            ("turn", 0.0),
        ])

    def test_manual_locomotion_does_not_reapply_unchanged_gait_mode(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        params = {
            "x_step": 12,
            "y_step": 0,
            "turn_rate": 0,
            "gait": "trot",
            "pace": "normal",
        }

        first = runtime.execute({"kind": "locomotion.relative", "params": params})
        second = runtime.execute({"kind": "locomotion.relative", "params": {**params, "x_step": 14}})

        self.assertTrue(first["executed"])
        self.assertTrue(second["executed"])
        self.assertEqual(runtime.robot.calls, [
            ("pace", "normal"),
            ("gait_type", "trot"),
            ("move", "x", 12.0),
            ("move", "y", 0.0),
            ("turn", 0.0),
            ("move", "x", 14.0),
            ("move", "y", 0.0),
            ("turn", 0.0),
        ])

    def test_locomotion_blocks_lateral_step_by_default(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()

        result = runtime.execute({
            "kind": "locomotion.relative",
            "params": {"x_step": 0, "y_step": 18, "turn_rate": 0, "gait": "trot", "pace": "slow"},
        })

        self.assertTrue(result["executed"])
        self.assertIn(("move", "y", 0.0), runtime.robot.calls)

    def test_gamepad_locomotion_caps_lateral_step_at_manual_limit(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()

        result = runtime.execute({
            "kind": "locomotion.relative",
            "params": {"x_step": 0, "y_step": -18, "turn_rate": 0, "gait": "trot", "pace": "slow", "source": "gamepad"},
        })

        self.assertTrue(result["executed"])
        self.assertIn(("move", "y", -1.0), runtime.robot.calls)

    def test_touch_locomotion_caps_lateral_step_at_manual_limit(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()

        result = runtime.execute({
            "kind": "locomotion.relative",
            "params": {"x_step": 0, "y_step": 18, "turn_rate": 0, "gait": "trot", "pace": "slow", "source": "touch"},
        })

        self.assertTrue(result["executed"])
        self.assertIn(("move", "y", 1.0), runtime.robot.calls)

    def test_nav2_cmd_vel_to_locomotion_preserves_forward_motion_with_stable_walk(self):
        params = dogzilla_lib_bridge.nav2_cmd_vel_to_locomotion({
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.2},
        })

        self.assertEqual(params["x_step"], 4.0)
        self.assertEqual(params["mapping"]["linearFullScale"], 0.26)
        self.assertEqual(params["mapping"]["maxXStep"], 8.0)
        self.assertEqual(params["y_step"], 0.0)
        self.assertEqual(params["gait"], "walk")
        self.assertEqual(params["pace"], "slow")
        self.assertGreater(params["turn_rate"], 0)
        self.assertLess(params["turn_rate"], 5)
        self.assertFalse(params["mapping"]["allowTrot"])
        self.assertEqual(params["source"], "nav2_cmd_vel")

        recovery = dogzilla_lib_bridge.nav2_cmd_vel_to_locomotion({
            "linear": {"x": -0.13, "y": 0.0},
            "angular": {"z": 0.0},
        })
        self.assertEqual(recovery["x_step"], -4.0)
        self.assertEqual(recovery["y_step"], 0.0)
        self.assertEqual(recovery["gait"], "walk")
        self.assertEqual(recovery["pace"], "slow")

    def test_nav2_approved_wood_floor_scale_ignores_stale_override(self):
        globals_ = dogzilla_lib_bridge.nav2_cmd_vel_to_locomotion.__globals__
        update_speed_config = globals_["update_speed_config"]

        config = update_speed_config({"linearFullScale": 0.15})
        params = dogzilla_lib_bridge.nav2_cmd_vel_to_locomotion({
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.0},
        })

        self.assertEqual(config["linearFullScale"], 0.26)
        self.assertEqual(params["x_step"], 4.0)

        env_name = "DOGZILLA_NAV2_GAIT_LINEAR_FULL_SCALE"
        previous = os.environ.get(env_name)
        try:
            os.environ[env_name] = "0.15"
            spec = importlib.util.spec_from_file_location(
                "nav2_gait_adapter_stale_env",
                BRIDGE_DIR / "nav2_gait_adapter.py",
            )
            isolated = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(isolated)
        finally:
            if previous is None:
                os.environ.pop(env_name, None)
            else:
                os.environ[env_name] = previous

        self.assertEqual(isolated.get_speed_config()["linearFullScale"], 0.26)

    def test_nav2_cmd_vel_to_locomotion_blocks_lateral_motion_by_default(self):
        params = dogzilla_lib_bridge.nav2_cmd_vel_to_locomotion({
            "linear": {"x": 0.0, "y": 0.06},
            "angular": {"z": 0.0},
        })

        self.assertEqual(params["x_step"], 0.0)
        self.assertEqual(params["y_step"], 0.0)
        self.assertEqual(params["gait"], "walk")
        self.assertEqual(params["pace"], "slow")

    def test_nav2_gait_safety_cannot_be_overridden(self):
        globals_ = dogzilla_lib_bridge.nav2_cmd_vel_to_locomotion.__globals__
        config = globals_["_SPEED_CONFIG"]
        previous = dict(config)
        self.addCleanup(lambda: config.update(previous))
        config.update({"maxXStep": 18, "maxYStep": 18, "allowTrot": True})

        params = dogzilla_lib_bridge.nav2_cmd_vel_to_locomotion({
            "linear": {"x": 0.26, "y": 0.2},
            "angular": {"z": 0.0},
        })

        self.assertEqual(params["x_step"], 8.0)
        self.assertEqual(params["y_step"], 0.0)
        self.assertEqual(params["gait"], "walk")
        self.assertEqual(params["pace"], "slow")

    def test_nav2_cmd_vel_to_locomotion_rejects_trot_override(self):
        globals_ = dogzilla_lib_bridge.nav2_cmd_vel_to_locomotion.__globals__
        previous = globals_["_SPEED_CONFIG"]["allowTrot"]
        globals_["_SPEED_CONFIG"]["allowTrot"] = True
        self.addCleanup(lambda: globals_["_SPEED_CONFIG"].__setitem__("allowTrot", previous))

        params = dogzilla_lib_bridge.nav2_cmd_vel_to_locomotion({
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.2},
        })

        self.assertEqual(params["gait"], "walk")
        self.assertEqual(params["pace"], "slow")
        self.assertFalse(params["mapping"]["allowTrot"])

    def test_nav2_cmd_vel_to_locomotion_limits_in_place_turn_when_nav2_requests_it(self):
        params = dogzilla_lib_bridge.nav2_cmd_vel_to_locomotion({
            "linear": {"x": 0.0, "y": 0.0},
            "angular": {"z": -1.0},
        })

        self.assertEqual(params["x_step"], 0.0)
        self.assertEqual(params["y_step"], 0.0)
        self.assertEqual(params["turn_rate"], -12.0)
        self.assertTrue(params["mapping"]["inPlaceTurnLimited"])
        self.assertEqual(params["gait"], "walk")

    def test_vendor_minimum_turn_is_duty_cycled_instead_of_amplified(self):
        pulse = dogzilla_lib_bridge.pulse_vendor_turn_rate
        phase = 0.0
        sign = 0
        outputs = []

        for _ in range(10):
            output, phase, sign = pulse(6.0, phase, sign)
            outputs.append(output)

        self.assertEqual(
            outputs,
            [30.0, 0.0, 0.0, 0.0, 0.0, 30.0, 0.0, 0.0, 0.0, 0.0],
        )

    def test_vendor_turn_pulse_damps_direction_reversal(self):
        pulse = dogzilla_lib_bridge.pulse_vendor_turn_rate
        output, phase, sign = pulse(6.0, 0.0, 0)
        self.assertEqual(output, 30.0)

        output, phase, sign = pulse(-6.0, phase, sign)
        self.assertEqual(output, 0.0)
        self.assertEqual(sign, -1)

    def test_nav2_gait_adapter_command_does_not_cancel_active_navigation(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.navigation_cancel = threading.Event()

        result = runtime.execute_nav2_cmd_vel({
            "receivedAt": time.time(),
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.2},
        })

        self.assertTrue(result["executed"])
        self.assertEqual(result["kind"], "nav2.cmd_vel.gait_adapter")
        self.assertFalse(runtime.navigation_cancel.is_set())
        self.assertEqual(runtime.robot.calls[:2], [("pace", "slow"), ("gait_type", "walk")])
        self.assertEqual(runtime.robot.calls[-3][0], "move")
        self.assertEqual(runtime.robot.calls[-3][1], "x")
        self.assertGreater(runtime.robot.calls[-3][2], 0)
        self.assertEqual(runtime.nav2_gait_adapter_count, 1)
        self.assertEqual(runtime.nav2_gait_nonzero_command_count, 1)

    def test_autonomous_mapping_forward_motion_uses_trot(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(
            dogzilla_lib_bridge.DogzillaRuntime
        )
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()

        with patch.object(
            dogzilla_lib_bridge,
            "get_autonomous_mapping_status",
            return_value={"active": True},
        ):
            result = runtime.execute_nav2_cmd_vel({
                "receivedAt": time.time(),
                "linear": {"x": 0.13, "y": 0.0},
                "angular": {"z": 0.0},
            })

        self.assertTrue(result["executed"])
        self.assertEqual(result["params"]["gait"], "trot")
        self.assertEqual(result["params"]["pace"], "normal")
        self.assertIn(("gait_type", "trot"), runtime.robot.calls)
        self.assertEqual(runtime.robot.calls[:2], [("pace", "normal"), ("gait_type", "trot")])
        self.assertEqual(runtime.robot.calls[-3][0], "move")
        self.assertEqual(runtime.robot.calls[-3][1], "x")
        self.assertGreater(runtime.robot.calls[-3][2], 0)
        self.assertEqual(runtime.nav2_gait_adapter_count, 1)
        self.assertEqual(runtime.nav2_gait_nonzero_command_count, 1)

    def test_nav2_gait_adapter_rejects_stale_nonzero_command(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.nav2_gait_adapter_count = 0
        runtime.nav2_gait_nonzero_command_count = 0

        result = runtime.execute_nav2_cmd_vel({
            "receivedAt": time.time() - dogzilla_lib_bridge.DEFAULT_NAV2_CMD_VEL_MAX_AGE_SEC - 1.0,
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.0},
        })

        self.assertFalse(result["executed"])
        self.assertEqual(result["delivery"], "nav2-gait-adapter-stale")
        self.assertTrue(result["stale"])
        self.assertTrue(result["safetyStop"]["executed"])
        self.assertEqual(
            runtime.robot.calls,
            [("move", "x", 0), ("move", "y", 0), ("turn", 0), ("stop",)],
        )
        self.assertEqual(runtime.nav2_gait_adapter_count, 1)
        self.assertEqual(runtime.nav2_gait_nonzero_command_count, 0)

    def test_nav2_cmd_vel_deadman_stops_latched_motion_after_silence(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.nav2_cmd_vel_blocked = False
        runtime.nav2_cmd_vel_blocked_reason = None
        runtime.nav2_gait_adapter_count = 0
        runtime.nav2_gait_nonzero_command_count = 0
        runtime._battery_motion_rejection = lambda *_args, **_kwargs: None
        runtime._start_nav2_cmd_vel_deadman(timeout_sec=0.05)
        self.addCleanup(runtime._stop_nav2_cmd_vel_deadman)

        result = runtime.execute_nav2_cmd_vel({
            "receivedAt": time.time(),
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.0},
        })

        self.assertTrue(result["executed"])
        deadline = time.monotonic() + 1.0
        while ("stop",) not in runtime.robot.calls and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertIn(("stop",), runtime.robot.calls)
        self.assertGreaterEqual(runtime.nav2_cmd_vel_deadman_stop_count, 1)

    def test_nav2_cmd_vel_rechecks_emergency_block_after_waiting_for_robot_lock(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.nav2_cmd_vel_blocked = False
        runtime.nav2_cmd_vel_blocked_reason = None
        runtime.nav2_gait_adapter_count = 0
        runtime.nav2_gait_nonzero_command_count = 0
        runtime._battery_motion_rejection = lambda *_args, **_kwargs: None
        first_check = threading.Event()
        original_is_blocked = runtime._nav2_cmd_vel_is_blocked

        def observed_is_blocked():
            first_check.set()
            return original_is_blocked()

        runtime._nav2_cmd_vel_is_blocked = observed_is_blocked
        result = {}
        runtime._lock.acquire()
        worker = threading.Thread(target=lambda: result.update(runtime.execute_nav2_cmd_vel({
            "receivedAt": time.time(),
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.0},
        })))
        worker.start()
        self.assertTrue(first_check.wait(1.0))

        runtime._block_nav2_cmd_vel("emergency_stop")
        runtime._lock.release()
        worker.join(1.0)

        self.assertFalse(worker.is_alive())
        self.assertFalse(result["executed"])
        self.assertEqual(result["blockedReason"], "emergency_stop")
        self.assertFalse(any(call[:2] == ("move", "x") and call[2] > 0 for call in runtime.robot.calls))

    def test_nav2_cmd_vel_partial_failure_retries_fail_safe_stop(self):
        class PartialFailureRobot(FakeActionRobot):
            def __init__(self):
                super().__init__()
                self.gait_failure_injected = False
                self.fail_safe_round = False

            def move(self, axis, value):
                self.calls.append(("move", axis, value))
                if axis == "y" and value == 0 and not self.gait_failure_injected:
                    self.gait_failure_injected = True
                    self.fail_safe_round = True
                    raise OSError("later gait operation failed")
                if self.fail_safe_round:
                    raise OSError("fail-safe zero failed")

            def turn(self, value):
                self.calls.append(("turn", value))
                if self.fail_safe_round:
                    raise OSError("fail-safe turn failed")

            def stop(self):
                self.calls.append(("stop",))
                if self.fail_safe_round:
                    self.fail_safe_round = False
                    raise OSError("first fail-safe stop failed")

        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = PartialFailureRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.nav2_cmd_vel_blocked = False
        runtime.nav2_cmd_vel_blocked_reason = None
        runtime.nav2_gait_adapter_count = 0
        runtime.nav2_gait_nonzero_command_count = 0
        runtime._battery_motion_rejection = lambda *_args, **_kwargs: None
        runtime._start_nav2_cmd_vel_deadman(timeout_sec=1.0)
        self.addCleanup(runtime._stop_nav2_cmd_vel_deadman)

        result = runtime.execute_nav2_cmd_vel({
            "receivedAt": time.time(),
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.0},
        })

        self.assertFalse(result["executed"])
        self.assertFalse(result["safetyStop"]["executed"])
        deadline = time.monotonic() + 1.0
        while runtime.nav2_cmd_vel_deadman_stop_count < 1 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertGreaterEqual(runtime.nav2_cmd_vel_deadman_stop_count, 1)
        self.assertTrue(runtime.nav2_cmd_vel_deadman_last_stop["result"]["executed"])

    def test_runtime_shutdown_blocks_motion_and_zeroes_before_stopping_deadman(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.nav2_cmd_vel_blocked = False
        runtime.nav2_cmd_vel_blocked_reason = None
        runtime._start_nav2_cmd_vel_deadman(timeout_sec=10.0)
        runtime._arm_nav2_cmd_vel_deadman()

        result = runtime.shutdown()

        self.assertTrue(result["executed"])
        self.assertTrue(runtime.nav2_cmd_vel_blocked)
        self.assertEqual(runtime.nav2_cmd_vel_blocked_reason, "bridge_shutdown")
        self.assertEqual(
            runtime.robot.calls,
            [("move", "x", 0), ("move", "y", 0), ("turn", 0), ("stop",)],
        )
        self.assertFalse(runtime._nav2_cmd_vel_deadman_thread.is_alive())

    def test_live_runtime_initialization_zeroes_robot_before_constructor_returns(self):
        robot = FakeActionRobot()
        original_client = dogzilla_lib_bridge.Nav2NavigateClient
        original_supervisor = dogzilla_lib_bridge.LidarAvoidanceSupervisor
        original_loader = dogzilla_lib_bridge.DogzillaRuntime._load_factory
        dogzilla_lib_bridge.Nav2NavigateClient = lambda _action: SimpleNamespace()
        dogzilla_lib_bridge.LidarAvoidanceSupervisor = lambda: SimpleNamespace()
        dogzilla_lib_bridge.DogzillaRuntime._load_factory = lambda _self: (
            lambda _serial_port=None: robot
        )
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "Nav2NavigateClient", original_client))
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "LidarAvoidanceSupervisor", original_supervisor))
        self.addCleanup(
            lambda: setattr(dogzilla_lib_bridge.DogzillaRuntime, "_load_factory", original_loader)
        )

        runtime = dogzilla_lib_bridge.DogzillaRuntime("/dev/test", dry_run=False)
        self.addCleanup(runtime._stop_nav2_cmd_vel_deadman)

        self.assertTrue(runtime.startup_stop["executed"])
        self.assertEqual(
            robot.calls,
            [("move", "x", 0), ("move", "y", 0), ("turn", 0), ("stop",)],
        )
        self.assertFalse(runtime._nav2_cmd_vel_is_blocked())

    def test_failed_startup_zero_keeps_global_motion_block_latched(self):
        class FailingRobot(FakeActionRobot):
            def move(self, axis, value):
                super().move(axis, value)
                raise OSError("serial write failed")

            def turn(self, value):
                super().turn(value)
                raise OSError("serial write failed")

            def stop(self):
                super().stop()
                raise OSError("serial write failed")

        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FailingRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.nav2_cmd_vel_blocked = False
        runtime.nav2_cmd_vel_blocked_reason = None
        runtime._start_nav2_cmd_vel_deadman(timeout_sec=10.0)
        self.addCleanup(runtime._stop_nav2_cmd_vel_deadman)

        result = runtime._initialize_nav2_motion_safe_state()

        self.assertFalse(result["executed"])
        self.assertTrue(runtime._nav2_cmd_vel_is_blocked())
        self.assertEqual(runtime._nav2_cmd_vel_block_reason(), "bridge_startup")

    def test_direct_bridge_shutdown_zeroes_runtime_before_stopping_server(self):
        events = []

        class Runtime:
            def shutdown(self):
                events.append("runtime-safe-stop")
                return {"executed": True}

        class Server:
            def shutdown(self):
                events.append("server-shutdown")

        result = dogzilla_lib_bridge.shutdown_direct_bridge(Runtime(), Server())

        self.assertTrue(result["executed"])
        self.assertEqual(events, ["runtime-safe-stop", "server-shutdown"])

    def test_nav2_gait_adapter_accepts_zero_without_timestamp(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.nav2_cmd_vel_blocked = False
        runtime.nav2_cmd_vel_blocked_reason = None
        runtime.nav2_gait_adapter_count = 0
        runtime.nav2_gait_nonzero_command_count = 0

        result = runtime.execute_nav2_cmd_vel({
            "linear": {"x": 0.0, "y": 0.0},
            "angular": {"z": 0.0},
        })

        self.assertTrue(result["executed"])
        self.assertEqual(result["delivery"], "DOGZILLALib nav2 gait adapter")
        self.assertEqual(runtime.nav2_gait_adapter_count, 1)
        self.assertEqual(runtime.nav2_gait_nonzero_command_count, 0)

    def test_noop_stop_also_stops_performance_mode(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()

        result = runtime.execute({"kind": "noop", "params": {"reason": "emergency_stop"}})

        self.assertTrue(result["executed"])
        self.assertTrue(result["performanceStopped"])
        self.assertTrue(result["nav2CmdVelBlocked"])
        self.assertTrue(runtime.navigation_cancel.is_set())
        self.assertEqual(runtime.robot.calls, [("perform", 0), ("stop",)])

    def test_emergency_stop_blocks_nav2_cmd_vel_and_goto_does_not_clear_it(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.navigation_cancel = threading.Event()
        runtime.nav2_client = FakeCancelableNav2Client()

        stop = runtime.execute({"kind": "noop", "params": {"reason": "emergency_stop"}})

        self.assertTrue(stop["executed"])
        self.assertTrue(runtime.navigation_cancel.is_set())
        self.assertTrue(runtime.nav2_cmd_vel_blocked)
        self.assertEqual(runtime.nav2_cmd_vel_blocked_reason, "emergency_stop")
        self.assertEqual(stop["nav2Cancel"]["goalsCanceling"], 1)

        blocked = runtime.execute_nav2_cmd_vel({
            "receivedAt": time.time(),
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.2},
        })

        self.assertFalse(blocked["executed"])
        self.assertEqual(blocked["delivery"], "nav2-gait-adapter-blocked")
        self.assertEqual(blocked["blockedReason"], "emergency_stop")
        self.assertEqual(runtime.robot.calls, [("perform", 0), ("stop",)])

        goto = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(x=0.0, y=0.0, yaw=0.0, waypoint="resume"),
        })

        self.assertFalse(goto["executed"])
        self.assertEqual(goto["delivery"], "rejected")
        self.assertEqual(goto["blockedReason"], "emergency_stop")
        self.assertTrue(runtime.nav2_cmd_vel_blocked)
        self.assertEqual(runtime.nav2_cmd_vel_blocked_reason, "emergency_stop")

        cleared = runtime.execute({"kind": "noop", "params": {"reason": "clear_emergency_stop"}})
        self.assertTrue(cleared["executed"])
        self.assertEqual(cleared["delivery"], "emergency-stop-cleared")
        self.assertFalse(runtime.nav2_cmd_vel_blocked)
        self.assertIsNone(runtime.nav2_cmd_vel_blocked_reason)

        resumed = runtime.execute_nav2_cmd_vel({
            "receivedAt": time.time(),
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.0},
        })

        self.assertTrue(resumed["executed"])

    def test_command_preempt_cannot_replace_emergency_stop_latch(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.navigation_cancel = threading.Event()
        runtime.nav2_client = FakeCancelableNav2Client()

        stop = runtime.execute({"kind": "noop", "params": {"reason": "emergency_stop"}})
        preempt = runtime.execute({"kind": "noop", "params": {"reason": "command_preempt"}})
        goto = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(x=0.0, y=0.0, yaw=0.0, waypoint="resume"),
        })

        self.assertTrue(stop["executed"])
        self.assertTrue(preempt["executed"])
        self.assertEqual(runtime._nav2_cmd_vel_block_reason(), "emergency_stop")
        self.assertFalse(goto["executed"])
        self.assertEqual(goto["blockedReason"], "emergency_stop")

        cleared = runtime.execute({"kind": "noop", "params": {"reason": "clear_emergency_stop"}})
        resumed = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(x=0.0, y=0.0, yaw=0.0, waypoint="resume"),
        })

        self.assertTrue(cleared["executed"])
        self.assertTrue(cleared["nav2CmdVelBlocked"])
        self.assertEqual(cleared["blockedReason"], "command_preempt")
        self.assertTrue(resumed["executed"])
        self.assertIsNone(runtime._nav2_cmd_vel_block_reason())

    def test_battery_block_cycle_cannot_replace_or_clear_emergency_stop_latch(self):
        runtime = battery_safety_runtime(9)
        runtime.navigation_cancel = threading.Event()

        stop = runtime.execute({"kind": "noop", "params": {"reason": "emergency_stop"}})
        low_battery = runtime._battery_safety_snapshot(refresh=True)
        runtime.robot.battery = 100
        runtime.battery_last_read_monotonic = 0
        recovered_battery = runtime._battery_safety_snapshot(refresh=True)

        self.assertTrue(stop["executed"])
        self.assertFalse(low_battery["motionAllowed"])
        self.assertTrue(recovered_battery["motionAllowed"])
        self.assertEqual(runtime._nav2_cmd_vel_block_reason(), "emergency_stop")

        cleared = runtime.execute({"kind": "noop", "params": {"reason": "clear_emergency_stop"}})
        self.assertTrue(cleared["executed"])
        self.assertIsNone(runtime._nav2_cmd_vel_block_reason())

    def test_shutdown_block_survives_other_latch_clears(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.nav2_cmd_vel_blocked = False
        runtime.nav2_cmd_vel_blocked_reason = None

        runtime._block_nav2_cmd_vel("bridge_shutdown")
        runtime._block_nav2_cmd_vel("emergency_stop")
        runtime._replace_nav2_cmd_vel_blocks(
            dogzilla_lib_bridge.NAV2_BATTERY_BLOCK_REASONS,
            "battery_cutoff",
        )
        runtime._block_nav2_cmd_vel("command_preempt")

        self.assertEqual(runtime._nav2_cmd_vel_block_reason(), "bridge_shutdown")
        self.assertTrue(runtime._clear_nav2_cmd_vel_block_if_reason("emergency_stop"))
        runtime._replace_nav2_cmd_vel_blocks(dogzilla_lib_bridge.NAV2_BATTERY_BLOCK_REASONS, None)
        self.assertTrue(runtime._clear_nav2_cmd_vel_block_if_reason("command_preempt"))
        self.assertEqual(runtime._nav2_cmd_vel_block_reason(), "bridge_shutdown")

    def test_startup_clear_reveals_battery_then_preempt_blocks(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.nav2_cmd_vel_blocked = False
        runtime.nav2_cmd_vel_blocked_reason = None

        runtime._block_nav2_cmd_vel("bridge_startup")
        runtime._replace_nav2_cmd_vel_blocks(
            dogzilla_lib_bridge.NAV2_BATTERY_BLOCK_REASONS,
            "battery_cutoff",
        )
        runtime._block_nav2_cmd_vel("command_preempt")

        self.assertEqual(runtime._nav2_cmd_vel_block_reason(), "bridge_startup")
        self.assertTrue(runtime._clear_nav2_cmd_vel_block_if_reason("bridge_startup"))
        self.assertEqual(runtime._nav2_cmd_vel_block_reason(), "battery_cutoff")
        runtime._replace_nav2_cmd_vel_blocks(dogzilla_lib_bridge.NAV2_BATTERY_BLOCK_REASONS, None)
        self.assertEqual(runtime._nav2_cmd_vel_block_reason(), "command_preempt")

    def test_emergency_stop_blocks_all_manual_motion_until_explicit_clear(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.navigation_cancel = threading.Event()
        runtime.nav2_client = FakeCancelableNav2Client()

        stop = runtime.execute({"kind": "noop", "params": {"reason": "emergency_stop"}})
        calls_after_stop = list(runtime.robot.calls)

        blocked_plans = [
            {"kind": "locomotion.relative", "params": {"x_step": 1}},
            {"kind": "action.once", "params": {"actionName": "shake"}},
            {"kind": "action.loop", "params": {"enabled": True}},
            {"kind": "pose.body", "params": {"height": 10}},
            {"kind": "stabilize.set", "params": {"enabled": True}},
        ]
        blocked = [runtime.execute(plan) for plan in blocked_plans]

        self.assertTrue(stop["executed"])
        self.assertTrue(all(result["executed"] is False for result in blocked))
        self.assertTrue(all(result["delivery"] == "motion-safety-blocked" for result in blocked))
        self.assertEqual(runtime.robot.calls, calls_after_stop)

        cleared = runtime.execute({
            "kind": "noop",
            "params": {"reason": "clear_emergency_stop"},
        })
        resumed = runtime.execute({
            "kind": "locomotion.relative",
            "params": {"x_step": 1},
        })

        self.assertTrue(cleared["executed"])
        self.assertTrue(resumed["executed"])

    def test_command_preempt_blocks_nav2_but_keeps_manual_motion_available(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.navigation_cancel = threading.Event()
        runtime.nav2_client = FakeCancelableNav2Client()

        preempt = runtime.execute({"kind": "noop", "params": {"reason": "command_preempt"}})
        manual = runtime.execute({
            "kind": "locomotion.relative",
            "params": {"x_step": 1},
        })

        self.assertTrue(preempt["executed"])
        self.assertEqual(runtime._nav2_cmd_vel_block_reason(), "command_preempt")
        self.assertTrue(manual["executed"])
        self.assertTrue(
            any(call[:2] == ("move", "x") and call[2] > 0 for call in runtime.robot.calls)
        )

    def test_manual_motion_rechecks_global_block_after_waiting_for_robot_lock(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.nav2_cmd_vel_blocked = False
        runtime.nav2_cmd_vel_blocked_reason = None
        runtime._battery_motion_rejection = lambda *_args, **_kwargs: None
        first_check = threading.Event()
        original_check = runtime._global_motion_block_rejection
        check_count = 0

        def observed_check(kind, params):
            nonlocal check_count
            check_count += 1
            if check_count == 1:
                first_check.set()
            return original_check(kind, params)

        runtime._global_motion_block_rejection = observed_check
        result = {}
        runtime._lock.acquire()
        worker = threading.Thread(
            target=lambda: result.update(runtime.execute({
                "kind": "locomotion.relative",
                "params": {"x_step": 1},
            }))
        )
        worker.start()
        self.assertTrue(first_check.wait(1.0))

        runtime._block_nav2_cmd_vel("emergency_stop")
        runtime._lock.release()
        worker.join(1.0)

        self.assertFalse(worker.is_alive())
        self.assertFalse(result["executed"])
        self.assertEqual(result["blockedReason"], "emergency_stop")
        self.assertFalse(
            any(call[:2] == ("move", "x") and call[2] > 0 for call in runtime.robot.calls)
        )

    def test_command_preempt_cancels_nav2_and_blocks_late_gait_adapter_motion(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.navigation_cancel = threading.Event()
        runtime.nav2_cmd_vel_blocked = False
        runtime.nav2_cmd_vel_blocked_reason = None
        runtime.nav2_client = FakeCancelableNav2Client()

        stop = runtime.execute({"kind": "noop", "params": {"reason": "command_preempt"}})

        self.assertTrue(stop["executed"])
        self.assertTrue(runtime.navigation_cancel.is_set())
        self.assertTrue(runtime.nav2_cmd_vel_blocked)
        self.assertEqual(runtime.nav2_cmd_vel_blocked_reason, "command_preempt")
        self.assertEqual(stop["nav2Cancel"]["goalsCanceling"], 1)
        self.assertEqual(runtime.nav2_client.cancel_calls, 1)

        motion = runtime.execute_nav2_cmd_vel({
            "receivedAt": time.time(),
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.2},
        })

        self.assertFalse(motion["executed"])
        self.assertEqual(motion["delivery"], "nav2-gait-adapter-blocked")
        self.assertEqual(motion["blockedReason"], "command_preempt")
        self.assertEqual(runtime.robot.calls, [("perform", 0), ("stop",)])

    def test_active_mapping_goal_clears_only_the_command_preempt_latch(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.nav2_cmd_vel_blocked = True
        runtime.nav2_cmd_vel_blocked_reason = "command_preempt"
        runtime._battery_motion_rejection = lambda *_args, **_kwargs: None
        original_mapping_status = dogzilla_lib_bridge.get_autonomous_mapping_status
        dogzilla_lib_bridge.get_autonomous_mapping_status = lambda: {"active": True}
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "get_autonomous_mapping_status", original_mapping_status))

        motion = runtime.execute_nav2_cmd_vel({
            "receivedAt": time.time(),
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.0},
        })

        self.assertTrue(motion["executed"])
        self.assertIsNone(runtime._nav2_cmd_vel_block_reason())

    def test_active_mapping_does_not_clear_emergency_stop(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.nav2_cmd_vel_blocked = True
        runtime.nav2_cmd_vel_blocked_reason = "emergency_stop"
        runtime._battery_motion_rejection = lambda *_args, **_kwargs: None
        original_mapping_status = dogzilla_lib_bridge.get_autonomous_mapping_status
        dogzilla_lib_bridge.get_autonomous_mapping_status = lambda: {"active": True}
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "get_autonomous_mapping_status", original_mapping_status))

        motion = runtime.execute_nav2_cmd_vel({
            "receivedAt": time.time(),
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.0},
        })

        self.assertFalse(motion["executed"])
        self.assertEqual(motion["blockedReason"], "emergency_stop")

    def test_command_preempt_blocks_cmd_vel_while_nav2_cancel_is_in_flight(self):
        cancel_started = threading.Event()
        release_cancel = threading.Event()

        class BlockingCancelClient(FakeCancelableNav2Client):
            def cancel_active_goal(self):
                self.cancel_calls += 1
                cancel_started.set()
                release_cancel.wait(1.0)
                return {"executed": True, "goalsCanceling": 1}

        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.navigation_cancel = threading.Event()
        runtime.nav2_cmd_vel_blocked = False
        runtime.nav2_cmd_vel_blocked_reason = None
        runtime.nav2_client = BlockingCancelClient()
        runtime._battery_motion_rejection = lambda *_args, **_kwargs: None
        preempt_result = {}
        worker = threading.Thread(target=lambda: preempt_result.update(runtime._execute_command_preempt()))
        worker.start()
        self.assertTrue(cancel_started.wait(1.0))

        motion = runtime.execute_nav2_cmd_vel({
            "receivedAt": time.time(),
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.0},
        })

        self.assertFalse(motion["executed"])
        self.assertEqual(motion["blockedReason"], "command_preempt")
        release_cancel.set()
        worker.join(1.0)
        self.assertFalse(worker.is_alive())
        self.assertTrue(preempt_result["executed"])
        self.assertTrue(runtime.nav2_cmd_vel_blocked)

    def test_goto_after_command_preempt_allows_nav2_goal_and_cmd_vel_motion(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.navigation_cancel = threading.Event()
        runtime.nav2_cmd_vel_blocked = False
        runtime.nav2_cmd_vel_blocked_reason = None
        runtime.nav2_client = FakeCancelableNav2Client()

        preempt = runtime.execute({"kind": "noop", "params": {"reason": "command_preempt"}})

        self.assertTrue(preempt["executed"])
        self.assertTrue(runtime.nav2_cmd_vel_blocked)
        self.assertEqual(runtime.nav2_cmd_vel_blocked_reason, "command_preempt")

        goto = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(x=0.0, y=0.0, yaw=0.0, waypoint="garage"),
        })

        self.assertTrue(goto["executed"])
        self.assertEqual(goto["waypoint"], "garage")
        self.assertFalse(runtime.nav2_cmd_vel_blocked)

    def test_nav_mode_defaults_to_navigate(self):
        self.assertEqual(dogzilla_lib_bridge.get_nav_mode(), "navigate")
        snapshot = dogzilla_lib_bridge.nav_mode_snapshot()
        self.assertEqual(snapshot["mode"], "navigate")
        self.assertIn("history", snapshot)

    def test_nav_mode_is_fixed_to_normal_navigation(self):
        old_run = dogzilla_lib_bridge._run
        dogzilla_lib_bridge._run = lambda *_args, **_kwargs: self.fail("normal nav mode must not call lifecycle shell commands")
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "_run", old_run))

        navigate = dogzilla_lib_bridge.set_nav_mode("navigate")
        self.assertTrue(navigate["ok"])
        self.assertFalse(navigate["changed"])
        self.assertFalse(navigate["navStandby"])

        for legacy_mode in ("idle", "localize", "sleep", "dance"):
            with self.subTest(mode=legacy_mode):
                result = dogzilla_lib_bridge.set_nav_mode(legacy_mode)
                self.assertFalse(result["ok"])
                self.assertEqual(result["mode"], "navigate")
                self.assertEqual(result["validModes"], ["navigate"])

        self.assertFalse(dogzilla_lib_bridge.sleep_status()["sleeping"])
        self.assertFalse(dogzilla_lib_bridge.sleep_pi()["ok"])
        self.assertTrue(dogzilla_lib_bridge.wake_pi()["ok"])
        self.assertEqual(dogzilla_lib_bridge.nav_mode_snapshot()["history"], [])

    def test_healthz_lite_includes_compact_feedback(self):
        # Ensure the expected compact-feedback keys are present in the handler.
        handler = dogzilla_lib_bridge.Handler
        self.assertTrue(callable(handler.do_GET))

    def test_nav2_gait_health_is_read_only_and_safety_blocks_are_not_edge_failures(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.nav2_cmd_vel_blocked_reason = "battery_cutoff"
        runtime._nav2_cmd_vel_is_blocked = lambda: True
        runtime._battery_safety_snapshot = lambda **_kwargs: self.fail("health edge must not poll battery")

        health = dogzilla_lib_bridge.nav2_gait_health_snapshot(runtime)

        self.assertTrue(health["ok"])
        self.assertEqual(health["endpoint"], "/nav2/cmd_vel")
        self.assertEqual(health["sourceTopic"], "/cmd_vel")
        self.assertTrue(health["runtimeAvailable"])
        self.assertTrue(health["blocked"])
        self.assertEqual(health["blockedReason"], "battery_cutoff")
        self.assertEqual(health["navMode"], "navigate")

    def test_autonomous_mapping_status_uses_active_marker_and_candidate_result(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            maps_dir = Path(temp_dir)
            proc_root = maps_dir / "proc"
            (proc_root / "123").mkdir(parents=True)
            (proc_root / "123" / "cmdline").write_bytes(b"/bin/bash\0/home/pi/robodoge/sidecars/dogzilla_navigation/autonomous_mapping_supervisor.sh\0")
            (maps_dir / "autonomous-mapping.active").write_text("123\n", encoding="utf-8")
            (maps_dir / "autonomous-mapping-status.json").write_text(
                json.dumps({"state": "navigating", "startedAt": 10, "updatedAt": 20}),
                encoding="utf-8",
            )
            (maps_dir / "autonomous-mapping-result.json").write_text(
                json.dumps({"state": "candidate-ready", "detail": "saved"}),
                encoding="utf-8",
            )
            (maps_dir / "robodoge_home_map.json").write_text(
                json.dumps({
                    "resumePose": {
                        "frame": "map",
                        "x": 1.25,
                        "y": -0.75,
                        "yaw": 0.4,
                        "capturedAt": "2026-07-12T12:00:00Z",
                    },
                }),
                encoding="utf-8",
            )
            candidate_dir = maps_dir / "candidates" / "candidate-existing"
            candidate_dir.mkdir(parents=True)
            candidate_metadata = candidate_dir / "candidate.json"
            candidate_metadata.write_text("{}", encoding="utf-8")
            os.utime(maps_dir / "robodoge_home_map.json", (100, 100))
            os.utime(candidate_metadata, (200, 200))
            (maps_dir / "autonomous-mapping-result.json").write_text(
                json.dumps({"state": "failed", "detail": "candidate=false no_verified_motion"}),
                encoding="utf-8",
            )

            status = dogzilla_lib_bridge.get_autonomous_mapping_status(maps_dir, proc_root)
            self.assertFalse(status["active"])
            self.assertTrue(status["candidateAvailable"])
            (maps_dir / "autonomous-mapping.ready").touch()
            status = dogzilla_lib_bridge.get_autonomous_mapping_status(maps_dir, proc_root)

            self.assertTrue(status["active"])
            self.assertTrue(status["candidateAvailable"])
            self.assertEqual(status["state"], "navigating")
            self.assertEqual(status["resumePose"]["x"], 1.25)

            self.assertTrue(dogzilla_lib_bridge.autonomous_mapping_marker_is_live(
                maps_dir / "autonomous-mapping.active", proc_root,
            ))
            (proc_root / "123" / "cmdline").write_bytes(b"python3\0unrelated.py\0")
            self.assertFalse(dogzilla_lib_bridge.autonomous_mapping_marker_is_live(
                maps_dir / "autonomous-mapping.active", proc_root,
            ))

    def test_background_goto_updates_existing_record_and_detects_no_motion(self):
        import io
        import socket

        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeNav2Client()
        runtime.nav2_gait_adapter_count = 0
        runtime.navigation_cancel = threading.Event()

        bridge_server = dogzilla_lib_bridge.BridgeServer(("127.0.0.1", 0), dogzilla_lib_bridge.Handler, runtime)
        self.addCleanup(bridge_server.server_close)

        class MockHandler(dogzilla_lib_bridge.Handler):
            def __init__(self, server):
                self.server = server

        command_id = "dogzilla-lib-0001"
        envelope = {"canonicalPlan": {"kind": "locomotion.goto", "params": {"frame": "map", "x": 1, "y": 0, "yaw": 0}}}
        bridge_server.recent_commands.appendleft({
            "commandId": command_id,
            "receivedAt": dogzilla_lib_bridge.utc_now(),
            "envelope": envelope,
            "canonicalPlan": envelope["canonicalPlan"],
            "result": {
                "executed": True,
                "delivery": "accepted",
                "goalId": runtime.nav2_client.goal_id,
                "goalStatus": "accepted",
            },
        })

        previous_window = dogzilla_lib_bridge.DEFAULT_NO_MOTION_WINDOW_SEC
        dogzilla_lib_bridge.DEFAULT_NO_MOTION_WINDOW_SEC = 0.2
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "DEFAULT_NO_MOTION_WINDOW_SEC", previous_window))

        dogzilla_lib_bridge.Handler._monitor_background_motion(
            MockHandler(bridge_server), command_id, envelope, envelope["canonicalPlan"], 0, time.monotonic()
        )

        matching = [r for r in bridge_server.recent_commands if r.get("commandId") == command_id]
        self.assertEqual(len(matching), 1)
        record = matching[0]
        self.assertIn("completedAt", record)
        self.assertTrue(record.get("background"))
        self.assertEqual(record["result"].get("motionStatus"), "no-command")
        self.assertEqual(record["result"].get("goalStatus"), "succeeded")
        self.assertEqual(record["result"].get("goalId"), runtime.nav2_client.goal_id)
        self.assertEqual(record["result"].get("delivery"), "accepted")


class FakeRobot:
    def read_Battery(self):
        return 87

    def read_Motor(self):
        return [1, 2, 3]


class FakeStateRobot:
    def read_Battery(self):
        return 87

    def read_roll(self):
        return 1

    def read_pitch(self):
        return 2

    def read_yaw(self):
        return 3

    def read_Motor(self):
        raise AssertionError("slow motor state should be opt-in")


class FakeZeroBatteryRobot:
    def read_Battery(self):
        return 0


class FakeActionRobot:
    def __init__(self, battery=100):
        self.calls = []
        self.battery = battery

    def read_Battery(self):
        return self.battery

    def gait_type(self, value):
        self.calls.append(("gait_type", value))

    def pace(self, value):
        self.calls.append(("pace", value))

    def action(self, value):
        self.calls.append(("action", value))

    def perform(self, value):
        self.calls.append(("perform", value))

    def stop(self):
        self.calls.append(("stop",))

    def move(self, axis, value):
        self.calls.append(("move", axis, value))

    def turn(self, value):
        self.calls.append(("turn", value))


class FakeBlockingBatteryRobot(FakeActionRobot):
    def __init__(self):
        super().__init__()
        self.ser = FakeSerial()
        self.read_started = threading.Event()
        self.read_active = False
        self.uart_overlap = False

    def read_Battery(self):
        self.read_active = True
        self.read_started.set()
        time.sleep(self.ser.timeout)
        self.read_active = False
        return self.battery

    def stop(self):
        self.uart_overlap = self.uart_overlap or self.read_active
        super().stop()


class FakeSerial:
    def __init__(self):
        self.timeout = 0.5


class FakeRestoreFailureSerial:
    def __init__(self):
        self._timeout = 0.5
        self._writes = 0

    @property
    def timeout(self):
        return self._timeout

    @timeout.setter
    def timeout(self, value):
        self._writes += 1
        if self._writes == 2:
            raise OSError("restore failed")
        self._timeout = value


def battery_safety_runtime(battery):
    runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
    runtime.import_error = None
    runtime.robot_error = None
    runtime.robot = FakeActionRobot(battery)
    runtime.dry_run = False
    runtime._lock = threading.Lock()
    runtime.battery_safety_enforced = True
    runtime.nav2_client = FakeNav2Client()
    runtime.nav2_cmd_vel_blocked = False
    runtime.nav2_cmd_vel_blocked_reason = None
    return runtime


class FakeNav2Client:
    goal_id = "00112233445566778899aabbccddeeff"

    def snapshot(self):
        return {
            "available": True,
            "waypointReady": True,
            "canSendGoal": True,
            "blockers": [],
            "odom": {"available": True, "fresh": True, "tfFresh": True},
            "lifecycle": {"active": True},
            "scan": {"available": True, "fresh": True},
        }

    def _scan_snapshot(self):
        return {
            "topic": "/scan_nav2",
            "publisherCount": 1,
            "subscriptionCount": 2,
            "available": True,
            "checkedAt": 123.0,
        }

    def send_goal(
        self,
        *,
        frame,
        x,
        y,
        yaw,
        wait_for_result=False,
        result_timeout=0,
        on_goal_accepted=None,
    ):
        self.goal = {
            "frame": frame,
            "x": x,
            "y": y,
            "yaw": yaw,
            "waitForResult": wait_for_result,
            "resultTimeoutSec": result_timeout,
        }
        accepted = {
            "executed": True,
            "delivery": "Nav2 NavigateToPose",
            "goalAccepted": True,
            "goalId": self.goal_id,
            **self.goal,
        }
        if on_goal_accepted is not None:
            on_goal_accepted(dict(accepted))
        return {
            **accepted,
            **({"goalCompleted": True, "goalStatus": "succeeded"} if wait_for_result else {}),
        }

    def wait_for_goal_result(self, goal_id, *, timeout):
        return {
            "executed": True,
            "delivery": "Nav2 NavigateToPose",
            "goalAccepted": True,
            "goalCompleted": True,
            "goalStatus": "succeeded",
            "goalId": goal_id,
        }


class FakeCancelableNav2Client(FakeNav2Client):
    def __init__(self):
        self.cancel_calls = 0

    def cancel_active_goal(self):
        self.cancel_calls += 1
        return {
            "executed": True,
            "delivery": "Nav2 NavigateToPose cancel",
            "goalsCanceling": 1,
        }


class FakeMissingOdomNav2Client:
    def snapshot(self):
        return {
            "available": True,
            "waypointReady": False,
            "blockers": ["No publishers on /odom"],
            "odom": {
                "topic": "/odom",
                "publisherCount": 0,
                "available": False,
                "error": "No publishers on /odom",
            },
        }

    def send_goal(self, *, frame, x, y, yaw, **_kwargs):
        self.goal = {"frame": frame, "x": x, "y": y, "yaw": yaw}
        return {
            "executed": True,
            "delivery": "Nav2 NavigateToPose",
            **self.goal,
        }


class FakeUnavailableNav2Client:
    def snapshot(self):
        return {
            "available": True,
            "waypointReady": True,
            "canSendGoal": True,
            "blockers": [],
            "odom": {"available": True, "fresh": True, "tfFresh": True},
            "lifecycle": {"active": True},
            "scan": {"available": True, "fresh": True},
        }

    def send_goal(self, *, frame, x, y, yaw, **_kwargs):
        return {
            "executed": False,
            "delivery": "nav2-unavailable",
            "error": "Nav2 NavigateToPose action server unavailable",
        }


class FakeLidarAvoidance:
    def __init__(self):
        self.requests = []

    def ensure_running(self, request):
        self.requests.append(request)
        return {
            "required": True,
            "ok": True,
            "mode": request.get("mode", "yahboom_laser"),
            "lidarTopic": request.get("lidarTopic", "/scan_nav2"),
        }

    def snapshot(self):
        return {"available": False}


class FakeFailedLidarAvoidance:
    def ensure_running(self, request):
        return {
            "required": True,
            "ok": False,
            "error": "avoidance node unavailable",
        }


class AlternatingNav2Client:
    def __init__(self):
        self.calls = 0

    def snapshot(self):
        self.calls += 1
        if self.calls == 1:
            return {
                "available": True,
                "waypointReady": True,
                "blockers": [],
                "odom": {
                    "topic": "/odom",
                    "publisherCount": 1,
                    "available": True,
                    "error": None,
                },
            }

        return {
            "available": False,
            "waypointReady": False,
            "blockers": ["Nav2 unavailable"],
            "odom": {
                "topic": "/odom",
                "publisherCount": 1,
                "available": True,
                "error": None,
            },
        }


if __name__ == "__main__":
    unittest.main()
