from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT_DIR = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT_DIR / "sidecars" / "dogzilla_navigation" / "nav2_readiness_logic.py"
spec = importlib.util.spec_from_file_location("nav2_readiness_logic", SCRIPT_PATH)
nav2_readiness_logic = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = nav2_readiness_logic
spec.loader.exec_module(nav2_readiness_logic)


class Nav2ReadinessLogicTests(unittest.TestCase):
    def test_humble_anonymous_endpoint_requires_one_endpoint_and_live_named_node(self):
        anonymous = SimpleNamespace(
            node_name="_NODE_NAME_UNKNOWN_",
            node_namespace="_NODE_NAMESPACE_UNKNOWN_",
        )
        required = "/dogzilla_cmd_vel_gait_adapter"
        live_nodes = (("dogzilla_cmd_vel_gait_adapter", "/"),)

        self.assertTrue(
            nav2_readiness_logic.single_anonymous_endpoint_matches_live_node(
                (anonymous,), live_nodes, required
            )
        )
        self.assertFalse(
            nav2_readiness_logic.single_anonymous_endpoint_matches_live_node(
                (anonymous,), (), required
            )
        )
        self.assertFalse(
            nav2_readiness_logic.single_anonymous_endpoint_matches_live_node(
                (anonymous, anonymous), live_nodes, required
            )
        )

    @staticmethod
    def _write_process(
        proc_root: Path,
        pid: int,
        *,
        pgid: int,
        start_ticks: int,
        token: str,
        state: str = "S",
    ) -> None:
        process_dir = proc_root / str(pid)
        process_dir.mkdir(parents=True, exist_ok=True)
        fields = [state, "1", str(pgid)] + ["0"] * 16 + [str(start_ticks)]
        (process_dir / "stat").write_text(
            f"{pid} (nav process) {' '.join(fields)}\n", encoding="utf-8"
        )
        (process_dir / "environ").write_bytes(
            f"DOGZILLA_NAV2_OWNER_TOKEN={token}\0".encode()
        )

    def _owner_fixture(self, *, mode: str = "normal"):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        proc_root = root / "proc"
        proc_root.mkdir()
        boot_id_path = proc_root / "sys" / "kernel" / "random" / "boot_id"
        boot_id_path.parent.mkdir(parents=True)
        boot_id = "11111111-2222-3333-4444-555555555555"
        boot_id_path.write_text(boot_id, encoding="utf-8")
        token = "0123456789abcdef0123456789abcdef"
        owner_pid = 100
        launch_pid = 200
        self._write_process(
            proc_root, owner_pid, pgid=50, start_ticks=1000, token=token
        )
        pgid = ""
        pgid_start_ticks = ""
        if mode == "normal":
            pgid = str(launch_pid)
            pgid_start_ticks = "2000"
            self._write_process(
                proc_root,
                launch_pid,
                pgid=launch_pid,
                start_ticks=2000,
                token=token,
            )
        owner_file = root / "navigation-runtime.owner"
        owner_file.write_text(
            "\n".join(
                (
                    "version=2",
                    f"mode={mode}",
                    f"token={token}",
                    f"boot_id={boot_id}",
                    f"pid={owner_pid}",
                    "pid_start_ticks=1000",
                    f"pgid={pgid}",
                    f"pgid_start_ticks={pgid_start_ticks}",
                    "",
                )
            ),
            encoding="utf-8",
        )
        return temporary, owner_file, proc_root, boot_id_path, launch_pid

    def test_startup_requires_two_continuous_ready_seconds(self):
        gate = nav2_readiness_logic.ReadinessHysteresis(
            started_at=0.0,
            startup_timeout_sec=120.0,
            unhealthy_grace_sec=20.0,
            stable_ready_sec=2.0,
        )

        self.assertEqual(gate.update(1.0, expected_ready=True), "waiting")
        self.assertEqual(gate.update(2.9, expected_ready=True), "waiting")
        self.assertEqual(gate.update(3.0, expected_ready=True), "ready")

    def test_persistent_degradation_fails_only_after_full_grace(self):
        gate = nav2_readiness_logic.ReadinessHysteresis(0.0, 120.0, 20.0, 2.0, ready=True)

        self.assertEqual(gate.update(10.0, expected_ready=False), "degraded")
        self.assertEqual(gate.update(29.9, expected_ready=False), "degrading")
        self.assertEqual(gate.update(30.0, expected_ready=False), "unhealthy")

    def test_short_good_blip_does_not_reset_degradation(self):
        gate = nav2_readiness_logic.ReadinessHysteresis(0.0, 120.0, 20.0, 2.0, ready=True)

        self.assertEqual(gate.update(10.0, expected_ready=False), "degraded")
        self.assertEqual(gate.update(25.0, expected_ready=True), "recovering")
        self.assertEqual(gate.update(26.0, expected_ready=False), "degrading")
        self.assertEqual(gate.update(30.0, expected_ready=False), "unhealthy")

    def test_two_stable_seconds_clear_degradation(self):
        gate = nav2_readiness_logic.ReadinessHysteresis(0.0, 120.0, 20.0, 2.0, ready=True)

        self.assertEqual(gate.update(10.0, expected_ready=False), "degraded")
        self.assertEqual(gate.update(20.0, expected_ready=True), "recovering")
        self.assertEqual(gate.update(22.0, expected_ready=True), "recovered")
        self.assertIsNone(gate.unhealthy_since)

    def test_namespaced_collision_monitor_satisfies_scan_safety(self):
        self.assertTrue(
            nav2_readiness_logic.node_names_present(
                [SimpleNamespace(node_name="collision_monitor", node_namespace="/robot/nav")],
                nav2_readiness_logic.REQUIRED_SAFETY_SCAN_CONSUMERS,
            )
        )
        self.assertFalse(
            nav2_readiness_logic.node_names_present(
                [SimpleNamespace(node_name="custom_costmap", node_namespace="/robot/nav")],
                nav2_readiness_logic.REQUIRED_SAFETY_SCAN_CONSUMERS,
            )
        )

    def test_cmd_vel_publisher_edge_allows_only_root_collision_monitor(self):
        collision_monitor = [
            SimpleNamespace(node_name="collision_monitor", node_namespace="/")
        ]
        self.assertTrue(
            nav2_readiness_logic.node_identities_exactly(
                collision_monitor,
                nav2_readiness_logic.PERMITTED_CMD_VEL_PUBLISHERS,
            )
        )

        bypass = collision_monitor + [
            SimpleNamespace(node_name="controller_server", node_namespace="/")
        ]
        self.assertFalse(
            nav2_readiness_logic.node_identities_exactly(
                bypass,
                nav2_readiness_logic.PERMITTED_CMD_VEL_PUBLISHERS,
            )
        )
        self.assertFalse(
            nav2_readiness_logic.node_identities_exactly(
                [SimpleNamespace(node_name="collision_monitor", node_namespace="/shadow")],
                nav2_readiness_logic.PERMITTED_CMD_VEL_PUBLISHERS,
            )
        )
        self.assertFalse(
            nav2_readiness_logic.node_identities_exactly(
                collision_monitor + [SimpleNamespace(node_name="", node_namespace="/")],
                nav2_readiness_logic.PERMITTED_CMD_VEL_PUBLISHERS,
            )
        )
        self.assertTrue(
            nav2_readiness_logic.node_identities_exactly(
                collision_monitor + collision_monitor,
                nav2_readiness_logic.PERMITTED_CMD_VEL_PUBLISHERS,
            )
        )

    def test_mapping_cmd_vel_consumers_allow_only_adapter_and_frontier_observer(self):
        mapping_consumers = [
            SimpleNamespace(
                node_name="dogzilla_cmd_vel_gait_adapter", node_namespace="/"
            ),
            SimpleNamespace(node_name="robodoge_frontier_explorer", node_namespace="/"),
        ]
        self.assertTrue(
            nav2_readiness_logic.node_identities_exactly(
                mapping_consumers,
                nav2_readiness_logic.PERMITTED_MAPPING_CMD_VEL_CONSUMERS,
            )
        )
        self.assertFalse(
            nav2_readiness_logic.node_identities_exactly(
                mapping_consumers
                + [SimpleNamespace(node_name="rogue_cmd_vel_listener", node_namespace="/")],
                nav2_readiness_logic.PERMITTED_MAPPING_CMD_VEL_CONSUMERS,
            )
        )

    def test_velocity_chain_rejects_missing_or_extra_publishers(self):
        controller_and_behavior = [
            SimpleNamespace(node_name="controller_server", node_namespace="/"),
            SimpleNamespace(node_name="behavior_server", node_namespace="/"),
        ]
        self.assertTrue(
            nav2_readiness_logic.node_identities_exactly(
                controller_and_behavior,
                nav2_readiness_logic.REQUIRED_CMD_VEL_NAV_PUBLISHERS,
            )
        )
        self.assertTrue(
            nav2_readiness_logic.node_identities_exactly(
                controller_and_behavior + [controller_and_behavior[1]] * 4,
                nav2_readiness_logic.REQUIRED_CMD_VEL_NAV_PUBLISHERS,
            )
        )
        self.assertFalse(
            nav2_readiness_logic.node_identities_exactly(
                controller_and_behavior[:1],
                nav2_readiness_logic.REQUIRED_CMD_VEL_NAV_PUBLISHERS,
            )
        )
        self.assertFalse(
            nav2_readiness_logic.node_identities_exactly(
                controller_and_behavior
                + [SimpleNamespace(node_name="rogue", node_namespace="/")],
                nav2_readiness_logic.REQUIRED_CMD_VEL_NAV_PUBLISHERS,
            )
        )
        self.assertTrue(
            nav2_readiness_logic.node_identities_exactly(
                [SimpleNamespace(node_name="velocity_smoother", node_namespace="/")],
                nav2_readiness_logic.PERMITTED_CMD_VEL_RAW_PUBLISHERS,
            )
        )
        for endpoint, required in (
            (
                SimpleNamespace(node_name="velocity_smoother", node_namespace="/"),
                nav2_readiness_logic.REQUIRED_CMD_VEL_NAV_CONSUMERS,
            ),
            (
                SimpleNamespace(node_name="collision_monitor", node_namespace="/"),
                nav2_readiness_logic.REQUIRED_CMD_VEL_RAW_CONSUMERS,
            ),
            (
                SimpleNamespace(
                    node_name="dogzilla_cmd_vel_gait_adapter", node_namespace="/"
                ),
                nav2_readiness_logic.REQUIRED_CMD_VEL_CONSUMERS,
            ),
        ):
            self.assertTrue(
                nav2_readiness_logic.node_identities_exactly([endpoint], required)
            )
            self.assertTrue(
                nav2_readiness_logic.node_identities_exactly(
                    [endpoint, endpoint], required
                )
            )

    def test_owner_generation_rejects_wrong_mode_reused_pid_and_missing_token(self):
        temporary, owner_file, proc_root, boot_id_path, launch_pid = self._owner_fixture()
        self.addCleanup(temporary.cleanup)

        self.assertTrue(
            nav2_readiness_logic.owner_generation_is_valid(
                owner_file,
                "normal",
                launch_pid=launch_pid,
                proc_root=proc_root,
                boot_id_path=boot_id_path,
            )
        )
        self.assertFalse(
            nav2_readiness_logic.owner_generation_is_valid(
                owner_file,
                "mapping",
                launch_pid=launch_pid,
                proc_root=proc_root,
                boot_id_path=boot_id_path,
            )
        )

    def test_owner_generation_accepts_tokenless_ros_child_but_requires_owner_generation(self):
        temporary, owner_file, proc_root, boot_id_path, launch_pid = self._owner_fixture()
        self.addCleanup(temporary.cleanup)

        self._write_process(
            proc_root,
            300,
            pgid=launch_pid,
            start_ticks=3000,
            token="",
        )
        self.assertTrue(
            nav2_readiness_logic.owner_generation_is_valid(
                owner_file,
                "normal",
                launch_pid=launch_pid,
                proc_root=proc_root,
                boot_id_path=boot_id_path,
            )
        )

        owner_text = owner_file.read_text(encoding="utf-8")
        owner_file.write_text(
            owner_text.replace(
                "boot_id=11111111-2222-3333-4444-555555555555",
                "boot_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            ),
            encoding="utf-8",
        )
        self.assertFalse(
            nav2_readiness_logic.owner_generation_is_valid(
                owner_file,
                "normal",
                launch_pid=launch_pid,
                proc_root=proc_root,
                boot_id_path=boot_id_path,
            )
        )
        owner_file.write_text(owner_text, encoding="utf-8")

        owner_file.write_text(owner_text.replace("pid_start_ticks=1000", "pid_start_ticks=9999"), encoding="utf-8")
        self.assertFalse(
            nav2_readiness_logic.owner_generation_is_valid(
                owner_file,
                "normal",
                launch_pid=launch_pid,
                proc_root=proc_root,
                boot_id_path=boot_id_path,
            )
        )
        owner_file.write_text(owner_text, encoding="utf-8")

        owner_file.write_text(owner_text.replace("pgid_start_ticks=2000", "pgid_start_ticks=9999"), encoding="utf-8")
        self.assertFalse(
            nav2_readiness_logic.owner_generation_is_valid(
                owner_file,
                "normal",
                launch_pid=launch_pid,
                proc_root=proc_root,
                boot_id_path=boot_id_path,
            )
        )
        owner_file.write_text(owner_text, encoding="utf-8")

        self._write_process(
            proc_root,
            launch_pid,
            pgid=launch_pid,
            start_ticks=2000,
            token="ffffffffffffffffffffffffffffffff",
        )
        self.assertFalse(
            nav2_readiness_logic.owner_generation_is_valid(
                owner_file,
                "normal",
                launch_pid=launch_pid,
                proc_root=proc_root,
                boot_id_path=boot_id_path,
            )
        )

        stat_path = proc_root / str(launch_pid) / "stat"
        stat_path.write_text(
            stat_path.read_text(encoding="utf-8").replace(" 2000\n", " 9999\n"),
            encoding="utf-8",
        )
        self.assertFalse(
            nav2_readiness_logic.owner_generation_is_valid(
                owner_file,
                "normal",
                launch_pid=launch_pid,
                proc_root=proc_root,
                boot_id_path=boot_id_path,
            )
        )

        self._write_process(
            proc_root,
            launch_pid,
            pgid=launch_pid,
            start_ticks=2000,
            token="ffffffffffffffffffffffffffffffff",
        )
        self.assertFalse(
            nav2_readiness_logic.owner_generation_is_valid(
                owner_file,
                "normal",
                launch_pid=launch_pid,
                proc_root=proc_root,
                boot_id_path=boot_id_path,
            )
        )

    def test_mapping_owner_requires_live_matching_generation_without_a_launch_pid(self):
        temporary, owner_file, proc_root, boot_id_path, _ = self._owner_fixture(
            mode="mapping"
        )
        self.addCleanup(temporary.cleanup)

        self.assertTrue(
            nav2_readiness_logic.owner_generation_is_valid(
                owner_file,
                "mapping",
                expected_token="0123456789abcdef0123456789abcdef",
                launch_pid=0,
                proc_root=proc_root,
                boot_id_path=boot_id_path,
            )
        )
        self.assertFalse(
            nav2_readiness_logic.owner_generation_is_valid(
                owner_file,
                "mapping",
                expected_token="ffffffffffffffffffffffffffffffff",
                launch_pid=0,
                proc_root=proc_root,
                boot_id_path=boot_id_path,
            )
        )
        self.assertFalse(
            nav2_readiness_logic.owner_generation_is_valid(
                owner_file,
                "normal",
                launch_pid=0,
                proc_root=proc_root,
                boot_id_path=boot_id_path,
            )
        )

if __name__ == "__main__":
    unittest.main()
