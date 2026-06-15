#!/usr/bin/env bash
set -e
FIXED_KEY=/usr/share/keyrings/ros-archive-keyring.gpg
python3 -c "
import urllib.request
data = urllib.request.urlopen('https://raw.githubusercontent.com/ros/rosdistro/master/ros.key', timeout=10).read()
open('$FIXED_KEY', 'wb').write(data)
" 2>/dev/null || curl -sSL https://raw.githubusercontent.com/ros/rosdistro/master/ros.key 2>/dev/null > "$FIXED_KEY" 2>/dev/null || wget -q -O - https://raw.githubusercontent.com/ros/rosdistro/master/ros.key 2>/dev/null > "$FIXED_KEY" 2>/dev/null
apt-get update -qq 2>/dev/null
apt-get install -y --no-install-recommends -qq ros-humble-nav2-msgs 2>/dev/null
