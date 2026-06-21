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
  fetchDogzillaMapOriginFromBridge,
  getDogzillaMapOriginIdentity,
  hasDogzillaMapOriginIdentity,
  loadDogzillaMapOrigin,
  saveDogzillaMapOriginFromPose,
} from './dogzilla-map-frame.mjs'
import { green } from './startup-banner.mjs'
import { probeRobotSidecarHealth } from './robot-sidecar-client.mjs'

const DEFAULT_READY_TIMEOUT_MS = 45_000
const HEALTH_POLL_INTERVAL_MS = 1_000
const DOGZILLA_POSE_URL = process.env.DOGZILLA_POSE_URL || 'http://10.0.4.32:8896/pose'

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
  sleepImpl = sleep,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  pollIntervalMs = HEALTH_POLL_INTERVAL_MS,
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

  const existingHealth = await probeRobotSidecarHealthImpl(runtimeConfig, ros2Config)
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

  logger.log?.(replaceExisting
    ? 'Restarting DOGZILLA waypoint navigator on app startup.'
    : 'Starting DOGZILLA waypoint navigator on app startup.')
  const startResult = await runDogzillaConnectionActionImpl('start-navigation')

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
} = {}) {
  logger.log?.('Ensuring DOGZILLA map pose localization before Nav2 startup.')
  return runDogzillaConnectionActionImpl('start-map-pose')
}

async function autoSaveDogzillaMapOrigin({
  logger = console,
  mapMetadata = null,
} = {}) {
  try {
    const oldOrigin = await loadDogzillaMapOrigin()
    const oldId = oldOrigin ? getDogzillaMapOriginIdentity(oldOrigin) : null

    if (oldOrigin && hasDogzillaMapOriginIdentity(oldOrigin) && !mapMetadata) {
      logger.log?.(`DOGZILLA map origin has map identity; no active map metadata to refresh with. Keeping identity-bearing origin.`)
      return
    }

    if (oldOrigin && hasDogzillaMapOriginIdentity(oldOrigin) && mapMetadata) {
      const newFingerprint = String(mapMetadata.fingerprint || '').trim()
      if (newFingerprint && oldId.fingerprint !== newFingerprint) {
        logger.warn?.(`DOGZILLA map fingerprint changed (${oldId.fingerprint.slice(0, 12)}... → ${newFingerprint.slice(0, 12)}...). Map origin NOT overwritten — keeping existing identity-bearing origin. Operator must review stale-map-mismatch before re-capturing.`)
        return
      }
    }

    const newOrigin = await fetchDogzillaMapOriginFromBridge(DOGZILLA_POSE_URL, { mapMetadata })
    if (!newOrigin) {
      logger.warn?.(`DOGZILLA map origin auto-save failed: could not fetch origin from bridge. Waypoints may appear in wrong spots on minimap.`)
      return
    }

    if (oldOrigin) {
      logger.log?.(`DOGZILLA map origin refreshed (label="${newOrigin.label}").`)
    } else {
      logger.log?.(`DOGZILLA map origin saved at current robot pose.`)
    }
  } catch (error) {
    logger.warn?.(`DOGZILLA map origin auto-save failed: ${error instanceof Error ? error.message : String(error)}. Use set-dogzilla-map-origin.mjs manually.`)
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
