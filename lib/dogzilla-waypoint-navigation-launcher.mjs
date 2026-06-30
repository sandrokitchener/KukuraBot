import {
  loadDogzillaConnectionConfig,
  runDogzillaConnectionAction,
} from './dogzilla-connection-center.mjs'
import {
  buildDogzillaWaypointNavigationReadinessSteps,
  getDogzillaWaypointNavigationReadiness,
} from './dogzilla-navigation-readiness.mjs'
import {
  DEFAULT_MAP_ORIGIN_FILE,
  loadDogzillaMapOrigin,
  saveDogzillaMapOriginFromPose,
} from './dogzilla-map-frame.mjs'
import {
  getDogzillaRobotPose,
  startDogzillaLidarClient,
} from './dogzilla-lidar-client.mjs'
import { green } from './startup-banner.mjs'
import { enterDogzillaNavMode, fetchDogzillaNavMode, probeRobotSidecarHealth } from './robot-sidecar-client.mjs'
import { runDogzillaStartWithRetries } from './dogzilla-start-retry.mjs'

const DEFAULT_READY_TIMEOUT_MS = 45_000
const DISCOVERY_WAIT_TIMEOUT_MS = 60_000
const DISCOVERY_POLL_INTERVAL_MS = 2_000
const HEALTH_POLL_INTERVAL_MS = 1_000
const DEFAULT_EXISTING_READY_GRACE_MS = 3_000
const DEFAULT_BRIDGE_NAV_READY_TIMEOUT_MS = 240_000

export function shouldUseBridgeNavOwner(env = process.env) {
  const override = String(env.APP_DOGZILLA_NAV_OWNER ?? env.DOGZILLA_NAV_OWNER ?? '').trim().toLowerCase()
  return override !== 'ssh'
}


export function shouldForceDogzillaWaypointNavigation(runtimeConfig = {}, dogzillaConfig = {}, env = process.env) {
  const override = String(env.APP_DOGZILLA_WAYPOINT_NAVIGATION_START ?? env.DOGZILLA_WAYPOINT_NAVIGATION_START ?? '').trim().toLowerCase()

  if (['0', 'false', 'no', 'off'].includes(override)) {
    return false
  }

  if (['1', 'true', 'yes', 'on'].includes(override)) {
    return runtimeConfig.enabled !== false && runtimeConfig.activeTarget?.kind === 'dogzilla-direct'
  }

  return runtimeConfig.enabled !== false
    && runtimeConfig.activeTarget?.kind === 'dogzilla-direct'
    && dogzillaConfig.lidar?.enabled === true
}

