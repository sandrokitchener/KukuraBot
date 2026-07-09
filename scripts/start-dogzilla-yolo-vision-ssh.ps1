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
  [switch]$DetectionEnabled,
  [switch]$Background,
  [switch]$NoSync,
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

if (-not $NoSync) {
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
  }

  if ($resolvedDataYamlPath) {
    Write-Host "Copying YOLO labels -> ${Alias}:$remoteLabelsPath"
    & scp -F $configPath $resolvedDataYamlPath "${Alias}:$remoteLabelsPath"
    if ($LASTEXITCODE -ne 0) {
      throw "scp failed for YOLO labels"
    }
  }
}

if ($DetectionEnabled -and -not $resolvedModelPath) {
  Write-Host "Using existing remote YOLO ONNX model: $remoteModelPath"
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "test -s '$remoteModelPath'"
  if ($LASTEXITCODE -ne 0) {
    throw "Remote YOLO ONNX model missing. Provide -ModelPath once to sync it to $remoteModelPath."
  }
}

if ($DetectionEnabled -and -not $resolvedDataYamlPath) {
  Write-Host "Using existing remote YOLO labels: $remoteLabelsPath"
}

$pythonModules = if ($DetectionEnabled) { "'cv2','numpy','onnxruntime'" } else { "'cv2','numpy'" }
$installProbe = "import importlib.util, sys; missing=[m for m in ($pythonModules) if importlib.util.find_spec(m) is None]; print('missing:' + ','.join(missing) if missing else 'deps-ok'); sys.exit(42 if missing else 0)"
$installProbeQuoted = ConvertTo-RemoteSingleQuote $installProbe
$installCommand = "python3 -c $installProbeQuoted"

$installResult = Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $installCommand
if ($LASTEXITCODE -ne 0) {
  if ($NoInstallDeps) {
    throw "Pi is missing required Python vision dependencies. Re-run without -NoInstallDeps to install onnxruntime."
  }

  $installPackage = if ($DetectionEnabled) { "onnxruntime" } else { "opencv-python numpy" }
  Write-Host "Installing missing Pi Python vision dependency: $installPackage"
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "python3 -m pip install --user --break-system-packages $installPackage"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install onnxruntime on Pi."
  }
}

$effectiveCameraUrl = if ($CameraUrl) { $CameraUrl } else { "auto" }
if ($effectiveCameraUrl -eq "auto") {
  $detectCameraCommand = 'for candidate in /dev/v4l/by-id/*video-index0 /dev/video0 /dev/video1 /dev/video2 /dev/video3; do if [ -e "$candidate" ]; then printf "%s" "$candidate"; exit 0; fi; done; printf "/dev/video0"'
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
$detectionFlag = if ($DetectionEnabled) { "--detection-enabled" } else { "--raw-stream" }
$serverCommand = "export PYTHONUNBUFFERED=1; cd $RemoteRoot && python3 sidecars/dogzilla_yolo_vision/server.py --host 0.0.0.0 --port $Port --model $remoteModelPath --labels $remoteLabelsPath --camera-url $effectiveCameraUrl $cameraControlArgs $detectionFlag"

$releaseVendorCameraCommand = "true"
if (-not $usesHttpCamera) {
  $releaseCameraSource = ConvertTo-RemoteSingleQuote $effectiveCameraUrl
  $releaseVendorCameraCommand = "pkill -TERM -f '[a]pp_dogzilla.py' 2>/dev/null || true; if command -v fuser >/dev/null 2>&1; then fuser -k $releaseCameraSource 2>/dev/null || true; fi; sleep 1"
}

if ($Background) {
  $serverCommandQuoted = ConvertTo-RemoteSingleQuote $serverCommand
  $stopPattern = "[s]idecars/dogzilla_yolo_vision/server.py"
  $stopPatternQuoted = ConvertTo-RemoteSingleQuote $stopPattern
  $stopCommand = 'for pid in $(pgrep -f ' + $stopPatternQuoted + ' 2>/dev/null || true); do if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then continue; fi; kill -TERM "$pid" 2>/dev/null || true; done; sleep 0.8; for pid in $(pgrep -f ' + $stopPatternQuoted + ' 2>/dev/null || true); do if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then continue; fi; kill -KILL "$pid" 2>/dev/null || true; done'
  $stopCommandQuoted = ConvertTo-RemoteSingleQuote $stopCommand
  $remoteCommand = "cd $remoteRootQuoted && mkdir -p logs && $releaseVendorCameraCommand && if [ -f logs/yolo-vision.pid ]; then kill `$(cat logs/yolo-vision.pid) 2>/dev/null || true; fi && bash -lc $stopCommandQuoted && sleep 1; (nohup bash -lc $serverCommandQuoted > logs/yolo-vision.log 2>&1 < /dev/null & echo `$! > logs/yolo-vision.pid) && sleep 2 && cat logs/yolo-vision.pid && tail -n 20 logs/yolo-vision.log"
  Write-Host "Starting DOGZILLA YOLO vision sidecar on $Alias port $Port in remote background."
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
  exit $LASTEXITCODE
}

$remoteCommand = "cd $remoteRootQuoted && $releaseVendorCameraCommand && $serverCommand"
Write-Host "Starting DOGZILLA YOLO vision sidecar on $Alias port $Port. This SSH session stays attached."
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
