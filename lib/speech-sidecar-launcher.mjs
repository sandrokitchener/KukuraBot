import { spawn } from 'node:child_process'
import path from 'node:path'
import { stopManagedProcessByScript } from './managed-process-cleanup.mjs'
import { probeSpeechSidecarHealth } from './speech-sidecar-client.mjs'

const DEFAULT_SIDECAR_HOST = '127.0.0.1'
const DEFAULT_SIDECAR_PORT = 8893
const DEFAULT_READY_TIMEOUT_MS = 120000
const HEALTH_POLL_INTERVAL_MS = 500

export function resolveManagedSpeechSidecarPlan(sidecarConfig = {}, rootDir = '.') {
  const transport = sidecarConfig.transport ?? {}
  const launch = sidecarConfig.launch ?? {}
  const workspaceRoot = path.resolve(rootDir)
  const workdir = path.resolve(workspaceRoot, launch.workdir || '.')
  const targetUrl = safeParseUrl(transport.baseUrl)
  const host = targetUrl?.hostname || DEFAULT_SIDECAR_HOST
  const port = normalizePort(targetUrl?.port)
  const sidecarScriptPath = path.resolve(workdir, launch.scriptPath || 'sidecars/parakeet_onnx_bridge/server.py')
  const runtime = normalizeRuntime(launch.runtime)
  const command = runtime === 'wsl'
    ? normalizeCommand(launch.wslCommand, 'wsl.exe')
    : normalizeCommand(launch.pythonPath, 'python')
  const args = runtime === 'wsl'
    ? buildWslLaunchArgs({
      launch,
      workdir,
      sidecarScriptPath,
      host,
      port,
    })
    : [
      sidecarScriptPath,
      '--host',
      host,
      '--port',
      String(port),
      ...normalizeStringList(launch.scriptArgs),
    ]

  return {
    managedByApp: launch.managedByApp ?? false,
    transportEnabled: transport.enabled ?? true,
    sidecarReadyTimeoutMs: normalizeTimeoutMs(launch.sidecarReadyTimeoutMs),
    sidecar: {
      runtime,
      command,
      args,
      cwd: workdir,
      scriptPath: sidecarScriptPath,
      baseUrl: targetUrl?.toString() || transport.baseUrl || `http://${host}:${port}`,
    },
  }
}

function buildWslLaunchArgs({ launch, workdir, sidecarScriptPath, host, port }) {
  const linuxWorkdir = normalizeLinuxPath(launch.linuxWorkdir) || windowsPathToWslPath(workdir)
  const linuxScriptPath = normalizeLinuxPath(launch.linuxScriptPath) || windowsPathToWslPath(sidecarScriptPath)
  const distro = typeof launch.wslDistribution === 'string' ? launch.wslDistribution.trim() : ''
  const pythonPath = normalizeCommand(launch.pythonPath, 'python3')
  const args = []

  if (distro) {
    args.push('-d', distro)
  }

  args.push(
    '--cd',
    linuxWorkdir,
    '--',
    pythonPath,
    linuxScriptPath,
    '--host',
    host,
    '--port',
    String(port),
    ...normalizeStringList(launch.scriptArgs),
  )

  return args
}

export function windowsPathToWslPath(filePath) {
  const normalized = path.resolve(filePath)
  const driveMatch = normalized.match(/^([A-Za-z]):[\\/](.*)$/)

  if (!driveMatch) {
    return normalized.replaceAll('\\', '/')
  }

  const drive = driveMatch[1].toLowerCase()
  const remainder = driveMatch[2].replaceAll('\\', '/')
  return `/mnt/${drive}/${remainder}`
}

