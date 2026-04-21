from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import carb.events
import omni.kit.app
import omni.usd
from pxr import Gf, UsdGeom


ROOT_DIR = Path(r"C:\Users\sandr\OneDrive\Documents\Robo-Doge")
RUNTIME_DIR = ROOT_DIR / "isaacsim" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from robot_controller import create_controller  # noqa: E402
from proxy_rig_motion import ProxyRigMotionSolver  # noqa: E402


COMMAND_LOG = ROOT_DIR / "sidecars" / "isaac_bridge" / "command_log.ndjson"
JOINT_LIMITS_FILE = ROOT_DIR / "config" / "dogzilla-proxy-joint-limits.json"
WALK_FILE = ROOT_DIR / "config" / "dogzilla-proxy-walk-cycle.json"
RIG_FILE = ROOT_DIR / "config" / "isaacsim-proxy-rig.json"


class StageSceneAdapter:
    def __init__(self):
        self._context = omni.usd.get_context()
        self._stage = self._context.get_stage()
        self._defaults = {}

    def refresh_stage(self):
        self._stage = self._context.get_stage()

    def set_transform(self, prim_path: str, payload: dict):
        self.refresh_stage()
        if self._stage is None:
            return
        prim = self._stage.GetPrimAtPath(prim_path)
        if not prim.IsValid():
            return

        xformable = UsdGeom.Xformable(prim)
        if prim_path not in self._defaults:
            self._defaults[prim_path] = self._capture_defaults(xformable)

        defaults = self._defaults[prim_path]

        if "translate" in payload:
            self._set_translate(xformable, payload["translate"])
        elif defaults.get("translate") is not None:
            self._set_translate(xformable, defaults["translate"])

        if "yawDegrees" in payload:
            self._set_orient_from_yaw(xformable, payload["yawDegrees"])
        elif defaults.get("orient") is not None:
            self._set_orient(xformable, defaults["orient"])

        if "heightOffset" in payload or "rollDegrees" in payload or "pitchDegrees" in payload:
            base_translate = defaults.get("translate", Gf.Vec3d(0.0, 0.0, 0.0))
            height_offset = payload.get("heightOffset", 0.0)
            self._set_translate(xformable, (base_translate[0], base_translate[1], base_translate[2] + height_offset))
            self._set_orient_from_rpy(
                xformable,
                payload.get("rollDegrees", 0.0),
                payload.get("pitchDegrees", 0.0),
                0.0,
            )

    def set_rotate_x(self, prim_path: str, degrees: float):
        self.refresh_stage()
        if self._stage is None:
            return
        prim = self._stage.GetPrimAtPath(prim_path)
        if not prim.IsValid():
            return

        xformable = UsdGeom.Xformable(prim)
        op = self._get_or_add_op(xformable, UsdGeom.XformOp.TypeRotateX)
        op.Set(float(degrees))

    def _capture_defaults(self, xformable):
        data = {}
        for op in xformable.GetOrderedXformOps():
            op_type = op.GetOpType()
            if op_type == UsdGeom.XformOp.TypeTranslate:
                data["translate"] = op.Get()
            elif op_type == UsdGeom.XformOp.TypeOrient:
                data["orient"] = op.Get()
        return data

    def _get_or_add_op(self, xformable, op_type):
        for op in xformable.GetOrderedXformOps():
            if op.GetOpType() == op_type:
                return op

        if op_type == UsdGeom.XformOp.TypeTranslate:
            return xformable.AddTranslateOp()
        if op_type == UsdGeom.XformOp.TypeOrient:
            return xformable.AddOrientOp()
        if op_type == UsdGeom.XformOp.TypeRotateX:
            return xformable.AddRotateXOp()

        raise RuntimeError(f"Unsupported op type {op_type}")

    def _set_translate(self, xformable, value):
        op = self._get_or_add_op(xformable, UsdGeom.XformOp.TypeTranslate)
        op.Set(Gf.Vec3d(*value))

    def _set_orient(self, xformable, quat):
        op = self._get_or_add_op(xformable, UsdGeom.XformOp.TypeOrient)
        op.Set(quat)

    def _set_orient_from_yaw(self, xformable, yaw_degrees: float):
        radians = math.radians(float(yaw_degrees))
        quat = Gf.Quatd(math.cos(radians / 2.0), Gf.Vec3d(0.0, 0.0, math.sin(radians / 2.0)))
        self._set_orient(xformable, quat)

    def _set_orient_from_rpy(self, xformable, roll_degrees: float, pitch_degrees: float, yaw_degrees: float):
        rx = Gf.Rotation(Gf.Vec3d(1, 0, 0), roll_degrees)
        ry = Gf.Rotation(Gf.Vec3d(0, 1, 0), pitch_degrees)
        rz = Gf.Rotation(Gf.Vec3d(0, 0, 1), yaw_degrees)
        quat = (rz * ry * rx).GetQuat()
        self._set_orient(xformable, Gf.Quatd(quat.GetReal(), quat.GetImaginary()))


