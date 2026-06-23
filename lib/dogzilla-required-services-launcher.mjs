import {
  loadDogzillaConnectionConfig,
  runDogzillaConnectionAction,
} from './dogzilla-connection-center.mjs'
import { green } from './startup-banner.mjs'
import { formatFetchError } from './http-error.mjs'

const DEFAULT_READY_TIMEOUT_MS = 45_000
const HEALTH_POLL_INTERVAL_MS = 1_000

export function shouldForceDogzillaRequiredServices(config = {}, env = process.env) {
  const override = String(env.APP_DOGZILLA_REQUIRED_SERVICES_START ?? env.DOGZILLA_REQUIRED_SERVICES_START ?? '').trim().toLowerCase()

  if (['0', 'false', 'no', 'off'].includes(override)) {
    return false
  }

  return config.vision?.enabled === true || config.audio?.enabled === true || config.lidar?.enabled === true
}

export async function forceDogzillaRequiredServicesOnStartup({
  config = null,
  env = process.env,
  logger = console,
  fetchImpl = fetch,
  runDogzillaConnectionActionImpl = runDogzillaConnectionAction,
  loadDogzillaConnectionConfigImpl = loadDogzillaConnectionConfig,
  sleepImpl = sleep,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  pollIntervalMs = HEALTH_POLL_INTERVAL_MS,
  replaceExisting = false,
} = {}) {
  const resolvedConfig = config || await loadDogzillaConnectionConfigImpl()

  if (!shouldForceDogzillaRequiredServices(resolvedConfig, env)) {
    return {
      enabled: false,
      status: 'skipped',
      reason: 'YOLO vision, Pi audio cues, and lidar are disabled',
      results: {},
    }
  }

  const services = buildRequiredServiceDescriptors(resolvedConfig)
  const results = {}

  for (const service of services) {
    if (service.requiresService && results[service.requiresService]?.status !== 'ok') {
      const dependency = results[service.requiresService]
      logger.warn?.(`${service.label} startup skipped because ${service.requiresService} is not ready.`)
      results[service.id] = {
        status: 'skipped',
        reusedService: false,
        skipped: true,
        reason: `${service.requiresService} is not ready`,
        dependency,
      }
      continue
    }

    results[service.id] = await ensureRequiredService({
      service,
      logger,
      fetchImpl,
      runDogzillaConnectionActionImpl,
      sleepImpl,
      readyTimeoutMs,
      pollIntervalMs,
      replaceExisting,
    })
  }

  const values = Object.values(results)
  return {
    enabled: true,
    status: values.every((result) => result.status === 'ok') ? 'ok' : 'error',
    results,
  }
}

export function buildRequiredServiceDescriptors(config = {}) {
  const services = []

  if (config.vision?.enabled === true) {
    services.push({
      id: 'vision',
      label: 'DOGZILLA YOLO object recognition',
      action: 'start-yolo',
      healthUrl: config.vision.statusUrl,
    })
  }

  if (config.audio?.enabled === true) {
    services.push({
      id: 'audio',
      label: 'DOGZILLA Pi speaker cues',
      action: 'start-audio',
      healthUrl: config.audio.healthUrl,
    })
  }

  if (config.lidar?.enabled === true) {
    services.push({
      id: 'lidar',
      label: 'DOGZILLA lidar bridge',
      action: 'start-lidar',
      healthUrl: config.lidar.healthUrl,
    })

    services.push({
      id: 'mapPose',
      label: 'DOGZILLA map pose localization',
      action: 'start-map-pose',
      healthUrl: config.lidar.poseUrl,
      expectMapPose: true,
      requiresService: 'lidar',
    })
  }

  return services.filter((service) => service.healthUrl)
}

