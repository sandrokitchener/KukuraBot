from setuptools import find_packages, setup


package_name = "dogzilla_bridge"


setup(
    name=package_name,
    version="0.1.0",
    packages=find_packages(),
    data_files=[
        ("share/ament_index/resource_index/packages", [f"resource/{package_name}"]),
        (f"share/{package_name}", ["package.xml"]),
        (f"share/{package_name}/config", ["config/bridge.params.yaml"]),
        (f"share/{package_name}/launch", ["launch/dogzilla_bridge.launch.py"]),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="Robo-Doge",
    maintainer_email="support@example.com",
    description="Config-driven DOGZILLA ROS2 bridge scaffold for Robo-Doge.",
    license="Apache-2.0",
    entry_points={
        "console_scripts": [
            "bridge_node = dogzilla_bridge.bridge_node:main",
        ],
    },
)
