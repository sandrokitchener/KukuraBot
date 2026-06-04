import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function stopManagedProcessByScript({
  label = 'managed process',
  scriptPath = '',
  port = 0,
  logger = console,
  execFileImpl = execFileAsync,
} = {}) {
  const fragments = [
    normalizeProcessFragment(scriptPath),
    '--port',
    String(port || ''),
  ].filter(Boolean)

  if (fragments.length < 2) {
    return { stopped: [], skipped: true, reason: 'missing process match fragments' }
  }

  return stopManagedProcesses({
    label,
    fragments,
    port,
    logger,
    execFileImpl,
  })
}

export async function stopManagedProcessOnPort({
  label = 'managed process',
  port = 0,
  fragments = [],
  logger = console,
  execFileImpl = execFileAsync,
} = {}) {
  const normalizedFragments = fragments.map(normalizeProcessFragment).filter(Boolean)
  if (!port || normalizedFragments.length === 0) {
    return { stopped: [], skipped: true, reason: 'missing port or process match fragments' }
  }

  return stopManagedProcesses({
    label,
    fragments: normalizedFragments,
    port,
    logger,
    execFileImpl,
  })
}

async function stopManagedProcesses({ label, fragments, port, logger, execFileImpl }) {
  const result = process.platform === 'win32'
    ? await stopWindowsProcesses({ fragments, port, execFileImpl })
    : await stopPosixProcesses({ fragments, execFileImpl })

  if (result.stopped.length > 0) {
    logger.log?.(`Stopped stale ${label}: ${result.stopped.map((item) => item.processId).join(', ')}`)
  }

  return result
}

async function stopWindowsProcesses({ fragments, port, execFileImpl }) {
  const command = resolvePowerShellCommand()
  const script = `
$ErrorActionPreference = 'Stop'
$fragments = ConvertFrom-Json @'
${JSON.stringify(fragments)}
'@
$port = ${Number(port || 0)}
$callerPid = ${process.pid}
$excluded = [System.Collections.Generic.HashSet[int]]::new()
function Add-ProcessAncestry([int]$processId) {
  while ($processId -gt 0 -and -not $excluded.Contains($processId)) {
    [void]$excluded.Add($processId)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    if (-not $process) { break }
    $processId = [int]$process.ParentProcessId
  }
}
Add-ProcessAncestry $PID
Add-ProcessAncestry $callerPid
$owners = @()
if ($port -gt 0) {
  $owners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
}
$matches = @(Get-CimInstance Win32_Process | Where-Object {
  $cmd = $_.CommandLine
  if (-not $cmd) { return $false }
  $cmdNormalized = $cmd.Replace('\\', '/')
  foreach ($fragment in $fragments) {
    if ($cmdNormalized -notlike "*$fragment*") { return $false }
  }
  if ($owners.Count -gt 0 -and -not ($owners -contains [int]$_.ProcessId)) { return $false }
  return -not $excluded.Contains([int]$_.ProcessId)
})
foreach ($process in $matches) {
  Stop-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 800
foreach ($process in $matches) {
  if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
$matches | Select-Object @{Name='processId';Expression={$_.ProcessId}}, CommandLine | ConvertTo-Json -Compress
`
  const { stdout } = await execFileImpl(command, [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    script,
  ], {
    windowsHide: true,
    timeout: 10_000,
  })

  return { stopped: parseJsonRows(stdout), skipped: false }
}

async function stopPosixProcesses({ fragments, execFileImpl }) {
  const script = `
set -e
python3 - "$@" <<'PY'
import json, os, signal, subprocess, sys, time
fragments = sys.argv[1:]
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
    pid = int(parts[0])
    command = parts[1]
    if pid in excluded:
        continue
    if all(fragment in command for fragment in fragments):
        matches.append({"processId": pid, "CommandLine": command})
for item in matches:
    try:
        os.kill(item["processId"], signal.SIGTERM)
    except ProcessLookupError:
        pass
time.sleep(0.8)
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
  const { stdout } = await execFileImpl('bash', ['-lc', script, 'managed-process-cleanup', ...fragments], {
    timeout: 10_000,
  })

  return { stopped: parseJsonRows(stdout), skipped: false }
}

function parseJsonRows(stdout = '') {
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

function normalizeProcessFragment(value) {
  return String(value || '').trim().replaceAll('\\', '/')
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