async function ensureRequiredService({
  service,
  logger,
  fetchImpl,
  runDogzillaConnectionActionImpl,
  sleepImpl,
  readyTimeoutMs,
  pollIntervalMs,
  replaceExisting,
}) {
  const existingHealth = await probeRequiredServiceHealth(service, fetchImpl)

  if (existingHealth.status === 'ok' && !replaceExisting) {
    logger.log?.(green(`${service.label} already ready at ${service.healthUrl}. Reusing existing process.`))
    return {
      status: 'ok',
      reusedService: true,
      health: existingHealth,
    }
  }

  logger.log?.(replaceExisting
    ? `Restarting ${service.label} on app startup.`
    : `Starting ${service.label} on app startup.`)
  const startResult = await runDogzillaConnectionActionImpl(service.action)

  if (startResult.status === 'error') {
    logger.warn?.(`${service.label} startup failed: ${startResult.error || startResult.stderr || 'unknown error'}`)
    const health = await waitForRequiredServiceHealth({
      service,
      fetchImpl,
      sleepImpl,
      timeoutMs: readyTimeoutMs,
      pollIntervalMs,
    })

    if (health.status === 'ok') {
      logger.log?.(green(`${service.label} ready at ${service.healthUrl} after startup retry verification.`))
      return {
        status: 'ok',
        reusedService: false,
        health,
        startResult,
        recoveredAfterStartError: true,
      }
    }

    return {
      status: 'error',
      reusedService: false,
      health,
      startResult,
    }
  }

  const health = await waitForRequiredServiceHealth({
    service,
    fetchImpl,
    sleepImpl,
    timeoutMs: readyTimeoutMs,
    pollIntervalMs,
  })

  if (health.status === 'ok') {
    logger.log?.(green(`${service.label} ready at ${service.healthUrl}.`))
  } else {
    logger.warn?.(`${service.label} did not become ready: ${health.error || health.body?.error || health.status || 'unknown status'}`)
  }

  return {
    status: health.status === 'ok' ? 'ok' : 'error',
    reusedService: false,
    health,
    startResult,
  }
}

export async function probeRequiredServiceHealth(service, fetchImpl = fetch) {
  if (!service.healthUrl) {
    return {
      status: 'unconfigured',
      error: `${service.label || service.id} health URL is not configured.`,
    }
  }

  try {
    const response = await fetchImpl(service.healthUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(4000),
    })
    const body = await safeReadJson(response)
    const bodyOk = body && typeof body === 'object' && body.ok === false ? false : true
    const expectationOk = service.expectMapPose ? hasWaypointSafeMapPose(body) : true

    return {
      status: response.ok && bodyOk && expectationOk ? 'ok' : response.ok ? 'degraded' : 'error',
      destination: service.healthUrl,
      responseStatus: response.status,
      body,
      ...(response.ok && bodyOk && !expectationOk
        ? { error: `${service.label || service.id} did not report waypoint-safe map pose.` }
        : {}),
    }
  } catch (error) {
    return {
      status: 'error',
      destination: service.healthUrl,
      error: formatFetchError(error),
    }
  }
}

async function waitForRequiredServiceHealth({
  service,
  fetchImpl,
  sleepImpl,
  timeoutMs,
  pollIntervalMs,
}) {
  const startedAt = Date.now()
  let lastHealth = null

  do {
    lastHealth = await probeRequiredServiceHealth(service, fetchImpl)

    if (lastHealth.status === 'ok') {
      return lastHealth
    }

    await sleepImpl(pollIntervalMs)
  } while (Date.now() - startedAt < timeoutMs)

  return lastHealth || {
    status: 'error',
    destination: service.healthUrl,
    error: `Timed out waiting ${timeoutMs}ms for ${service.label} readiness.`,
  }
}

function hasWaypointSafeMapPose(body) {
  if (!body || typeof body !== 'object') {
    return false
  }

  const mapPose = body.mapPose && typeof body.mapPose === 'object' ? body.mapPose : null
  const pose = body.pose && typeof body.pose === 'object'
    ? body.pose
    : Number.isFinite(Number(body.x)) && Number.isFinite(Number(body.y))
      ? body
      : null

  if (body.ok === true && body.waypointSafe === true && pose?.frame === 'map') {
    return true
  }

  return body.ok === true
    && body.waypointSafe === true
    && mapPose?.frame === 'map'
}

async function safeReadJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
