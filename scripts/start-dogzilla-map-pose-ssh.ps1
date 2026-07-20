param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [string]$ContainerName = "robodoge-map-pose",
  [int]$RosDomainId = 16,
  [int]$PosePort = 9090,
  [ValidateSet("auto", "localization", "mapping", "continue_mapping")]
  [string]$Mode = "auto",
  [string]$MapPath = "",
  [switch]$AllowMapping,
  [switch]$ForceRestart,
  [switch]$RestoreOnly,
  [switch]$NoSync,
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

Require-LocalCommand ssh
Require-LocalCommand scp

$repoRoot = Resolve-RoboDogeRoot
$mapMetadataSource = Join-Path $repoRoot "sidecars\dogzilla_lib_bridge\map_metadata.py"
if (!(Test-Path -LiteralPath $mapMetadataSource)) {
  throw "Shared map metadata validator not found at $mapMetadataSource"
}
$configPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $SshPort `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$remoteRootQuoted = ConvertTo-RemoteSingleQuote $RemoteRoot
if (-not $NoSync) {
  $remoteSetup = "sudo install -d -o $User -g $User $remoteRootQuoted/maps $remoteRootQuoted/logs $remoteRootQuoted/sidecars/dogzilla_map_pose $remoteRootQuoted/sidecars/dogzilla_lib_bridge"
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteSetup
  if ($LASTEXITCODE -ne 0) { throw "remote map-pose setup failed" }
  $mapPoseSource = Join-Path $repoRoot "sidecars\dogzilla_map_pose"
  Write-Output "Copying sidecars\dogzilla_map_pose -> ${Alias}:$RemoteRoot/sidecars/"
  $runtimeFiles = @(
    Get-ChildItem -LiteralPath $mapPoseSource -File |
      Where-Object { $_.Extension -in @('.py', '.sh', '.lua') }
  )
  foreach ($file in $runtimeFiles) {
    $stageName = "robodoge-map-pose-$([guid]::NewGuid().ToString('N'))-$($file.Name)"
    $stagePath = "/tmp/$stageName"
    $remotePath = "$RemoteRoot/sidecars/dogzilla_map_pose/$($file.Name)"
    & scp -q -F $configPath $file.FullName "${Alias}:$stagePath"
    if ($LASTEXITCODE -ne 0) {
      throw "scp failed for dogzilla_map_pose file $($file.Name)"
    }
    $installMode = if ($file.Extension -eq '.sh') { '0755' } else { '0644' }
    $installCommand = "sudo install -o $User -g $User -m $installMode $(ConvertTo-RemoteSingleQuote $stagePath) $(ConvertTo-RemoteSingleQuote $remotePath) && rm -f $(ConvertTo-RemoteSingleQuote $stagePath)"
    Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $installCommand
    if ($LASTEXITCODE -ne 0) {
      throw "sudo install failed for dogzilla_map_pose file $($file.Name)"
    }
  }

  $mapMetadataStagePath = "/tmp/robodoge-map-metadata-$([guid]::NewGuid().ToString('N')).py"
  $mapMetadataRemotePath = "$RemoteRoot/sidecars/dogzilla_lib_bridge/map_metadata.py"
  Write-Output "Copying sidecars\dogzilla_lib_bridge\map_metadata.py -> ${Alias}:$mapMetadataRemotePath"
  & scp -q -F $configPath $mapMetadataSource "${Alias}:$mapMetadataStagePath"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed for shared map metadata validator"
  }
  $mapMetadataInstall = "sudo install -o $User -g $User -m 0644 $(ConvertTo-RemoteSingleQuote $mapMetadataStagePath) $(ConvertTo-RemoteSingleQuote $mapMetadataRemotePath) && rm -f $(ConvertTo-RemoteSingleQuote $mapMetadataStagePath)"
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $mapMetadataInstall
  if ($LASTEXITCODE -ne 0) {
    throw "sudo install failed for shared map metadata validator"
  }
}

Repair-RemoteScriptLineEndings -ConfigPath $configPath -Alias $Alias -RemoteRoot $RemoteRoot

Write-Output "Starting DOGZILLA Cartographer map pose in $ContainerName."
$containerScript = "$RemoteRoot/sidecars/dogzilla_map_pose/start-map-pose-in-container.sh"
$mapEnv = if ($MapPath) { " -e DOGZILLA_MAP_PBSTREAM=$MapPath" } else { "" }
$allowMappingEnv = if ($AllowMapping) { " -e DOGZILLA_MAP_POSE_ALLOW_MAPPING=1" } else { "" }
$forceRestartEnv = if ($ForceRestart) { " -e DOGZILLA_FORCE_RESTART=1" } else { "" }
$navInactiveEnv = if ($Mode -in @('mapping', 'continue_mapping')) { " -e DOGZILLA_NAV2_PROVEN_INACTIVE=1" } else { "" }
$skipRelocalizationMarker = "$RemoteRoot/maps/robodoge_map_pose_skip_relocalization"
$continueStatusPath = "$RemoteRoot/maps/robodoge_localization_status.json"
$continueReadyPath = "$RemoteRoot/maps/robodoge_map_pose_ready"
$readyReset = "rm -f $(ConvertTo-RemoteSingleQuote $continueReadyPath)"
$continueStateReset = "rm -f $(ConvertTo-RemoteSingleQuote $continueStatusPath); $readyReset"
function Wait-ContainerRunning {
  param(
    [string]$Name,
    [int]$TimeoutSec = 25
  )
  for ($i = 0; $i -lt $TimeoutSec; $i += 2) {
    $id = & ssh -n -F $configPath $Alias "docker ps --filter name=$Name --format='{{.ID}}' 2>/dev/null || true" 2>$null
    if ($id) {
      Start-Sleep -Seconds 3
      return $true
    }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Wait-ContainerReady {
  param(
    [string]$Name,
    [int]$TimeoutSec = 50
  )
  for ($i = 0; $i -lt $TimeoutSec; $i += 2) {
    $ready = & ssh -n -F $configPath $Alias "docker inspect -f '{{.State.Running}}' $Name 2>/dev/null | grep -qx true && test -e $(ConvertTo-RemoteSingleQuote $continueReadyPath) && echo ready" 2>$null
    if ($ready -match '^ready$') { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Wait-ContinueMappingProof {
  param([int]$TimeoutSec = 120)
  $statusPython = "import json,os,subprocess; p='$continueStatusPath'; x=json.load(open(p)) if os.path.isfile(p) else {}; running=subprocess.run(['docker','inspect','-f','{{.State.Running}}','$ContainerName'],capture_output=True,text=True).stdout.strip()=='true'; print(json.dumps({'trusted':x.get('trusted') is True,'phase':x.get('phase'),'error':x.get('error') or '','ready':os.path.isfile('$continueReadyPath'),'running':running}))"
  for ($i = 0; $i -lt $TimeoutSec; $i += 2) {
    $statusText = & ssh -n -F $configPath $Alias "python3 -c $(ConvertTo-RemoteSingleQuote $statusPython)" 2>$null
    if ($LASTEXITCODE -ne 0) {
      throw 'Continue Current Map could not read relocalization status from the Pi.'
    }
    try {
      $status = $statusText | Select-Object -Last 1 | ConvertFrom-Json
    } catch {
      throw "Continue Current Map received invalid relocalization status: $statusText"
    }
    if ($status.phase -eq 'error') {
      throw "Continue Current Map relocalization failed: $($status.error)"
    }
    if ($status.running -ne $true) {
      throw "Continue Current Map container '$ContainerName' exited before startup completed."
    }
    if ($status.trusted -eq $true -and $status.ready -eq $true) { return }
    Start-Sleep -Seconds 2
  }
  throw "Continue Current Map relocalization did not prove the robot pose within $TimeoutSec seconds."
}

if ($Mode -in @('mapping', 'continue_mapping')) {
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand 'sudo systemctl stop robodoge-navigation.service; ! sudo systemctl is-active --quiet robodoge-navigation.service'
  if ($LASTEXITCODE -ne 0) { throw 'Mapping handoff could not prove Nav2 inactive before Cartographer startup.' }
}

$relocalizeNav2Arg = if ($Mode -eq 'localization') { " --no-pause-nav2" } else { "" }
$relocalizeCommand = "docker exec -e REMOTE_ROOT=$RemoteRoot -e ROS_DOMAIN_ID=$RosDomainId $ContainerName bash -lc 'source /opt/ros/humble/setup.bash; source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true; python3 $RemoteRoot/sidecars/dogzilla_map_pose/relocalize_on_frozen_map.py --remote-root $RemoteRoot$relocalizeNav2Arg'"
$stopNavigationCommand = "sudo systemctl stop robodoge-navigation.service; ! sudo systemctl is-active --quiet robodoge-navigation.service"
$restartNavigationCommand = "sudo systemctl reset-failed robodoge-navigation.service; sudo systemctl start robodoge-navigation.service"
$skipMarkerCommand = "printf '%s\\n' '$Mode' > $(ConvertTo-RemoteSingleQuote $skipRelocalizationMarker)"
$clearSkipMarkerCommand = "rm -f $(ConvertTo-RemoteSingleQuote $skipRelocalizationMarker)"
$startedInRequestedMode = $Mode -in @('mapping', 'continue_mapping')
$startedBySystemd = $false
if ($startedInRequestedMode) {
  Write-Output "Starting dedicated $Mode container..."
  $stateReset = if ($Mode -eq 'continue_mapping') { $continueStateReset } else { $readyReset }
  $startCommand = "sudo systemctl stop robodoge-map-pose.service 2>/dev/null || true; docker rm -f $ContainerName 2>/dev/null || true; $stateReset; docker run -d --rm --name $ContainerName --privileged --network host -e REMOTE_ROOT=$RemoteRoot -e POSE_PORT=$PosePort -e ROS_DOMAIN_ID=$RosDomainId -e DOGZILLA_MAP_POSE_MODE=$Mode$mapEnv$allowMappingEnv$forceRestartEnv$navInactiveEnv -v /dev:/dev -v ${RemoteRoot}:${RemoteRoot} -w $RemoteRoot robodoge/ros-humble-cartographer:1.0 bash -lc 'source /opt/ros/humble/setup.bash; source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true; bash $containerScript'"
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $startCommand
  if ($LASTEXITCODE -ne 0 -or !(Wait-ContainerRunning -Name $ContainerName -TimeoutSec 25)) {
    throw "DOGZILLA Cartographer map pose container '$ContainerName' did not become ready in $Mode mode"
  }
  if ($Mode -eq 'continue_mapping') {
    Wait-ContinueMappingProof
  } elseif (-not (Wait-ContainerReady -Name $ContainerName)) {
    throw "DOGZILLA Cartographer map pose container '$ContainerName' did not finish startup in $Mode mode"
  }
} else {
  if ($Mode -eq 'localization' -and -not $RestoreOnly) {
    Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $stopNavigationCommand
    if ($LASTEXITCODE -ne 0) {
      throw 'Localization recovery could not prove Nav2 inactive before changing map localization.'
    }
  }
  $containerState = & ssh -n -F $configPath $Alias "docker inspect -f '{{.State.Running}}' $ContainerName 2>/dev/null" 2>$null
  if ($Mode -eq 'localization') {
    Write-Output "Restarting $ContainerName in localization mode..."
    $startedBySystemd = $true
    & ssh -n -F $configPath $Alias "sudo systemctl stop robodoge-map-pose.service; $readyReset; $skipMarkerCommand; sudo systemctl reset-failed robodoge-map-pose.service; sudo systemctl start robodoge-map-pose.service || { $clearSkipMarkerCommand; exit 1; }"
    if (-not (Wait-ContainerReady -Name $ContainerName)) {
      & ssh -n -F $configPath $Alias $clearSkipMarkerCommand 2>$null
      throw "DOGZILLA Cartographer map pose container '$ContainerName' did not restart in localization mode"
    }
  } elseif ($containerState -notmatch '^true$') {
    Write-Output "Container $ContainerName not available; starting via systemd..."
    $startedBySystemd = $true
    & ssh -n -F $configPath $Alias "$readyReset; $skipMarkerCommand; sudo systemctl reset-failed robodoge-map-pose.service; sudo systemctl start robodoge-map-pose.service 2>/dev/null || { $clearSkipMarkerCommand; exit 1; }"
    if (-not (Wait-ContainerReady -Name $ContainerName)) {
      & ssh -n -F $configPath $Alias $clearSkipMarkerCommand 2>$null
      throw "DOGZILLA Cartographer map pose container '$ContainerName' did not finish systemd startup"
    }
  }
  if ($RestoreOnly) {
    if (-not $startedBySystemd) {
      Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "sudo systemctl stop robodoge-map-pose.service; $readyReset; $skipMarkerCommand; sudo systemctl reset-failed robodoge-map-pose.service; sudo systemctl start robodoge-map-pose.service || { $clearSkipMarkerCommand; exit 1; }"
      if ($LASTEXITCODE -ne 0) { throw 'DOGZILLA Cartographer map pose restore-only restart failed' }
      if (-not (Wait-ContainerReady -Name $ContainerName)) {
        & ssh -n -F $configPath $Alias $clearSkipMarkerCommand 2>$null
        throw "DOGZILLA Cartographer map pose container '$ContainerName' did not become ready after restore-only restart"
      }
    }
    Write-Output "DOGZILLA Cartographer map pose container started by systemd; no second startup transaction was launched."
    return
  }
  try {
    Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $relocalizeCommand
    if ($LASTEXITCODE -ne 0) {
      throw "DOGZILLA Cartographer global relocalization failed"
    }
  } catch {
    if ($Mode -eq 'localization' -and -not $RestoreOnly) {
      Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $restartNavigationCommand 2>$null
    }
    throw
  }
  if ($Mode -eq 'localization' -and -not $RestoreOnly) {
    Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $restartNavigationCommand
    if ($LASTEXITCODE -ne 0) {
      throw 'Localization succeeded but Nav2 could not be restarted.'
    }
  }
}