export async function startManagedSpeechSidecar({
  sidecarConfig = {},
  rootDir = '.',
  logger = console,
  probeSpeechSidecarHealthImpl = probeSpeechSidecarHealth,
  spawnImpl = spawn,
  stopStaleSidecarImpl = stopManagedProcessByScript,
  replaceExisting = false,
} = {}) {
  const plan = resolveManagedSpeechSidecarPlan(sidecarConfig, rootDir)
  const managedChildren = []

  if (!plan.transportEnabled || !plan.managedByApp) {
    return {
      enabled: false,
      plan,
      reusedSidecar: false,
      sidecarChild: null,
      async stop() {
        await stopManagedChildren(managedChildren)
      },
    }
  }

  if (replaceExisting) {
    await stopStaleSidecarImpl({
      label: 'speech sidecar',
      scriptPath: plan.sidecar.scriptPath,
      port: portFromBaseUrl(plan.sidecar.baseUrl, DEFAULT_SIDECAR_PORT),
      logger,
    })
  }

  const existingHealth = replaceExisting
    ? { status: 'error', destination: plan.sidecar.baseUrl }
    : await probeSpeechSidecarHealthImpl(sidecarConfig)
  const reusedSidecar = existingHealth.status === 'ok'
  let sidecarChild = null

  if (reusedSidecar) {
    logger.log(`Speech sidecar already ready at ${existingHealth.destination}. Reusing existing process.`)
  } else {
    logger.log(`Starting speech sidecar via ${plan.sidecar.command} ${plan.sidecar.args.join(' ')}`)
    sidecarChild = spawnImpl(plan.sidecar.command, plan.sidecar.args, {
      cwd: plan.sidecar.cwd,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
      stdio: 'inherit',
    })
    managedChildren.push(sidecarChild)
    await waitForChildSpawn(sidecarChild, 'Speech sidecar')
    const health = await waitForSidecarReady({
      sidecarConfig,
      child: sidecarChild,
      timeoutMs: plan.sidecarReadyTimeoutMs,
      probeSpeechSidecarHealthImpl,
    })
    logger.log(`Speech sidecar ready at ${health.destination}.`)
  }

  return {
    enabled: true,
    plan,
    reusedSidecar,
    sidecarChild,
    async stop() {
      await stopManagedChildren(managedChildren)
    },
  }
}

async function waitForSidecarReady({ sidecarConfig, child, timeoutMs, probeSpeechSidecarHealthImpl }) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode != null) {
      throw new Error(`Speech sidecar exited early with code ${child.exitCode}.`)
    }

    const health = await probeSpeechSidecarHealthImpl(sidecarConfig)

    if (health.status === 'ok') {
      return health
    }

    if (health.status !== 'error') {
      throw new Error(`Speech sidecar readiness probe returned unexpected status "${health.status}".`)
    }

    await sleep(HEALTH_POLL_INTERVAL_MS)
  }

  throw new Error(`Timed out waiting ${timeoutMs}ms for speech sidecar readiness.`)
}

function waitForChildSpawn(child, label) {
  if (child.pid) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup()
      resolve()
    }
    const onError = (error) => {
      cleanup()
      reject(new Error(`${label} failed to start: ${error instanceof Error ? error.message : String(error)}`))
    }

    const cleanup = () => {
      child.off('spawn', onSpawn)
      child.off('error', onError)
    }

    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

async function stopManagedChildren(children) {
  for (const child of [...children].reverse()) {
    if (!child || child.exitCode != null || child.killed) {
      continue
    }

    try {
      child.kill('SIGTERM')
    } catch {
      child.kill()
    }
  }
}

function normalizeStringList(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : []
}

function normalizeTimeoutMs(value) {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_READY_TIMEOUT_MS
}

function normalizeRuntime(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'wsl' ? 'wsl' : 'python'
}

function normalizeCommand(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function normalizeLinuxPath(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function normalizePort(value) {
  const numeric = Number.parseInt(value || '', 10)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_SIDECAR_PORT
}

function safeParseUrl(value) {
  try {
    return new URL(value || `http://${DEFAULT_SIDECAR_HOST}:${DEFAULT_SIDECAR_PORT}`)
  } catch {
    return new URL(`http://${DEFAULT_SIDECAR_HOST}:${DEFAULT_SIDECAR_PORT}`)
  }
}

function portFromBaseUrl(value, fallback) {
  return normalizePort(safeParseUrl(value)?.port || fallback)
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
