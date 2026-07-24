"""Deterministic readiness hysteresis for the Pi-owned Nav2 supervisor."""

from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import Path


REQUIRED_SAFETY_SCAN_CONSUMERS = frozenset({"collision_monitor"})
PERMITTED_CMD_VEL_PUBLISHERS = frozenset({"/collision_monitor"})
REQUIRED_CMD_VEL_NAV_PUBLISHERS = frozenset(
    {"/controller_server", "/behavior_server"}
)
PERMITTED_MAPPING_CMD_VEL_NAV_PUBLISHERS = frozenset(
    {"/robodoge_frontier_explorer"}
)
REQUIRED_CMD_VEL_NAV_CONSUMERS = frozenset({"/velocity_smoother"})
PERMITTED_CMD_VEL_RAW_PUBLISHERS = frozenset({"/velocity_smoother"})
REQUIRED_CMD_VEL_RAW_CONSUMERS = frozenset({"/collision_monitor"})
REQUIRED_CMD_VEL_CONSUMERS = frozenset({"/dogzilla_cmd_vel_gait_adapter"})
PERMITTED_MAPPING_CMD_VEL_CONSUMERS = frozenset(
    {"/dogzilla_cmd_vel_gait_adapter", "/robodoge_frontier_explorer"}
)

_OWNER_TOKEN_PATTERN = re.compile(r"^[0-9a-fA-F]{32}$")
_UNKNOWN_NODE_NAMES = frozenset({"", "_NODE_NAME_UNKNOWN_"})


def _endpoint_node_identity(endpoint: object) -> str:
    node_name = str(getattr(endpoint, "node_name", "") or "").strip("/")
    if node_name in _UNKNOWN_NODE_NAMES:
        return ""
    namespace = str(getattr(endpoint, "node_namespace", "/") or "/").strip("/")
    prefix = f"/{namespace}" if namespace else ""
    return f"{prefix}/{node_name}"


def endpoint_node_identities(endpoints: Iterable[object]) -> frozenset[str]:
    """Return canonical fully-qualified ROS node identities for graph endpoints."""

    return frozenset(
        identity
        for identity in (_endpoint_node_identity(endpoint) for endpoint in endpoints)
        if identity
    )


def node_names_present(
    endpoints: Iterable[object], required_names: frozenset[str]
) -> bool:
    present = {
        str(getattr(endpoint, "node_name", "") or "").strip("/")
        for endpoint in endpoints
    }
    return required_names.issubset(present)


def node_identities_exactly(
    endpoints: Iterable[object], permitted_names: frozenset[str]
) -> bool:
    """Require the exact node identities while allowing a node multiple endpoints."""

    identities = tuple(_endpoint_node_identity(endpoint) for endpoint in endpoints)
    return (
        bool(identities)
        and all(identities)
        and frozenset(identities) == permitted_names
    )


def single_anonymous_endpoint_matches_live_node(
    endpoints: Iterable[object],
    live_nodes: Iterable[tuple[str, str]],
    required_identity: str,
) -> bool:
    """Corroborate Humble's anonymous endpoint bug with a live named node.

    Fast DDS can retain an endpoint GID while replacing its node identity with
    ``_NODE_*_UNKNOWN_``. Accept that narrow case only when there is exactly one
    anonymous endpoint and the required named node is independently live.
    """

    endpoint_list = tuple(endpoints)
    if len(endpoint_list) != 1 or _endpoint_node_identity(endpoint_list[0]):
        return False
    live_identities = set()
    for node_name, node_namespace in live_nodes:
        name = str(node_name or "").strip("/")
        namespace = str(node_namespace or "/").strip("/")
        if not name or name in _UNKNOWN_NODE_NAMES:
            continue
        prefix = f"/{namespace}" if namespace else ""
        live_identities.add(f"{prefix}/{name}")
    return required_identity in live_identities


def _read_owner_record(owner_file: Path) -> dict[str, str] | None:
    values: dict[str, str] = {}
    try:
        lines = owner_file.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        key, separator, value = line.partition("=")
        if not separator or not key or key in values:
            return None
        values[key] = value
    return values


def _read_process_identity(proc_root: Path, pid: int) -> tuple[str, int, int] | None:
    try:
        stat = (proc_root / str(pid) / "stat").read_text(encoding="utf-8")
        fields = stat.rsplit(") ", 1)[1].split()
        if len(fields) < 20:
            return None
        return fields[0], int(fields[2]), int(fields[19])
    except (IndexError, OSError, ValueError):
        return None


