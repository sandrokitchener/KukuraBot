param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$ModelPath = "",
  [string]$DataYamlPath = "",
  [string[]]$SearchRoot = @(),
  [string]$User = "",
  [int]$SshPort = 0,
  [string]$Alias = "",
  [string]$KeyPath = "",
  [string]$RemoteRoot = "",
  [int]$VisionPort = 0,
  [string]$CameraUrl = "",
  [switch]$NoInstallDeps,
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

function Resolve-OptionalPath {
  param([string]$Path)

  if (-not $Path) {
    return ""
  }

  return (Resolve-Path -LiteralPath $Path).Path
}

function Get-ConfigValue {
  param(
    [object]$Object,
    [string[]]$Path,
    [object]$Fallback
  )

  $current = $Object
  foreach ($part in $Path) {
    if ($null -eq $current) {
      return $Fallback
    }

    $property = $current.PSObject.Properties[$part]
    if ($null -eq $property) {
      return $Fallback
    }

    $current = $property.Value
  }

  if ($null -eq $current -or $current -eq "") {
    return $Fallback
  }

  return $current
}

function Find-LatestOnnx {
  param([string[]]$Roots)

  $existingRoots = @(
    $Roots |
      Where-Object { $_ } |
      ForEach-Object { Resolve-OptionalPath $_ } |
      Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  )

  if (-not $existingRoots) {
    throw "No ONNX search roots exist. Pass -SearchRoot or -ModelPath."
  }

  $excluded = '\\.venv\\|\\node_modules\\|\\site-packages\\|\\__pycache__\\'
  $matches = Get-ChildItem -Path $existingRoots -Recurse -File -Filter *.onnx -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch $excluded } |
    Sort-Object LastWriteTime -Descending

  if (-not $matches) {
    throw "No ONNX files found under: $($existingRoots -join ', ')"
  }

  return $matches[0].FullName
}

function Read-TrainingDataPath {
  param([string]$ArgsYamlPath)

  if (-not (Test-Path -LiteralPath $ArgsYamlPath)) {
    return ""
  }

  $dataLine = Get-Content -LiteralPath $ArgsYamlPath |
    Where-Object { $_ -match '^\s*data\s*:\s*(.+?)\s*$' } |
    Select-Object -First 1

  if (-not $dataLine) {
    return ""
  }

  $rawValue = ($dataLine -replace '^\s*data\s*:\s*', '').Trim().Trim("'").Trim('"')
  if (-not $rawValue) {
    return ""
  }

  if ([System.IO.Path]::IsPathRooted($rawValue)) {
    return $rawValue
  }

  $parent = Split-Path -Parent $ArgsYamlPath
  return (Join-Path $parent $rawValue)
}

function Find-LabelsYaml {
  param([string]$OnnxPath)

  $weightsDir = Split-Path -Parent $OnnxPath
  $runDir = Split-Path -Parent $weightsDir
  $argsYaml = Join-Path $runDir "args.yaml"
  $dataPath = Read-TrainingDataPath -ArgsYamlPath $argsYaml

  $candidates = @()
  if ($dataPath) {
    $candidates += $dataPath
  }
  $projectDir = Split-Path -Parent $runDir
  if ($projectDir) {
    $candidates += (Join-Path $projectDir "Dataset_delivery-local-yolo26n-img640\custom.yaml")
    $candidates += (Join-Path $projectDir "custom.yaml")
  }
  $candidates += (Join-Path $runDir "custom.yaml")
  $candidates += (Join-Path $weightsDir "metadata.yaml")

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      $content = Get-Content -LiteralPath $candidate -Raw
      if ($content -match '(?m)^\s*names\s*:') {
        return (Resolve-Path -LiteralPath $candidate).Path
      }
    }
  }

  throw "Could not find matching YOLO labels YAML for $OnnxPath. Pass -DataYamlPath explicitly."
}

$repoRoot = Resolve-RoboDogeRoot
$configPath = Join-Path $repoRoot "config\dogzilla-connection.json"
$config = $null
if (Test-Path -LiteralPath $configPath) {
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
}

if (-not $PiIp) { $PiIp = Get-ConfigValue -Object $config -Path @("ssh", "host") -Fallback "" }
if (-not $User) { $User = Get-ConfigValue -Object $config -Path @("ssh", "user") -Fallback "pi" }
if (-not $SshPort) { $SshPort = [int](Get-ConfigValue -Object $config -Path @("ssh", "port") -Fallback 22) }
if (-not $Alias) { $Alias = Get-ConfigValue -Object $config -Path @("ssh", "alias") -Fallback "dogzilla" }
if (-not $KeyPath) { $KeyPath = Get-ConfigValue -Object $config -Path @("ssh", "keyPath") -Fallback "$HOME\.ssh\robodoge_pi_ed25519" }
if (-not $RemoteRoot) { $RemoteRoot = Get-ConfigValue -Object $config -Path @("remoteRoot") -Fallback "/home/pi/robodoge" }
if (-not $VisionPort) { $VisionPort = [int](Get-ConfigValue -Object $config -Path @("vision", "port") -Fallback 8894) }
if (-not $CameraUrl) { $CameraUrl = Get-ConfigValue -Object $config -Path @("vision", "sourceStreamUrl") -Fallback "/dev/video0" }

