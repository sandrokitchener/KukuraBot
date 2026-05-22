$ErrorActionPreference = "Stop"

$modelDir = Join-Path (Resolve-Path ".") "models"
$modelFile = "NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf"
$modelPath = Join-Path $modelDir $modelFile
$modelUrl = "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF/resolve/main/$modelFile`?download=true"

New-Item -ItemType Directory -Force -Path $modelDir | Out-Null

if (Test-Path -LiteralPath $modelPath) {
  Write-Host "Already downloaded: $modelPath"
} else {
  curl.exe -L --fail --continue-at - --output $modelPath $modelUrl
}

Get-Item -LiteralPath $modelPath | Format-List FullName,Length,LastWriteTime
