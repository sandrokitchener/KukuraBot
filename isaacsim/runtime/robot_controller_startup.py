from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import carb.events
import omni.kit.app
import omni.timeline
import omni.usd
from pxr import Gf, UsdGeom


ROOT_DIR = Path(r"C:\Users\sandr\OneDrive\Documents\Robo-Doge")
RUNTIME_DIR = ROOT_DIR / "isaacsim" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from robot_controller import create_controller  # noqa: E402
from proxy_rig_motion import ProxyRigMotionSolver  # noqa: E402
from runtime_feedback import IsaacRuntimeFeedbackStore  # noqa: E402


COMMAND_LOG = ROOT_DIR / "sidecars" / "isaac_bridge" / "command_log.ndjson"
FEEDBACK_FILE = ROOT_DIR / "sidecars" / "isaac_bridge" / "runtime_feedback.json"
JOINT_LIMITS_FILE = ROOT_DIR / "config" / "dogzilla-proxy-joint-limits.json"
WALK_FILE = ROOT_DIR / "config" / "dogzilla-proxy-walk-cycle.json"


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

    def set_translate_offset(self, prim_path: str, offset):
        self.refresh_stage()
        if self._stage is None:
            return
        prim = self._stage.GetPrimAtPath(prim_path)
        if not prim.IsValid():
            return

        xformable = UsdGeom.Xformable(prim)
        if prim_path not in self._defaults:
            self._defaults[prim_path] = self._capture_defaults(xformable)

        base_translate = self._defaults[prim_path].get("translate", Gf.Vec3d(0.0, 0.0, 0.0))
        offset = list(offset or [0.0, 0.0, 0.0])
        self._set_translate(
            xformable,
            (
                float(base_translate[0]) + float(offset[0]),
                float(base_translate[1]) + float(offset[1]),
                float(base_translate[2]) + float(offset[2]),
            ),
        )

    def get_lidar_front_yaw_offset_degrees(
        self,
        lidar_prim_path: str,
        front_leg_paths: list[str],
        rear_leg_paths: list[str],
        fallback_degrees: float,
    ) -> float:
        self.refresh_stage()
        if self._stage is None:
            return fallback_degrees

        lidar_prim = self._stage.GetPrimAtPath(lidar_prim_path)
        if not lidar_prim.IsValid():
            return fallback_degrees

        xform_cache = UsdGeom.XformCache()
        front_midpoint = self._midpoint_for_prims(xform_cache, front_leg_paths)
        rear_midpoint = self._midpoint_for_prims(xform_cache, rear_leg_paths)
        if front_midpoint is None or rear_midpoint is None:
            return fallback_degrees

        front_world = front_midpoint - rear_midpoint
        if front_world.GetLength() <= 1e-6:
            return fallback_degrees

        lidar_world = xform_cache.GetLocalToWorldTransform(lidar_prim)
        front_local = lidar_world.GetInverse().TransformDir(front_world)
        if math.hypot(float(front_local[0]), float(front_local[1])) <= 1e-6:
            return fallback_degrees

        return normalize_angle_degrees(math.degrees(math.atan2(float(front_local[1]), float(front_local[0]))))

    def get_obstacle_footprints(self):
        self.refresh_stage()
        if self._stage is None:
            return []

        obstacle_root = self._stage.GetPrimAtPath("/ObstacleRoom")
        if not obstacle_root.IsValid():
            return []

        xform_cache = UsdGeom.XformCache()
        footprints = []
        for prim in obstacle_root.GetChildren():
            if not prim.GetName().startswith("obstacle_"):
                continue

            center = xform_cache.GetLocalToWorldTransform(prim).ExtractTranslation()
            scale = self._get_local_scale(UsdGeom.Xformable(prim))
            size_attr = prim.GetAttribute("size")
            size = float(size_attr.Get() if size_attr.IsValid() and size_attr.Get() is not None else 1.0)
            footprints.append(
                {
                    "primPath": str(prim.GetPath()),
                    "center": [float(center[0]), float(center[1])],
                    "halfExtentsMeters": [
                        abs(float(scale[0])) * size * 0.5,
                        abs(float(scale[1])) * size * 0.5,
                    ],
                }
            )

        return footprints

    def _capture_defaults(self, xformable):
        data = {}
        for op in xformable.GetOrderedXformOps():
            op_type = op.GetOpType()
            if op_type == UsdGeom.XformOp.TypeTranslate:
                data["translate"] = op.Get()
            elif op_type == UsdGeom.XformOp.TypeOrient:
                data["orient"] = op.Get()
        return data

    def _midpoint_for_prims(self, xform_cache, prim_paths: list[str]):
        points = []
        for prim_path in prim_paths:
            prim = self._stage.GetPrimAtPath(prim_path)
            if prim.IsValid():
                points.append(xform_cache.GetLocalToWorldTransform(prim).ExtractTranslation())

        if not points:
            return None

        total = Gf.Vec3d(0.0, 0.0, 0.0)
        for point in points:
            total += point
        return total / len(points)

    def _get_local_scale(self, xformable):
        for op in xformable.GetOrderedXformOps():
            if op.GetOpType() == UsdGeom.XformOp.TypeScale:
                value = op.Get()
                return (abs(float(value[0])), abs(float(value[1])), abs(float(value[2])))
        return (1.0, 1.0, 1.0)

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

    def read_new_commands(self):
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
                envelopes.append(
                    {
                        "commandId": command_id,
                        "receivedAt": record.get("receivedAt"),
                        "envelope": envelope,
                    }
                )
        return envelopes


