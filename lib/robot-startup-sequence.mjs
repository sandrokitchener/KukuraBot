import { sendDogzillaAudioCue } from './dogzilla-audio-cue-client.mjs'
import { runDogzillaConnectionAction } from './dogzilla-connection-center.mjs'
import { loadRobotActionsConfig, loadRobotWaypointsConfig } from './isaacsim-config.mjs'
import { compileRobotRuntimePreview } from './robot-command-compiler.mjs'
import { isRobotHttpTarget, probeRobotSidecarHealth, sendRobotCommand } from './robot-sidecar-client.mjs'
import {
  loadRobotMotionConfig,
  loadRobotRos2Config,
  loadRobotRuntimeConfig,
} from './robot-runtime-config.mjs'

const DEFAULT_AUDIO_CUE = 'bark'
const DEFAULT_GESTURE_TRICK = 'handshake'
const DEFAULT_GESTURE_ACTION_ID = 19
const DEFAULT_GESTURE_DELAY_MS = 200
const DIRECT_BRIDGE_READY_TIMEOUT_MS = 15_000
const DIRECT_BRIDGE_POLL_MS = 500
const DIRECT_BRIDGE_START_ATTEMPTS = 3
const OFF_VALUES = new Set(['0', 'false', 'no', 'off'])

export function shouldRunRobotStartupSequence(runtimeConfig = {}, env = process.env) {
  const override = normalizeString(env.APP_ROBOT_STARTUP_SEQUENCE ?? env.ROBOT_STARTUP_SEQUENCE).toLowerCase()

  if (OFF_VALUES.has(override)) {
    return false
  }

  return runtimeConfig.enabled !== false && isRobotHttpTarget(runtimeConfig)
}

export async function runRobotStartupSequence({
  runtimeConfig = null,
  ros2Config = null,
  waypointConfig = null,
  actionConfig = null,
  motionConfig = null,
  env = process.env,
  logger = console,
  requiredServicesReady = null,
  existingDirectBridgeHealth = null,
  sendDogzillaAudioCueImpl = sendDogzillaAudioCue,
  sendRobotCommandImpl = sendRobotCommand,
  probeRobotSidecarHealthImpl = probeRobotSidecarHealth,
  runDogzillaConnectionActionImpl = runDogzillaConnectionAction,
  sleepImpl = sleep,
} = {}) {
  const [
    resolvedRuntimeConfig,
    resolvedRos2Config,
    resolvedWaypointConfig,
    resolvedActionConfig,
    resolvedMotionConfig,
  ] = await Promise.all([
    runtimeConfig ? Promise.resolve(runtimeConfig) : loadRobotRuntimeConfig(),
    ros2Config ? Promise.resolve(ros2Config) : loadRobotRos2Config(),
    waypointConfig ? Promise.resolve(waypointConfig) : loadRobotWaypointsConfig(),
    actionConfig ? Promise.resolve(actionConfig) : loadRobotActionsConfig(),
    motionConfig ? Promise.resolve(motionConfig) : loadRobotMotionConfig(),
  ])

  if (!shouldRunRobotStartupSequence(resolvedRuntimeConfig, env)) {
    return {
      status: 'skipped',
      reason: 'active target is not a robot HTTP target',
      target: resolvedRuntimeConfig.activeTarget?.id || '',
    }
  }

  const readiness = await waitForRequiredServices(requiredServicesReady, logger)
  const liveStartup = shouldUseLiveStartupGesture(resolvedRuntimeConfig, env)
  const liveBridge = liveStartup
    ? await ensureDirectStartupBridgeLive({
      runtimeConfig: resolvedRuntimeConfig,
      ros2Config: resolvedRos2Config,
      existingHealth: existingDirectBridgeHealth,
      logger,
      probeRobotSidecarHealthImpl,
      runDogzillaConnectionActionImpl,
      sleepImpl,
    })
    : null
  const audioCue = normalizeString(env.ROBOT_STARTUP_AUDIO_CUE) || DEFAULT_AUDIO_CUE
  const gestureTrick = normalizeString(env.ROBOT_STARTUP_TRICK) || DEFAULT_GESTURE_TRICK
  const gestureDelayMs = positiveInteger(
    env.ROBOT_STARTUP_GESTURE_DELAY_MS,
    DEFAULT_GESTURE_DELAY_MS,
  )
  const audio = await sendStartupAudioCue(audioCue, sendDogzillaAudioCueImpl)

  if (gestureDelayMs > 0) {
    await sleepImpl(gestureDelayMs)
  }

  const commandRuntimeConfig = liveStartup ? forceLiveRobotConfig(resolvedRuntimeConfig) : resolvedRuntimeConfig
  const commandRos2Config = liveStartup ? forceLiveRos2Config(resolvedRos2Config) : resolvedRos2Config
  const preview = buildRobotStartupGesturePreview({
    trick: gestureTrick,
    runtimeConfig: commandRuntimeConfig,
    ros2Config: commandRos2Config,
    waypointConfig: resolvedWaypointConfig,
    actionConfig: resolvedActionConfig,
    motionConfig: resolvedMotionConfig,
  })
  const gesture = liveStartup && liveBridge?.status !== 'ok'
    ? {
      attempted: false,
      status: 'live-bridge-not-ready',
      bridgeStatus: liveBridge?.status || 'unknown',
    }
    : preview.status === 'ready'
    ? await sendStartupGesture(preview, commandRuntimeConfig, commandRos2Config, sendRobotCommandImpl)
    : {
      attempted: false,
      status: 'preview-not-ready',
      previewStatus: preview.status,
      warnings: preview.warnings,
    }
  const status = summarizeDirectStartupStatus(audio, gesture)

  logger.log?.(`Robot startup sequence ${status}: audio=${audio.status}; gesture=${gesture.status}.`)

  return {
    status,
    readiness,
    liveStartup,
    liveBridge,
    audio,
    preview,
    gesture,
  }
}

