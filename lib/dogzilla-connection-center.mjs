import { execFile, spawn } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DOGZILLA_CAMERA_STATUS_PATH,
  DOGZILLA_CAMERA_STREAM_PROXY_PATH,
} from './dogzilla-camera-paths.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const CONFIG_PATH = path.join(ROOT_DIR, 'config', 'dogzilla-connection.json')
const SSH_CONFIG_PATH = path.join(ROOT_DIR, 'output', 'pi-ssh', 'config')
const DEFAULT_TIMEOUT_MS = 20_000
const SCRIPT_ACTIONS = new Set(['check-ssh', 'sync-bridges', 'start-direct', 'start-ros2', 'stop-bridges'])

export async function getDogzillaConnectionCenter(options = {}) {
  const config = await loadDogzillaConnectionConfig(options)
  const sshConfigExists = await pathExists(SSH_CONFIG_PATH)
  return {
    config,
    sshConfigExists,
    scripts: {
      installKey: 'scripts/install-dogzilla-ssh-key.ps1',
      smokeTest: 'scripts/smoke-test-dogzilla.bat',
      syncBridges: 'scripts/sync-dogzilla-bridges.ps1',
      startBridge: 'scripts/start-dogzilla-bridge-ssh.ps1',
      stopBridge: 'scripts/stop-dogzilla-bridge-ssh.ps1',
    },
    status: summarizeConnection(config, sshConfigExists),
  }
}

export async function loadDogzillaConnectionConfig({ env = process.env } = {}) {
  const rawConfig = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'))
  return normalizeDogzillaConnectionConfig(rawConfig, env)
}

export async function saveDogzillaConnectionConfig(update = {}) {
  const rawConfig = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'))
  const sshUpdate = update.ssh && typeof update.ssh === 'object' ? update.ssh : {}
  const bridgeUpdate = update.bridges && typeof update.bridges === 'object' ? update.bridges : {}

  rawConfig.ssh = {
    ...(rawConfig.ssh || {}),
    host: normalizeString(sshUpdate.host ?? rawConfig.ssh?.host),
    user: normalizeString(sshUpdate.user ?? rawConfig.ssh?.user) || 'pi',
    port: normalizePort(sshUpdate.port ?? rawConfig.ssh?.port, 22),
    alias: normalizeString(sshUpdate.alias ?? rawConfig.ssh?.alias) || 'dogzilla',
    keyPath: normalizeString(sshUpdate.keyPath ?? rawConfig.ssh?.keyPath) || defaultKeyPath(),
  }
  rawConfig.remoteRoot = normalizeString(update.remoteRoot ?? rawConfig.remoteRoot) || '/home/pi/robodoge'
  rawConfig.bridges = {
    direct: {
      ...(rawConfig.bridges?.direct || {}),
      ...(bridgeUpdate.direct && typeof bridgeUpdate.direct === 'object' ? bridgeUpdate.direct : {}),
    },
    ros2: {
      ...(rawConfig.bridges?.ros2 || {}),
      ...(bridgeUpdate.ros2 && typeof bridgeUpdate.ros2 === 'object' ? bridgeUpdate.ros2 : {}),
    },
  }

  await writeFile(CONFIG_PATH, `${JSON.stringify(rawConfig, null, 2)}\n`, 'utf-8')
  return loadDogzillaConnectionConfig()
}

