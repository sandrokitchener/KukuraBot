param(
  [string]$BridgeBaseUrl = "http://192.168.8.88:8892",
  [ValidateSet("health", "feedback", "reset", "sit", "stand", "lie_down", "stretch", "three_axis", "swing", "pee", "crawl", "pray")]
  [string]$Command = "health",
  [int]$TimeoutSec = 8
)

$ErrorActionPreference = "Stop"

function Join-Url([string]$Base, [string]$Path) {
  return "$($Base.TrimEnd('/'))/$($Path.TrimStart('/'))"
}

function Invoke-JsonPost([string]$Url, [object]$Body) {
  $json = $Body | ConvertTo-Json -Depth 20
  Invoke-RestMethod -Uri $Url -Method Post -ContentType "application/json" -Body $json -TimeoutSec $TimeoutSec
}

$actionMap = @{
  reset      = @{ actionId = 255; trick = "reset_pose" }
  sit        = @{ actionId = 12; trick = "sit_down" }
  stand      = @{ actionId = 2; trick = "stand_up" }
  lie_down   = @{ actionId = 1; trick = "lie_down" }
  stretch    = @{ actionId = 14; trick = "startup_stretch" }
  three_axis = @{ actionId = 10; trick = "three_axis" }
  swing      = @{ actionId = 16; trick = "swing" }
  pee        = @{ actionId = 11; trick = "pee" }
  crawl      = @{ actionId = 3; trick = "crawl" }
  pray       = @{ actionId = 17; trick = "pray" }
}

if ($Command -eq "health") {
  Invoke-RestMethod -Uri (Join-Url $BridgeBaseUrl "/healthz") -Method Get -TimeoutSec $TimeoutSec
  exit 0
}

if ($Command -eq "feedback") {
  Invoke-RestMethod -Uri (Join-Url $BridgeBaseUrl "/feedback") -Method Get -TimeoutSec $TimeoutSec
  exit 0
}

$action = $actionMap[$Command]
$canonicalPlan = @{
  kind = "action.once"
  params = @{
    actionId = $action.actionId
    trick = $action.trick
    verified = $true
  }
}

$envelope = @{
  status = "ready"
  source = "scripts/probe-dogzilla-bridge.ps1"
  rawText = "manual $Command test"
  action = "dogzilla.perform_action"
  canonicalPlan = $canonicalPlan
  payload = @{
    canonicalPlan = $canonicalPlan
  }
}

Invoke-JsonPost (Join-Url $BridgeBaseUrl "/commands") @{ envelope = $envelope }