export async function forceDogzillaWaypointNavigationOnStartup({
  runtimeConfig = {},
  ros2Config = {},
  dogzillaConfig = null,
  env = process.env,
  logger = console,
  probeRobotSidecarHealthImpl = probeRobotSidecarHealth,
  runDogzillaConnectionActionImpl = runDogzillaConnectionAction,
  loadDogzillaConnectionConfigImpl = loadDogzillaConnectionConfig,
  runDogzillaStartWithRetriesImpl = runDogzillaStartWithRetries,
  waitForPoseReadyImpl = waitForPoseReady,
  sleepImpl = sleep,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  pollIntervalMs = HEALTH_POLL_INTERVAL_MS,
  existingReadyGraceMs = DEFAULT_EXISTING_READY_GRACE_MS,
  replaceExisting = false,
} = {}) {
  const resolvedDogzillaConfig = dogzillaConfig || await loadDogzillaConnectionConfigImpl({ env })

  if (!shouldForceDogzillaWaypointNavigation(runtimeConfig, resolvedDogzillaConfig, env)) {
    return {
      enabled: false,
      status: 'skipped',
      reason: 'active target is not DOGZILLA Direct Bridge or DOGZILLA lidar is disabled',
    }
  }

  let existingHealth = await probeRobotSidecarHealthImpl(runtimeConfig, ros2Config)
  if (
    !replaceExisting
    && existingHealth?.status === 'ok'
    && !isDogzillaWaypointNavigationReady(existingHealth)
    && Number.isFinite(existingReadyGraceMs)
    && existingReadyGraceMs > 0
  ) {
    existingHealth = await waitForDogzillaWaypointNavigationHealth({
      runtimeConfig,
      ros2Config,
      probeRobotSidecarHealthImpl,
      sleepImpl,
      timeoutMs: existingReadyGraceMs,
      pollIntervalMs,
    })
  }
  logDogzillaWaypointNavigationReadiness(existingHealth, logger, {
    heading: 'DOGZILLA Nav2 startup readiness before repair:',
  })

  if (isDogzillaWaypointNavigationReady(existingHealth) && !replaceExisting) {
    logger.log?.(green(`DOGZILLA waypoint navigator already ready at ${existingHealth.destination}. Reusing existing Nav2 server.`))
    await autoSaveDogzillaMapOrigin({ logger, mapMetadata: existingHealth?.body?.runtime?.map || null })
    return {
      enabled: true,
      status: 'ok',
      reusedNavigation: true,
      health: existingHealth,
    }
  }

  const existingReadiness = getDogzillaWaypointNavigationReadiness(existingHealth.body?.runtime)
  if (existingReadiness.discovering && !replaceExisting) {
    logger.log?.('DOGZILLA Nav2 lifecycle/odom/scan/pose healthy; action server still discovering. Waiting instead of restarting.')
    const discoveredHealth = await waitForDogzillaWaypointNavigationHealth({
      runtimeConfig,
      ros2Config,
      probeRobotSidecarHealthImpl,
      sleepImpl,
      timeoutMs: DISCOVERY_WAIT_TIMEOUT_MS,
      pollIntervalMs: DISCOVERY_POLL_INTERVAL_MS,
    })
    logDogzillaWaypointNavigationReadiness(discoveredHealth, logger, {
      heading: 'DOGZILLA Nav2 readiness after discovery wait:',
    })
    if (isDogzillaWaypointNavigationReady(discoveredHealth)) {
      logger.log?.(green(`DOGZILLA waypoint navigator discovered existing action server at ${discoveredHealth.destination}.`))
      await autoSaveDogzillaMapOrigin({ logger, mapMetadata: discoveredHealth?.body?.runtime?.map || null })
      return {
        enabled: true,
        status: 'ok',
        reusedNavigation: true,
        health: discoveredHealth,
      }
    }
    logger.warn?.('DOGZILLA Nav2 action server did not appear after discovery wait; will restart navigation.')
  }

  if (existingHealth.status !== 'ok') {
    logger.warn?.(`DOGZILLA waypoint navigator startup skipped because direct bridge health is ${existingHealth.status}${existingHealth.error ? ` (${existingHealth.error})` : ''}.`)
    return {
      enabled: true,
      status: 'error',
      reusedNavigation: false,
      health: existingHealth,
      error: 'DOGZILLA direct bridge is not ready',
    }
  }

  const mapPoseStartResult = await ensureDogzillaMapPoseBeforeNavigation({
    logger,
    runDogzillaConnectionActionImpl,
    runDogzillaStartWithRetriesImpl,
  })

  if (mapPoseStartResult?.status === 'error') {
    logger.warn?.(`DOGZILLA map pose startup failed before Nav2: ${mapPoseStartResult.error || mapPoseStartResult.stderr || 'unknown error'}`)
    return {
      enabled: true,
      status: 'error',
      reusedNavigation: false,
      health: existingHealth,
      mapPoseStartResult,
      error: 'DOGZILLA map pose is not ready',
    }
  }

  await waitForPoseReadyImpl({ logger, sleepImpl, timeoutMs: 15_000, pollIntervalMs: 1_000 })

  logger.log?.(replaceExisting
    ? 'Restarting DOGZILLA waypoint navigator on app startup.'
    : 'Starting DOGZILLA waypoint navigator on app startup.')
  const startResult = await runDogzillaStartWithRetriesImpl({
    action: 'start-navigation',
    runDogzillaConnectionActionImpl,
    sleepImpl,
    logger,
  })

  if (startResult.status === 'error') {
    logger.warn?.(`DOGZILLA waypoint navigator startup failed: ${startResult.error || startResult.stderr || 'unknown error'}`)
    return {
      enabled: true,
      status: 'error',
      reusedNavigation: false,
      health: existingHealth,
      mapPoseStartResult,
      startResult,
    }
  }

  const health = await waitForDogzillaWaypointNavigationHealth({
    runtimeConfig,
    ros2Config,
    probeRobotSidecarHealthImpl,
    sleepImpl,
    timeoutMs: readyTimeoutMs,
    pollIntervalMs,
  })
  logDogzillaWaypointNavigationReadiness(health, logger, {
    heading: 'DOGZILLA Nav2 startup readiness after repair:',
  })

  if (isDogzillaWaypointNavigationReady(health)) {
    logger.log?.(green(`DOGZILLA waypoint navigator ready at ${health.destination}.`))
    await autoSaveDogzillaMapOrigin({ logger, mapMetadata: health?.body?.runtime?.map || null })
  } else {
    logger.warn?.(`DOGZILLA waypoint navigator did not become ready: ${formatDogzillaWaypointNavigationError(health)}`)
  }

  return {
    enabled: true,
    status: isDogzillaWaypointNavigationReady(health) ? 'ok' : 'error',
    reusedNavigation: false,
    health,
    mapPoseStartResult,
    startResult,
  }
}

