#!/bin/bash
# Stop only the process group recorded by the systemd-owned normal Nav2 launch.
set -euo pipefail

EXPECTED_MODE="${1:-normal}"
REMOTE_ROOT="${REMOTE_ROOT:-/home/pi/robodoge}"
OWNER_FILE="${DOGZILLA_NAV2_OWNER_FILE:-$REMOTE_ROOT/logs/navigation-runtime.owner}"
LOCK_FILE="${DOGZILLA_NAV2_LOCK_FILE:-$REMOTE_ROOT/logs/navigation-runtime.lock}"

[ -s "$OWNER_FILE" ] || exit 0
owner_version="$(sed -n 's/^version=//p' "$OWNER_FILE" | head -1)"
owner_mode="$(sed -n 's/^mode=//p' "$OWNER_FILE" | head -1)"
owner_token="$(sed -n 's/^token=//p' "$OWNER_FILE" | head -1)"
owner_boot_id="$(sed -n 's/^boot_id=//p' "$OWNER_FILE" | head -1)"
owner_pid="$(sed -n 's/^pid=//p' "$OWNER_FILE" | head -1)"
owner_pid_start_ticks="$(sed -n 's/^pid_start_ticks=//p' "$OWNER_FILE" | head -1)"
owner_pgid="$(sed -n 's/^pgid=//p' "$OWNER_FILE" | head -1)"
owner_pgid_start_ticks="$(sed -n 's/^pgid_start_ticks=//p' "$OWNER_FILE" | head -1)"

if [ "$owner_mode" != "$EXPECTED_MODE" ]; then
  echo "Refusing to stop Nav2 owner mode '$owner_mode' as '$EXPECTED_MODE'." >&2
  exit 0
fi
current_boot_id="$(tr -d '[:space:]' < /proc/sys/kernel/random/boot_id)"
if [ "$owner_version" != "2" ] \
  || ! [[ "$owner_token" =~ ^[0-9a-fA-F]{32}$ ]] \
  || [ "$owner_boot_id" != "$current_boot_id" ] \
  || ! [[ "$owner_pid" =~ ^[0-9]+$ ]] \
  || ! [[ "$owner_pid_start_ticks" =~ ^[0-9]+$ ]]; then
  echo "Recorded Nav2 owner generation is incomplete or stale." >&2
  exit 1
fi
has_group=0
if [ -n "$owner_pgid" ] || [ -n "$owner_pgid_start_ticks" ]; then
  if ! [[ "$owner_pgid" =~ ^[0-9]+$ ]] || ! [[ "$owner_pgid_start_ticks" =~ ^[0-9]+$ ]]; then
    echo "Recorded Nav2 process group generation is incomplete." >&2
    exit 1
  fi
  has_group=1
fi

read_proc_fields() {
  local process_id="$1"
  local stat_line=""
  local stat_rest=""
  stat_line="$(cat "/proc/$process_id/stat" 2>/dev/null)" || return 1
  stat_rest="${stat_line##*) }"
  set -- $stat_rest
  [ "$#" -ge 20 ] || return 1
  PROC_STATE="$1"
  PROC_PGID="$3"
  PROC_SESSION="$4"
  PROC_START_TICKS="${20}"
}

wrapper_alive=0
if read_proc_fields "$owner_pid" && [ "$PROC_STATE" != "Z" ]; then
  owner_command="$(tr '\0' ' ' < "/proc/$owner_pid/cmdline")"
  owner_is_mapping_launch=0
  if [ "$owner_mode" = "mapping" ] \
    && [[ "$owner_command" == *"ros2 launch"*"robodoge_nav2_navigation_launch.py"* ]]; then
    owner_is_mapping_launch=1
  fi
  if [ "$PROC_START_TICKS" != "$owner_pid_start_ticks" ] \
    || { [[ "$owner_command" != *"start-navigation-in-container.sh"* ]] && [ "$owner_is_mapping_launch" -ne 1 ]; }; then
    echo "Recorded PID $owner_pid failed wrapper generation validation." >&2
    exit 1
  fi
  if [ "$owner_is_mapping_launch" -eq 1 ]; then
    if ! tr '\0' '\n' < "/proc/$owner_pid/environ" 2>/dev/null \
      | grep -Fqx "DOGZILLA_NAV2_OWNER_TOKEN=$owner_token"; then
      echo "Recorded mapping owner lacks its generation token." >&2
      exit 1
    fi
    if [ "$has_group" -eq 0 ] && [ "$PROC_PGID" = "$owner_pid" ] && [ "$PROC_SESSION" = "$owner_pid" ]; then
      owner_pgid="$owner_pid"
      owner_pgid_start_ticks="$owner_pid_start_ticks"
      has_group=1
    fi
  fi
  wrapper_alive=1
