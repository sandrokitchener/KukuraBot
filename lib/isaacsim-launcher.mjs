import { spawn } from 'node:child_process'
import path from 'node:path'
import { green } from './startup-banner.mjs'
import { probeIsaacSidecarHealth } from './isaacsim-sidecar-client.mjs'
import { stopManagedProcessByScript } from './managed-process-cleanup.mjs'

const DEFAULT_SIDECAR_HOST = '127.0.0.1'
const DEFAULT_SIDECAR_PORT = 8891
const DEFAULT_READY_TIMEOUT_MS = 10_000
const HEALTH_POLL_INTERVAL_MS = 250

export function resolveManagedIsaacLaunchPlan(sidecarConfig = {}, rootDir = '.') {
  const transport = sidecarConfig.transport ?? {}
  const launch = sidecarConfig.launch ?? {}
  const workspaceRoot = path.resolve(rootDir)
  const workdir = path.resolve(workspaceRoot, launch.workdir || '.')
  const targetUrl = safeParseUrl(transport.baseUrl)
  const host = targetUrl?.hostname || DEFAULT_SIDECAR_HOST
  const port = normalizePort(targetUrl?.port)
  const sidecarScriptPath = path.resolve(workdir, launch.scriptPath || 'sidecars/isaac_bridge/server.py')
  const isaacSimLaunchScriptPath = launch.isaacSimLaunchScriptPath
    ? path.resolve(workdir, launch.isaacSimLaunchScriptPath)
    : ''

  return {
    managedByApp: launch.managedByApp ?? false,
    sidecarReadyTimeoutMs: normalizeTimeoutMs(launch.sidecarReadyTimeoutMs),
    sidecar: {
      command: typeof launch.pythonPath === 'string' && launch.pythonPath.trim() ? launch.pythonPath.trim() : 'python',
      args: [
        sidecarScriptPath,
        '--host',
        host,
        '--port',
        String(port),
        ...normalizeStringList(launch.scriptArgs),
      ],
      cwd: workdir,
      scriptPath: sidecarScriptPath,
      baseUrl: targetUrl?.toString() || transport.baseUrl || `http://${host}:${port}`,
    },
    isaac: {
      enabled: launch.isaacSimLaunchEnabled ?? false,
      command: isaacSimLaunchScriptPath,
      args: normalizeStringList(launch.isaacSimLaunchArgs),
      cwd: workdir,
      shell: isWindowsBatchFile(isaacSimLaunchScriptPath),
      scriptPath: isaacSimLaunchScriptPath,
    },
  }
}

export async function startManagedIsaacEnvironment({
  sidecarConfig = {},
  rootDir = '.',
  logger = console,
  probeIsaacSidecarHealthImpl = probeIsaacSidecarHealth,
  spawnImpl = spawn,
  stopStaleSidecarImpl = stopManagedProcessByScript,
  replaceExisting = false,
} = {}) {
  const plan = resolveManagedIsaacLaunchPlan(sidecarConfig, rootDir)
  const managedChildren = []

  if (!plan.managedByApp) {
    return {
      enabled: false,
      plan,
      reusedSidecar: false,
      sidecarChild: null,
      isaacChild: null,
      async stop() {
        await stopManagedChildren(managedChildren)
      },
    }
  }

  if (replaceExisting) {
    await stopStaleSidecarImpl({
      label: 'Isaac sidecar',
      scriptPath: plan.sidecar.scriptPath,
      port: portFromBaseUrl(plan.sidecar.baseUrl, DEFAULT_SIDECAR_PORT),
      logger,
    })
  }

  const existingHealth = replaceExisting
    ? { status: 'error', destination: plan.sidecar.baseUrl }
    : await probeIsaacSidecarHealthImpl(sidecarConfig)
  const reusedSidecar = existingHealth.status === 'ok'
  let sidecarChild = null
  let isaacChild = null

  if (reusedSidecar) {
    logger.log(green(`Isaac sidecar already ready at ${existingHealth.destination}. Reusing existing process.`))
  } else {
    logger.log(`Starting Isaac sidecar via ${plan.sidecar.command} ${plan.sidecar.args.join(' ')}`)
    sidecarChild = spawnImpl(plan.sidecar.command, plan.sidecar.args, {
      cwd: plan.sidecar.cwd,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
      stdio: 'inherit',
    })
    managedChildren.push(sidecarChild)
    await waitForChildSpawn(sidecarChild, 'Isaac sidecar')
    const health = await waitForSidecarReady({
      sidecarConfig,
      child: sidecarChild,
      timeoutMs: plan.sidecarReadyTimeoutMs,
      probeIsaacSidecarHealthImpl,
    })
    logger.log(green(`Isaac sidecar ready at ${health.destination}.`))
  }

  if (plan.isaac.enabled) {
    if (!plan.isaac.command) {
      throw new Error('Isaac Sim launch is enabled but no launch script path is configured.')
    }

    if (reusedSidecar) {
      logger.log('Reusing existing Isaac sidecar. Launching Isaac Sim anyway.')
    }

    logger.log(`Launching Isaac Sim via ${plan.isaac.command || '<missing launch script>'}`)
    isaacChild = spawnImpl(plan.isaac.command, plan.isaac.args, {
      cwd: plan.isaac.cwd,
      env: process.env,
      shell: plan.isaac.shell,
      stdio: 'inherit',
    })
    managedChildren.push(isaacChild)
    await waitForChildSpawn(isaacChild, 'Isaac Sim launcher')
  }

  return {
    enabled: true,
    plan,
    reusedSidecar,
    sidecarChild,
    isaacChild,
    async stop() {
      await stopManagedChildren(managedChildren)
    },
  }
}

async function waitForSidecarReady({ sidecarConfig, child, timeoutMs, probeIsaacSidecarHealthImpl }) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode != null) {
      throw new Error(`Isaac sidecar exited early with code ${child.exitCode}.`)
    }

    const health = await probeIsaacSidecarHealthImpl(sidecarConfig)

    if (health.status === 'ok') {
      return health
    }

    if (health.status !== 'error') {
      throw new Error(`Isaac sidecar readiness probe returned unexpected status "${health.status}".`)
    }

    await sleep(HEALTH_POLL_INTERVAL_MS)
  }

  throw new Error(`Timed out waiting ${timeoutMs}ms for Isaac sidecar readiness.`)
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

function isWindowsBatchFile(filePath) {
  return process.platform === 'win32' && /\.(bat|cmd)$/i.test(filePath || '')
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