export async function forceDogzillaNavModeViaBridge({
  runtimeConfig = {},
  ros2Config = {},
  dogzillaConfig = null,
  mode = 'navigate',
  env = process.env,
  logger = console,
  enterDogzillaNavModeImpl = enterDogzillaNavMode,
  fetchDogzillaNavModeImpl = fetchDogzillaNavMode,
  probeRobotSidecarHealthImpl = probeRobotSidecarHealth,
  loadDogzillaConnectionConfigImpl = loadDogzillaConnectionConfig,
  sleepImpl = sleep,
  readyTimeoutMs = resolveBridgeNavReadyTimeoutMs(env),
  pollIntervalMs = HEALTH_POLL_INTERVAL_MS,
} = {}) {
  const resolvedDogzillaConfig = dogzillaConfig || await loadDogzillaConnectionConfigImpl({ env })

  if (!shouldForceDogzillaWaypointNavigation(runtimeConfig, resolvedDogzillaConfig, env)) {
    return {
      enabled: false,
      status: 'skipped',
      reason: 'active target is not DOGZILLA Direct Bridge or DOGZILLA lidar is disabled',
    }
  }

  logger.log?.(`DOGZILLA bridge nav owner: requesting mode '${mode}'.`)
  const modeResult = await enterDogzillaNavModeImpl(runtimeConfig, ros2Config, mode)
  let modeState = null

  if (!modeResult.ok) {
    modeState = await fetchDogzillaNavModeImpl(runtimeConfig, ros2Config).catch((error) => ({
      ok: false,
      status: 'error',
      navMode: 'unknown',
      error: error instanceof Error ? error.message : String(error),
    }))

    if (!isDogzillaBridgeModeTransitionPending(modeState, mode)) {
      logger.warn?.(`DOGZILLA bridge nav owner: mode request failed: ${modeResult.error || modeResult.status}`)
      return {
        enabled: true,
        status: 'error',
        modeResult,
        modeState,
        error: modeResult.error || `bridge mode request failed: ${modeResult.status}`,
      }
    }

    logger.log?.(`DOGZILLA bridge nav owner: ${mode} request did not complete; bridge transition still running.`)
  }

  if (mode !== 'navigate') {
    return { enabled: true, status: 'ok', modeResult, modeState, health: null }
  }

  const health = await waitForDogzillaWaypointNavigationHealth({
    runtimeConfig,
    ros2Config,
    probeRobotSidecarHealthImpl,
    sleepImpl,
    timeoutMs: readyTimeoutMs,
    pollIntervalMs,
  })
  logDogzillaWaypointNavigationReadiness(health, logger, {
    heading: 'DOGZILLA Nav2 readiness after bridge mode transition:',
  })

  if (isDogzillaWaypointNavigationReady(health)) {
    logger.log?.(green(`DOGZILLA waypoint navigator ready at ${health.destination}.`))
    await autoSaveDogzillaMapOrigin({ logger, mapMetadata: health?.body?.runtime?.map || null })
  } else {
    logger.warn?.(`DOGZILLA waypoint navigator did not become ready: ${formatDogzillaWaypointNavigationError(health)}`)
  }

  return {
    enabled: true,
    status: isDogzillaWaypointNavigationReady(health) ? 'ok' : 'error',
    modeResult,
    modeState,
    health,
  }
}

export function isDogzillaBridgeModeTransitionPending(modeState = {}, expectedMode = 'navigate') {
  const body = modeState?.body && typeof modeState.body === 'object' ? modeState.body : {}
  const navMode = body.navMode || body.mode || modeState?.navMode || modeState?.mode || ''
  return body.transitioning === true || modeState?.transitioning === true || navMode === expectedMode
}

function resolveBridgeNavReadyTimeoutMs(env = process.env) {
  const raw = env.APP_DOGZILLA_NAV2_BRIDGE_READY_TIMEOUT_MS ?? env.DOGZILLA_NAV2_BRIDGE_READY_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BRIDGE_NAV_READY_TIMEOUT_MS
}

export function isDogzillaWaypointNavigationReady(health = {}) {
  if (health?.status !== 'ok') {
    return false
  }

  const runtime = health.body?.runtime && typeof health.body.runtime === 'object' ? health.body.runtime : null
  return getDogzillaWaypointNavigationReadiness(runtime).ready
}

