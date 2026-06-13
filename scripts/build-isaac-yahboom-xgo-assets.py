from __future__ import annotations

import argparse
import math
import re
import struct
import textwrap
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
URDF_PATH = ROOT_DIR / "yahboom_xgo_rviz_local_meshes_from_pi.urdf"
MESH_USD_PATH = ROOT_DIR / "isaacsim" / "assets" / "yahboom_xgo_from_pi_meshes.usda"
RIG_USD_PATH = ROOT_DIR / "isaacsim" / "yahboom_xgo_proxy_visual.usda"
SCENE_USD_PATH = ROOT_DIR / "isaacsim" / "sim_environment_yahboom_xgo.usda"

LINK_TO_PROXY = {
    "base_link": "body_link",
    "lf_hip_link": "front_left_hip",
    "lf_upper_leg_link": "front_left_upper",
    "lf_lower_leg_link": "front_left_lower",
    "rf_hip_link": "front_right_hip",
    "rf_upper_leg_link": "front_right_upper",
    "rf_lower_leg_link": "front_right_lower",
    "lh_hip_link": "rear_left_hip",
    "lh_upper_leg_link": "rear_left_upper",
    "lh_lower_leg_link": "rear_left_lower",
    "rh_hip_link": "rear_right_hip",
    "rh_upper_leg_link": "rear_right_upper",
    "rh_lower_leg_link": "rear_right_lower",
    "camera_link": "camera_link",
    "laser_link": "laser_link",
}

@dataclass
class Origin:
    xyz: tuple[float, float, float] = (0.0, 0.0, 0.0)
    rpy: tuple[float, float, float] = (0.0, 0.0, 0.0)


@dataclass
class Visual:
    origin: Origin
    mesh_path: Path
    color: tuple[float, float, float] = (0.8, 0.8, 0.8)


@dataclass
class Joint:
    parent: str
    child: str
    origin: Origin


@dataclass
class MeshData:
    points: list[tuple[float, float, float]]
    indices: list[int]
    bounds_min: tuple[float, float, float]
    bounds_max: tuple[float, float, float]
    triangle_count: int


def parse_vector(raw: str | None, length: int = 3) -> tuple[float, ...]:
    if not raw:
        return tuple(0.0 for _ in range(length))
    values = [float(value) for value in raw.split()]
    if len(values) != length:
        raise ValueError(f"Expected {length} vector values, got {raw!r}")
    return tuple(values)


def parse_origin(node: ET.Element | None) -> Origin:
    if node is None:
        return Origin()
    return Origin(
        xyz=parse_vector(node.get("xyz"), 3),  # type: ignore[arg-type]
        rpy=parse_vector(node.get("rpy"), 3),  # type: ignore[arg-type]
    )


def parse_urdf(path: Path) -> tuple[dict[str, Visual], dict[str, Joint], dict[str, list[str]]]:
    root = ET.parse(path).getroot()
    visuals: dict[str, Visual] = {}
    joints: dict[str, Joint] = {}
    children: dict[str, list[str]] = {}

    for link in root.findall("link"):
        name = link.get("name")
        if not name or name not in LINK_TO_PROXY:
            continue
        visual_node = link.find("visual")
        mesh_node = visual_node.find("geometry/mesh") if visual_node is not None else None
        if mesh_node is None or not mesh_node.get("filename"):
            continue

        color_node = visual_node.find("material/color") if visual_node is not None else None
        rgba = parse_vector(color_node.get("rgba"), 4) if color_node is not None else (0.8, 0.8, 0.8, 1.0)
        visuals[name] = Visual(
            origin=parse_origin(visual_node.find("origin") if visual_node is not None else None),
            mesh_path=(ROOT_DIR / mesh_node.get("filename")).resolve(),
            color=(rgba[0], rgba[1], rgba[2]),
        )

    for joint in root.findall("joint"):
        parent_node = joint.find("parent")
        child_node = joint.find("child")
        if parent_node is None or child_node is None:
            continue
        parent = parent_node.get("link") or ""
        child = child_node.get("link") or ""
        if child not in LINK_TO_PROXY:
            continue
        joints[child] = Joint(parent=parent, child=child, origin=parse_origin(joint.find("origin")))
        children.setdefault(parent, []).append(child)

    return visuals, joints, children


def parse_stl(path: Path) -> MeshData:
    raw = path.read_bytes()
    if len(raw) >= 84:
        triangle_count = struct.unpack("<I", raw[80:84])[0]
        if 84 + triangle_count * 50 == len(raw):
            return parse_binary_stl(raw, triangle_count)
    return parse_ascii_stl(raw.decode("utf-8", errors="replace"))