class RigMotionDriver:
    LEG_PATHS = {
        "front_left": (
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/front_left_hip",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/front_left_hip/front_left_upper",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/front_left_hip/front_left_upper/front_left_lower",
        ),
        "front_right": (
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/front_right_hip",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/front_right_hip/front_right_upper",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/front_right_hip/front_right_upper/front_right_lower",
        ),
        "rear_left": (
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/rear_left_hip",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/rear_left_hip/rear_left_upper",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/rear_left_hip/rear_left_upper/rear_left_lower",
        ),
        "rear_right": (
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/rear_right_hip",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/rear_right_hip/rear_right_upper",
            "/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link/rear_right_hip/rear_right_upper/rear_right_lower",
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

        for leg_name, (hip_path, upper_path, lower_path) in self.LEG_PATHS.items():
            leg_pose = rig_pose["legs"][leg_name]
            self.scene_adapter.set_translate_offset(hip_path, leg_pose.get("hipTranslateOffset", [0.0, 0.0, 0.0]))
            self.scene_adapter.set_rotate_x(hip_path, leg_pose["hip"])
            self.scene_adapter.set_rotate_x(upper_path, leg_pose["upper"])
            self.scene_adapter.set_rotate_x(lower_path, leg_pose["lower"])


class RobotControllerRuntime:
    def __init__(self):
        self.scene_adapter = StageSceneAdapter()
        self.controller = create_controller(scene_adapter=self.scene_adapter)
        self.command_log = CommandLogFollower(COMMAND_LOG)
        self.feedback_store = IsaacRuntimeFeedbackStore(FEEDBACK_FILE)
        self.rig_motion_driver = RigMotionDriver(self.scene_adapter, self.controller.body_prim)
        self.subscription = None
        self.timeline = omni.timeline.get_timeline_interface()
        self.lidar_interface = None
        self.lidar_prim_path = None
        self.lidar_front_yaw_offset_degrees = None
        self._waiting_for_stage = False
        self._lidar_import_warning_printed = False
        self._lidar_missing_warning_printed = False
        self._lidar_empty_warning_printed = False

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
        print(f"Writing feedback: {FEEDBACK_FILE}")

    def stop(self):
        if self.subscription is not None:
            self.subscription.unsubscribe()
            self.subscription = None
            print("robot controller startup stopped")

    def _tick(self, dt_seconds: float):
        stage = omni.usd.get_context().get_stage()
        if stage is not None and not self.timeline.is_playing():
            physics_scene = stage.GetPrimAtPath("/physicsScene")
            robot_root = stage.GetPrimAtPath(self.controller.rig_root_prim)
            if physics_scene.IsValid() and robot_root.IsValid():
                self.timeline.play()
                print("robot controller requested timeline play")

        for record in self.command_log.read_new_commands():
            envelope = record["envelope"]
            command_id = str(record.get("commandId") or "").strip()
            if command_id:
                self.feedback_store.record_command(command_id, envelope)
            result = self.controller.handle_command(envelope)
            print("robot controller command:", result)

        sensor_state = {
            "lidarFlatScan": self._read_lidar_scan(),
            "obstacleFootprints": self.scene_adapter.get_obstacle_footprints(),
        }
        snapshot = self.controller.tick(dt_seconds, sensor_state=sensor_state)
        event = self.feedback_store.record_snapshot(snapshot)
        if event is not None:
            print("robot controller event:", event)
        self.rig_motion_driver.update(dt_seconds, snapshot)

    def _read_lidar_scan(self):
        try:
            from isaacsim.sensors.physx import _range_sensor
        except Exception as error:
            if not self._lidar_import_warning_printed:
                print(f"robot controller could not import PhysX lidar interface: {error}")
                self._lidar_import_warning_printed = True
            return None

        stage = omni.usd.get_context().get_stage()
        if stage is None:
            return None

        if self.lidar_interface is None:
            self.lidar_interface = _range_sensor.acquire_lidar_sensor_interface()

        preferred_path = self.controller.config.get("lidarPrimPath", "")
        if self.lidar_prim_path is None:
            body_prim = stage.GetPrimAtPath(self.controller.body_prim)
            if not body_prim.IsValid():
                if not self._waiting_for_stage:
                    print(f"robot controller waiting for stage prim before lidar startup: {self.controller.body_prim}")
                    self._waiting_for_stage = True
                return None
            if preferred_path and self.lidar_interface.is_lidar_sensor(preferred_path):
                self.lidar_prim_path = preferred_path
            else:
                for prim in body_prim.GetChildren():
                    candidate = str(prim.GetPath())
                    if self.lidar_interface.is_lidar_sensor(candidate):
                        self.lidar_prim_path = candidate
                        break
            if self.lidar_prim_path is None:
                if not self._lidar_missing_warning_printed:
                    print(f"robot controller found no PhysX lidar under {self.controller.body_prim}")
                    self._lidar_missing_warning_printed = True
                return None
            self._waiting_for_stage = False
            print(f"robot controller using PhysX lidar prim: {self.lidar_prim_path}")

        if hasattr(self.lidar_interface, "get_linear_depth_data"):
            depth_raw = self.lidar_interface.get_linear_depth_data(self.lidar_prim_path)
        else:
            depth_raw = self.lidar_interface.get_depth_data(self.lidar_prim_path)
        azimuth_raw = self.lidar_interface.get_azimuth_data(self.lidar_prim_path)
        if depth_raw is None or azimuth_raw is None:
            return None

        import numpy as np

        depth_array = np.array(depth_raw, dtype=np.float32)
        azimuth_array = np.array(azimuth_raw, dtype=np.float32).reshape(-1)
        if depth_array.size == 0 or azimuth_array.size == 0:
            if not self._lidar_empty_warning_printed:
                print(
                    "robot controller PhysX lidar returned empty buffers:"
                    f" depth_size={depth_array.size} azimuth_size={azimuth_array.size}"
                )
                self._lidar_empty_warning_printed = True
            return None
        linear_depth = self._linearize_depth_by_azimuth(depth_array, azimuth_array.size)
        angles = [normalize_angle_degrees(float(value)) for value in azimuth_array.tolist()]

        prim_paths = []
        if hasattr(self.lidar_interface, "get_prim_data"):
            try:
                prim_raw = list(self.lidar_interface.get_prim_data(self.lidar_prim_path) or [])
            except Exception:
                prim_raw = []
            if len(prim_raw) == linear_depth.size:
                prim_paths = prim_raw
            elif depth_array.ndim == 2 and len(prim_raw) == depth_array.size:
                prim_paths = np.array(prim_raw, dtype=object).reshape(depth_array.shape)[:, 0].tolist()

        if self.lidar_front_yaw_offset_degrees is None:
            front_reference = self.controller.config.get("frontReference", {})
            fallback = float(self.controller.avoidance.get("lidarFrontYawOffsetDegrees", 0.0))
            self.lidar_front_yaw_offset_degrees = self.scene_adapter.get_lidar_front_yaw_offset_degrees(
                self.lidar_prim_path,
                list(front_reference.get("frontLegPrims", []) or []),
                list(front_reference.get("rearLegPrims", []) or []),
                fallback,
            )
            print(f"robot controller lidar front yaw offset: {self.lidar_front_yaw_offset_degrees:.2f} degrees")

        return {
            "linear_depth_data": linear_depth.tolist(),
            "angles": angles,
            "hit_prim_paths": [str(value) for value in prim_paths],
            "frontYawOffsetDegrees": self.lidar_front_yaw_offset_degrees,
        }

    def _linearize_depth_by_azimuth(self, depth_array, azimuth_count: int):
        import numpy as np

        if depth_array.ndim <= 1 or azimuth_count <= 0:
            return depth_array.reshape(-1).astype(np.float32)

        if depth_array.shape[0] == azimuth_count:
            return np.nanmin(depth_array, axis=1).astype(np.float32)

        if depth_array.shape[1] == azimuth_count:
            return np.nanmin(depth_array, axis=0).astype(np.float32)

        flat = depth_array.reshape(-1).astype(np.float32)
        if flat.size % azimuth_count == 0:
            return np.nanmin(flat.reshape(-1, azimuth_count), axis=0).astype(np.float32)

        return flat


def normalize_angle_degrees(value: float) -> float:
    wrapped = (float(value) + 180.0) % 360.0 - 180.0
    return 180.0 if math.isclose(wrapped, -180.0, abs_tol=1e-9) else wrapped


_runtime = RobotControllerRuntime()


def start():
    _runtime.start()


def stop():
    _runtime.stop()


if __name__ == "__main__":
    start()
