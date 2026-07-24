import os

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess, OpaqueFunction, SetEnvironmentVariable
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.descriptions import ParameterFile
from nav2_common.launch import RewrittenYaml


def generate_launch_description():
    use_sim_time = LaunchConfiguration("use_sim_time")
    autostart = LaunchConfiguration("autostart")
    map_yaml_file = LaunchConfiguration("map")
    params_file = LaunchConfiguration("params_file")
    use_respawn = LaunchConfiguration("use_respawn")
    log_level = LaunchConfiguration("log_level")
    localization_backend = LaunchConfiguration("localization_backend")
    mapping_mode = LaunchConfiguration("mapping_mode")

    configured_params = ParameterFile(
        RewrittenYaml(
            source_file=params_file,
            root_key="",
            param_rewrites={
                "use_sim_time": use_sim_time,
                "yaml_filename": map_yaml_file,
            },
            convert_types=True,
        ),
        allow_substs=True,
    )

    remappings = [
        ("/tf", "tf"),
        ("/tf_static", "tf_static"),
    ]

    def build_nodes(context):
        backend = localization_backend.perform(context).strip().lower() or "amcl"
        is_mapping_mode = mapping_mode.perform(context).strip().lower() in {"1", "true", "yes", "on"}
        remote_root = os.environ.get("REMOTE_ROOT", "/home/pi/robodoge")
        helper_root = os.path.join(remote_root, "sidecars", "dogzilla_navigation")
        scan_filter_enabled = os.environ.get("DOGZILLA_NAV2_SCAN_FILTER_ENABLED", "1") == "1"
        gait_adapter_enabled = os.environ.get("DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED", "1") == "1"
        gait_input_topic = os.environ.get("DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC", "/cmd_vel")
        lifecycle_nodes = [
            "controller_server",
            "planner_server",
            "behavior_server",
            "bt_navigator",
            "velocity_smoother",
            "collision_monitor",
        ]
        nodes = []
        if scan_filter_enabled:
            nodes.append(
                ExecuteProcess(
                    cmd=[
                        "python3",
                        os.path.join(helper_root, "scan_self_filter.py"),
                        "--input-topic", "/scan",
                        "--output-topic", os.environ["DOGZILLA_NAV2_SCAN_FILTER_TOPIC"],
                        "--mask-start-deg", os.environ["DOGZILLA_NAV2_SCAN_FILTER_MASK_START_DEG"],
                        "--mask-end-deg", os.environ["DOGZILLA_NAV2_SCAN_FILTER_MASK_END_DEG"],
                        "--mask-range-m", os.environ["DOGZILLA_NAV2_SCAN_FILTER_MASK_RANGE_M"],
                        "--self-radius-m", os.environ["DOGZILLA_NAV2_ROBOT_RADIUS"],
                    ],
                    output="screen",
                    respawn=True,
                    respawn_delay=2.0,
                )
            )

        if backend == "cartographer":
            odom_cmd = [
                "python3",
                os.path.join(helper_root, "tf_odom_publisher.py"),
                "--odom-frame", "odom",
                "--base-frame", "base_link",
                "--topic", "/odom",
                "--rate", "10",
                "--fallback-source-frame", "map",
                "--synthetic-fallback-after-sec", "1.0",
                "--real-authority-node", "cartographer_node",
            ]
        else:
            odom_cmd = [
                "python3",
                os.path.join(helper_root, "cmd_vel_odom_publisher.py"),
                "--input-topic", gait_input_topic,
                "--topic", "/odom",
                "--odom-frame", "odom",
                "--base-frame", "base_link",
                "--rate", "15",
                "--stale-stop-sec", os.environ["DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC"],
            ]
        nodes.append(
            ExecuteProcess(
                cmd=odom_cmd,
                output="screen",
                respawn=True,
                respawn_delay=2.0,
            )
        )

        if gait_adapter_enabled:
            nodes.append(
                ExecuteProcess(
                    cmd=[
                        "python3",
                        os.path.join(helper_root, "cmd_vel_gait_adapter.py"),
                        "--input-topic", gait_input_topic,
                        "--bridge-url", os.environ["DOGZILLA_NAV2_GAIT_ADAPTER_URL"],
                        "--max-rate-hz", os.environ["DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ"],
                        "--stale-stop-sec", os.environ["DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC"],
                        "--http-timeout-sec", os.environ["DOGZILLA_NAV2_GAIT_ADAPTER_HTTP_TIMEOUT_SEC"],
                    ],
                    output="screen",
                    respawn=True,
                    respawn_delay=2.0,
                )
            )
        if not is_mapping_mode:
            lifecycle_nodes.insert(0, "map_server")
        if backend == "amcl" and not is_mapping_mode:
            lifecycle_nodes.insert(1, "amcl")
            nodes.append(
                Node(
                    package="nav2_amcl",
                    executable="amcl",
                    name="amcl",
                    output="screen",
                    respawn=use_respawn,
                    respawn_delay=2.0,
                    parameters=[configured_params],
                    arguments=["--ros-args", "--log-level", log_level],
                    remappings=remappings,
                )
            )

        nodes.extend(
            [
                *([] if is_mapping_mode else [Node(
                    package="nav2_map_server",
                    executable="map_server",
                    name="map_server",
                    output="screen",
                    respawn=use_respawn,
                    respawn_delay=2.0,
                    parameters=[configured_params],
                    arguments=["--ros-args", "--log-level", log_level],
                    remappings=remappings,
                )]),
                Node(
                    package="nav2_controller",
                    executable="controller_server",
                    output="screen",
                    respawn=use_respawn,
                    respawn_delay=2.0,
                    parameters=[configured_params],
                    arguments=["--ros-args", "--log-level", log_level],
                    remappings=remappings + [("cmd_vel", "cmd_vel_nav")],
                ),
                Node(
                    package="nav2_planner",
                    executable="planner_server",
                    name="planner_server",
                    output="screen",
                    respawn=use_respawn,
                    respawn_delay=2.0,
                    parameters=[configured_params],
                    arguments=["--ros-args", "--log-level", log_level],
                    remappings=remappings,
                ),
                Node(
                    package="nav2_behaviors",
                    executable="behavior_server",
                    name="behavior_server",
                    output="screen",
                    respawn=use_respawn,
                    respawn_delay=2.0,
                    parameters=[configured_params],
                    arguments=["--ros-args", "--log-level", log_level],
                    remappings=remappings + [("cmd_vel", "cmd_vel_nav")],
                ),
                Node(
                    package="nav2_bt_navigator",
                    executable="bt_navigator",
                    name="bt_navigator",
                    output="screen",
                    respawn=use_respawn,
                    respawn_delay=2.0,
                    parameters=[configured_params],
                    arguments=["--ros-args", "--log-level", log_level],
                    remappings=remappings,
                ),
                Node(
                    package="nav2_velocity_smoother",
                    executable="velocity_smoother",
                    name="velocity_smoother",
                    output="screen",
                    respawn=use_respawn,
                    respawn_delay=2.0,
                    parameters=[configured_params],
                    arguments=["--ros-args", "--log-level", log_level],
                    remappings=remappings + [("cmd_vel", "cmd_vel_nav"), ("cmd_vel_smoothed", "cmd_vel_raw")],
                ),
                Node(
                    package="nav2_collision_monitor",
                    executable="collision_monitor",
                    name="collision_monitor",
                    output="screen",
                    respawn=use_respawn,
                    respawn_delay=2.0,
                    parameters=[configured_params],
                    arguments=["--ros-args", "--log-level", log_level],
                    remappings=remappings,
                ),
                Node(
                    package="nav2_lifecycle_manager",
                    executable="lifecycle_manager",
                    name="lifecycle_manager_navigation",
                    output="screen",
                    arguments=["--ros-args", "--log-level", log_level],
                    parameters=[
                        {"use_sim_time": use_sim_time},
                        {"autostart": autostart},
                        {"node_names": lifecycle_nodes},
                    ],
                ),
            ]
        )
        return nodes

    return LaunchDescription(
        [
            SetEnvironmentVariable("RCUTILS_LOGGING_BUFFERED_STREAM", "1"),
            DeclareLaunchArgument("map", description="Full path to ROS map yaml file"),
            DeclareLaunchArgument(
                "params_file",
                default_value="/opt/ros/humble/share/nav2_bringup/params/nav2_params.yaml",
                description="Nav2 parameter file",
            ),
            DeclareLaunchArgument("use_sim_time", default_value="false"),
            DeclareLaunchArgument("autostart", default_value="true"),
            DeclareLaunchArgument("use_respawn", default_value="true"),
            DeclareLaunchArgument("log_level", default_value="info"),
            DeclareLaunchArgument("localization_backend", default_value="amcl"),
            DeclareLaunchArgument("mapping_mode", default_value="false"),
            OpaqueFunction(function=build_nodes),
        ]
    )
