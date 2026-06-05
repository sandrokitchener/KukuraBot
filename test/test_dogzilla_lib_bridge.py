from __future__ import annotations

import importlib.util
import sys
import threading
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
BRIDGE_DIR = ROOT_DIR / "sidecars" / "dogzilla_lib_bridge"

spec = importlib.util.spec_from_file_location("dogzilla_lib_bridge_server", BRIDGE_DIR / "server.py")
dogzilla_lib_bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = dogzilla_lib_bridge
spec.loader.exec_module(dogzilla_lib_bridge)


class DogzillaLibBridgeTests(unittest.TestCase):
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

    def test_goto_uses_nav2_without_dogzilla_serial_robot(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeNav2Client()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": {
                "frame": "map",
                "x": 1,
                "y": -2,
                "yaw": 7,
                "waypoint": "living_room",
                "arrivalToleranceMeters": 0.25,
            },
        })

        self.assertTrue(result["executed"])
        self.assertEqual(result["delivery"], "Nav2 NavigateToPose")
        self.assertEqual(result["kind"], "locomotion.goto")
        self.assertEqual(result["waypoint"], "living_room")
        self.assertTrue(result["waypointSafe"])
        self.assertAlmostEqual(runtime.nav2_client.goal["yaw"], 7 - 6.283185307179586)

    def test_goto_invokes_required_lidar_avoidance_before_nav2(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeNav2Client()
        runtime.lidar_avoidance = FakeLidarAvoidance()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": {
                "frame": "map",
                "x": 1,
                "y": -2,
                "yaw": 0.2,
                "waypoint": "living_room",
                "obstacleAvoidance": {
                    "required": True,
                    "mode": "yahboom_laser",
                    "lidarTopic": "/scan",
                },
            },
        })

        self.assertTrue(result["executed"])
        self.assertEqual(result["lidarAvoidance"]["mode"], "yahboom_laser")
        self.assertEqual(runtime.lidar_avoidance.requests[0]["lidarTopic"], "/scan")
        self.assertEqual(runtime.nav2_client.goal["frame"], "map")

    def test_goto_blocks_nav2_when_required_lidar_avoidance_fails(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeNav2Client()
        runtime.lidar_avoidance = FakeFailedLidarAvoidance()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": {
                "frame": "map",
                "x": 1,
                "y": -2,
                "yaw": 0.2,
                "waypoint": "living_room",
                "obstacleAvoidance": {"required": True},
            },
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
        self.assertEqual(result["delivery"], "Nav2 NavigateToPose")
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
            "params": {
                "frame": "map",
                "x": 1,
                "y": 2,
                "yaw": 0,
                "waypoint": "living_room",
            },
        })

        self.assertFalse(result["executed"])
        self.assertEqual(result["delivery"], "nav2-unavailable")
        self.assertEqual(result["error"], "Nav2 NavigateToPose action server unavailable")

    def test_goto_falls_back_to_map_pose_navigation_when_nav2_server_missing(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime.nav2_client = FakeUnavailableNav2Client()
        runtime.map_navigation = FakeMapNavigation()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": {
                "frame": "map",
                "x": 1,
                "y": 2,
                "yaw": 0,
                "waypoint": "living_room",
            },
        })

        self.assertTrue(result["executed"])
        self.assertEqual(result["delivery"], "DOGZILLALib map-pose navigation")
        self.assertEqual(result["nav2"]["delivery"], "nav2-unavailable")
        self.assertEqual(runtime.map_navigation.calls[0]["x"], 1)

    def test_nav2_client_uses_docker_backend_when_host_rclpy_is_missing(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.action_name = "navigate_to_pose"
        client.wait_timeout = 2.0
        client.goal_response_timeout = 3.0
        client.host_import_error = "No module named 'rclpy'"
        client.import_error = "No module named 'rclpy'"
        client.docker_import_error = None
        client.backend = "host-rclpy"
        client.available = False
        client.docker_container = "robodoge-lidar-bridge"
        calls = []
        shell_calls = []

        def fake_run_docker_python(script, *, timeout):
            calls.append({"script": script, "timeout": timeout})
            return dogzilla_lib_bridge.subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout="ok\n",
                stderr="",
            )

        def fake_run_docker_shell(command, *, timeout):
            shell_calls.append({"command": command, "timeout": timeout})
            return dogzilla_lib_bridge.subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout="/navigate_to_pose\n",
                stderr="",
            )

        client._run_docker_python = fake_run_docker_python
        client._run_docker_shell = fake_run_docker_shell
        client._try_enable_docker_backend()

        self.assertTrue(client.available)
        self.assertTrue(client.client_available)
        self.assertTrue(client.server_available)
        self.assertEqual(client.backend, "docker-rclpy")
        self.assertIsNone(client.import_error)
        self.assertEqual(calls[0]["timeout"], 6)
        self.assertIn("nav2_msgs.action", calls[0]["script"])
        self.assertIn("ros2 action list", shell_calls[0]["command"])

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
        client.docker_container = "robodoge-lidar-bridge"
        calls = []
        shell_calls = []

        def fake_run_docker_python(script, *, timeout):
            calls.append({"script": script, "timeout": timeout})
            return dogzilla_lib_bridge.subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout="ok\n",
                stderr="",
            )

        def fake_run_docker_shell(command, *, timeout):
            shell_calls.append({"command": command, "timeout": timeout})
            return dogzilla_lib_bridge.subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout="",
                stderr="",
            )

        client._run_docker_python = fake_run_docker_python
        client._run_docker_shell = fake_run_docker_shell
        client._try_enable_docker_backend()

        self.assertFalse(client.available)
        self.assertTrue(client.client_available)
        self.assertFalse(client.server_available)
        self.assertEqual(client.backend, "docker-rclpy")
        self.assertIn("action server is not running", client.import_error)
        self.assertIn("ros2 action list", shell_calls[0]["command"])
        snapshot = client.snapshot()
        self.assertFalse(snapshot["available"])
        self.assertTrue(snapshot["clientAvailable"])
        self.assertFalse(snapshot["serverAvailable"])

    def test_nav2_client_retries_docker_backend_after_container_boots(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.action_name = "navigate_to_pose"
        client.wait_timeout = 2.0
        client.goal_response_timeout = 3.0
        client.host_import_error = "No module named 'rclpy'"
        client.import_error = "No module named 'rclpy'; docker:No such container: robodoge-lidar-bridge"
        client.docker_import_error = "No such container: robodoge-lidar-bridge"
        client.server_error = None
        client.client_available = False
        client.server_available = False
        client._last_status_check = 0.0
        client.backend = "host-rclpy"
        client.available = False
        client.docker_container = "robodoge-lidar-bridge"
        calls = []

        def fake_run_docker_python(script, *, timeout):
            calls.append({"script": script, "timeout": timeout})
            return dogzilla_lib_bridge.subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout="ok\n",
                stderr="",
            )

        def fake_run_docker_shell(command, *, timeout):
            return dogzilla_lib_bridge.subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout="/navigate_to_pose\n",
                stderr="",
            )

        client._run_docker_python = fake_run_docker_python
        client._run_docker_shell = fake_run_docker_shell

        snapshot = client.snapshot()

        self.assertTrue(snapshot["available"])
        self.assertTrue(snapshot["clientAvailable"])
        self.assertTrue(snapshot["serverAvailable"])
        self.assertEqual(snapshot["backend"], "docker-rclpy")
        self.assertIsNone(snapshot["dockerImportError"])
        self.assertIsNone(snapshot["importError"])
        self.assertEqual(calls[0]["timeout"], 6)

    def test_nav2_client_sends_goal_through_docker_backend(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.action_name = "navigate_to_pose"
        client.wait_timeout = 2.0
        client.goal_response_timeout = 3.0
        client.backend = "docker-rclpy"
        client.available = True
        client.docker_container = "robodoge-lidar-bridge"
        calls = []

        def fake_run_docker_python(script, *, timeout):
            calls.append({"script": script, "timeout": timeout})
            return dogzilla_lib_bridge.subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout='{"executed": true, "delivery": "Nav2 NavigateToPose", "goalAccepted": true, "frame": "map", "x": 1.25, "y": -0.5, "yaw": 0.2}\n',
                stderr="",
            )

        client._run_docker_python = fake_run_docker_python
        result = client.send_goal(frame="map", x=1.25, y=-0.5, yaw=0.2)

        self.assertTrue(result["executed"])
        self.assertEqual(result["delivery"], "Nav2 NavigateToPose")
        self.assertEqual(result["backend"], "docker-rclpy")
        self.assertEqual(result["container"], "robodoge-lidar-bridge")
        self.assertEqual(calls[0]["timeout"], 8.0)
        self.assertIn("dogzilla_direct_nav2_docker_client", calls[0]["script"])
        self.assertIn('\\"x\\": 1.25', calls[0]["script"])

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
        self.assertEqual(runtime.robot.calls, [("perform", 0), ("stop",)])


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
    def __init__(self):
        self.calls = []

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


class FakeNav2Client:
    def send_goal(self, *, frame, x, y, yaw):
        self.goal = {"frame": frame, "x": x, "y": y, "yaw": yaw}
        return {
            "executed": True,
            "delivery": "Nav2 NavigateToPose",
            **self.goal,
        }


class FakeUnavailableNav2Client:
    def send_goal(self, *, frame, x, y, yaw):
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
            "lidarTopic": request.get("lidarTopic", "/scan"),
        }


class FakeFailedLidarAvoidance:
    def ensure_running(self, request):
        return {
            "required": True,
            "ok": False,
            "error": "avoidance node unavailable",
        }


class FakeMapNavigation:
    def __init__(self):
        self.calls = []

    def goto(self, robot, *, frame, x, y, yaw, params):
        self.calls.append({"frame": frame, "x": x, "y": y, "yaw": yaw, "params": params})
        return {
            "executed": True,
            "delivery": "DOGZILLALib map-pose navigation",
            "kind": "locomotion.goto",
            "waypoint": params.get("waypoint"),
            "waypointSafe": frame == "map",
        }


if __name__ == "__main__":
    unittest.main()
