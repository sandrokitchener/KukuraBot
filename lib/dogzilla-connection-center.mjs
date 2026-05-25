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
const SCRIPT_ACTIONS = new Set([
  'check-ssh',
  'sync-bridges',
  'start-direct',
  'start-ros2',
  'start-audio',
  'start-lidar',
  'stop-bridges',
])

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
      startAudio: 'scripts/start-dogzilla-audio-cue-ssh.ps1',
      startLidar: 'scripts/start-dogzilla-lidar-ssh.ps1',
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

  if (normalizedAction === 'probe-support') {
    return probeConfiguredSupportServices(config)
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
  const rawVision = rawConfig.vision && typeof rawConfig.vision === 'object' ? rawConfig.vision : {}
  const rawAudio = rawConfig.audio && typeof rawConfig.audio === 'object' ? rawConfig.audio : {}
  const rawLidar = rawConfig.lidar && typeof rawConfig.lidar === 'object' ? rawConfig.lidar : {}
  const envHost = normalizeString(env.DOGZILLA_HOST)
  const host = envHost || normalizeString(rawSsh.host)
  const direct = normalizeBridge(rawBridges.direct, 'Direct DOGZILLALib', host, 8893)
  const ros2 = normalizeBridge(rawBridges.ros2, 'ROS2 Sidecar', host, 8892)
  const sourceCamera = normalizeCamera(rawCamera, host)
  const vision = normalizeVision(rawVision, host, sourceCamera)
  const camera = vision.enabled ? normalizeVisionCamera(vision, sourceCamera) : sourceCamera
  const audio = normalizeAudio(rawAudio, host)
  const lidar = normalizeLidar(rawLidar, host)

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
    vision,
    audio,
    lidar,
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
    case 'start-audio':
      return {
        action,
        command: resolvePowerShellCommand(),
        args: [
          ...powershellArgs,
          path.join(ROOT_DIR, 'scripts', 'start-dogzilla-audio-cue-ssh.ps1'),
          ...scriptArgs,
          '-RemoteRoot',
          config.remoteRoot,
          '-Port',
          String(config.audio.port),
          '-Background',
        ],
        timeoutMs: 35_000,
        background: false,
      }
    case 'start-lidar':
      return {
        action,
        command: resolvePowerShellCommand(),
        args: [
          ...powershellArgs,
          path.join(ROOT_DIR, 'scripts', 'start-dogzilla-lidar-ssh.ps1'),
          ...scriptArgs,
          '-RemoteRoot',
          config.remoteRoot,
          '-Port',
          String(config.lidar.port),
          '-Background',
        ],
        timeoutMs: 45_000,
        background: false,
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

async function probeConfiguredSupportServices(config) {
  const results = {
    audio: await probeConfiguredService('audio', config.audio?.healthUrl, config.audio?.enabled !== false),
    lidar: await probeConfiguredService('lidar', config.lidar?.healthUrl, config.lidar?.enabled !== false),
    camera: await probeConfiguredService('camera', config.camera?.indexUrl, !!config.camera?.indexUrl),
    vision: await probeConfiguredService('vision', config.vision?.statusUrl, config.vision?.enabled === true),
  }
  const values = Object.values(results)
  const anyReachable = values.some((result) => result.status === 'ok' || result.status === 'degraded')
  const anyRequiredError = values.some((result) => result.required && result.status === 'error')

  return {
    status: anyReachable && !anyRequiredError ? 'ok' : anyReachable ? 'degraded' : 'error',
    action: 'probe-support',
    results,
  }
}

async function probeConfiguredService(id, targetUrl, required) {
  if (!required || !targetUrl) {
    return {
      status: 'disabled',
      required: false,
      destination: targetUrl || '',
    }
  }

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(4000),
    })
    const body = await safeReadJson(response)
    const bodyOk = body && typeof body === 'object' && body.ok === false ? false : true

    return {
      status: response.ok && bodyOk ? 'ok' : response.ok ? 'degraded' : 'error',
      required: true,
      service: id,
      responseStatus: response.status,
      destination: targetUrl,
      body,
    }
  } catch (error) {
    return {
      status: 'error',
      required: true,
      service: id,
      destination: targetUrl,
      error: error instanceof Error ? error.message : String(error),
    }
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

function normalizeVision(rawVision = {}, host, sourceCamera) {
  const enabled = rawVision.enabled === true || normalizeString(rawVision.enabled).toLowerCase() === 'true'
  const port = normalizePort(rawVision.port, 8894)
  const rawBaseUrl = normalizeString(rawVision.baseUrl)
  const baseUrl = normalizeUrl(rawBaseUrl) || (host ? `http://${host}:${port}` : '')
  const streamPath = normalizePath(rawVision.streamPath) || '/stream.mjpg'
  const statusPath = normalizePath(rawVision.statusPath) || '/healthz'
  const detectionsPath = normalizePath(rawVision.detectionsPath) || '/detections'

  return {
    enabled,
    label: normalizeString(rawVision.label) || 'DOGZILLA YOLO annotated camera',
    baseUrl,
    port,
    streamPath,
    statusPath,
    detectionsPath,
    streamUrl: baseUrl ? new URL(streamPath, baseUrl).toString() : '',
    statusUrl: baseUrl ? new URL(statusPath, baseUrl).toString() : '',
    detectionsUrl: baseUrl ? new URL(detectionsPath, baseUrl).toString() : '',
    sourceStreamUrl: normalizeString(rawVision.sourceStreamUrl) || sourceCamera.streamUrl || '',
    modelRemotePath: normalizeString(rawVision.modelRemotePath) || '/home/pi/robodoge/models/dogzilla_yolo/best.onnx',
  }
}

function normalizeVisionCamera(vision, sourceCamera) {
  const baseUrl = vision.baseUrl
  const streamPath = vision.streamPath
  const indexPath = '/'

  return {
    label: vision.label,
    baseUrl,
    streamPath,
    indexPath,
    streamUrl: baseUrl ? new URL(streamPath, baseUrl).toString() : '',
    indexUrl: baseUrl ? new URL(indexPath, baseUrl).toString() : '',
    proxyStreamPath: DOGZILLA_CAMERA_STREAM_PROXY_PATH,
    proxyStatusPath: DOGZILLA_CAMERA_STATUS_PATH,
    sourceLabel: sourceCamera.label,
    sourceStreamUrl: sourceCamera.streamUrl,
    processed: true,
    visionStatusUrl: vision.statusUrl,
    detectionsUrl: vision.detectionsUrl,
  }
}

function normalizeAudio(rawAudio = {}, host) {
  const enabled = rawAudio.enabled === true || normalizeString(rawAudio.enabled).toLowerCase() === 'true'
  const port = normalizePort(rawAudio.port, 8895)
  const rawBaseUrl = normalizeString(rawAudio.baseUrl)
  const baseUrl = normalizeUrl(rawBaseUrl) || (host ? `http://${host}:${port}` : '')
  const cuePath = normalizePath(rawAudio.cuePath) || '/cue'
  const healthPath = normalizePath(rawAudio.healthPath) || '/healthz'

  return {
    enabled,
    label: normalizeString(rawAudio.label) || 'DOGZILLA Pi speaker cues',
    baseUrl,
    port,
    cuePath,
    healthPath,
    cueUrl: baseUrl ? new URL(cuePath, baseUrl).toString() : '',
    healthUrl: baseUrl ? new URL(healthPath, baseUrl).toString() : '',
  }
}

function normalizeLidar(rawLidar = {}, host) {
  const enabled = rawLidar.enabled === true || normalizeString(rawLidar.enabled).toLowerCase() === 'true'
  const port = normalizePort(rawLidar.port, 8896)
  const rawBaseUrl = normalizeString(rawLidar.baseUrl)
  const baseUrl = normalizeUrl(rawBaseUrl) || (host ? `http://${host}:${port}` : '')
  const healthPath = normalizePath(rawLidar.healthPath) || '/healthz'
  const scanPath = normalizePath(rawLidar.scanPath) || '/scan'
  const diagnosticsPath = normalizePath(rawLidar.diagnosticsPath) || '/diagnostics'

  return {
    enabled,
    label: normalizeString(rawLidar.label) || 'DOGZILLA lidar bridge',
    baseUrl,
    port,
    healthPath,
    scanPath,
    diagnosticsPath,
    healthUrl: baseUrl ? new URL(healthPath, baseUrl).toString() : '',
    scanUrl: baseUrl ? new URL(scanPath, baseUrl).toString() : '',
    diagnosticsUrl: baseUrl ? new URL(diagnosticsPath, baseUrl).toString() : '',
    proxyHealthPath: '/api/dogzilla/lidar/health',
    proxyScanPath: '/api/dogzilla/lidar/scan',
    proxyDiagnosticsPath: '/api/dogzilla/lidar/diagnostics',
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
