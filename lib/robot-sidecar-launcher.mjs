import { spawn } from 'node:child_process'
import path from 'node:path'
import { stopManagedProcessByScript } from './managed-process-cleanup.mjs'
import { green } from './startup-banner.mjs'
import { probeRobotSidecarHealth } from './robot-sidecar-client.mjs'

const DEFAULT_SIDECAR_HOST = '127.0.0.1'
const DEFAULT_SIDECAR_PORT = 8892
const DEFAULT_READY_TIMEOUT_MS = 10_000
const HEALTH_POLL_INTERVAL_MS = 250

export function resolveManagedRobotLaunchPlan(runtimeConfig = {}, ros2Config = {}, rootDir = '.') {
  const activeTarget = runtimeConfig.activeTarget ?? {}
  const transport = ros2Config.transport ?? {}
  const launch = ros2Config.launch ?? {}
  const workspaceRoot = path.resolve(rootDir)
  const workdir = path.resolve(workspaceRoot, launch.workdir || '.')
  const targetUrl = safeParseUrl(transport.baseUrl)
  const host = targetUrl?.hostname || DEFAULT_SIDECAR_HOST
  const port = normalizePort(targetUrl?.port)
  const sidecarScriptPath = path.resolve(workdir, launch.scriptPath || 'sidecars/ros2_bridge/server.py')
  const launchCommandPath = launch.commandPath
    ? path.resolve(workdir, launch.commandPath)
    : ''
  const launchCommand = launchCommandPath
    || (typeof launch.pythonPath === 'string' && launch.pythonPath.trim() ? launch.pythonPath.trim() : 'python')
  const launchArgs = launchCommandPath
    ? [
      '--host',
      host,
      '--port',
      String(port),
      ...normalizeStringList(launch.scriptArgs),
    ]
    : [
      sidecarScriptPath,
      '--host',
      host,
      '--port',
      String(port),
      ...normalizeStringList(launch.scriptArgs),
    ]

  return {
    targetId: activeTarget.id || 'ros2_real',
    targetKind: activeTarget.kind || 'ros2-bridge',
    managedByApp:
      runtimeConfig.enabled !== false
      && activeTarget.kind === 'ros2-bridge'
      && activeTarget.managedByApp !== false
      && launch.managedByApp !== false,
    sidecarReadyTimeoutMs: normalizeTimeoutMs(launch.sidecarReadyTimeoutMs),
    sidecar: {
      command: launchCommand,
      args: launchArgs,
      cwd: workdir,
      scriptPath: sidecarScriptPath,
      shell: isWindowsBatchFile(launchCommandPath),
      baseUrl: targetUrl?.toString() || transport.baseUrl || `http://${host}:${port}`,
    },
  }
}

export async function startManagedRobotEnvironment({
  runtimeConfig = {},
  ros2Config = {},
  rootDir = '.',
  logger = console,
  probeRobotSidecarHealthImpl = probeRobotSidecarHealth,
  spawnImpl = spawn,
  stopStaleSidecarImpl = stopManagedProcessByScript,
  replaceExisting = false,
} = {}) {
  const plan = resolveManagedRobotLaunchPlan(runtimeConfig, ros2Config, rootDir)
  const managedChildren = []

  if (!plan.managedByApp) {
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
      label: 'ROS2 bridge sidecar',
      scriptPath: plan.sidecar.scriptPath,
      port: portFromBaseUrl(plan.sidecar.baseUrl, DEFAULT_SIDECAR_PORT),
      logger,
    })
  }

  const existingHealth = replaceExisting
    ? { status: 'error', destination: plan.sidecar.baseUrl }
    : await probeRobotSidecarHealthImpl(runtimeConfig, ros2Config)
  const reusedSidecar = existingHealth.status === 'ok'
  let sidecarChild = null

  if (reusedSidecar) {
    logger.log(green(`ROS2 bridge sidecar already ready at ${existingHealth.destination}. Reusing existing process.`))
  } else {
    logger.log(`Starting ROS2 bridge sidecar via ${plan.sidecar.command} ${plan.sidecar.args.join(' ')}`)
    sidecarChild = spawnImpl(plan.sidecar.command, plan.sidecar.args, {
      cwd: plan.sidecar.cwd,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
      shell: plan.sidecar.shell,
      stdio: 'inherit',
    })
    managedChildren.push(sidecarChild)
    await waitForChildSpawn(sidecarChild, 'ROS2 bridge sidecar')
    const health = await waitForSidecarReady({
      runtimeConfig,
      ros2Config,
      child: sidecarChild,
      timeoutMs: plan.sidecarReadyTimeoutMs,
      probeRobotSidecarHealthImpl,
    })
    logger.log(green(`ROS2 bridge sidecar ready at ${health.destination}.`))
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

async function waitForSidecarReady({
  runtimeConfig,
  ros2Config,
  child,
  timeoutMs,
  probeRobotSidecarHealthImpl,
}) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode != null) {
      throw new Error(`ROS2 bridge sidecar exited early with code ${child.exitCode}.`)
    }

    const health = await probeRobotSidecarHealthImpl(runtimeConfig, ros2Config)

    if (health.status === 'ok') {
      return health
    }

    if (health.status !== 'error') {
      throw new Error(`ROS2 bridge readiness probe returned unexpected status "${health.status}".`)
    }

    await sleep(HEALTH_POLL_INTERVAL_MS)
  }

  throw new Error(`Timed out waiting ${timeoutMs}ms for ROS2 bridge sidecar readiness.`)
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

function isWindowsBatchFile(filePath) {
  return process.platform === 'win32' && /\.(bat|cmd)$/i.test(filePath || '')
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
