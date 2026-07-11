param(
  [string]$ScanRoot = "C:\Users\sandr\OneDrive\Documents\SLAM App\scans",
  [Alias("Host")]
  [string]$PiIp = "",
  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [switch]$NoDeploy,
  [switch]$NoRestart,
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

# Temporary test bridge for SLAM App exports. Long term, Questing Beast app
# SLAM scanner mode should promote its own map directly.
$repoRoot = Resolve-RoboDogeRoot
$mapDir = Join-Path $repoRoot "maps"
New-Item -ItemType Directory -Force -Path $mapDir | Out-Null

$scan = Get-ChildItem -LiteralPath $ScanRoot -Directory |
  Where-Object {
    (Test-Path -LiteralPath (Join-Path $_.FullName "map.yaml")) -and
    (Test-Path -LiteralPath (Join-Path $_.FullName "map.pgm"))
  } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $scan) {
  throw "No scan folder with map.yaml and map.pgm found in $ScanRoot"
}

$sourceYaml = Join-Path $scan.FullName "map.yaml"
$sourcePgm = Join-Path $scan.FullName "map.pgm"
$destYaml = Join-Path $mapDir "robodoge_home.yaml"
$destPgm = Join-Path $mapDir "robodoge_home.pgm"
$destMetadata = Join-Path $mapDir "robodoge_home_map.json"

$yaml = Get-Content -LiteralPath $sourceYaml -Raw
if ($yaml -notmatch "(?m)^image:\s*.+$") {
  throw "map.yaml missing image field: $sourceYaml"
}
$yaml = $yaml -replace "(?m)^image:\s*.+$", "image: robodoge_home.pgm"
[System.IO.File]::WriteAllText($destYaml, $yaml, [System.Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath $sourcePgm -Destination $destPgm -Force
$yamlSha256 = (Get-FileHash -LiteralPath $destYaml -Algorithm SHA256).Hash.ToLowerInvariant()
$pgmSha256 = (Get-FileHash -LiteralPath $destPgm -Algorithm SHA256).Hash.ToLowerInvariant()

$metadata = [ordered]@{
  id = "robodoge_home"
  yaml = "robodoge_home.yaml"
  pgm = "robodoge_home.pgm"
  savedAt = (Get-Date).ToUniversalTime().ToString("o")
  source = "SLAM App"
  sourceScan = $scan.FullName
  sourceYaml = $sourceYaml
  sourcePgm = $sourcePgm
  activeAlias = "robodoge_home"
  artifacts = [ordered]@{
    yaml = [ordered]@{ path = "robodoge_home.yaml"; sha256 = $yamlSha256 }
    pgm = [ordered]@{ path = "robodoge_home.pgm"; sha256 = $pgmSha256 }
  }
  note = "External occupancy map only; no Cartographer pbstream was generated."
}
$metadataJson = $metadata | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($destMetadata, "$metadataJson`n", [System.Text.UTF8Encoding]::new($false))

Write-Output "Promoted $($scan.Name) to maps\robodoge_home.yaml and maps\robodoge_home.pgm"
Write-Output "Warning: SLAM App maps do not include a .pbstream; this updates the Nav2 map, not Cartographer localization state."

if ($NoDeploy) {
  return
}

Require-LocalCommand ssh
Require-LocalCommand scp
$configPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $SshPort `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$remoteMaps = "$RemoteRoot/maps"
$remoteMapsQuoted = ConvertTo-RemoteSingleQuote $remoteMaps
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "sudo mkdir -p $remoteMapsQuoted && sudo chown -R ${User}:${User} $remoteMapsQuoted"
if ($LASTEXITCODE -ne 0) {
  throw "remote map directory setup failed"
}

& scp -F $configPath $destYaml $destPgm $destMetadata "${Alias}:$remoteMaps/"
if ($LASTEXITCODE -ne 0) {
  throw "map deploy failed"
}
Write-Output "Deployed Nav2 map aliases to ${Alias}:$remoteMaps/"

if (-not $NoRestart) {
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "sudo systemctl restart robodoge-navigation.service"
  if ($LASTEXITCODE -ne 0) {
    throw "robodoge-navigation.service restart failed"
  }
  Write-Output "Restarted robodoge-navigation.service"
}
