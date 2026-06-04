param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

$configPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $SshPort `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$remoteRootQuoted = ConvertTo-RemoteSingleQuote $RemoteRoot
$remoteCommand = @"
ROBO_DOGE_REMOTE_ROOT=$remoteRootQuoted python3 - <<'PY'
import os
import signal
import time

TARGETS = (
    "/home/pi/DOGZILLA/app_dogzilla/app_dogzilla.py",
    "/home/pi/DOGZILLA/app_dogzilla/oled_dogzilla.py",
)


def parent_pid(pid):
    try:
        with open(f"/proc/{pid}/status", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("PPid:"):
                    return int(line.split()[1])
    except OSError:
        return 0
    return 0


def ancestry(pid):
    seen = set()
    while pid > 1 and pid not in seen:
        seen.add(pid)
        pid = parent_pid(pid)
    return seen


def process_cmdline(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as handle:
            raw = handle.read()
    except OSError:
        return ""
    return raw.replace(b"\x00", b" ").decode("utf-8", errors="replace").strip()


excluded = ancestry(os.getpid()) | {os.getpid(), os.getppid()}
matches = []
for name in os.listdir("/proc"):
    if not name.isdigit():
        continue
    pid = int(name)
    if pid in excluded:
        continue
    cmdline = process_cmdline(pid)
    if not cmdline:
        continue
    if any(target in cmdline for target in TARGETS):
        matches.append((pid, cmdline))

stopped = []
for pid, cmdline in sorted(matches):
    try:
        os.kill(pid, signal.SIGTERM)
        stopped.append(pid)
        print(f"stopped vendor DOGZILLA app {pid}: {cmdline}")
    except ProcessLookupError:
        pass

time.sleep(0.8)
for pid in stopped:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        continue
    os.kill(pid, signal.SIGKILL)
    print(f"force-stopped vendor DOGZILLA app {pid}")

root = os.environ.get("ROBO_DOGE_REMOTE_ROOT", "/home/pi/robodoge").rstrip("/")
pid_path = f"{root}/logs/vendor-app.pid"
try:
    os.remove(pid_path)
except FileNotFoundError:
    pass
except OSError as error:
    print(f"vendor pid cleanup skipped: {error}")

if not stopped:
    print("vendor DOGZILLA app not running")
PY
"@

Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
exit $LASTEXITCODE