if (-not $SearchRoot) {
  $documents = [Environment]::GetFolderPath("MyDocuments")
  $SearchRoot = @(
    (Join-Path $documents "Questing Beast Yolo"),
    $repoRoot
  )
}

$resolvedModelPath = Resolve-OptionalPath $ModelPath
if (-not $resolvedModelPath) {
  $resolvedModelPath = Find-LatestOnnx -Roots $SearchRoot
}

if (-not $resolvedModelPath.ToLowerInvariant().EndsWith(".onnx")) {
  throw "ModelPath must point to an ONNX file: $resolvedModelPath"
}

$resolvedDataYamlPath = Resolve-OptionalPath $DataYamlPath
if (-not $resolvedDataYamlPath) {
  $resolvedDataYamlPath = Find-LabelsYaml -OnnxPath $resolvedModelPath
}

$localModelHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedModelPath).Hash.ToLowerInvariant()
$localLabelsHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedDataYamlPath).Hash.ToLowerInvariant()

Write-Host "Latest local ONNX: $resolvedModelPath"
Write-Host "Local ONNX SHA256: $localModelHash"
Write-Host "Labels YAML: $resolvedDataYamlPath"
Write-Host "Labels SHA256: $localLabelsHash"

$startScript = Join-Path $PSScriptRoot "start-dogzilla-yolo-vision-ssh.ps1"
$startArgs = @{
  PiIp = $PiIp
  User = $User
  SshPort = $SshPort
  Alias = $Alias
  KeyPath = $KeyPath
  RemoteRoot = $RemoteRoot
  Port = $VisionPort
  CameraUrl = $CameraUrl
  ModelPath = $resolvedModelPath
  DataYamlPath = $resolvedDataYamlPath
  Background = $true
}
if ($NoInstallDeps) { $startArgs.NoInstallDeps = $true }
if ($NoHostKeyScan) { $startArgs.NoHostKeyScan = $true }

& $startScript @startArgs
if ($LASTEXITCODE -ne 0) {
  throw "Failed to update DOGZILLA YOLO ONNX."
}

$sshConfigPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $SshPort `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$remoteModelPath = "$RemoteRoot/models/dogzilla_yolo/best.onnx"
$remoteLabelsPath = "$RemoteRoot/models/dogzilla_yolo/custom.yaml"
$verifyCommand = "set -e; sha256sum '$remoteModelPath'; sha256sum '$remoteLabelsPath'; pgrep -af 'dogzilla_yolo_vision/server.py'"
$verifyOutput = & ssh -F $sshConfigPath $Alias $verifyCommand
if ($LASTEXITCODE -ne 0) {
  throw "Could not verify DOGZILLA YOLO files after update."
}

$remoteModelHash = (($verifyOutput | Select-String -Pattern "best\.onnx" | Select-Object -First 1).ToString().Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)[0]).ToLowerInvariant()
$remoteLabelsHash = (($verifyOutput | Select-String -Pattern "custom\.yaml" | Select-Object -First 1).ToString().Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)[0]).ToLowerInvariant()

if ($remoteModelHash -ne $localModelHash) {
  throw "Remote ONNX hash mismatch. local=$localModelHash remote=$remoteModelHash"
}
if ($remoteLabelsHash -ne $localLabelsHash) {
  throw "Remote labels hash mismatch. local=$localLabelsHash remote=$remoteLabelsHash"
}

$healthUrl = "http://${PiIp}:$VisionPort/healthz"
$health = $null
$lastHealthError = ""
for ($attempt = 1; $attempt -le 12; $attempt++) {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 10
    if ($health.ok -and $health.modelLoaded) {
      break
    }

    $lastHealthError = "health returned ok=$($health.ok), modelLoaded=$($health.modelLoaded), error=$($health.error)"
  } catch {
    $lastHealthError = $_.Exception.Message
  }

  Start-Sleep -Seconds 2
}

if (-not $health -or -not $health.ok -or -not $health.modelLoaded) {
  throw "YOLO health check failed at $healthUrl. Last result: $lastHealthError"
}

Write-Host "DOGZILLA YOLO ONNX updated and verified."
Write-Host "Remote model: $remoteModelPath"
Write-Host "Remote SHA256: $remoteModelHash"
Write-Host "YOLO health: ok, labels=$($health.labels -join ', '), inferenceMs=$($health.inferenceMs)"
