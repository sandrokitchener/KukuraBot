param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$ModelPath = "",

  [string]$DataYamlPath = "",
  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [int]$Port = 8894,
  [string]$CameraUrl = "auto",
  [switch]$Background,
  [switch]$NoInstallDeps,
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

Require-LocalCommand ssh
Require-LocalCommand scp

$repoRoot = Resolve-RoboDogeRoot
$resolvedModelPath = ""
if ($ModelPath) {
  $resolvedModelPath = (Resolve-Path -LiteralPath $ModelPath).Path
  $modelFileName = Split-Path -Leaf $resolvedModelPath
  if (-not $modelFileName.ToLowerInvariant().EndsWith(".onnx")) {
    throw "ModelPath must point to an ONNX file: $resolvedModelPath"
  }
}

$resolvedDataYamlPath = ""
if ($DataYamlPath) {
  $resolvedDataYamlPath = (Resolve-Path -LiteralPath $DataYamlPath).Path
}

$configPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $SshPort `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$remoteRootQuoted = ConvertTo-RemoteSingleQuote $RemoteRoot
$remoteModelDir = "$RemoteRoot/models/dogzilla_yolo"
$remoteModelPath = "$remoteModelDir/best.onnx"
$remoteLabelsPath = "$remoteModelDir/custom.yaml"

Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "mkdir -p $remoteRootQuoted/sidecars $remoteRootQuoted/models/dogzilla_yolo $remoteRootQuoted/logs"

$sidecarSource = Join-Path $repoRoot "sidecars\dogzilla_yolo_vision"
Write-Host "Copying sidecars\dogzilla_yolo_vision -> ${Alias}:$RemoteRoot/sidecars/"
& scp -r -F $configPath $sidecarSource "${Alias}:$RemoteRoot/sidecars/"
if ($LASTEXITCODE -ne 0) {
  throw "scp failed for dogzilla_yolo_vision sidecar"
}

if ($resolvedModelPath) {
  Write-Host "Copying YOLO ONNX model -> ${Alias}:$remoteModelPath"
  & scp -F $configPath $resolvedModelPath "${Alias}:$remoteModelPath"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed for YOLO ONNX model"
  }
} else {
  Write-Host "Using existing remote YOLO ONNX model: $remoteModelPath"
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "test -s '$remoteModelPath'"
  if ($LASTEXITCODE -ne 0) {
    throw "Remote YOLO ONNX model missing. Provide -ModelPath once to sync it to $remoteModelPath."
  }
}

if ($resolvedDataYamlPath) {
  Write-Host "Copying YOLO labels -> ${Alias}:$remoteLabelsPath"
  & scp -F $configPath $resolvedDataYamlPath "${Alias}:$remoteLabelsPath"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed for YOLO labels"
  }
} else {
  Write-Host "Using existing remote YOLO labels: $remoteLabelsPath"
}

$installCommand = "python3 - <<'PY'
import importlib.util
import sys
missing=[m for m in ['cv2','numpy','onnxruntime'] if importlib.util.find_spec(m) is None]
if missing:
    print('missing:' + ','.join(missing))
    sys.exit(42)
print('deps-ok')
PY"

$installResult = Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $installCommand
if ($LASTEXITCODE -ne 0) {
  if ($NoInstallDeps) {
    throw "Pi is missing required Python vision dependencies. Re-run without -NoInstallDeps to install onnxruntime."
  }

  Write-Host "Installing missing Pi Python dependency: onnxruntime"
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "python3 -m pip install --user --break-system-packages onnxruntime"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install onnxruntime on Pi."
  }
}

$effectiveCameraUrl = if ($CameraUrl) { $CameraUrl } else { "auto" }
if ($effectiveCameraUrl -eq "auto") {
  $detectCameraCommand = @'
for candidate in /dev/v4l/by-id/*video-index0 /dev/video0 /dev/video1 /dev/video2 /dev/video3; do
  if [ -e "$candidate" ]; then
    printf '%s' "$candidate"
    exit 0
  fi
done
printf '/dev/video0'
'@
  $effectiveCameraUrl = Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $detectCameraCommand
  $effectiveCameraUrl = ($effectiveCameraUrl | Out-String).Trim()
  if (-not $effectiveCameraUrl) {
    $effectiveCameraUrl = "/dev/video0"
  }
  Write-Host "Auto-selected DOGZILLA YOLO camera source: $effectiveCameraUrl"
}
$usesHttpCamera = $effectiveCameraUrl.StartsWith("http://") -or $effectiveCameraUrl.StartsWith("https://")
$cameraControlArgs = if ($usesHttpCamera) {
  $cameraHost = if ($PiIp) { $PiIp } else { "127.0.0.1" }
  "--camera-control-host $cameraHost --camera-control-port 6000"
} else {
  "--camera-control-host '' --camera-control-port 0"
}
$serverCommand = "export PYTHONUNBUFFERED=1; cd $RemoteRoot && python3 sidecars/dogzilla_yolo_vision/server.py --host 0.0.0.0 --port $Port --model $remoteModelPath --labels $remoteLabelsPath --camera-url $effectiveCameraUrl $cameraControlArgs"

$releaseVendorCameraCommand = "true"
if (-not $usesHttpCamera) {
  $releaseVendorCameraCommand = @'
python3 - <<'PY'
import os, signal, subprocess, time
camera_source = os.environ.get('ROBO_DOGE_CAMERA_SOURCE', '')
camera_realpath = os.path.realpath(camera_source) if camera_source else ''
try:
    rows = subprocess.check_output(['pgrep', '-af', '/home/pi/DOGZILLA/app_dogzilla/app_dogzilla.py'], text=True).splitlines()
except subprocess.CalledProcessError:
    rows = []
for row in rows:
    pid = int(row.split()[0])
    if pid in (os.getpid(), os.getppid()):
        continue
    try:
        comm = open(f'/proc/{pid}/comm', encoding='utf-8').read().strip()
    except OSError:
        continue
    if comm.startswith('python'):
        os.kill(pid, signal.SIGTERM)
        print(f'stopped vendor camera app {pid}')
camera_consumers = set()
if camera_realpath:
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        pid = int(name)
        if pid in (os.getpid(), os.getppid()):
            continue
        fd_dir = f'/proc/{pid}/fd'
        try:
            comm = open(f'/proc/{pid}/comm', encoding='utf-8').read().strip()
        except OSError:
            continue
        if comm not in ('pipewire', 'wireplumber'):
            continue
        try:
            fd_names = os.listdir(fd_dir)
        except OSError:
            continue
        for fd_name in fd_names:
            try:
                target = os.path.realpath(os.readlink(f'{fd_dir}/{fd_name}'))
            except OSError:
                continue
            if target == camera_realpath:
                camera_consumers.add((pid, comm))
                break
for pid, comm in sorted(camera_consumers):
    try:
        os.kill(pid, signal.SIGTERM)
        print(f'stopped camera desktop consumer {comm} {pid}')
    except ProcessLookupError:
        pass
if rows or camera_consumers:
    time.sleep(1)
PY
'@
  $releaseCameraScript = ConvertTo-RemoteSingleQuote $releaseVendorCameraCommand.Trim()
  $releaseCameraSource = ConvertTo-RemoteSingleQuote $effectiveCameraUrl
  $releaseVendorCameraCommand = "ROBO_DOGE_CAMERA_SOURCE=$releaseCameraSource bash -lc $releaseCameraScript"
}

if ($Background) {
  $serverCommandQuoted = ConvertTo-RemoteSingleQuote $serverCommand
  $stopCommand = @'
python3 - <<'PY'
import os, signal, subprocess, time
try:
    rows = subprocess.check_output(['pgrep', '-af', 'sidecars/dogzilla_yolo_vision/server.py'], text=True).splitlines()
except subprocess.CalledProcessError:
    rows = []
stopped = []
for row in rows:
    pid = int(row.split()[0])
    try:
        comm = open(f'/proc/{pid}/comm', encoding='utf-8').read().strip()
    except OSError:
        continue
    if comm.startswith('python'):
        os.kill(pid, signal.SIGTERM)
        stopped.append(pid)
        print(f'stopped yolo vision {pid}')
time.sleep(0.8)
for pid in stopped:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        continue
    os.kill(pid, signal.SIGKILL)
    print(f'force-stopped yolo vision {pid}')
PY
'@
  $stopCommand = $stopCommand.Trim()
  $stopCommandQuoted = ConvertTo-RemoteSingleQuote $stopCommand
  $remoteCommand = "cd $remoteRootQuoted && mkdir -p logs && $releaseVendorCameraCommand && if [ -f logs/yolo-vision.pid ]; then kill `$(cat logs/yolo-vision.pid) 2>/dev/null || true; fi && bash -lc $stopCommandQuoted && sleep 1; (nohup bash -lc $serverCommandQuoted > logs/yolo-vision.log 2>&1 < /dev/null & echo `$! > logs/yolo-vision.pid) && sleep 2 && cat logs/yolo-vision.pid && tail -n 20 logs/yolo-vision.log"
  Write-Host "Starting DOGZILLA YOLO vision sidecar on $Alias port $Port in remote background."
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
  exit $LASTEXITCODE
}

$remoteCommand = "cd $remoteRootQuoted && $releaseVendorCameraCommand && $serverCommand"
Write-Host "Starting DOGZILLA YOLO vision sidecar on $Alias port $Port. This SSH session stays attached."
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
