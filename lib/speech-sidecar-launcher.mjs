import { spawn } from 'node:child_process'
import path from 'node:path'
import { probeSpeechSidecarHealth } from './speech-sidecar-client.mjs'

const DEFAULT_SIDECAR_HOST = '127.0.0.1'
const DEFAULT_SIDECAR_PORT = 8892
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
  const sidecarScriptPath = path.resolve(workdir, launch.scriptPath || 'sidecars/parakeet_bridge/server.py')

  return {
    managedByApp: launch.managedByApp ?? false,
    transportEnabled: transport.enabled ?? true,
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
  }
}

export async function startManagedSpeechSidecar({
  sidecarConfig = {},
  rootDir = '.',
  logger = console,
  probeSpeechSidecarHealthImpl = probeSpeechSidecarHealth,
  spawnImpl = spawn,
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

  const existingHealth = await probeSpeechSidecarHealthImpl(sidecarConfig)
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