def parse_binary_stl(raw: bytes, triangle_count: int) -> MeshData:
    points: list[tuple[float, float, float]] = []
    indices: list[int] = []
    seen: dict[tuple[float, float, float], int] = {}
    mins = [math.inf, math.inf, math.inf]
    maxs = [-math.inf, -math.inf, -math.inf]
    offset = 84

    for _ in range(triangle_count):
        offset += 12
        for _ in range(3):
            vertex = struct.unpack("<fff", raw[offset : offset + 12])
            offset += 12
            index = seen.get(vertex)
            if index is None:
                index = len(points)
                seen[vertex] = index
                points.append(vertex)
                for axis, value in enumerate(vertex):
                    mins[axis] = min(mins[axis], value)
                    maxs[axis] = max(maxs[axis], value)
            indices.append(index)
        offset += 2

    return MeshData(points, indices, tuple(mins), tuple(maxs), triangle_count)  # type: ignore[arg-type]


def parse_ascii_stl(text: str) -> MeshData:
    vertices = [
        tuple(float(value) for value in match.groups())
        for match in re.finditer(
            r"vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)",
            text,
        )
    ]
    points: list[tuple[float, float, float]] = []
    indices: list[int] = []
    seen: dict[tuple[float, float, float], int] = {}
    mins = [math.inf, math.inf, math.inf]
    maxs = [-math.inf, -math.inf, -math.inf]
    for vertex in vertices:
        index = seen.get(vertex)
        if index is None:
            index = len(points)
            seen[vertex] = index
            points.append(vertex)
            for axis, value in enumerate(vertex):
                mins[axis] = min(mins[axis], value)
                maxs[axis] = max(maxs[axis], value)
        indices.append(index)
    return MeshData(points, indices, tuple(mins), tuple(maxs), len(indices) // 3)  # type: ignore[arg-type]


def rpy_to_quat(rpy: tuple[float, float, float]) -> tuple[float, float, float, float]:
    roll, pitch, yaw = rpy
    cr = math.cos(roll * 0.5)
    sr = math.sin(roll * 0.5)
    cp = math.cos(pitch * 0.5)
    sp = math.sin(pitch * 0.5)
    cy = math.cos(yaw * 0.5)
    sy = math.sin(yaw * 0.5)
    return (
        cr * cp * cy + sr * sp * sy,
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
    )


def matrix_multiply(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    return [[sum(a[row][k] * b[k][col] for k in range(4)) for col in range(4)] for row in range(4)]


def origin_matrix(origin: Origin) -> list[list[float]]:
    roll, pitch, yaw = origin.rpy
    cx, sx = math.cos(roll), math.sin(roll)
    cy, sy = math.cos(pitch), math.sin(pitch)
    cz, sz = math.cos(yaw), math.sin(yaw)
    # Rz * Ry * Rx
    rotation = [
        [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
        [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
        [-sy, cy * sx, cy * cx],
    ]
    return [
        [rotation[0][0], rotation[0][1], rotation[0][2], origin.xyz[0]],
        [rotation[1][0], rotation[1][1], rotation[1][2], origin.xyz[1]],
        [rotation[2][0], rotation[2][1], rotation[2][2], origin.xyz[2]],
        [0.0, 0.0, 0.0, 1.0],
    ]


def transform_point(matrix: list[list[float]], point: tuple[float, float, float]) -> tuple[float, float, float]:
    x, y, z = point
    return (
        matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z + matrix[0][3],
        matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z + matrix[1][3],
        matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z + matrix[2][3],
    )


def compute_link_matrices(joints: dict[str, Joint]) -> dict[str, list[list[float]]]:
    identity = [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
    matrices = {"base_link": identity}
    remaining = set(joints)
    while remaining:
        progressed = False
        for child in list(remaining):
            joint = joints[child]
            if joint.parent not in matrices:
                continue
            matrices[child] = matrix_multiply(matrices[joint.parent], origin_matrix(joint.origin))
            remaining.remove(child)
            progressed = True
        if not progressed:
            break
    return matrices


def compute_body_lift(
    visuals: dict[str, Visual],
    meshes: dict[Path, MeshData],
    link_matrices: dict[str, list[list[float]]],
) -> float:
    min_z = math.inf
    for link_name, visual in visuals.items():
        mesh = meshes[visual.mesh_path]
        link_matrix = link_matrices.get(link_name)
        if link_matrix is None:
            continue
        visual_matrix = matrix_multiply(link_matrix, origin_matrix(visual.origin))
        for corner in bounds_corners(mesh.bounds_min, mesh.bounds_max):
            min_z = min(min_z, transform_point(visual_matrix, corner)[2])
    if not math.isfinite(min_z):
        return 0.145
    return round(-min_z + 0.002, 6)


def bounds_corners(
    bounds_min: tuple[float, float, float],
    bounds_max: tuple[float, float, float],
) -> list[tuple[float, float, float]]:
    return [
        (x, y, z)
        for x in (bounds_min[0], bounds_max[0])
        for y in (bounds_min[1], bounds_max[1])
        for z in (bounds_min[2], bounds_max[2])
    ]


def fmt_float(value: float) -> str:
    if abs(value) < 1e-12:
        value = 0.0
    return f"{value:.9g}"


def fmt_tuple(values: tuple[float, ...]) -> str:
    return "(" + ", ".join(fmt_float(value) for value in values) + ")"


def fmt_point_array(points: list[tuple[float, float, float]], indent: str) -> str:
    rows = [fmt_tuple(point) for point in points]
    return wrap_array(rows, indent)


def fmt_int_array(values: list[int], indent: str) -> str:
    return wrap_array([str(value) for value in values], indent)


def wrap_array(values: list[str], indent: str, per_line: int = 8) -> str:
    lines = []
    for index in range(0, len(values), per_line):
        lines.append(indent + ", ".join(values[index : index + per_line]))
    return "[\n" + ",\n".join(lines) + "\n" + indent[:-4] + "]"


def usd_identifier(raw: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_]", "_", raw)
    if not safe or safe[0].isdigit():
        safe = "_" + safe
    return safe


def write_mesh_library(meshes: dict[Path, MeshData]) -> None:
    MESH_USD_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "#usda 1.0",
        "(",
        '    defaultPrim = "YahboomXgoMeshes"',
        "    metersPerUnit = 1",
        '    upAxis = "Z"',
        ")",
        "",
        'def Xform "YahboomXgoMeshes"',
        "{",
    ]
    for mesh_path in sorted(meshes, key=lambda item: item.name.lower()):
        mesh = meshes[mesh_path]
        prim_name = usd_identifier(mesh_path.stem)
        lines.extend(
            [
                f'    def Mesh "{prim_name}"',
                "    {",
                f'        custom string source_stl = "{mesh_path.relative_to(ROOT_DIR).as_posix()}"',
                f"        custom int source_triangle_count = {mesh.triangle_count}",
                '        uniform token subdivisionScheme = "none"',
                f"        int[] faceVertexCounts = {wrap_array(['3'] * mesh.triangle_count, '            ')}",
                f"        int[] faceVertexIndices = {fmt_int_array(mesh.indices, '            ')}",
                f"        point3f[] points = {fmt_point_array(mesh.points, '            ')}",
                "    }",
                "",
            ]
        )
    lines.append("}")
    MESH_USD_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_rig_asset(visuals: dict[str, Visual], joints: dict[str, Joint], body_lift: float) -> None:
    RIG_USD_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "#usda 1.0",
        "(",
        '    defaultPrim = "World"',
        "    metersPerUnit = 1",
        '    upAxis = "Z"',
        ")",
        "",
        'def Xform "World"',
        "{",
        '    def Xform "DOGZILLA_PROXY" (',
        '        displayName = "Yahboom XGO visual proxy from Pi URDF"',
        '        kind = "component"',
        "    )",
        "    {",
        '        custom string source_urdf = "../yahboom_xgo_rviz_local_meshes_from_pi.urdf"',
        '        custom string source_package = "../yahboom_description_from_pi"',
        '        custom string runtime_contract = "Keeps /dogzilla_proxy_blockout/DOGZILLA_PROXY prim paths used by robot_controller runtime."',
        "        double3 xformOp:translate = (0, 0, 0)",
        "        quatd xformOp:orient = (1, 0, 0, 0)",
        "        double3 xformOp:scale = (1, 1, 1)",
        '        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient", "xformOp:scale"]',
        "",
    ]

    emit_link(lines, "base_link", visuals, joints, body_lift, depth=2)
    lines.extend(
        [
            "    }",
            "",
            '    def DistantLight "defaultLight"',
            "    {",
            "        float inputs:intensity = 2500",
            "        quatd xformOp:orient = (0.6830127, 0.1830127, 0.1830127, 0.6830127)",
            '        uniform token[] xformOpOrder = ["xformOp:orient"]',
            "    }",
            "}",
        ]
    )
    RIG_USD_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def emit_link(
    lines: list[str],
    link_name: str,
    visuals: dict[str, Visual],
    joints: dict[str, Joint],
    body_lift: float,
    depth: int,
) -> None:
    proxy_name = LINK_TO_PROXY[link_name]
    indent = "    " * depth
    origin = joints[link_name].origin if link_name in joints else Origin(xyz=(0.0, 0.0, body_lift))
    if link_name == "base_link":
        origin = Origin(xyz=(0.0, 0.0, body_lift), rpy=(0.0, 0.0, 0.0))
    quat = rpy_to_quat(origin.rpy)
    lines.extend(
        [
            f'{indent}def Xform "{proxy_name}"',
            f"{indent}{{",
            f"{indent}    double3 xformOp:translate = {fmt_tuple(origin.xyz)}",
            f"{indent}    double xformOp:rotateX = 0",
            f"{indent}    quatd xformOp:orient = {fmt_tuple(quat)}",
            f"{indent}    double3 xformOp:scale = (1, 1, 1)",
            f'{indent}    uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateX", "xformOp:orient", "xformOp:scale"]',
        ]
    )

    visual = visuals.get(link_name)
    if visual is not None:
        emit_visual(lines, link_name, visual, depth + 1)

    if link_name == "base_link":
        emit_camera_and_lidar(lines, depth + 1)

    for child in child_links_for(link_name):
        if child in LINK_TO_PROXY:
            emit_link(lines, child, visuals, joints, body_lift, depth + 1)

    lines.append(f"{indent}}}")


def child_links_for(parent: str) -> list[str]:
    if parent == "base_link":
        return ["lf_hip_link", "rf_hip_link", "lh_hip_link", "rh_hip_link", "camera_link", "laser_link"]
    if parent == "lf_hip_link":
        return ["lf_upper_leg_link"]
    if parent == "lf_upper_leg_link":
        return ["lf_lower_leg_link"]
    if parent == "rf_hip_link":
        return ["rf_upper_leg_link"]
    if parent == "rf_upper_leg_link":
        return ["rf_lower_leg_link"]
    if parent == "lh_hip_link":
        return ["lh_upper_leg_link"]
    if parent == "lh_upper_leg_link":
        return ["lh_lower_leg_link"]
    if parent == "rh_hip_link":
        return ["rh_upper_leg_link"]
    if parent == "rh_upper_leg_link":
        return ["rh_lower_leg_link"]
    return []


def emit_visual(lines: list[str], link_name: str, visual: Visual, depth: int) -> None:
    indent = "    " * depth
    prim_name = usd_identifier(f"{link_name}_visual")
    mesh_name = usd_identifier(visual.mesh_path.stem)
    quat = rpy_to_quat(visual.origin.rpy)
    mesh_ref = "./assets/yahboom_xgo_from_pi_meshes.usda"
    lines.extend(
        [
            "",
            f'{indent}def Mesh "{prim_name}" (',
            f"{indent}    references = @{mesh_ref}@</YahboomXgoMeshes/{mesh_name}>",
            f"{indent})",
            f"{indent}{{",
            f"{indent}    color3f[] primvars:displayColor = [{fmt_tuple(visual.color)}]",
            f"{indent}    double3 xformOp:translate = {fmt_tuple(visual.origin.xyz)}",
            f"{indent}    quatd xformOp:orient = {fmt_tuple(quat)}",
            f"{indent}    double3 xformOp:scale = (1, 1, 1)",
            f'{indent}    uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient", "xformOp:scale"]',
            f"{indent}}}",
        ]
    )


def emit_camera_and_lidar(lines: list[str], depth: int) -> None:
    indent = "    " * depth
    lines.extend(
        [
            "",
            f'{indent}def Camera "Camera"',
            f"{indent}{{",
            f"{indent}    float2 clippingRange = (0.01, 10000000)",
            f"{indent}    float focalLength = 18.147562",
            f"{indent}    float focusDistance = 400",
            f"{indent}    quatd xformOp:orient = (0.706977511, 0.706977511, 0.0135202954, 0.0135202954)",
            f"{indent}    double3 xformOp:scale = (0.1, 0.1, 0.1)",
            f"{indent}    double3 xformOp:translate = (0.075751, 0, 0.059653)",
            f'{indent}    uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient", "xformOp:scale"]',
            f"{indent}}}",
            "",
            f'{indent}def Lidar "Lidar"',
            f"{indent}{{",
            f"{indent}    bool drawLines = 0",
            f"{indent}    bool drawPoints = 0",
            f"{indent}    bool enabled = 1",
            f"{indent}    bool enableSemantics = 1",
            f"{indent}    bool highLod = 0",
            f"{indent}    float horizontalFov = 360",
            f"{indent}    float horizontalResolution = 0.4",
            f"{indent}    float maxRange = 100",
            f"{indent}    float minRange = 0.05",
            f"{indent}    float rotationRate = 0",
            f"{indent}    float verticalFov = 30",
            f"{indent}    float verticalResolution = 4",
            f"{indent}    token visibility = \"inherited\"",
            f"{indent}    quatd xformOp:orient = (1, 0, 0, 0)",
            f"{indent}    double3 xformOp:scale = (1, 1, 1)",
            f"{indent}    double3 xformOp:translate = (-0.016732, 0.000044164, 0.10335)",
            f'{indent}    uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient", "xformOp:scale"]',
            f"{indent}    float yawOffset = 0",
            f"{indent}}}",
        ]
    )


def write_scene() -> None:
    text = """#usda 1.0
(
    defaultPrim = "dogzilla_proxy_blockout"
    metersPerUnit = 1
    upAxis = "Z"
)

def Xform "dogzilla_proxy_blockout"
{
    def Xform "DOGZILLA_PROXY" (
        displayName = "Yahboom XGO Visual Proxy Obstacle Room"
        references = @./yahboom_xgo_proxy_visual.usda@</World/DOGZILLA_PROXY>
    )
    {
    }
}

def PhysicsScene "physicsScene"
{
    vector3f physics:gravityDirection = (0.0, 0.0, -1.0)
    float physics:gravityMagnitude = 9.81
}

def Xform "ObstacleRoom"
{
    def Cube "Floor" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        color3f[] primvars:displayColor = [(0.72, 0.71, 0.68)]
        double size = 1
        double3 xformOp:scale = (5.1, 5.1, 0.02)
        double3 xformOp:translate = (0.0, 0.0, -0.02)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def Cube "NorthWall" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        color3f[] primvars:displayColor = [(0.86, 0.85, 0.82)]
        double size = 1
        double3 xformOp:scale = (5.1, 0.08, 0.56)
        double3 xformOp:translate = (0.0, 2.55, 0.26)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def Cube "SouthWall" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        color3f[] primvars:displayColor = [(0.86, 0.85, 0.82)]
        double size = 1
        double3 xformOp:scale = (5.1, 0.08, 0.56)
        double3 xformOp:translate = (0.0, -2.55, 0.26)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def Cube "WestWall" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        color3f[] primvars:displayColor = [(0.82, 0.81, 0.79)]
        double size = 1
        double3 xformOp:scale = (0.08, 4.94, 0.56)
        double3 xformOp:translate = (-2.55, 0.0, 0.26)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def Cube "EastWall" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        color3f[] primvars:displayColor = [(0.82, 0.81, 0.79)]
        double size = 1
        double3 xformOp:scale = (0.08, 4.94, 0.56)
        double3 xformOp:translate = (2.55, 0.0, 0.26)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def Cube "obstacle_1" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        color3f[] primvars:displayColor = [(0.72, 0.42, 0.37)]
        double size = 1
        double3 xformOp:scale = (0.374, 0.266, 0.435)
        double3 xformOp:translate = (0.068, 0.951, 0.217)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def Cube "obstacle_2" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        color3f[] primvars:displayColor = [(0.84, 0.68, 0.39)]
        double size = 1
        double3 xformOp:scale = (0.238, 0.224, 0.328)
        double3 xformOp:translate = (0.633, 0.5, 0.164)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def Cube "obstacle_3" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        color3f[] primvars:displayColor = [(0.42, 0.62, 0.84)]
        double size = 1
        double3 xformOp:scale = (0.3, 0.271, 0.457)
        double3 xformOp:translate = (0.764, -0.768, 0.229)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def Cube "obstacle_4" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        color3f[] primvars:displayColor = [(0.77, 0.48, 0.61)]
        double size = 1
        double3 xformOp:scale = (0.38, 0.23, 0.448)
        double3 xformOp:translate = (1.38, -0.305, 0.224)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def Cube "obstacle_5" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        color3f[] primvars:displayColor = [(0.48, 0.73, 0.48)]
        double size = 1
        double3 xformOp:scale = (0.333, 0.309, 0.487)
        double3 xformOp:translate = (1.163, -1.082, 0.243)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def Cube "obstacle_6" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        color3f[] primvars:displayColor = [(0.68, 0.56, 0.82)]
        double size = 1
        double3 xformOp:scale = (0.361, 0.322, 0.307)
        double3 xformOp:translate = (-0.899, 0.124, 0.153)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def Cube "obstacle_7" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        color3f[] primvars:displayColor = [(0.33, 0.73, 0.76)]
        double size = 1
        double3 xformOp:scale = (0.296, 0.379, 0.26)
        double3 xformOp:translate = (-1.296, 1.363, 0.13)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def Cube "obstacle_8" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        color3f[] primvars:displayColor = [(0.85, 0.54, 0.35)]
        double size = 1
        double3 xformOp:scale = (0.277, 0.374, 0.325)
        double3 xformOp:translate = (-1.39, 0.781, 0.163)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def Cube "obstacle_9" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        color3f[] primvars:displayColor = [(0.58, 0.62, 0.35)]
        double size = 1
        double3 xformOp:scale = (0.341, 0.276, 0.351)
        double3 xformOp:translate = (-0.705, -1.52, 0.175)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def Cube "obstacle_10" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        color3f[] primvars:displayColor = [(0.4, 0.55, 0.7)]
        double size = 1
        double3 xformOp:scale = (0.244, 0.238, 0.279)
        double3 xformOp:translate = (-0.943, -0.771, 0.14)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def Cube "BedroomMarker"
    {
        color3f[] primvars:displayColor = [(0.3, 0.78, 0.92)]
        double size = 1
        double3 xformOp:scale = (0.28, 0.28, 0.02)
        double3 xformOp:translate = (1.35, 1.25, 0.0)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }
}

def DistantLight "defaultLight"
{
    float inputs:intensity = 3000
    color3f inputs:color = (1.0, 0.98, 0.95)
    quatd xformOp:orient = (0.6830127, 0.1830127, 0.1830127, 0.6830127)
    uniform token[] xformOpOrder = ["xformOp:orient"]
}
"""
    SCENE_USD_PATH.write_text(textwrap.dedent(text), encoding="utf-8")


def validate_asset_text() -> None:
    for path in (MESH_USD_PATH, RIG_USD_PATH, SCENE_USD_PATH):
        if not path.exists():
            raise FileNotFoundError(path)
        text = path.read_text(encoding="utf-8")
        if "#usda 1.0" not in text:
            raise ValueError(f"{path} does not look like USDA")

    rig_text = RIG_USD_PATH.read_text(encoding="utf-8")
    required_prims = [
        'def Xform "body_link"',
        'def Xform "front_left_hip"',
        'def Xform "front_right_hip"',
        'def Xform "rear_left_hip"',
        'def Xform "rear_right_hip"',
        'def Lidar "Lidar"',
    ]
    for marker in required_prims:
        if marker not in rig_text:
            raise ValueError(f"Missing required rig marker: {marker}")


def build() -> None:
    visuals, joints, _children = parse_urdf(URDF_PATH)
    mesh_paths = {visual.mesh_path for visual in visuals.values()}
    missing = [path for path in mesh_paths if not path.exists()]
    if missing:
        raise FileNotFoundError(f"Missing mesh files: {missing}")

    meshes = {path: parse_stl(path) for path in mesh_paths}
    body_lift = compute_body_lift(visuals, meshes, compute_link_matrices(joints))

    write_mesh_library(meshes)
    write_rig_asset(visuals, joints, body_lift)
    write_scene()
    validate_asset_text()

    print(f"wrote {MESH_USD_PATH.relative_to(ROOT_DIR)}")
    print(f"wrote {RIG_USD_PATH.relative_to(ROOT_DIR)}")
    print(f"wrote {SCENE_USD_PATH.relative_to(ROOT_DIR)}")
    print(f"body_lift_m={body_lift}")
    print(f"mesh_count={len(meshes)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build IsaacSim USDA assets from Pi Yahboom XGO URDF/STL files.")
    parser.add_argument("--check", action="store_true", help="Validate generated assets without rebuilding.")
    args = parser.parse_args()
    if args.check:
        validate_asset_text()
        print("isaac-yahboom-assets-ok")
        return
    build()


if __name__ == "__main__":
    main()