export async function runExistingAppRobotStartupSequence(appUrl, appConfig = {}, {
  env = process.env,
  logger = console,
  requiredServicesReady = null,
  fetchImpl = fetch,
  sleepImpl = sleep,
} = {}) {
  const runtimeConfig = appConfig.robotRuntime || {}

  if (!shouldRunRobotStartupSequence(runtimeConfig, env)) {
    return {
      status: 'skipped',
      reason: 'existing app active target is not a robot HTTP target',
      target: runtimeConfig.activeTarget?.id || '',
    }
  }

  const readiness = await waitForRequiredServices(requiredServicesReady, logger)
  const liveStartup = shouldUseLiveStartupGesture(runtimeConfig, env)
  const liveBridge = liveStartup
    ? await ensureExistingAppDirectBridgeLive(appUrl, appConfig, {
      fetchImpl,
      sleepImpl,
      logger,
    })
    : null
  const audioCue = normalizeString(env.ROBOT_STARTUP_AUDIO_CUE) || DEFAULT_AUDIO_CUE
  const gestureTrick = normalizeString(env.ROBOT_STARTUP_TRICK) || DEFAULT_GESTURE_TRICK
  const gestureDelayMs = positiveInteger(env.ROBOT_STARTUP_GESTURE_DELAY_MS, DEFAULT_GESTURE_DELAY_MS)
  const audio = await postExistingAppJson(fetchImpl, appUrl, '/api/dogzilla/audio/cue', {
    cue: audioCue,
  })

  if (gestureDelayMs > 0) {
    await sleepImpl(gestureDelayMs)
  }

  const gesture = liveStartup
    ? liveBridge?.status === 'ok'
      ? await sendExistingAppDirectStartupGesture(fetchImpl, appConfig, gestureTrick)
      : {
        attempted: false,
        status: 'live-bridge-not-ready',
        bridgeStatus: liveBridge?.status || 'unknown',
      }
    : await sendExistingAppDryRunStartupGesture(fetchImpl, appUrl, gestureTrick)
  const status = summarizeExistingAppStartupStatus(audio, gesture)

  logger.log?.(`Robot startup sequence ${status}: audio=${audio.status}; gesture=${gesture.status}.`)

  return {
    status,
    readiness,
    liveStartup,
    liveBridge,
    audio,
    gesture,
  }
}

export function shouldUseLiveStartupGesture(runtimeConfig = {}, env = process.env) {
  const override = normalizeString(env.APP_ROBOT_STARTUP_LIVE ?? env.ROBOT_STARTUP_LIVE).toLowerCase()

  if (OFF_VALUES.has(override)) {
    return false
  }

  return runtimeConfig.activeTarget?.kind === 'dogzilla-direct'
}

export function buildRobotStartupGesturePreview({
  trick = DEFAULT_GESTURE_TRICK,
  runtimeConfig = {},
  ros2Config = {},
  waypointConfig = {},
  actionConfig = {},
  motionConfig = {},
} = {}) {
  const parsed = buildStartupGestureParsed(trick)

  return compileRobotRuntimePreview({
    source: {
      input: 'startup robot handshake',
      rawResponse: JSON.stringify(parsed),
      parsed,
    },
    runtimeConfig,
    ros2Config,
    waypointConfig,
    actionConfig,
    motionConfig,
  })
}

