import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDogzillaConnectionConfig } from './dogzilla-connection-center.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const SSH_TIMEOUT_MS = 25_000

const REMOTE_PI_PERFORMANCE_SCRIPT = `
import json
import os
import re
import subprocess
import time

def read_text(path):
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            return handle.read().strip()
    except Exception:
        return ''

def run(args, timeout=2):
    try:
        proc = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
        return proc.stdout.strip() if proc.returncode == 0 else ''
    except Exception:
        return ''

load_raw = read_text('/proc/loadavg')
load_parts = load_raw.split()
loads = [float(value) for value in load_parts[:3]] if len(load_parts) >= 3 else []
running_threads = load_parts[3] if len(load_parts) >= 4 else ''

meminfo = {}
for line in read_text('/proc/meminfo').splitlines():
    if ':' not in line:
        continue
    key, value = line.split(':', 1)
    match = re.search(r'\\d+', value)
    if match:
        meminfo[key] = int(match.group(0))

total_kb = meminfo.get('MemTotal')
available_kb = meminfo.get('MemAvailable')
used_kb = total_kb - available_kb if total_kb and available_kb is not None else None

temperature_c = None
temp_raw = read_text('/sys/class/thermal/thermal_zone0/temp')
if temp_raw:
    try:
        temperature_c = round(float(temp_raw) / 1000.0, 1)
    except Exception:
        temperature_c = None
if temperature_c is None:
    vc_temp = run(['vcgencmd', 'measure_temp'])
    match = re.search(r'([0-9.]+)', vc_temp)
    if match:
        temperature_c = round(float(match.group(1)), 1)

uptime_parts = read_text('/proc/uptime').split()
uptime_sec = float(uptime_parts[0]) if uptime_parts else None

throttled_raw = run(['vcgencmd', 'get_throttled'])

print(json.dumps({
    'ok': True,
    'collectedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'hostname': os.uname().nodename,
    'cpu': {
        'cores': os.cpu_count(),
        'loadAverage': loads,
        'loadAverageRaw': load_raw,
        'runningThreads': running_threads,
    },
    'memory': {
        'totalMb': round(total_kb / 1024, 1) if total_kb else None,
        'availableMb': round(available_kb / 1024, 1) if available_kb is not None else None,
        'usedMb': round(used_kb / 1024, 1) if used_kb is not None else None,
        'usedPercent': round((used_kb / total_kb) * 100, 1) if used_kb is not None and total_kb else None,
    },
    'temperature': {
        'celsius': temperature_c,
    },
    'system': {
        'uptimeSec': uptime_sec,
        'throttled': throttled_raw,
    },
}))
`.trim()

export async function getDogzillaPiPerformance() {
  const startedAt = Date.now()
  const config = await loadDogzillaConnectionConfig()
  const ssh = config.ssh || {}

  if (!ssh.host) {
    return {
      ok: false,
      status: 'unconfigured',
      error: 'DOGZILLA SSH host is not configured.',
      durationMs: Date.now() - startedAt,
    }
  }

  const plan = buildSshPlan(config)
  const result = await execFilePromise(plan.command, plan.args, {
    cwd: ROOT_DIR,
    timeout: SSH_TIMEOUT_MS,
    windowsHide: true,
  })
  const parsed = parseRemoteJson(result.stdout)
  const ok = result.exitCode === 0 && parsed?.ok === true

  return {
    ok,
    status: ok ? 'ok' : 'error',
    durationMs: Date.now() - startedAt,
    exitCode: result.exitCode,
    stderr: result.stderr,
    data: parsed || null,
    error: ok ? undefined : parsed?.error || result.stderr || result.stdout || 'Pi performance diagnostics failed.',
  }
}

function buildSshPlan(config) {
  return {
    command: resolvePowerShellCommand(),
    args: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(ROOT_DIR, 'scripts', 'dogzilla-ssh.ps1'),
      '-Host',
      config.ssh.host,
      '-User',
      config.ssh.user,
      '-Port',
      String(config.ssh.port),
      '-Alias',
      config.ssh.alias,
      '-KeyPath',
      config.ssh.keyPath,
      '-Command',
      buildRemoteCommand(),
    ],
  }
}

function buildRemoteCommand() {
  const encoded = Buffer.from(REMOTE_PI_PERFORMANCE_SCRIPT, 'utf-8').toString('base64')
  return `printf %s ${encoded} | base64 -d | python3 -`
}

function resolvePowerShellCommand() {
  return process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
}

function execFilePromise(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout = '', stderr = '') => {
      resolve({
        exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      })
    })
  })
}

function parseRemoteJson(stdout) {
  const trimmed = String(stdout || '').trim()
  if (!trimmed) return null
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return null
  try {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1))
  } catch {
    return null
  }
}