export async function runDogzillaConnectionAction(action, options = {}) {
  const normalizedAction = normalizeString(action)
  const config = await loadDogzillaConnectionConfig()

  if (normalizedAction === 'probe-bridges') {
    return probeConfiguredBridges(config)
  }

  if (!SCRIPT_ACTIONS.has(normalizedAction)) {
    return {
      status: 'error',
      error: `Unknown DOGZILLA action "${normalizedAction}".`,
    }
  }

  const plan = buildDogzillaActionPlan(normalizedAction, config, options)

  if (!config.ssh.host) {
    return {
      status: 'error',
      action: normalizedAction,
      error: 'Set DOGZILLA IP first.',
      plan,
    }
  }

  if (plan.background) {
    const child = spawn(plan.command, plan.args, {
      cwd: ROOT_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return {
      status: 'started',
      action: normalizedAction,
      pid: child.pid,
      plan: redactPlan(plan),
    }
  }

  const result = await execFilePromise(plan.command, plan.args, {
    cwd: ROOT_DIR,
    timeout: plan.timeoutMs || DEFAULT_TIMEOUT_MS,
    windowsHide: true,
  })

  return {
    status: result.exitCode === 0 ? 'ok' : 'error',
    action: normalizedAction,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    plan: redactPlan(plan),
  }
}

export function normalizeDogzillaConnectionConfig(rawConfig = {}, env = process.env) {
  const rawSsh = rawConfig.ssh && typeof rawConfig.ssh === 'object' ? rawConfig.ssh : {}
  const rawBridges = rawConfig.bridges && typeof rawConfig.bridges === 'object' ? rawConfig.bridges : {}
  const rawCamera = rawConfig.camera && typeof rawConfig.camera === 'object' ? rawConfig.camera : {}
  const envHost = normalizeString(env.DOGZILLA_HOST)
  const host = envHost || normalizeString(rawSsh.host)
  const direct = normalizeBridge(rawBridges.direct, 'Direct DOGZILLALib', host, 8893)
  const ros2 = normalizeBridge(rawBridges.ros2, 'ROS2 Sidecar', host, 8892)
  const camera = normalizeCamera(rawCamera, host)

  return {
    ssh: {
      host,
      user: normalizeString(env.DOGZILLA_USER) || normalizeString(rawSsh.user) || 'pi',
      port: normalizePort(env.DOGZILLA_SSH_PORT || rawSsh.port, 22),
      alias: normalizeString(rawSsh.alias) || 'dogzilla',
      keyPath: normalizeString(rawSsh.keyPath) || defaultKeyPath(),
      source: envHost ? 'override' : 'config',
      selectionLocked: !!envHost,
    },
    remoteRoot: normalizeString(rawConfig.remoteRoot) || '/home/pi/robodoge',
    bridges: {
      direct,
      ros2,
    },
    camera,
    notes: Array.isArray(rawConfig.notes) ? rawConfig.notes : [],
  }
}

export function buildDogzillaActionPlan(action, config, options = {}) {
  const scriptArgs = buildBaseScriptArgs(config)
  const powershellArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']

  switch (action) {
    case 'check-ssh':
      return {
        action,
        command: resolvePowerShellCommand(),
        args: [
          ...powershellArgs,
          path.join(ROOT_DIR, 'scripts', 'dogzilla-ssh.ps1'),
          ...scriptArgs,
          '-Command',
          'echo ssh-ok && hostname',
        ],
        timeoutMs: 15_000,
        background: false,
      }
    case 'sync-bridges':
      return {
        action,
        command: resolvePowerShellCommand(),
        args: [
          ...powershellArgs,
          path.join(ROOT_DIR, 'scripts', 'sync-dogzilla-bridges.ps1'),
          ...scriptArgs,
          '-RemoteRoot',
          config.remoteRoot,
        ],
        timeoutMs: 90_000,
        background: false,
      }
    case 'start-direct':
    case 'start-ros2': {
      const bridge = action === 'start-direct' ? 'direct' : 'ros2'
      const bridgeConfig = config.bridges[bridge]
      const args = [
        ...powershellArgs,
        path.join(ROOT_DIR, 'scripts', 'start-dogzilla-bridge-ssh.ps1'),
        ...scriptArgs,
        '-Bridge',
        bridge,
        '-RemoteRoot',
        config.remoteRoot,
        '-BridgePort',
        String(bridgeConfig.port),
        '-Background',
      ]

      if (options.live === true && bridge === 'direct') {
        args.push('-Live')
      }

      return {
        action,
        command: resolvePowerShellCommand(),
        args,
        timeoutMs: 30_000,
        background: false,
      }
    }
    case 'stop-bridges':
      return {
        action,
        command: resolvePowerShellCommand(),
        args: [
          ...powershellArgs,
          path.join(ROOT_DIR, 'scripts', 'stop-dogzilla-bridge-ssh.ps1'),
          ...scriptArgs,
          '-RemoteRoot',
          config.remoteRoot,
        ],
        timeoutMs: 20_000,
        background: false,
      }
    default:
      throw new Error(`Unknown DOGZILLA action "${action}".`)
  }
}

async function probeConfiguredBridges(config) {
  const results = {}

  for (const [id, bridge] of Object.entries(config.bridges)) {
    results[id] = await probeBridgeHealth(bridge)
  }

  return {
    status: Object.values(results).some((result) => result.status === 'ok' || result.status === 'degraded') ? 'ok' : 'error',
    action: 'probe-bridges',
    results,
  }
}

async function probeBridgeHealth(bridge) {
  const targetUrl = new URL('/healthz', bridge.baseUrl).toString()

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(4000),
    })
    const body = await safeReadJson(response)
    const ok = body && typeof body === 'object' && body.ok === false ? false : true

    return {
      status: response.ok && ok ? 'ok' : response.ok ? 'degraded' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      body,
    }
  } catch (error) {
    return {
      status: 'error',
      destination: targetUrl,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function buildBaseScriptArgs(config) {
  return [
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
  ]
}

function normalizeBridge(rawBridge = {}, label, host, fallbackPort) {
  const port = normalizePort(rawBridge.port, fallbackPort)
  const rawBaseUrl = normalizeString(rawBridge.baseUrl)
  const baseUrl = normalizeUrl(rawBaseUrl) || (host ? `http://${host}:${port}` : `http://127.0.0.1:${port}`)

  return {
    label: normalizeString(rawBridge.label) || label,
    baseUrl,
    port,
  }
}

function normalizeCamera(rawCamera = {}, host) {
  const baseUrl = normalizeUrl(rawCamera.baseUrl) || (host ? `http://${host}:6500` : '')
  const streamPath = normalizePath(rawCamera.streamPath) || '/video_feed'
  const indexPath = normalizePath(rawCamera.indexPath) || '/'
  const controlPort = normalizePort(rawCamera.controlPort, 6000)
  const wakeCommand = normalizeString(rawCamera.wakeCommand) || '$010F040115#'

  return {
    label: normalizeString(rawCamera.label) || 'Yahboom DOGZILLA app camera',
    baseUrl,
    streamPath,
    indexPath,
    controlPort,
    wakeCommand,
    streamUrl: baseUrl ? new URL(streamPath, baseUrl).toString() : '',
    indexUrl: baseUrl ? new URL(indexPath, baseUrl).toString() : '',
    proxyStreamPath: DOGZILLA_CAMERA_STREAM_PROXY_PATH,
    proxyStatusPath: DOGZILLA_CAMERA_STATUS_PATH,
  }
}

function summarizeConnection(config, sshConfigExists) {
  return {
    hasHost: !!config.ssh.host,
    sshConfigExists,
    activeHost: config.ssh.host || '',
    user: config.ssh.user,
    directUrl: config.bridges.direct.baseUrl,
    ros2Url: config.bridges.ros2.baseUrl,
  }
}

async function execFilePromise(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || error?.message || '').trim(),
      })
    })
  })
}

async function safeReadJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function redactPlan(plan) {
  return {
    action: plan.action,
    command: plan.command,
    args: plan.args,
    timeoutMs: plan.timeoutMs,
    background: plan.background,
  }
}

function resolvePowerShellCommand() {
  return process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
}

function normalizeUrl(value) {
  if (!value) {
    return ''
  }

  try {
    return new URL(value).toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function normalizePath(value) {
  const normalized = normalizeString(value)
  return normalized ? `/${normalized.replace(/^\/+/, '')}` : ''
}

function normalizePort(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 65535 ? numeric : fallback
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function defaultKeyPath() {
  return path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'robodoge_pi_ed25519')
}
