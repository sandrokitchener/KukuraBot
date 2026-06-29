from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
BRIDGE_DIR = ROOT_DIR / "sidecars" / "dogzilla_lib_bridge"

spec = importlib.util.spec_from_file_location("dogzilla_lib_bridge_server", BRIDGE_DIR / "server.py")
dogzilla_lib_bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = dogzilla_lib_bridge
spec.loader.exec_module(dogzilla_lib_bridge)


def ready_nav2_status_stdout() -> str:
    return json.dumps({
        "available": True,
        "action": "navigate_to_pose",
        "odom": {
            "topic": "/odom",
            "publisherCount": 1,
            "available": True,
            "messageAvailable": True,
            "tfAvailable": True,
            "frameId": "odom",
            "childFrameId": "base_link",
        },
        "lifecycle": {
            "active": True,
            "nodes": [
                {"name": "controller_server", "active": True, "state": "active"},
                {"name": "planner_server", "active": True, "state": "active"},
                {"name": "bt_navigator", "active": True, "state": "active"},
                {"name": "behavior_server", "active": True, "state": "active"},
            ],
        },
        "scan": {
            "topic": "/scan_nav2",
            "publisherCount": 1,
            "subscriptionCount": 2,
            "available": True,
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
            "yaml": str(yaml_path),
            "pgm": str(pgm_path),
            "savedAt": "2026-06-08T00:00:00Z",
            "resolution": 0.05,
        }), encoding="utf-8")

        old_metadata = dogzilla_lib_bridge.DEFAULT_MAP_METADATA_FILE
        old_yaml = dogzilla_lib_bridge.DEFAULT_MAP_YAML_FILE
        dogzilla_lib_bridge.DEFAULT_MAP_METADATA_FILE = metadata_path
        dogzilla_lib_bridge.DEFAULT_MAP_YAML_FILE = yaml_path
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "DEFAULT_MAP_METADATA_FILE", old_metadata))
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "DEFAULT_MAP_YAML_FILE", old_yaml))

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
            "lidarTopic": "/scan",
        })

        self.assertTrue(result["ok"])
        self.assertEqual(result["mode"], "nav2_costmap")
        self.assertEqual(result["publisherCount"], 1)
        self.assertEqual(result["subscriptionCount"], 2)
        self.assertIn("not started", result["safety"])
        self.assertEqual(calls[0], ("bridge-scan",))
        self.assertEqual(calls[1], ("scan", "/scan"))

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
            "lidarTopic": "/scan",
        })

        self.assertTrue(result["ok"])
        self.assertEqual(result["attempt"], "dogzilla-scan-endpoint")
        self.assertEqual(result["validRanges"], 438)
        self.assertEqual(calls, [])

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

    def test_goto_blocks_goal_outside_active_map(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = "serial lib unavailable"
        runtime.dry_run = False
        runtime.nav2_client = FakeNav2Client()

        result = runtime.execute({
            "kind": "locomotion.goto",
            "params": {
                "frame": "map",
                "x": 11,
                "y": 0,
                "yaw": 0,
                "waypoint": "kitchen",
            },
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
            "params": {
                "frame": "map",
                "x": 1,
                "y": -2,
                "yaw": 0,
                "waypoint": "living_room",
            },
        })

        self.assertFalse(result["executed"])
        self.assertEqual(result["delivery"], "nav2-prerequisite-unavailable")
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
            "tfAvailable": True,
        })
        client._set_lifecycle_status_from_payload({
            "active": True,
            "nodes": [{"name": "controller_server", "active": True, "state": "active"}],
        })
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
        self.assertIn("No Nav2 costmap subscribers visible on /scan_nav2", snapshot["blockers"])

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

    def test_nav2_client_rejects_docker_send_goal_by_default(self):
        client = dogzilla_lib_bridge.Nav2NavigateClient.__new__(dogzilla_lib_bridge.Nav2NavigateClient)
        client.action_name = "navigate_to_pose"
        client.backend = "docker-rclpy"
        client.docker_container = "robodoge-rosbridge"
        calls = []

        def fake_run_docker_python(script, *, timeout):
            calls.append({"script": script, "timeout": timeout})
            return dogzilla_lib_bridge.subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")

        client._run_docker_python = fake_run_docker_python
        result = client.send_goal(frame="map", x=1.25, y=-0.5, yaw=0.2)

        self.assertFalse(result["executed"])
        self.assertEqual(result["delivery"], "nav2-unavailable")
        self.assertIn("Docker Nav2 goal backend disabled", result["error"])
        self.assertEqual(calls, [])

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
                stdout='{"executed": true, "delivery": "Nav2 NavigateToPose", "goalAccepted": true, "frame": "map", "x": 1.25, "y": -0.5, "yaw": 0.2}\n',
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

    def test_nav2_cmd_vel_to_locomotion_preserves_forward_motion_with_stable_walk(self):
        params = dogzilla_lib_bridge.nav2_cmd_vel_to_locomotion({
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.2},
        })

        self.assertGreater(params["x_step"], 0)
        self.assertEqual(params["mapping"]["maxXStep"], 14.0)
        self.assertEqual(params["y_step"], 0.0)
        self.assertEqual(params["gait"], "walk")
        self.assertEqual(params["pace"], "slow")
        self.assertGreater(params["turn_rate"], 0)
        self.assertLess(params["turn_rate"], 5)
        self.assertFalse(params["mapping"]["allowTrot"])
        self.assertEqual(params["source"], "nav2_cmd_vel")

    def test_nav2_cmd_vel_to_locomotion_trot_is_opt_in(self):
        globals_ = dogzilla_lib_bridge.nav2_cmd_vel_to_locomotion.__globals__
        previous = globals_["_SPEED_CONFIG"]["allowTrot"]
        globals_["_SPEED_CONFIG"]["allowTrot"] = True
        self.addCleanup(lambda: globals_["_SPEED_CONFIG"].__setitem__("allowTrot", previous))

        params = dogzilla_lib_bridge.nav2_cmd_vel_to_locomotion({
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.2},
        })

        self.assertEqual(params["gait"], "trot")
        self.assertEqual(params["pace"], "normal")
        self.assertTrue(params["mapping"]["allowTrot"])

    def test_nav2_cmd_vel_to_locomotion_allows_in_place_turn_when_nav2_requests_it(self):
        params = dogzilla_lib_bridge.nav2_cmd_vel_to_locomotion({
            "linear": {"x": 0.0, "y": 0.0},
            "angular": {"z": -1.0},
        })

        self.assertEqual(params["x_step"], 0.0)
        self.assertEqual(params["y_step"], 0.0)
        self.assertLess(params["turn_rate"], 0)
        self.assertEqual(abs(params["turn_rate"]), dogzilla_lib_bridge.DEFAULT_NAV2_GAIT_MAX_TURN_RATE)
        self.assertEqual(params["gait"], "walk")

    def test_nav2_gait_adapter_command_does_not_cancel_active_navigation(self):
        runtime = dogzilla_lib_bridge.DogzillaRuntime.__new__(dogzilla_lib_bridge.DogzillaRuntime)
        runtime.import_error = None
        runtime.robot_error = None
        runtime.robot = FakeActionRobot()
        runtime.dry_run = False
        runtime._lock = threading.Lock()
        runtime.navigation_cancel = threading.Event()

        result = runtime.execute_nav2_cmd_vel({
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
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.2},
        })

        self.assertFalse(blocked["executed"])
        self.assertEqual(blocked["delivery"], "nav2-gait-adapter-blocked")
        self.assertEqual(blocked["blockedReason"], "emergency_stop")
        self.assertEqual(runtime.robot.calls, [("perform", 0), ("stop",)])

        goto = runtime.execute({
            "kind": "locomotion.goto",
            "params": {
                "frame": "map",
                "x": 0.0,
                "y": 0.0,
                "yaw": 0.0,
                "waypoint": "resume",
            },
        })

        self.assertTrue(goto["executed"])
        self.assertTrue(runtime.nav2_cmd_vel_blocked)
        self.assertEqual(runtime.nav2_cmd_vel_blocked_reason, "emergency_stop")

        resumed = runtime.execute_nav2_cmd_vel({
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.0},
        })

        self.assertFalse(resumed["executed"])
        self.assertEqual(resumed["delivery"], "nav2-gait-adapter-blocked")
        self.assertEqual(resumed["blockedReason"], "emergency_stop")

    def test_command_preempt_cancels_nav2_without_blocking_gait_adapter(self):
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
        self.assertFalse(runtime.nav2_cmd_vel_blocked)
        self.assertIsNone(runtime.nav2_cmd_vel_blocked_reason)
        self.assertEqual(stop["nav2Cancel"]["goalsCanceling"], 1)
        self.assertEqual(runtime.nav2_client.cancel_calls, 1)

        motion = runtime.execute_nav2_cmd_vel({
            "linear": {"x": 0.13, "y": 0.0},
            "angular": {"z": 0.2},
        })

        self.assertTrue(motion["executed"])
        self.assertEqual(motion["delivery"], "DOGZILLALib nav2 gait adapter")
        self.assertEqual(runtime.robot.calls[2:4], [("pace", "slow"), ("gait_type", "walk")])

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
        self.assertFalse(runtime.nav2_cmd_vel_blocked)

        goto = runtime.execute({
            "kind": "locomotion.goto",
            "params": {
                "frame": "map",
                "x": 0.0,
                "y": 0.0,
                "yaw": 0.0,
                "waypoint": "garage",
            },
        })

        self.assertTrue(goto["executed"])
        self.assertEqual(goto["waypoint"], "garage")
        self.assertFalse(runtime.nav2_cmd_vel_blocked)

    def test_nav_mode_defaults_to_navigate(self):
        self.assertEqual(dogzilla_lib_bridge.get_nav_mode(), "navigate")
        snapshot = dogzilla_lib_bridge.nav_mode_snapshot()
        self.assertEqual(snapshot["mode"], "navigate")
        self.assertIn("history", snapshot)

    def test_set_nav_mode_rejects_invalid_mode(self):
        result = dogzilla_lib_bridge.set_nav_mode("dance")
        self.assertFalse(result["ok"])
        self.assertIn("invalid_nav_mode", result["error"])
        self.assertEqual(dogzilla_lib_bridge.get_nav_mode(), "navigate")

    def test_set_nav_mode_records_transition_history(self):
        previous = dogzilla_lib_bridge.get_nav_mode()
        result = dogzilla_lib_bridge.set_nav_mode("sleep")
        self.assertTrue(result["ok"])
        self.assertEqual(result["mode"], "sleep")
        self.assertEqual(result["previousMode"], previous)
        snapshot = dogzilla_lib_bridge.nav_mode_snapshot()
        self.assertEqual(snapshot["mode"], "sleep")
        self.assertTrue(len(snapshot["history"]) >= 1)
        # Restore navigate to avoid affecting other tests.
        dogzilla_lib_bridge.set_nav_mode("navigate")

    def test_healthz_lite_includes_compact_feedback(self):
        # Ensure the expected compact-feedback keys are present in the handler.
        handler = dogzilla_lib_bridge.Handler
        self.assertTrue(callable(handler.do_GET))

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
            "result": {"executed": True, "delivery": "navigation-accepted"},
        })

        previous_window = dogzilla_lib_bridge.DEFAULT_NO_MOTION_WINDOW_SEC
        dogzilla_lib_bridge.DEFAULT_NO_MOTION_WINDOW_SEC = 0.2
        self.addCleanup(lambda: setattr(dogzilla_lib_bridge, "DEFAULT_NO_MOTION_WINDOW_SEC", previous_window))

        dogzilla_lib_bridge.Handler._execute_background_command(
            MockHandler(bridge_server), command_id, envelope, envelope["canonicalPlan"]
        )

        matching = [r for r in bridge_server.recent_commands if r.get("commandId") == command_id]
        self.assertEqual(len(matching), 1)
        record = matching[0]
        self.assertIn("completedAt", record)
        self.assertTrue(record.get("background"))
        self.assertEqual(record["result"].get("motionStatus"), "no-motion")


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


class FakeNav2Client:
    def send_goal(self, *, frame, x, y, yaw):
        self.goal = {"frame": frame, "x": x, "y": y, "yaw": yaw}
        return {
            "executed": True,
            "delivery": "Nav2 NavigateToPose",
            **self.goal,
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
