import { runDogzillaConnectionAction } from './dogzilla-connection-center.mjs'
import { probeRobotSidecarHealth } from './robot-sidecar-client.mjs'

const DEFAULT_READY_TIMEOUT_MS = 12_000
const HEALTH_POLL_INTERVAL_MS = 500

export function shouldForceDogzillaDirectBridge(runtimeConfig = {}, env = process.env) {
  const override = String(env.APP_DOGZILLA_DIRECT_BRIDGE_START ?? env.DOGZILLA_DIRECT_BRIDGE_START ?? '').trim().toLowerCase()

  if (['0', 'false', 'no', 'off'].includes(override)) {
    return false
  }

  return runtimeConfig.enabled !== false && runtimeConfig.activeTarget?.kind === 'dogzilla-direct'
}

export async function forceDogzillaDirectBridgeOnStartup({
  runtimeConfig = {},
  ros2Config = {},
  env = process.env,
  logger = console,
  probeRobotSidecarHealthImpl = probeRobotSidecarHealth,
  runDogzillaConnectionActionImpl = runDogzillaConnectionAction,
  sleepImpl = sleep,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  pollIntervalMs = HEALTH_POLL_INTERVAL_MS,
  replaceExisting = false,
} = {}) {
  if (!shouldForceDogzillaDirectBridge(runtimeConfig, env)) {
    return {
      enabled: false,
      status: 'skipped',
      reason: 'active target is not DOGZILLA Direct Bridge',
    }
  }

  const vendorStopResult = await stopDogzillaVendorApp({
    logger,
    runDogzillaConnectionActionImpl,
  })
  const existingHealth = await probeRobotSidecarHealthImpl(runtimeConfig, ros2Config)

  if (existingHealth.status === 'ok' && !replaceExisting) {
    logger.log(`DOGZILLA direct bridge already ready at ${existingHealth.destination}. Reusing existing process.`)
    return {
      enabled: true,
      status: 'ok',
      reusedBridge: true,
      health: existingHealth,
      vendorStopResult,
    }
  }

  logger.log(replaceExisting
    ? 'Restarting DOGZILLA direct bridge on app startup.'
    : 'Starting DOGZILLA direct bridge on app startup.')
  const startResult = await runDogzillaConnectionActionImpl('start-direct', {
    live: shouldStartDirectBridgeLive(runtimeConfig, ros2Config),
  })

  if (startResult.status === 'error') {
    logger.warn?.(`DOGZILLA direct bridge startup failed: ${startResult.error || startResult.stderr || 'unknown error'}`)
    return {
      enabled: true,
      status: 'error',
      reusedBridge: false,
      health: existingHealth,
      startResult,
      vendorStopResult,
    }
  }

  const health = await waitForDogzillaDirectBridgeHealth({
    runtimeConfig,
    ros2Config,
    probeRobotSidecarHealthImpl,
    sleepImpl,
    timeoutMs: readyTimeoutMs,
    pollIntervalMs,
  })

  if (health.status === 'ok') {
    logger.log(`DOGZILLA direct bridge ready at ${health.destination}.`)
  } else {
    logger.warn?.(`DOGZILLA direct bridge did not become ready: ${health.error || health.status || 'unknown status'}`)
  }

  return {
    enabled: true,
    status: health.status === 'ok' ? 'ok' : 'error',
    reusedBridge: false,
    health,
    startResult,
    vendorStopResult,
  }
}

async function stopDogzillaVendorApp({
  logger,
  runDogzillaConnectionActionImpl,
}) {
  const result = await runDogzillaConnectionActionImpl('stop-vendor-app')

  if (result.status === 'error') {
    logger.warn?.(`DOGZILLA vendor app stop failed: ${result.error || result.stderr || 'unknown error'}`)
  } else {
    logger.log?.('DOGZILLA vendor app stopped or already absent.')
  }

  return result
}

export function shouldStartDirectBridgeLive(runtimeConfig = {}, ros2Config = {}) {
  return runtimeConfig.dryRun === false && ros2Config.transport?.dryRun === false
}

async function waitForDogzillaDirectBridgeHealth({
  runtimeConfig,
  ros2Config,
  probeRobotSidecarHealthImpl,
  sleepImpl,
  timeoutMs,
  pollIntervalMs,
}) {
  const startedAt = Date.now()
  let lastHealth = null

  do {
    lastHealth = await probeRobotSidecarHealthImpl(runtimeConfig, ros2Config)

    if (lastHealth.status === 'ok') {
      return lastHealth
    }

    await sleepImpl(pollIntervalMs)
  } while (Date.now() - startedAt < timeoutMs)

  return lastHealth || {
    attempted: true,
    status: 'error',
    error: `Timed out waiting ${timeoutMs}ms for DOGZILLA direct bridge readiness.`,
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