async function waitForDogzillaWaypointNavigationHealth({
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

    if (isDogzillaWaypointNavigationReady(lastHealth)) {
      return lastHealth
    }

    await sleepImpl(pollIntervalMs)
  } while (Date.now() - startedAt < timeoutMs)

  return lastHealth || {
    attempted: true,
    status: 'error',
    error: `Timed out waiting ${timeoutMs}ms for DOGZILLA waypoint navigator readiness.`,
  }
}

function formatDogzillaWaypointNavigationError(health = {}) {
  const runtime = health.body?.runtime && typeof health.body.runtime === 'object' ? health.body.runtime : null
  const nav2 = runtime?.nav2 && typeof runtime.nav2 === 'object' ? runtime.nav2 : null
  const readiness = getDogzillaWaypointNavigationReadiness(runtime)

  return readiness.reason
    || nav2?.serverError
    || nav2?.importError
    || health.error
    || health.status
    || 'unknown status'
}

export function logDogzillaWaypointNavigationReadiness(health = {}, logger = console, options = {}) {
  const runtime = health.body?.runtime && typeof health.body.runtime === 'object' ? health.body.runtime : null
  const readiness = getDogzillaWaypointNavigationReadiness(runtime)
  const steps = buildDogzillaWaypointNavigationReadinessSteps(readiness)
  const heading = options.heading || 'DOGZILLA Nav2 readiness:'

  logger.log?.(heading)

  if (health?.status !== 'ok') {
    logger.warn?.(`  [blocked] Direct bridge health: ${health?.error || health?.status || 'unknown status'}`)
  }

  for (const step of steps) {
    const line = `  [${step.ok ? 'ok' : 'blocked'}] ${step.label}: ${step.detail}`
    if (step.ok) {
      logger.log?.(line)
    } else {
      logger.warn?.(line)
    }
  }

  if (readiness.ready) {
    logger.log?.('  [ok] Nav2 waypoint readiness: ready.')
  } else {
    logger.warn?.(`  [blocked] Nav2 waypoint readiness: ${readiness.reason || 'not ready'}`)
  }
}

async function ensureDogzillaMapPoseBeforeNavigation({
  logger = console,
  runDogzillaConnectionActionImpl = runDogzillaConnectionAction,
  runDogzillaStartWithRetriesImpl = runDogzillaStartWithRetries,
} = {}) {
  logger.log?.('Ensuring DOGZILLA map pose localization before Nav2 startup.')
  return runDogzillaStartWithRetriesImpl({
    action: 'start-map-pose',
    runDogzillaConnectionActionImpl,
    logger,
  })
}

async function autoSaveDogzillaMapOrigin({
  logger = console,
} = {}) {
  try {
    const oldOrigin = await loadDogzillaMapOrigin()
    if (oldOrigin) {
      return
    }

    const pose = await getDogzillaRobotPose()
    if (!pose.ok || !pose.waypointSafe) {
      logger.warn?.(`DOGZILLA map origin auto-save skipped: no waypoint-safe map pose yet.`)
      return
    }

    await saveDogzillaMapOriginFromPose(pose, {
      originFile: DEFAULT_MAP_ORIGIN_FILE,
      label: 'auto_origin',
      requireMapIdentity: false,
    })
    logger.log?.(`DOGZILLA map origin saved at current robot pose.`)
  } catch (error) {
    logger.warn?.(`DOGZILLA map origin auto-save failed: ${error instanceof Error ? error.message : String(error)}. Use set-dogzilla-map-origin.mjs manually.`)
  }
}

async function waitForPoseReady({ logger = console, sleepImpl = sleep, timeoutMs = 15_000, pollIntervalMs = 1_000 } = {}) {
  await startDogzillaLidarClient()
  const startedAt = Date.now()
  logger.log?.(`Waiting up to ${timeoutMs / 1000}s for DOGZILLA Cartographer pose to stabilize (waypointSafe=true).`)

  while (Date.now() - startedAt < timeoutMs) {
    const body = await getDogzillaRobotPose()
    if (body.ok && body.waypointSafe === true) {
      logger.log?.(`DOGZILLA pose waypointSafe=true after ${Date.now() - startedAt}ms.`)
      return
    }
    await sleepImpl(pollIntervalMs)
  }

  logger.warn?.(`DOGZILLA Cartographer pose did not reach waypointSafe=true within ${timeoutMs / 1000}s. Nav2 startup will be attempted anyway.`)
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