class CommandLogFollower:
    def __init__(self, path: Path):
        self.path = path
        self.offset = path.stat().st_size if path.exists() else 0
        self.seen_ids: set[str] = set()

    def read_new_envelopes(self):
        if not self.path.exists():
            return []

        with self.path.open("r", encoding="utf-8") as handle:
            handle.seek(self.offset)
            lines = handle.readlines()
            self.offset = handle.tell()

        envelopes = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            command_id = record.get("commandId", "")
            if command_id in self.seen_ids:
                continue
            self.seen_ids.add(command_id)
            envelope = record.get("envelope")
            if isinstance(envelope, dict):
                envelopes.append(envelope)
        return envelopes


class RigMotionDriver:
    LEG_PATHS = {
        "front_left": (
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/front_left_hip",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/front_left_hip/front_left_upper",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/front_left_hip/front_left_upper/front_left_lower",
            "front",
        ),
        "front_right": (
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/front_right_hip",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/front_right_hip/front_right_upper",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/front_right_hip/front_right_upper/front_right_lower",
            "front",
        ),
        "rear_left": (
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/rear_left_hip",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/rear_left_hip/rear_left_upper",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/rear_left_hip/rear_left_upper/rear_left_lower",
            "rear",
        ),
        "rear_right": (
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/rear_right_hip",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/rear_right_hip/rear_right_upper",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/rear_right_hip/rear_right_upper/rear_right_lower",
            "rear",
        ),
    }

    def __init__(self, scene_adapter: StageSceneAdapter, body_prim: str):
        self.scene_adapter = scene_adapter
        self.body_prim = body_prim
        self.solver = ProxyRigMotionSolver(
            walk_config=json.loads(WALK_FILE.read_text(encoding="utf-8")),
            joint_limits=json.loads(JOINT_LIMITS_FILE.read_text(encoding="utf-8")),
        )

    def update(self, dt_seconds: float, snapshot: dict):
        rig_pose = self.solver.evaluate(snapshot, dt_seconds)
        self.scene_adapter.set_transform(self.body_prim, rig_pose["body"])

        for leg_name, (hip_path, upper_path, lower_path, _side) in self.LEG_PATHS.items():
            leg_pose = rig_pose["legs"][leg_name]
            self.scene_adapter.set_rotate_x(hip_path, leg_pose["hip"])
            self.scene_adapter.set_rotate_x(upper_path, leg_pose["upper"])
            self.scene_adapter.set_rotate_x(lower_path, leg_pose["lower"])


class RobotControllerRuntime:
    def __init__(self):
        self.scene_adapter = StageSceneAdapter()
        self.controller = create_controller(scene_adapter=self.scene_adapter)
        self.command_log = CommandLogFollower(COMMAND_LOG)
        self.rig_motion_driver = RigMotionDriver(self.scene_adapter, self.controller.body_prim)
        self.subscription = None

    def start(self):
        if self.subscription is not None:
            print("robot controller startup already active")
            return

        update_stream = omni.kit.app.get_app().get_update_event_stream()

        def on_update(event: carb.events.IEvent):
            dt = float(event.payload.get("dt", 1.0 / 60.0))
            self._tick(dt)

        self.subscription = update_stream.create_subscription_to_pop(
            on_update,
            name="robot_controller_runtime",
        )
        print("robot controller startup active")
        print(f"Scene file: {self.controller.config['sceneFile']}")
        print(f"Watching log: {COMMAND_LOG}")

    def stop(self):
        if self.subscription is not None:
            self.subscription.unsubscribe()
            self.subscription = None
            print("robot controller startup stopped")

    def _tick(self, dt_seconds: float):
        for envelope in self.command_log.read_new_envelopes():
            result = self.controller.handle_command(envelope)
            print("robot controller command:", result)

        snapshot = self.controller.tick(dt_seconds)
        self.rig_motion_driver.update(dt_seconds, snapshot)


_runtime = RobotControllerRuntime()


def start():
    _runtime.start()


def stop():
    _runtime.stop()


if __name__ == "__main__":
    start()
