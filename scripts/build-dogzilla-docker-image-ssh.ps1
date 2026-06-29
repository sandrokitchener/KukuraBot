param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [string]$DockerImage = "robodoge/ros-humble-cartographer:1.0",
  [string]$BaseDockerImage = "yahboomtechnology/ros-humble:3.6",
  [switch]$NoSync,
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
  -Port $SshPort `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$remoteRootQuoted = ConvertTo-RemoteSingleQuote $RemoteRoot
$remoteSetup = "sudo mkdir -p $remoteRootQuoted/sidecars/dogzilla_map_pose && sudo chown -R ${User}:${User} $remoteRootQuoted/sidecars"
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteSetup
if ($LASTEXITCODE -ne 0) {
  throw "remote setup for docker build failed"
}

if (-not $NoSync) {
  $mapPoseSource = Join-Path $repoRoot "sidecars\dogzilla_map_pose"
  Write-Output "Copying sidecars\dogzilla_map_pose -> ${Alias}:$RemoteRoot/sidecars/"
  & scp -r -F $configPath $mapPoseSource "${Alias}:$RemoteRoot/sidecars/"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed for dogzilla_map_pose sidecar"
  }
}

Repair-RemoteScriptLineEndings -ConfigPath $configPath -Alias $Alias -RemoteRoot $RemoteRoot

Write-Output "Building DOGZILLA Cartographer/Nav2 Docker image on $Alias."
Write-Output "Base image: $BaseDockerImage"
Write-Output "Target image: $DockerImage"

$dockerfileDir = "$RemoteRoot/sidecars/dogzilla_map_pose"
$buildCommand = "docker pull $BaseDockerImage && docker build -t $DockerImage -f $dockerfileDir/Dockerfile $dockerfileDir"

# Docker build writes progress output to stderr, which PowerShell treats as an
# error. Suppress the error-action while the build runs and check the exit code.
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $buildCommand
  $buildExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousErrorAction
}
if ($buildExitCode -ne 0) {
  throw "DOCKER_BUILD_FAILED: Failed to build $DockerImage on $Alias (exit $buildExitCode)"
}

Write-Output "Verifying built image..."
$verifyCommand = "docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep '$DockerImage'"
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $verifyCommand
if ($LASTEXITCODE -ne 0) {
  throw "DOCKER_VERIFY_FAILED: Image $DockerImage not found after build"
}

Write-Output "Built and verified $DockerImage on $Alias."
Write-Output "Next: re-run install-dogzilla-boot-services-ssh.ps1 to use the new image in systemd services."
