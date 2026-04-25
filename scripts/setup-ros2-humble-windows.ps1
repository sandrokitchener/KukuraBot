param(
  [string]$InstallRoot = 'C:\ros2_humble',
  [string]$PixiWorkspace = 'C:\pixi_ws',
  [string]$RepoRoot = '',
  [switch]$DownloadOnly,
  [switch]$SkipEnvFile
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

$assetNamePattern = 'ros2-humble-.*-windows-release-amd64\.zip'
$releaseApi = 'https://api.github.com/repos/ros2/ros2/releases'
$downloadDir = Join-Path $RepoRoot '.omx\downloads'
$envFilePath = Join-Path $RepoRoot 'scripts\ros2-humble-env.cmd'
$pixiExe = Join-Path $env:USERPROFILE '.pixi\bin\pixi.exe'

New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

Write-Host "Repo root: $RepoRoot"
Write-Host "Install root: $InstallRoot"

Write-Host 'Finding latest ROS 2 Humble Windows binary release asset...'
$releaseList = Invoke-RestMethod -Uri $releaseApi -Headers @{ 'User-Agent' = 'Robo-Doge-setup' }
$asset = $releaseList |
  ForEach-Object { $_.assets } |
  Where-Object { $_.name -match $assetNamePattern } |
  Select-Object -First 1

if (-not $asset) {
  throw 'Could not find a ROS 2 Humble Windows release asset from the GitHub releases API.'
}

$zipPath = Join-Path $downloadDir $asset.name
if (-not (Test-Path $zipPath)) {
  Write-Host "Downloading $($asset.name)..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
} else {
  Write-Host "Reusing existing download: $zipPath"
}

if (-not $DownloadOnly) {
  Write-Host 'Expanding archive...'
  Expand-Archive -LiteralPath $zipPath -DestinationPath $InstallRoot -Force

  if (-not (Test-Path $pixiExe)) {
    Write-Host 'Installing pixi...'
    powershell -ExecutionPolicy Bypass -Command "irm -useb https://pixi.sh/install.ps1 | iex"
  }

  if (-not (Test-Path $pixiExe)) {
    throw "pixi was not found after installation attempt: $pixiExe"
  }

  $resolvedRosRoot = Join-Path $InstallRoot 'ros2-windows'
  if (-not (Test-Path (Join-Path $resolvedRosRoot 'pixi.toml'))) {
    $resolvedRosRoot = $InstallRoot
  }

  if (-not (Test-Path (Join-Path $resolvedRosRoot 'pixi.toml'))) {
    throw "Could not find pixi.toml under $resolvedRosRoot"
  }

  Write-Host "Preparing pixi workspace at $PixiWorkspace..."
  New-Item -ItemType Directory -Force -Path $PixiWorkspace | Out-Null
  Copy-Item -LiteralPath (Join-Path $resolvedRosRoot 'pixi.toml') -Destination (Join-Path $PixiWorkspace 'pixi.toml') -Force

  Push-Location $PixiWorkspace
  & $pixiExe install
  Pop-Location

  $pixiPython = Join-Path $PixiWorkspace '.pixi\envs\default\python.exe'
  if (Test-Path $pixiPython) {
    Write-Host 'Installing colcon-common-extensions into pixi environment...'
    & $pixiPython -m pip install colcon-common-extensions
  }
}

if (-not $SkipEnvFile) {
  $envFile = @"
@echo off

set "ROS2_INSTALL_ROOT=$InstallRoot"
set "PIXI_ENV_ROOT=$PixiWorkspace\.pixi\envs\default"
if exist "%ROS2_INSTALL_ROOT%\ros2-windows\setup.bat" set "ROS2_INSTALL_ROOT=%ROS2_INSTALL_ROOT%\ros2-windows"
if exist "%PIXI_ENV_ROOT%\Scripts" set "PATH=%PIXI_ENV_ROOT%\Scripts;%PATH%"
if exist "%PIXI_ENV_ROOT%\Library\bin" set "PATH=%PIXI_ENV_ROOT%\Library\bin;%PATH%"
if exist "%ROS2_INSTALL_ROOT%\setup.bat" (
  call "%ROS2_INSTALL_ROOT%\setup.bat"
)

set "DOGZILLA_REPO_ROOT=$RepoRoot"
set "DOGZILLA_PLAN_TOPIC=/dogzilla/command_plan"
set "DOGZILLA_STATE_TOPIC=/dogzilla/state"
"@
  Set-Content -LiteralPath $envFilePath -Value $envFile -Encoding ASCII
  Write-Host "Wrote env helper: $envFilePath"
}

Write-Host ''
Write-Host 'Next steps:'
Write-Host "1. Run: $envFilePath"
Write-Host "2. Build bridge package: cmd /c ""call scripts\\ros2-humble-env.cmd && colcon --log-base ros2\\.log build --base-paths ros2\\dogzilla_bridge --build-base ros2\\.build --install-base ros2\\.install"""
Write-Host "3. Launch HTTP sidecar: $RepoRoot\\scripts\\launch-ros2-http-bridge.bat"
Write-Host "4. Launch bridge node: $RepoRoot\\scripts\\launch-ros2-dogzilla-bridge.bat"
