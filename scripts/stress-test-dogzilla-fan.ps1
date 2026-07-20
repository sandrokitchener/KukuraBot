param(
  [string]$Label = "fan-test",
  [ValidateRange(10, 3600)]
  [int]$DurationSeconds = 300,
  [ValidateRange(5, 300)]
  [int]$SampleIntervalSeconds = 15,
  [switch]$SkipStartup,
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"

function Get-TestSummary {
  param([object[]]$Samples)

  $temperatureSamples = @($Samples | Where-Object { $null -ne $_.temperatureC })
  $batterySamples = @($Samples | Where-Object { $null -ne $_.batteryPercent -and $_.batteryReadStatus -eq "ok" })
  if ($temperatureSamples.Count -eq 0) { throw "No valid temperature samples were collected." }
  if ($batterySamples.Count -lt 2) { throw "At least two fresh battery samples are required." }

  $startBattery = [double]$batterySamples[0].batteryPercent
  $endBattery = [double]$batterySamples[-1].batteryPercent
  $startTemp = [double]$temperatureSamples[0].temperatureC
  $endTemp = [double]$temperatureSamples[-1].temperatureC
  $maxTemp = ($temperatureSamples | Measure-Object -Property temperatureC -Maximum).Maximum
  $maxLoad = ($temperatureSamples | Measure-Object -Property load1 -Maximum).Maximum

  [pscustomobject]@{
    validTemperatureSamples = $temperatureSamples.Count
    validBatterySamples = $batterySamples.Count
    startTemperatureC = $startTemp
    endTemperatureC = $endTemp
    maxTemperatureC = [double]$maxTemp
    temperatureRiseC = [math]::Round($endTemp - $startTemp, 1)
    startBatteryPercent = $startBattery
    endBatteryPercent = $endBattery
    batteryDrainPercent = [math]::Round($startBattery - $endBattery, 1)
    maxLoad1 = if ($null -eq $maxLoad) { $null } else { [double]$maxLoad }
    throttleFlags = @($temperatureSamples.throttled | Where-Object { $_ } | Sort-Object -Unique)
  }
}

if ($SelfTest) {
  $summary = Get-TestSummary -Samples @(
    [pscustomobject]@{ temperatureC = 70.0; batteryPercent = 100.0; batteryReadStatus = "ok"; load1 = 1.0; throttled = "0x0" },
    [pscustomobject]@{ temperatureC = 76.5; batteryPercent = 98.0; batteryReadStatus = "ok"; load1 = 2.0; throttled = "0x0" }
  )
  if ($summary.maxTemperatureC -ne 76.5 -or $summary.batteryDrainPercent -ne 2.0 -or $summary.temperatureRiseC -ne 6.5) {
    throw "Self-test failed."
  }
  "Self-test passed."
  return
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$connectionPath = Join-Path $repoRoot "config\dogzilla-connection.json"
$connection = Get-Content -Raw -LiteralPath $connectionPath | ConvertFrom-Json
$directBaseUrl = [string]$connection.bridges.direct.baseUrl
$sshConfigPath = Join-Path $repoRoot "output\pi-ssh\config"
$outputDir = Join-Path $repoRoot "output\fan-tests"
$safeLabel = ($Label.Trim() -replace '[^A-Za-z0-9._-]+', '-')
if (-not $safeLabel) { $safeLabel = "fan-test" }
$startedAt = [DateTime]::UtcNow
$reportPath = Join-Path $outputDir ("{0}-{1}.json" -f $safeLabel, $startedAt.ToString("yyyyMMdd-HHmmss"))
$initialMode = $null
$engagedEmergencyStop = $false
$samples = [System.Collections.Generic.List[object]]::new()

function Invoke-BridgeJson {
  param(
    [string]$Path,
    [ValidateSet("Get", "Post")]
    [string]$Method = "Get",
    [object]$Body = $null
  )

  $params = @{
    Uri = "$directBaseUrl$Path"
    Method = $Method
    TimeoutSec = 20
  }
  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = $Body | ConvertTo-Json -Depth 8 -Compress
  }
  Invoke-RestMethod @params
}

function Set-EmergencyStop {
  param([bool]$Enabled)

  $reason = if ($Enabled) { "emergency_stop" } else { "clear_emergency_stop" }
  $action = if ($Enabled) { "stop" } else { "clear" }
  $result = Invoke-BridgeJson -Path "/commands" -Method Post -Body @{
    envelope = @{
      canonicalPlan = @{
        kind = "noop"
        params = @{ reason = $reason; action = $action }
      }
    }
  }
  if ($result.result.executed -ne $true) {
    $errorMessage = if ($result.result.error) { $result.result.error } else { "Emergency stop command failed." }
    throw $errorMessage
  }
}

function Get-PiSample {
  $remoteCommand = "printf 'temperatureMilliC='; cat /sys/class/thermal/thermal_zone0/temp; vcgencmd get_throttled 2>/dev/null || echo throttled=unknown; printf 'load1='; cut -d' ' -f1 /proc/loadavg"
  $lines = @(& ssh -n -F $sshConfigPath ([string]$connection.ssh.alias) $remoteCommand 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Pi temperature probe failed: $($lines -join ' ')" }
  $values = $lines | ConvertFrom-StringData
  [pscustomobject]@{
    temperatureC = [math]::Round(([double]$values.temperatureMilliC / 1000), 1)
    throttled = [string]$values.throttled
    load1 = [double]$values.load1
  }
}

function Get-FreshBatteryState {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $state = Invoke-BridgeJson -Path "/state"
    if ($state.batteryUnit -eq "percent" -and $state.batteryReadStatus -eq "ok") { return $state }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Fresh percentage battery telemetry was not available within 30 seconds."
}

function Wait-Nav2Active {
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  $lastBlockers = @()
  do {
    try {
      $health = Invoke-BridgeJson -Path "/healthz"
      $navigation = $health.runtime.navigation
      $lastBlockers = @($navigation.blockers)
      if (
        $health.navMode -eq "navigate" -and
        $navigation.stackActive -eq $true -and
        $navigation.actionServerAvailable -eq $true -and
        $navigation.odomFresh -eq $true -and
        $navigation.scanFresh -eq $true -and
        $navigation.localizationTrusted -eq $true
      ) {
        return $health
      }
    } catch {
      $lastBlockers = @($_.Exception.Message)
    }
    Start-Sleep -Seconds 5
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Nav2 did not become active within 120 seconds: $($lastBlockers -join '; ')"
}

function Get-Sample {
  param([double]$ElapsedSeconds)

  $errors = [System.Collections.Generic.List[string]]::new()
  $pi = $null
  $state = $null
  try { $pi = Get-PiSample } catch { $errors.Add($_.Exception.Message) }
  try { $state = Invoke-BridgeJson -Path "/state" } catch { $errors.Add($_.Exception.Message) }

  $temperatureC = if ($null -ne $pi) { $pi.temperatureC } else { $null }
  $load1 = if ($null -ne $pi) { $pi.load1 } else { $null }
  $throttled = if ($null -ne $pi) { $pi.throttled } else { $null }
  $batteryPercent = if ($null -ne $state -and $state.batteryUnit -eq "percent") { $state.battery } else { $null }
  $batteryReadStatus = if ($null -ne $state) { $state.batteryReadStatus } else { $null }

  [pscustomobject]@{
    collectedAt = [DateTime]::UtcNow.ToString("o")
    elapsedSeconds = [math]::Round($ElapsedSeconds, 1)
    temperatureC = $temperatureC
    load1 = $load1
    throttled = $throttled
    batteryPercent = $batteryPercent
    batteryReadStatus = $batteryReadStatus
    errors = @($errors)
  }
}

try {
  if (-not $directBaseUrl) { throw "Direct bridge base URL is missing from $connectionPath" }
  "DOGZILLA no-move thermal test: $Label"
  "Duration: $DurationSeconds seconds; interval: $SampleIntervalSeconds seconds"

  $health = Invoke-BridgeJson -Path "/healthz-lite"
  $state = Get-FreshBatteryState
  $initialMode = [string]$health.navMode
  if ($state.batterySafety.motionAllowed -ne $true) {
    $batteryError = if ($state.batterySafety.cause) { $state.batterySafety.cause } else { "Battery safety blocks the stress test." }
    throw $batteryError
  }
  if ($health.gaitBlocked -eq $true -and $health.gaitBlockedReason -ne "emergency_stop") {
    throw "Motion is already blocked by $($health.gaitBlockedReason); refusing to change that safety state."
  }

  if ($health.gaitBlockedReason -ne "emergency_stop") {
    "Engaging emergency stop for the no-move test."
    Set-EmergencyStop -Enabled $true
    $engagedEmergencyStop = $true
  } else {
    "Emergency stop was already active; it will remain active after the test."
  }

  if (-not $SkipStartup) {
    "Restarting systemd-owned Cartographer localization without syncing files."
    & (Join-Path $PSScriptRoot "start-dogzilla-map-pose-ssh.ps1") `
      -PiIp ([string]$connection.ssh.host) `
      -User ([string]$connection.ssh.user) `
      -SshPort ([int]$connection.ssh.port) `
      -Alias ([string]$connection.ssh.alias) `
      -KeyPath ([string]$connection.ssh.keyPath) `
      -Mode localization `
      -RestoreOnly `
      -NoSync

    "Restarting systemd-owned Nav2 without syncing files."
    & (Join-Path $PSScriptRoot "start-dogzilla-navigation-ssh.ps1") `
      -PiIp ([string]$connection.ssh.host) `
      -User ([string]$connection.ssh.user) `
      -SshPort ([int]$connection.ssh.port) `
      -Alias ([string]$connection.ssh.alias) `
      -KeyPath ([string]$connection.ssh.keyPath) `
      -NoSync `
      -SkipReadinessWait
  } else {
    Invoke-BridgeJson -Path "/mode" -Method Post -Body @{ mode = "navigate" } | Out-Null
  }

  if (-not (Test-Path -LiteralPath $sshConfigPath)) { throw "SSH config was not created at $sshConfigPath" }
  Wait-Nav2Active | Out-Null

  "Stack ready. Starting the five-minute sample window."
  $windowStartedAt = [DateTime]::UtcNow
  $deadline = $windowStartedAt.AddSeconds($DurationSeconds)
  do {
    $elapsed = ([DateTime]::UtcNow - $windowStartedAt).TotalSeconds
    $sample = Get-Sample -ElapsedSeconds $elapsed
    $samples.Add($sample)
    "{0,6:N1}s  temp={1} C  battery={2}%  load1={3}" -f $sample.elapsedSeconds, $sample.temperatureC, $sample.batteryPercent, $sample.load1

    $remaining = ($deadline - [DateTime]::UtcNow).TotalSeconds
    if ($remaining -gt 0) {
      Start-Sleep -Seconds ([math]::Min($SampleIntervalSeconds, [math]::Ceiling($remaining)))
    }
  } while ([DateTime]::UtcNow -lt $deadline)

  $summary = Get-TestSummary -Samples @($samples)
  $finishedAt = [DateTime]::UtcNow
  New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
  [pscustomobject]@{
    label = $Label
    startedAt = $startedAt.ToString("o")
    sampleWindowStartedAt = $windowStartedAt.ToString("o")
    finishedAt = $finishedAt.ToString("o")
    requestedDurationSeconds = $DurationSeconds
    sampleIntervalSeconds = $SampleIntervalSeconds
    summary = $summary
    samples = @($samples)
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8

  ""
  "RESULT"
  "Max temperature: {0:N1} C" -f $summary.maxTemperatureC
  "Temperature rise: {0:N1} C" -f $summary.temperatureRiseC
  "Battery: {0:N1}% -> {1:N1}%" -f $summary.startBatteryPercent, $summary.endBatteryPercent
  "Battery drain: {0:N1} percentage points" -f $summary.batteryDrainPercent
  "Report: $reportPath"
} finally {
  if ($initialMode -in @("idle", "localize", "navigate", "sleep")) {
    try {
      Invoke-BridgeJson -Path "/mode" -Method Post -Body @{ mode = $initialMode } | Out-Null
      "Restored navigation mode: $initialMode"
    } catch {
      Write-Warning "Could not restore navigation mode: $($_.Exception.Message)"
    }
  }
  if ($engagedEmergencyStop) {
    try {
      Set-EmergencyStop -Enabled $false
      "Cleared the emergency stop engaged by this test."
    } catch {
      Write-Warning "Emergency stop remains active: $($_.Exception.Message)"
    }
  }
}
