param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$Port = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

Require-LocalCommand ssh
Require-LocalCommand scp

$repoRoot = Resolve-RoboDogeRoot
$configPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $Port `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$remoteRootQuoted = ConvertTo-RemoteSingleQuote $RemoteRoot
$mkdirCommand = "mkdir -p $remoteRootQuoted $remoteRootQuoted/sidecars $remoteRootQuoted/ros2 $remoteRootQuoted/config $remoteRootQuoted/docs"
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $mkdirCommand

$directories = @(
  @{ Source = "sidecars\ros2_bridge"; Destination = "$RemoteRoot/sidecars/" },
  @{ Source = "sidecars\dogzilla_lib_bridge"; Destination = "$RemoteRoot/sidecars/" },
  @{ Source = "sidecars\dogzilla_yolo_vision"; Destination = "$RemoteRoot/sidecars/" },
  @{ Source = "ros2\dogzilla_bridge"; Destination = "$RemoteRoot/ros2/" }
)

$files = @(
  @{ Source = "config\robot-ros2.json"; Destination = "$RemoteRoot/config/" },
  @{ Source = "config\robot-motion.json"; Destination = "$RemoteRoot/config/" },
  @{ Source = "config\robot-actions.json"; Destination = "$RemoteRoot/config/" },
  @{ Source = "docs\dogzilla-hardware-adapter.md"; Destination = "$RemoteRoot/docs/" },
  @{ Source = "docs\dogzilla-ssh-workflow.md"; Destination = "$RemoteRoot/docs/" }
)

foreach ($item in $directories) {
  $sourcePath = Join-Path $repoRoot $item.Source
  if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "Missing local path: $sourcePath"
  }

  Write-Host "Copying $($item.Source) -> ${Alias}:$($item.Destination)"
  & scp -r -F $configPath $sourcePath "${Alias}:$($item.Destination)"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed for $($item.Source)"
  }
}

foreach ($item in $files) {
  $sourcePath = Join-Path $repoRoot $item.Source
  if (-not (Test-Path -LiteralPath $sourcePath)) {
    Write-Host "Skipping missing optional file: $($item.Source)"
    continue
  }

  Write-Host "Copying $($item.Source) -> ${Alias}:$($item.Destination)"
  & scp -F $configPath $sourcePath "${Alias}:$($item.Destination)"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed for $($item.Source)"
  }
}

Write-Host "Bridge files synced to ${Alias}:$RemoteRoot"
