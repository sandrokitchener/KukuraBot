import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROBO_DOGE_LOCAL_PORTS = [3037, 8891, 8892, 8893, 8894, 8895, 8896, 5037]

await resetLocalRuntime()
await import('../run.mjs')

async function resetLocalRuntime({
  ports = ROBO_DOGE_LOCAL_PORTS,
  execFileImpl = execFileAsync,
  logger = console,
} = {}) {
  const result = process.platform === 'win32'
    ? await resetWindowsRuntime({ ports, execFileImpl })
    : await resetPosixRuntime({ ports, execFileImpl })

  if (result.stopped.length > 0) {
    logger.log?.(`Clean startup reset stopped: ${result.stopped.map(formatStoppedProcess).join(', ')}`)
  } else {
    logger.log?.('Clean startup reset found no stale local Robo-Doge processes.')
  }

  return result
}

async function resetWindowsRuntime({ ports, execFileImpl }) {
  const script = `
$ErrorActionPreference = 'Continue'
$ports = ConvertFrom-Json @'
${JSON.stringify(ports)}
'@
$callerPid = ${process.pid}
$stopped = @()
$excluded = [System.Collections.Generic.HashSet[int]]::new()

function Add-ProcessAncestry([int]$processId) {
  while ($processId -gt 0 -and -not $excluded.Contains($processId)) {
    [void]$excluded.Add($processId)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    if (-not $process) { break }
    $processId = [int]$process.ParentProcessId
  }
}

function Stop-MatchedProcess([int]$processId, [string]$reason) {
  if ($processId -le 0 -or $excluded.Contains($processId)) { return }
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $process) { return }
  try {
    Stop-Process -Id $process.Id -Force -ErrorAction Stop
    $script:stopped += [pscustomobject]@{
      reason = $reason
      processId = $process.Id
      name = $process.ProcessName
    }
  } catch {}
}

Add-ProcessAncestry $PID
Add-ProcessAncestry $callerPid

$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains [int]$_.LocalPort })
foreach ($listener in $listeners) {
  Stop-MatchedProcess ([int]$listener.OwningProcess) "listen:$($listener.LocalPort)"
}

$repoRoot = (Get-Location).Path
$repoPattern = [regex]::Escape($repoRoot)
$repoProcesses = @(Get-CimInstance Win32_Process | Where-Object {
  $name = [string]$_.Name
  $cmd = [string]$_.CommandLine
  if (-not $cmd) { return $false }
  if ($name -notmatch '^(node|python|python3|ssh|adb)\\.exe$') { return $false }
  return $cmd -match $repoPattern -or $cmd -match 'Robo-Doge'
})
foreach ($process in $repoProcesses) {
  Stop-MatchedProcess ([int]$process.ProcessId) 'repo-process'
}

try {
  & adb kill-server *> $null
} catch {}

Start-Sleep -Milliseconds 500
$stopped | ConvertTo-Json -Compress
`
  const { stdout } = await execFileImpl(resolvePowerShellCommand(), [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    script,
  ], {
    windowsHide: true,
    timeout: 15_000,
  })

  return { stopped: parseStopped(stdout) }
}

async function resetPosixRuntime({ ports, execFileImpl }) {
  const script = `
set +e
python3 - "$@" <<'PY'
import json, os, signal, subprocess, sys, time
ports = set(sys.argv[1:])
excluded = set()
pid = os.getpid()
while pid and pid not in excluded:
    excluded.add(pid)
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as handle:
            pid = int(handle.read().split()[3])
    except Exception:
        break
try:
    rows = subprocess.check_output(["pgrep", "-af", "."], text=True).splitlines()
except subprocess.CalledProcessError:
    rows = []
matches = []
for row in rows:
    parts = row.split(maxsplit=1)
    if len(parts) != 2:
        continue
    process_id = int(parts[0])
    command = parts[1]
    if process_id in excluded:
        continue
    if "Robo-Doge" in command or "server.mjs" in command or "start-lan-server.mjs" in command or "sidecars/" in command:
        matches.append({"processId": process_id, "name": command.split()[0], "reason": "repo-process"})
for item in matches:
    try:
        os.kill(item["processId"], signal.SIGTERM)
    except ProcessLookupError:
        pass
time.sleep(0.5)
for item in matches:
    try:
        os.kill(item["processId"], 0)
    except ProcessLookupError:
        continue
    try:
        os.kill(item["processId"], signal.SIGKILL)
    except ProcessLookupError:
        pass
print(json.dumps(matches))
PY
`
  const { stdout } = await execFileImpl('bash', ['-lc', script, 'start-clean', ...ports.map(String)], {
    timeout: 15_000,
  })

  return { stopped: parseStopped(stdout) }
}

function parseStopped(stdout = '') {
  const text = String(stdout || '').trim()
  if (!text) {
    return []
  }

  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
  } catch {
    return []
  }
}

function formatStoppedProcess(item) {
  return `${item.name || 'process'} ${item.processId || item.Id || '?'} (${item.reason || item.Reason || 'matched'})`
}

function resolvePowerShellCommand() {
  if (process.platform !== 'win32') {
    return 'pwsh'
  }

  const pwsh = spawnSync('pwsh.exe', [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    '$PSVersionTable.PSVersion.ToString()',
  ], {
    stdio: 'ignore',
    windowsHide: true,
  })

  return pwsh.status === 0 ? 'pwsh.exe' : 'powershell.exe'
}
