from pathlib import Path

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    package_share = Path(get_package_share_directory("dogzilla_bridge"))
    params_file = package_share / "config" / "bridge.params.yaml"

    return LaunchDescription(
        [
            Node(
                package="dogzilla_bridge",
                executable="bridge_node",
                name="dogzilla_bridge",
                output="screen",
                parameters=[str(params_file)],
            )
        ]
    )
