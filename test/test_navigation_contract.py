from __future__ import annotations

import importlib.util
import hashlib
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
BRIDGE_DIR = ROOT_DIR / "sidecars" / "dogzilla_lib_bridge"

spec = importlib.util.spec_from_file_location("dogzilla_lib_bridge_nav_contract", BRIDGE_DIR / "server.py")
dogzilla_lib_bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = dogzilla_lib_bridge
spec.loader.exec_module(dogzilla_lib_bridge)


class FakeNav2Client:
    def snapshot(self):
        return {
            "waypointReady": True,
            "canSendGoal": True,
            "backend": "docker-rclpy",
            "blockers": [],
            "odom": {"available": True, "topic": "/odom", "publisherCount": 1},
            "lifecycle": {"active": True},
            "scan": {"available": True},
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
        self.goal = {"frame": frame, "x": x, "y": y, "yaw": yaw}
        accepted = {
            "executed": True,
            "delivery": "Nav2 NavigateToPose",
            "goalAccepted": True,
            "goalId": "00112233445566778899aabbccddeeff",
            **self.goal,
        }
        if on_goal_accepted is not None:
            on_goal_accepted(dict(accepted))
        return {
            **accepted,
            **(
                {"goalCompleted": True, "goalStatus": "succeeded"}
                if wait_for_result
                else {}
            ),
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


class FakeUnavailableNav2Client:
    def snapshot(self):
        return {
            "waypointReady": False,
            "canSendGoal": False,
            "backend": "docker-rclpy",
            "blockers": ["Nav2 NavigateToPose action server unavailable"],
            "odom": {"available": True, "topic": "/odom", "publisherCount": 1},
            "lifecycle": {"active": True},
            "scan": {"available": True},
        }

    def send_goal(self, *, frame, x, y, yaw, **_kwargs):
        return {
            "executed": False,
            "delivery": "nav2-unavailable",
            "error": "Nav2 NavigateToPose action server unavailable",
        }


class FakeActionRobot:
    def __init__(self):
        self.calls = []

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


class NavigationContractTests(unittest.TestCase):
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
            "artifacts": {
                "yaml": {"path": str(yaml_path), "sha256": hashlib.sha256(yaml_path.read_bytes()).hexdigest()},
                "pgm": {"path": str(pgm_path), "sha256": hashlib.sha256(pgm_path.read_bytes()).hexdigest()},
            },
            "savedAt": "2026-06-08T00:00:00Z",
            "resolution": 0.05,
        }), encoding="utf-8")

        old_metadata = dogzilla_lib_bridge.DEFAULT_MAP_METADATA_FILE
        old_yaml = dogzilla_lib_bridge.DEFAULT_MAP_YAML_FILE
        old_localization = dogzilla_lib_bridge.read_localization_status
        dogzilla_lib_bridge.DEFAULT_MAP_METADATA_FILE = metadata_path
        dogzilla_lib_bridge.DEFAULT_MAP_YAML_FILE = yaml_path
        active_map = dogzilla_lib_bridge.read_active_map_metadata()
        self.map_id = active_map["id"]
        self.map_fingerprint = active_map["fingerprint"]
        dogzilla_lib_bridge.read_localization_status = lambda: {
            "trusted": True,
            "phase": "localized",
            "mode": "localization",
            "source": "test",
        }
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "DEFAULT_MAP_METADATA_FILE", old_metadata))
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "DEFAULT_MAP_YAML_FILE", old_yaml))
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "read_localization_status", old_localization))

    def map_goal_params(self, **params):
        return {
            "frame": "map",
            "mapId": self.map_id,
            "mapFingerprint": self.map_fingerprint,
            **params,
        }

    def test_docker_send_goal_enabled_by_default(self):
        self.assertTrue(dogzilla_lib_bridge.nav2_client_module.DEFAULT_NAV2_SEND_GOAL_DOCKER_ENABLED)

    def test_navigation_power_modes_are_removed(self):
        source = (BRIDGE_DIR / "server.py").read_text(encoding="utf-8")
        self.assertNotIn("DOGZILLA_DEFAULT_NAV_MODE", source)
        self.assertNotIn("DOGZILLA_NAV2_STANDBY_ENABLED", source)
        self.assertEqual(dogzilla_lib_bridge.get_nav_mode(), "navigate")

    def test_goto_rejected_when_nav2_unavailable(self):
        dogzilla_lib_bridge._NAV_MODE = "navigate"

        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeUnavailableNav2Client()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(x=1, y=-2, yaw=0, waypoint="test"),
        })

        self.assertFalse(result["executed"])
        self.assertEqual(result["delivery"], "rejected")

    def test_goto_accepted_returns_normalized_delivery(self):
        dogzilla_lib_bridge._NAV_MODE = "navigate"

        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeNav2Client()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(x=1, y=-2, yaw=0, waypoint="test"),
        })

        self.assertTrue(result["executed"])
        self.assertEqual(result["delivery"], "accepted")
        self.assertEqual(result.get("deliveryDetail"), "Nav2 NavigateToPose")

    def test_goto_sends_goal_exactly_once(self):
        dogzilla_lib_bridge._NAV_MODE = "navigate"

        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_gait_adapter_count = 0
        runtime.navigation_cancel = threading.Event()

        class CountingNav2Client(FakeNav2Client):
            send_goal_count = 0

            def send_goal(self, *, frame, x, y, yaw, **kwargs):
                type(self).send_goal_count += 1
                return super().send_goal(frame=frame, x=x, y=y, yaw=yaw, **kwargs)

        runtime.nav2_client = CountingNav2Client()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(x=1, y=-2, yaw=0, waypoint="test"),
        })

        self.assertTrue(result["executed"])
        self.assertEqual(CountingNav2Client.send_goal_count, 1)

    def test_motion_monitor_returns_no_command_without_nonzero_gait(self):
        dogzilla_lib_bridge._NAV_MODE = "navigate"

        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_gait_adapter_count = 0
        runtime.navigation_cancel = threading.Event()

        class StaticOdomNav2Client(FakeNav2Client):
            def _odom_snapshot(self):
                return {"lastMessageAt": 12345.0}

        runtime.nav2_client = StaticOdomNav2Client()

        previous_window = dogzilla_lib_bridge.DEFAULT_NO_MOTION_WINDOW_SEC
        dogzilla_lib_bridge.DEFAULT_NO_MOTION_WINDOW_SEC = 0.2
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "DEFAULT_NO_MOTION_WINDOW_SEC", previous_window))

        handler = dogzilla_lib_bridge.Handler.__new__(dogzilla_lib_bridge.Handler)
        handler.server = type("S", (), {"runtime": runtime})()

        motion_status = handler._monitor_navigation_motion(
            runtime, start_gait_count=0, started_at=time.monotonic(), window_sec=0.2
        )
        self.assertEqual(motion_status, "no-command")

    def test_motion_monitor_returns_cancelled(self):
        dogzilla_lib_bridge._NAV_MODE = "navigate"

        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_gait_adapter_count = 0
        runtime.navigation_cancel = threading.Event()
        runtime.navigation_cancel.set()

        class StaticOdomNav2Client(FakeNav2Client):
            def _odom_snapshot(self):
                return {"lastMessageAt": 12345.0}

        runtime.nav2_client = StaticOdomNav2Client()

        handler = dogzilla_lib_bridge.Handler.__new__(dogzilla_lib_bridge.Handler)
        handler.server = type("S", (), {"runtime": runtime})()

        motion_status = handler._monitor_navigation_motion(
            runtime, start_gait_count=0, started_at=time.monotonic(), window_sec=1.0
        )
        self.assertEqual(motion_status, "cancelled")

    def test_motion_monitor_does_not_call_force_refresh(self):
        dogzilla_lib_bridge._NAV_MODE = "navigate"

        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_gait_adapter_count = 0
        runtime.navigation_cancel = threading.Event()

        refresh_calls = []

        class NoForceNav2Client(FakeNav2Client):
            def _odom_snapshot(self):
                return {"lastMessageAt": 12345.0}

            def _refresh_status(self, force=False):
                refresh_calls.append(force)
                return None

        runtime.nav2_client = NoForceNav2Client()

        previous_window = dogzilla_lib_bridge.DEFAULT_NO_MOTION_WINDOW_SEC
        dogzilla_lib_bridge.DEFAULT_NO_MOTION_WINDOW_SEC = 0.2
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "DEFAULT_NO_MOTION_WINDOW_SEC", previous_window))

        handler = dogzilla_lib_bridge.Handler.__new__(dogzilla_lib_bridge.Handler)
        handler.server = type("S", (), {"runtime": runtime})()

        handler._monitor_navigation_motion(
            runtime, start_gait_count=0, started_at=time.monotonic(), window_sec=0.2
        )
        self.assertEqual(refresh_calls, [])

    def test_command_preempt_keeps_gate_latched_until_fresh_goto(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime._lock = threading.Lock()
        runtime.nav2_client = FakeCancelableNav2Client()
        runtime.nav2_cmd_vel_blocked = True
        runtime.nav2_cmd_vel_blocked_reason = "command_preempt"
        runtime.vendor_paths = []

        runtime._execute_command_preempt()
        self.assertTrue(runtime.nav2_cmd_vel_blocked)
        self.assertEqual(runtime.nav2_cmd_vel_blocked_reason, "command_preempt")

    def test_goto_keeps_preempt_gate_through_readiness_then_clears_after_acceptance(self):
        dogzilla_lib_bridge._NAV_MODE = "navigate"

        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeNav2Client()
        runtime.nav2_cmd_vel_blocked = True
        runtime.nav2_cmd_vel_blocked_reason = "command_preempt"
        observed_blocks = []
        original_snapshot = runtime.nav2_client.snapshot

        def snapshot(*args, **kwargs):
            observed_blocks.append(runtime.nav2_cmd_vel_blocked_reason)
            return original_snapshot(*args, **kwargs)

        runtime.nav2_client.snapshot = snapshot

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": self.map_goal_params(x=1, y=-2, yaw=0, waypoint="test"),
        })

        self.assertTrue(result["executed"])
        self.assertTrue(observed_blocks)
        self.assertTrue(all(reason == "command_preempt" for reason in observed_blocks))
        self.assertFalse(runtime.nav2_cmd_vel_blocked)
        self.assertIsNone(runtime.nav2_cmd_vel_blocked_reason)

    def test_waypoint_ready_false_when_cannot_send_goal(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.backend = "docker-rclpy"
        client.client_available = False
        client.docker_container = "robodoge-rosbridge"
        client.action_name = "navigate_to_pose"
        client.available = False
        client.odom_topic = "/odom"
        client.odom_available = True
        client.odom_publisher_count = 1
        client.odom_message_available = True
        client.odom_tf_available = True
        client.odom_frame_id = "odom"
        client.odom_child_frame_id = "base_link"
        client.odom_tf_target_frame = "base_link"
        client.odom_last_message_at = None
        client.odom_checked_at = None
        client.odom_error = None
        client.lifecycle_active = True
        client.lifecycle_status = None
        client.lifecycle_error = None
        client.scan_topic = "/scan"
        client.scan_publisher_count = 1
        client.scan_subscription_count = 2
        client.scan_available = True
        client.scan_checked_at = None
        client.scan_error = None
        client.server_available = False
        import time as _time
        client._last_status_check = _time.monotonic()
        client.wait_timeout = 12.0
        client.goal_response_timeout = 3.0
        client._node = None
        client._executor = None
        client._thread = None
        client._action_client = None
        client._navigate_to_pose_type = None
        client.import_error = None
        client.host_import_error = None
        client.docker_import_error = None
        client.server_error = None

        self.assertFalse(client.can_send_goal())
        snapshot = client.snapshot()
        self.assertFalse(snapshot["waypointReady"])
        self.assertIn("Nav2 goal backend cannot send goals", snapshot["blockers"][0])

    def test_can_send_goal_true_for_docker_when_enabled_and_available(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.backend = "docker-rclpy"
        client.client_available = True
        self.assertTrue(client.can_send_goal())

    def test_background_exception_recorded_as_failed(self):
        dogzilla_lib_bridge._NAV_MODE = "navigate"

        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_gait_adapter_count = 0
        runtime.navigation_cancel = threading.Event()

        class BoomNav2Client(FakeNav2Client):
            def _odom_snapshot(self):
                raise RuntimeError("boom")

        runtime.nav2_client = BoomNav2Client()

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
            "result": {"executed": True, "delivery": "accepted"},
        })

        previous_window = dogzilla_lib_bridge.DEFAULT_NO_MOTION_WINDOW_SEC
        dogzilla_lib_bridge.DEFAULT_NO_MOTION_WINDOW_SEC = 0.2
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "DEFAULT_NO_MOTION_WINDOW_SEC", previous_window))

        original_monitor = dogzilla_lib_bridge.Handler._monitor_navigation_motion

        def boom_monitor(self_inner, rt, *, start_gait_count, started_at, window_sec):
            raise RuntimeError("monitor crashed")

        dogzilla_lib_bridge.Handler._monitor_navigation_motion = boom_monitor
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge.Handler, "_monitor_navigation_motion", original_monitor))

        dogzilla_lib_bridge.Handler._monitor_background_motion(
            MockHandler(bridge_server), command_id, envelope, envelope["canonicalPlan"], 0, time.monotonic()
        )

        matching = [r for r in bridge_server.recent_commands if r.get("commandId") == command_id]
        self.assertEqual(len(matching), 1)
        record = matching[0]
        self.assertIn("completedAt", record)
        self.assertEqual(record.get("motionStatus"), "failed")
        self.assertIn("monitorError", record["result"])

    def test_background_monitor_registers_goal_result_before_observing_motion(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_gait_adapter_count = 0
        runtime.navigation_cancel = threading.Event()
        call_order = []

        class OrderedNav2Client(FakeNav2Client):
            def wait_for_goal_result(self, goal_id, *, timeout):
                call_order.append("result")
                return super().wait_for_goal_result(goal_id, timeout=timeout)

        runtime.nav2_client = OrderedNav2Client()
        bridge_server = dogzilla_lib_bridge.BridgeServer(("127.0.0.1", 0), dogzilla_lib_bridge.Handler, runtime)
        self.addCleanup(bridge_server.server_close)

        class MockHandler(dogzilla_lib_bridge.Handler):
            def __init__(self, server):
                self.server = server

            def _monitor_navigation_motion(self, *_args, **_kwargs):
                call_order.append("motion")
                return "no-command"

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
                "goalId": "00112233445566778899aabbccddeeff",
            },
        })

        MockHandler(bridge_server)._monitor_background_motion(
            command_id,
            envelope,
            envelope["canonicalPlan"],
            0,
            time.monotonic(),
        )

        self.assertEqual(call_order, ["result", "motion"])

    def test_motion_monitor_does_not_treat_odom_heartbeat_as_motion(self):
        dogzilla_lib_bridge._NAV_MODE = "navigate"

        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_gait_adapter_count = 0
        runtime.navigation_cancel = threading.Event()

        class ChangingOdomClient(FakeNav2Client):
            ts_values = [100.0, 200.0, 300.0]
            call_idx = 0

            def _odom_snapshot(self):
                val = type(self).ts_values[min(type(self).call_idx, len(type(self).ts_values) - 1)]
                type(self).call_idx += 1
                return {"lastMessageAt": val}

        runtime.nav2_client = ChangingOdomClient()

        handler = dogzilla_lib_bridge.Handler.__new__(dogzilla_lib_bridge.Handler)
        handler.server = type("S", (), {"runtime": runtime})()

        motion_status = handler._monitor_navigation_motion(
            runtime, start_gait_count=0, started_at=time.monotonic(), window_sec=0.2
        )
        self.assertEqual(motion_status, "no-command")

    def test_motion_monitor_reports_nonzero_gait_command_activity(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.navigation_cancel = threading.Event()
        runtime.nav2_gait_nonzero_command_count = 1

        handler = dogzilla_lib_bridge.Handler.__new__(dogzilla_lib_bridge.Handler)
        handler.server = type("S", (), {"runtime": runtime})()

        motion_status = handler._monitor_navigation_motion(
            runtime, start_gait_count=0, started_at=time.monotonic(), window_sec=1.0
        )
        self.assertEqual(motion_status, "commanding")


if __name__ == "__main__":
    unittest.main()