fi

validate_group_members() {
  local proc_dir=""
  local member_pid=""
  local member_environment=""
  GROUP_MEMBER_COUNT=0
  if [ "$has_group" -eq 0 ]; then
    return 0
  fi
  for proc_dir in /proc/[0-9]*; do
    member_pid="${proc_dir#/proc/}"
    if ! read_proc_fields "$member_pid" || [ "$PROC_STATE" = "Z" ] || [ "$PROC_PGID" != "$owner_pgid" ]; then
      continue
    fi
    if [ "$member_pid" = "$owner_pgid" ] && [ "$PROC_START_TICKS" != "$owner_pgid_start_ticks" ]; then
      echo "Recorded Nav2 group leader generation changed." >&2
      return 1
    fi
    if [ "$PROC_SESSION" != "$owner_pgid" ]; then
      echo "Process $member_pid in recorded Nav2 group escaped its isolated session." >&2
      return 1
    fi
    if [ "$member_pid" = "$owner_pgid" ]; then
      if [ ! -r "$proc_dir/environ" ] \
        || ! member_environment="$(tr '\0' '\n' < "$proc_dir/environ" 2>/dev/null)" \
        || ! printf '%s\n' "$member_environment" | grep -Fqx "DOGZILLA_NAV2_OWNER_TOKEN=$owner_token"; then
        echo "Recorded Nav2 group leader lacks its generation token." >&2
        return 1
      fi
    fi
    GROUP_MEMBER_COUNT=$((GROUP_MEMBER_COUNT + 1))
  done
}

find_token_members() {
  local proc_dir=""
  local member_pid=""
  local member_environment=""
  TOKEN_MEMBER_PIDS=()
  for proc_dir in /proc/[0-9]*; do
    member_pid="${proc_dir#/proc/}"
    [ "$member_pid" != "$$" ] || continue
    if member_environment="$({ tr '\0' '\n' < "$proc_dir/environ"; } 2>/dev/null)" \
      && printf '%s\n' "$member_environment" | grep -Fqx "DOGZILLA_NAV2_OWNER_TOKEN=$owner_token"; then
      TOKEN_MEMBER_PIDS+=("$member_pid")
    fi
  done
}

signal_token_members() {
  local signal="$1"
  local member_pid=""
  find_token_members
  for member_pid in "${TOKEN_MEMBER_PIDS[@]}"; do
    kill "-$signal" "$member_pid" 2>/dev/null || true
  done
}

validate_group_members || exit 1
if [ "$GROUP_MEMBER_COUNT" -gt 0 ]; then
  kill -TERM -- "-$owner_pgid" 2>/dev/null || true
fi
signal_token_members TERM
if [ "$wrapper_alive" -eq 1 ]; then
  kill -TERM "$owner_pid" 2>/dev/null || true
fi

for _ in $(seq 1 15); do
  validate_group_members || exit 1
  find_token_members
  if [ "$GROUP_MEMBER_COUNT" -eq 0 ] && [ "${#TOKEN_MEMBER_PIDS[@]}" -eq 0 ]; then
    if ! read_proc_fields "$owner_pid" \
      || [ "$PROC_START_TICKS" != "$owner_pid_start_ticks" ] \
      || [ "$PROC_STATE" = "Z" ]; then
      flock -n "$LOCK_FILE" -c true && exit 0
    fi
  fi
  sleep 1
done

validate_group_members || exit 1
if [ "$GROUP_MEMBER_COUNT" -gt 0 ]; then
  kill -KILL -- "-$owner_pgid" 2>/dev/null || true
fi
signal_token_members KILL
if read_proc_fields "$owner_pid" \
  && [ "$PROC_START_TICKS" = "$owner_pid_start_ticks" ] \
  && [ "$PROC_STATE" != "Z" ]; then
  kill -KILL "$owner_pid" 2>/dev/null || true
fi

for _ in $(seq 1 10); do
  flock -n "$LOCK_FILE" -c true && exit 0
  sleep 0.2
done
echo "Nav2 owner cleanup left the runtime lock held." >&2
exit 1
