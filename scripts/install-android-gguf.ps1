param(
  [string]$ModelPath = "models/NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf",
  [string]$PackageId = "com.robodoge.console",
  [string]$DeviceModelDir = "/sdcard/Android/data/com.robodoge.console/files/models"
)

$ErrorActionPreference = "Stop"

$resolvedModelPath = Resolve-Path -LiteralPath $ModelPath
$modelFileName = Split-Path -Leaf $resolvedModelPath
$deviceModelPath = "$DeviceModelDir/$modelFileName"

Write-Host "Installing GGUF model:"
Write-Host "  local:  $resolvedModelPath"
Write-Host "  device: $deviceModelPath"

& adb shell "mkdir -p '$DeviceModelDir'"
if ($LASTEXITCODE -ne 0) {
  throw "adb shell mkdir failed. Is the device connected and authorized?"
}

& adb push "$resolvedModelPath" "$deviceModelPath"
if ($LASTEXITCODE -ne 0) {
  throw "adb push failed. If Android blocks /sdcard/Android/data access, reinstall the debug APK and retry while the app package exists."
}

$deviceListing = & adb shell "ls -lh '$deviceModelPath'"
if ($LASTEXITCODE -ne 0) {
  throw "Model push finished but device path was not readable: $deviceModelPath"
}

Write-Host ""
Write-Host "Model installed for ${PackageId}:"
Write-Host $deviceListing
Write-Host ""
Write-Host "Use this Android modelPath in config/model-profiles.json:"
Write-Host $deviceModelPath