function buildStartupGestureParsed(trick) {
  return {
    command: 'trick',
    waypoint: 'current_position',
    trick: normalizeString(trick) || DEFAULT_GESTURE_TRICK,
  }
}

async function waitForRequiredServices(requiredServicesReady, logger) {
  if (!requiredServicesReady) {
    return null
  }

  try {
    return await requiredServicesReady
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn?.(`Robot startup sequence continuing after support service startup failure: ${message}`)
    return {
      status: 'error',
      error: message,
    }
  }
}

async function sendStartupAudioCue(cue, sendDogzillaAudioCueImpl) {
  try {
    return await sendDogzillaAudioCueImpl(cue)
  } catch (error) {
    return {
      status: 'error',
      ok: false,
      cue,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function sendStartupGesture(preview, runtimeConfig, ros2Config, sendRobotCommandImpl) {
  try {
    return await sendRobotCommandImpl(preview, runtimeConfig, ros2Config)
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function ensureDirectStartupBridgeLive({
  runtimeConfig,
  ros2Config,
  existingHealth = null,
  logger,
  probeRobotSidecarHealthImpl,
  runDogzillaConnectionActionImpl,
  sleepImpl,
}) {
  const liveRuntimeConfig = forceLiveRobotConfig(runtimeConfig)
  const liveRos2Config = forceLiveRos2Config(ros2Config)

  if (isLiveDirectBridgeHealth(existingHealth)) {
    return {
      status: 'ok',
      reusedBridge: true,
      health: existingHealth,
      probeReused: true,
    }
  }

  const probedHealth = await probeRobotSidecarHealthImpl(liveRuntimeConfig, liveRos2Config)

  if (isLiveDirectBridgeHealth(probedHealth)) {
    return {
      status: 'ok',
      reusedBridge: true,
      health: probedHealth,
    }
  }

  if (probedHealth.status === 'ok') {
    logger.log?.('DOGZILLA direct bridge is ready but dry-run; restarting live for startup gesture.')
  } else {
    logger.log?.('Starting DOGZILLA direct bridge live for startup gesture.')
  }

  const startResult = await startLiveDirectBridgeWithRetries({
    runtimeConfig: liveRuntimeConfig,
    ros2Config: liveRos2Config,
    logger,
    probeRobotSidecarHealthImpl,
    runDogzillaConnectionActionImpl,
    sleepImpl,
  })

  if (startResult.status === 'error' && !isLiveDirectBridgeHealth(startResult.health)) {
    logger.warn?.(`DOGZILLA live startup bridge failed: ${startResult.error || startResult.stderr || 'unknown error'}`)
    return {
      status: 'error',
      reusedBridge: false,
      health: probedHealth,
      startResult,
    }
  }

  if (isLiveDirectBridgeHealth(startResult.health)) {
    return {
      status: 'ok',
      reusedBridge: false,
      health: startResult.health,
      startResult,
    }
  }

  const health = await waitForLiveDirectBridgeHealth({
    runtimeConfig: liveRuntimeConfig,
    ros2Config: liveRos2Config,
    probeRobotSidecarHealthImpl,
    sleepImpl,
  })

  return {
    status: isLiveDirectBridgeHealth(health) ? 'ok' : 'error',
    reusedBridge: false,
    health,
    startResult,
  }
}

async function ensureExistingAppDirectBridgeLive(appUrl, appConfig, { fetchImpl, sleepImpl, logger }) {
  const directBaseUrl = appConfig?.dogzilla?.bridges?.direct?.baseUrl
  const existingHealth = await getExistingAppRobotHealth(fetchImpl, appUrl)

  if (isLiveDirectBridgeHealth(existingHealth)) {
    return {
      status: 'ok',
      reusedBridge: true,
      health: existingHealth,
    }
  }

  logger.log?.('Starting DOGZILLA direct bridge live for startup gesture.')
  const start = await startExistingAppLiveDirectBridgeWithRetries({
    fetchImpl,
    appUrl,
    sleepImpl,
    logger,
  })

  if (!start.ok && !isLiveDirectBridgeHealth(start.health)) {
    return {
      status: 'error',
      reusedBridge: false,
      health: existingHealth,
      start,
    }
  }

  if (isLiveDirectBridgeHealth(start.health)) {
    return {
      status: 'ok',
      reusedBridge: false,
      health: start.health,
      start,
      directBaseUrl,
    }
  }

  const health = await waitForExistingAppLiveDirectBridgeHealth(fetchImpl, appUrl, sleepImpl)

  return {
    status: isLiveDirectBridgeHealth(health) ? 'ok' : 'error',
    reusedBridge: false,
    health,
    start,
    directBaseUrl,
  }
}

async function startLiveDirectBridgeWithRetries({
  runtimeConfig,
  ros2Config,
  logger,
  probeRobotSidecarHealthImpl,
  runDogzillaConnectionActionImpl,
  sleepImpl,
}) {
  let lastResult = null

  for (let attempt = 1; attempt <= DIRECT_BRIDGE_START_ATTEMPTS; attempt += 1) {
    lastResult = await runDogzillaConnectionActionImpl('start-direct', {
      live: true,
    })

    if (lastResult.status !== 'error') {
      return lastResult
    }

    const health = await probeRobotSidecarHealthImpl(runtimeConfig, ros2Config)
    if (isLiveDirectBridgeHealth(health)) {
      return {
        ...lastResult,
        status: 'ok',
        recoveredAfterError: true,
        health,
      }
    }

    if (attempt < DIRECT_BRIDGE_START_ATTEMPTS) {
      logger.warn?.(`DOGZILLA live bridge restart attempt ${attempt} failed; retrying.`)
      await sleepImpl(DIRECT_BRIDGE_POLL_MS * attempt)
    }
  }

  return lastResult || {
    status: 'error',
    error: 'DOGZILLA live bridge restart did not run.',
  }
}

async function startExistingAppLiveDirectBridgeWithRetries({ fetchImpl, appUrl, sleepImpl, logger }) {
  let lastStart = null

  for (let attempt = 1; attempt <= DIRECT_BRIDGE_START_ATTEMPTS; attempt += 1) {
    lastStart = await postExistingAppJson(fetchImpl, appUrl, '/api/dogzilla/connection/action', {
      action: 'start-direct',
      live: true,
    })

    if (lastStart.ok) {
      return lastStart
    }

    const health = await getExistingAppRobotHealth(fetchImpl, appUrl)
    if (isLiveDirectBridgeHealth(health)) {
      return {
        ...lastStart,
        ok: true,
        status: 'ok',
        recoveredAfterError: true,
        health,
      }
    }

    if (attempt < DIRECT_BRIDGE_START_ATTEMPTS) {
      logger.warn?.(`DOGZILLA live bridge restart attempt ${attempt} failed; retrying.`)
      await sleepImpl(DIRECT_BRIDGE_POLL_MS * attempt)
    }
  }

  return lastStart || {
    ok: false,
    status: 'error',
    error: 'DOGZILLA live bridge restart did not run.',
  }
}

async function waitForLiveDirectBridgeHealth({
  runtimeConfig,
  ros2Config,
  probeRobotSidecarHealthImpl,
  sleepImpl,
}) {
  const startedAt = Date.now()
  let lastHealth = null

  do {
    lastHealth = await probeRobotSidecarHealthImpl(runtimeConfig, ros2Config)

    if (isLiveDirectBridgeHealth(lastHealth)) {
      return lastHealth
    }

    await sleepImpl(DIRECT_BRIDGE_POLL_MS)
  } while (Date.now() - startedAt < DIRECT_BRIDGE_READY_TIMEOUT_MS)

  return lastHealth || {
    status: 'error',
    error: `Timed out waiting ${DIRECT_BRIDGE_READY_TIMEOUT_MS}ms for live DOGZILLA direct bridge.`,
  }
}

async function waitForExistingAppLiveDirectBridgeHealth(fetchImpl, appUrl, sleepImpl) {
  const startedAt = Date.now()
  let lastHealth = null

  do {
    lastHealth = await getExistingAppRobotHealth(fetchImpl, appUrl)

    if (isLiveDirectBridgeHealth(lastHealth)) {
      return lastHealth
    }

    await sleepImpl(DIRECT_BRIDGE_POLL_MS)
  } while (Date.now() - startedAt < DIRECT_BRIDGE_READY_TIMEOUT_MS)

  return lastHealth || {
    status: 'error',
    error: `Timed out waiting ${DIRECT_BRIDGE_READY_TIMEOUT_MS}ms for live DOGZILLA direct bridge.`,
  }
}

async function getExistingAppRobotHealth(fetchImpl, appUrl) {
  return postExistingAppFetch(fetchImpl, appUrl, '/api/robot/health', {
    method: 'GET',
  })
}

async function sendExistingAppDirectStartupGesture(fetchImpl, appConfig, trick) {
  const directBaseUrl = appConfig?.dogzilla?.bridges?.direct?.baseUrl

  if (!directBaseUrl) {
    return {
      attempted: false,
      status: 'unconfigured',
      error: 'DOGZILLA direct bridge URL is not configured.',
    }
  }

  const envelope = buildExistingAppStartupGestureEnvelope(appConfig, trick)
  return postExistingAppJson(fetchImpl, directBaseUrl, '/commands', {
    envelope,
  })
}

async function sendExistingAppDryRunStartupGesture(fetchImpl, appUrl, trick) {
  const parsed = buildStartupGestureParsed(trick)
  return postExistingAppJson(fetchImpl, appUrl, '/api/robot/dispatch', {
    input: 'startup robot handshake',
    rawResponse: JSON.stringify(parsed),
    parsed,
  })
}

function buildExistingAppStartupGestureEnvelope(appConfig, trick) {
  const robotRuntime = appConfig?.robotRuntime || {}
  const robotId = robotRuntime.robotId || robotRuntime.robot_id || 'dogzilla-local'
  const robotName = robotRuntime.robotName || robotRuntime.robot_name || 'Questing Beast'
  const actionId = trick === 'shake' || trick === 'handshake' ? DEFAULT_GESTURE_ACTION_ID : DEFAULT_GESTURE_ACTION_ID
  const canonicalPlan = {
    kind: 'action.once',
    params: {
      trick,
      actionId,
      verified: true,
    },
  }

  return {
    status: 'ready',
    target: robotRuntime.activeTarget?.id || 'dogzilla_direct',
    targetKind: robotRuntime.activeTarget?.kind || 'dogzilla-direct',
    targetLabel: robotRuntime.activeTarget?.label || 'DOGZILLA Direct Bridge',
    robotId,
    robotName,
    robot_id: robotId,
    robot_name: robotName,
    protocolVersion: 1,
    command: 'trick',
    action: 'dogzilla.perform_action',
    canonicalPlan,
    payload: {
      robotId,
      robotName,
      robot_id: robotId,
      robot_name: robotName,
      robotModel: robotRuntime.robotModel || 'dogzilla-s2',
      canonicalPlan,
    },
    warnings: [],
    missingRequired: [],
    dispatchPlan: {
      target: robotRuntime.activeTarget?.id || 'dogzilla_direct',
      targetKind: robotRuntime.activeTarget?.kind || 'dogzilla-direct',
      active: true,
      enabled: true,
      dryRun: false,
      dispatchOnChat: false,
      destination: appConfig?.dogzilla?.bridges?.direct?.baseUrl || '',
      commandsPath: '/commands',
    },
  }
}

function isLiveDirectBridgeHealth(health) {
  return health?.status === 'ok' && health?.body?.runtime?.dryRun === false
}

function forceLiveRobotConfig(runtimeConfig = {}) {
  return {
    ...runtimeConfig,
    dryRun: false,
  }
}

function forceLiveRos2Config(ros2Config = {}) {
  return {
    ...ros2Config,
    transport: {
      ...(ros2Config.transport || {}),
      dryRun: false,
    },
  }
}

async function postExistingAppJson(fetchImpl, appUrl, pathname, payload) {
  return postExistingAppFetch(fetchImpl, appUrl, pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

async function postExistingAppFetch(fetchImpl, appUrl, pathname, options = {}) {
  const targetUrl = new URL(pathname, appUrl).toString()

  try {
    const response = await fetchImpl(targetUrl, {
      ...options,
      signal: AbortSignal.timeout(5000),
    })
    const body = await safeReadJson(response)

    return {
      attempted: true,
      status: response.ok ? 'ok' : 'error',
      ok: response.ok,
      responseStatus: response.status,
      destination: targetUrl,
      body,
    }
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      ok: false,
      destination: targetUrl,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function summarizeDirectStartupStatus(audio, gesture) {
  const audioOk = audio?.ok === true
  const gestureOk = ['sent', 'dry-run'].includes(gesture?.status)

  if (audioOk && gestureOk) {
    return 'ok'
  }

  if (audioOk || gestureOk) {
    return 'degraded'
  }

  return 'error'
}

function summarizeExistingAppStartupStatus(audio, gesture) {
  const audioOk = audio?.ok === true && audio.body?.ok !== false
  const gestureDispatchStatus = gesture?.body?.dispatch?.status
  const gestureOk = gesture?.ok === true && (
    !gestureDispatchStatus || ['sent', 'dry-run'].includes(gestureDispatchStatus)
  )

  if (audioOk && gestureOk) {
    return 'ok'
  }

  if (audioOk || gestureOk) {
    return 'degraded'
  }

  return 'error'
}

async function safeReadJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInteger(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