def _process_has_owner_token(proc_root: Path, pid: int, token: str) -> bool:
    expected = f"DOGZILLA_NAV2_OWNER_TOKEN={token}".encode()
    try:
        environment = (proc_root / str(pid) / "environ").read_bytes()
    except OSError:
        return False
    return expected in environment.split(b"\0")


def owner_generation_is_valid(
    owner_file: str | Path,
    expected_mode: str,
    *,
    expected_token: str = "",
    launch_pid: int = 0,
    proc_root: str | Path = "/proc",
    boot_id_path: str | Path = "/proc/sys/kernel/random/boot_id",
) -> bool:
    """Validate the live process generation recorded by the Nav2 owner."""

    owner_file = Path(owner_file)
    proc_root = Path(proc_root)
    record = _read_owner_record(owner_file)
    if record is None or expected_mode not in {"normal", "mapping"}:
        return False

    token = record.get("token", "")
    try:
        current_boot_id = Path(boot_id_path).read_text(encoding="utf-8").strip()
        owner_pid = int(record.get("pid", ""))
        owner_start_ticks = int(record.get("pid_start_ticks", ""))
    except (OSError, TypeError, ValueError):
        return False
    if (
        record.get("version") != "2"
        or record.get("mode") != expected_mode
        or not _OWNER_TOKEN_PATTERN.fullmatch(token)
        or (expected_token and token != expected_token)
        or record.get("boot_id") != current_boot_id
        or owner_pid <= 0
        or owner_start_ticks <= 0
    ):
        return False

    owner_identity = _read_process_identity(proc_root, owner_pid)
    if (
        owner_identity is None
        or owner_identity[0] == "Z"
        or owner_identity[2] != owner_start_ticks
    ):
        return False

    pgid_text = record.get("pgid", "")
    pgid_start_text = record.get("pgid_start_ticks", "")
    if bool(pgid_text) != bool(pgid_start_text) or (expected_mode == "normal" and not pgid_text):
        return False
    if not pgid_text:
        return (
            launch_pid in {0, owner_pid}
            and _process_has_owner_token(proc_root, owner_pid, token)
        )

    try:
        pgid = int(pgid_text)
        pgid_start_ticks = int(pgid_start_text)
    except ValueError:
        return False
    if pgid <= 0 or pgid_start_ticks <= 0 or (launch_pid > 0 and launch_pid != pgid):
        return False

    leader_identity = _read_process_identity(proc_root, pgid)
    if (
        leader_identity is None
        or leader_identity[0] == "Z"
        or leader_identity[1] != pgid
        or leader_identity[2] != pgid_start_ticks
        or not _process_has_owner_token(proc_root, pgid, token)
    ):
        return False

    member_count = 0
    try:
        process_dirs = tuple(proc_root.iterdir())
    except OSError:
        return False
    for process_dir in process_dirs:
        if not process_dir.name.isdigit():
            continue
        member_pid = int(process_dir.name)
        identity = _read_process_identity(proc_root, member_pid)
        if identity is None or identity[0] == "Z" or identity[1] != pgid:
            continue
        member_count += 1
    return member_count > 0


class ReadinessHysteresis:
    """Require stable readiness while preserving the first degradation time."""

    def __init__(
        self,
        started_at: float,
        startup_timeout_sec: float,
        unhealthy_grace_sec: float,
        stable_ready_sec: float,
        ready: bool = False,
    ) -> None:
        self.started_at = started_at
        self.startup_timeout_sec = max(startup_timeout_sec, 0.0)
        self.unhealthy_grace_sec = max(unhealthy_grace_sec, 0.0)
        self.stable_ready_sec = max(stable_ready_sec, 0.0)
        self.ready = ready
        self.ready_since: float | None = None
        self.unhealthy_since: float | None = None

    def update(self, now: float, *, expected_ready: bool) -> str:
        if not self.ready:
            if expected_ready:
                if self.ready_since is None:
                    self.ready_since = now
                if now - self.ready_since >= self.stable_ready_sec:
                    self.ready = True
                    self.ready_since = None
                    return "ready"
            else:
                self.ready_since = None

            if now - self.started_at >= self.startup_timeout_sec:
                return "timeout"
            return "waiting"

        if expected_ready:
            if self.unhealthy_since is None:
                return "ready"
            if self.ready_since is None:
                self.ready_since = now
            if now - self.ready_since >= self.stable_ready_sec:
                self.ready_since = None
                self.unhealthy_since = None
                return "recovered"
            return "recovering"

        self.ready_since = None
        if self.unhealthy_since is None:
            self.unhealthy_since = now
            return "degraded"
        if now - self.unhealthy_since >= self.unhealthy_grace_sec:
            return "unhealthy"
        return "degrading"
