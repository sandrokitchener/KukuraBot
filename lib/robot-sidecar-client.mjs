import { loadRobotRos2Config, loadRobotRuntimeConfig } from './robot-runtime-config.mjs'
import { formatFetchError } from './http-error.mjs'

export const ROBOT_HTTP_TARGET_KINDS = new Set(['ros2-bridge', 'dogzilla-direct'])
const DEFAULT_ROBOT_COMMAND_TIMEOUT_MS = 12000
const DEFAULT_WAYPOINT_COMMAND_TIMEOUT_MS = 180000
const LIDAR_AIDED_OBSTACLE_AVOIDANCE = Object.freeze({
  required: true,
  mode: 'yahboom_laser',
  lidarTopic: '/scan',
  command: 'ros2 run yahboom_laser laser_Avoidance_xgo_RS200',
  docs: 'docs/DOGZILLA-main/14.Lidar course/2. Obstacle avoidance.pdf',
})

export async function getRobotSidecarHealth() {
  const [runtimeConfig, ros2Config] = await Promise.all([
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
  ])

  return probeRobotSidecarHealth(runtimeConfig, ros2Config)
}

export async function getRobotRuntimeFeedback() {
  const [runtimeConfig, ros2Config] = await Promise.all([
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
  ])

  return fetchRobotRuntimeFeedback(runtimeConfig, ros2Config)
}

export async function getRobotBridgeState() {
  const [runtimeConfig, ros2Config] = await Promise.all([
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
  ])

  return fetchRobotBridgeState(runtimeConfig, ros2Config)
}

export async function dispatchRobotCommand(preview) {
  const [runtimeConfig, ros2Config] = await Promise.all([
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
  ])

  return sendRobotCommand(preview, runtimeConfig, ros2Config)
}

export async function dispatchRobotEmergencyStop() {
  const [runtimeConfig, ros2Config] = await Promise.all([
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
  ])

  return sendRobotEmergencyStop(runtimeConfig, ros2Config)
}

export async function probeRobotSidecarHealth(runtimeConfig = {}, ros2Config = {}) {
  const transport = ros2Config.transport ?? {}

  if (!isRobotHttpTarget(runtimeConfig)) {
    return {
      attempted: false,
      status: 'inactive-target',
      destination: transport.baseUrl || '',
      activeTarget: runtimeConfig.activeTarget?.id || '',
    }
  }

  if (!transport.enabled) {
    return {
      attempted: false,
      status: 'disabled',
      destination: transport.baseUrl || '',
    }
  }

  if (transport.kind !== 'http') {
    return {
      attempted: false,
      status: 'unsupported-transport',
      destination: transport.baseUrl || '',
    }
  }

  const targetUrl = buildTargetUrl(transport.baseUrl, transport.healthPath)

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(transport.timeoutMs || 4000),
    })
    const body = await safeReadJson(response)
    const runtimeOk = body && typeof body === 'object' && body.ok === false ? false : true

    return {
      attempted: true,
      status: response.ok && runtimeOk ? 'ok' : response.ok ? 'degraded' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      body,
    }
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      error: formatFetchError(error),
    }
  }
}

export async function fetchRobotRuntimeFeedback(runtimeConfig = {}, ros2Config = {}) {
  const transport = ros2Config.transport ?? {}

  if (!isRobotHttpTarget(runtimeConfig)) {
    return {
      attempted: false,
      status: 'inactive-target',
      destination: transport.baseUrl || '',
      feedback: null,
    }
  }

  if (!transport.enabled) {
    return {
      attempted: false,
      status: 'disabled',
      destination: transport.baseUrl || '',
      feedback: null,
    }
  }

  const targetUrl = buildTargetUrl(transport.baseUrl, transport.feedbackPath)

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(transport.timeoutMs || 4000),
    })
    const body = await safeReadJson(response)

    return {
      attempted: true,
      status: response.ok ? 'ok' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      feedback: body,
    }
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      error: formatFetchError(error),
      feedback: null,
    }
  }
}

export async function sendRobotCommand(preview, runtimeConfig = {}, ros2Config = {}) {
  const transport = ros2Config.transport ?? {}

  if (!preview || typeof preview !== 'object') {
    return {
      attempted: false,
      status: 'invalid-preview',
      destination: transport.baseUrl || '',
    }
  }

  if (!isRobotHttpTarget(runtimeConfig)) {
    return {
      attempted: false,
      status: 'inactive-target',
      destination: transport.baseUrl || '',
      activeTarget: runtimeConfig.activeTarget?.id || '',
    }
  }

  if (preview.status !== 'ready') {
    return {
      attempted: false,
      status: 'preview-not-ready',
      destination: transport.baseUrl || '',
      previewStatus: preview.status,
    }
  }

  if (!transport.enabled) {
    return {
      attempted: false,
      status: 'disabled',
      destination: transport.baseUrl || '',
    }
  }

  if ((runtimeConfig.dryRun ?? true) || transport.dryRun) {
    return {
      attempted: false,
      status: 'dry-run',
      destination: buildTargetUrl(transport.baseUrl, transport.commandsPath),
    }
  }

  if (transport.kind !== 'http') {
    return {
      attempted: false,
      status: 'unsupported-transport',
      destination: transport.baseUrl || '',
    }
  }

  const targetUrl = buildTargetUrl(transport.baseUrl, transport.commandsPath)
  const envelope = withLidarAidedWaypointSafety(preview)
  const waypointNavigation = await verifyWaypointNavigationReady(preview, runtimeConfig, ros2Config)
  if (!waypointNavigation.ready) {
    return {
      attempted: false,
      status: 'navigation-unavailable',
      destination: targetUrl,
      error: waypointNavigation.error,
      health: waypointNavigation.health,
    }
  }

  try {
    const preemptTimeoutMs = transport.timeoutMs || DEFAULT_ROBOT_COMMAND_TIMEOUT_MS
    const commandTimeoutMs = resolveRobotCommandTimeoutMs(preview, transport)
    const preempt = shouldPreemptBeforeCommand(preview)
      ? await postRobotCommandEnvelope({
        targetUrl,
        envelope: buildPreemptiveStopEnvelope(runtimeConfig, ros2Config),
        action: 'stop',
        timeoutMs: preemptTimeoutMs,
      })
      : null

    if (preempt && preempt.status !== 'sent') {
      return {
        attempted: true,
        status: 'preempt-failed',
        destination: targetUrl,
        preempt,
      }
    }

    const command = await postRobotCommandEnvelope({
      targetUrl,
      envelope,
      timeoutMs: commandTimeoutMs,
    })

    if (command.status === 'sent') {
      return {
        ...command,
        preempt,
      }
    }

    return {
      ...command,
      preempt,
    }
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      error: formatFetchError(error),
    }
  }
}

async function verifyWaypointNavigationReady(preview = {}, runtimeConfig = {}, ros2Config = {}) {
  if (!isWaypointGotoPreview(preview)) {
    return { ready: true }
  }

  const health = await probeRobotSidecarHealth(runtimeConfig, ros2Config)
  if (health.status !== 'ok') {
    return {
      ready: false,
      health,
      error: `Waypoint navigation unavailable: robot bridge health is ${health.status}${health.error ? ` (${health.error})` : ''}.`,
    }
  }

  const runtime = health.body?.runtime && typeof health.body.runtime === 'object' ? health.body.runtime : null
  const nav2 = runtime?.nav2 && typeof runtime.nav2 === 'object' ? runtime.nav2 : null
  const navigation = runtime?.navigation && typeof runtime.navigation === 'object' ? runtime.navigation : null
  if (runtimeConfig.activeTarget?.kind === 'dogzilla-direct'
    && nav2?.available !== true
    && navigation?.available !== true) {
    const reason = normalizeErrorText(nav2?.importError)
      || normalizeErrorText(runtime?.importError)
      || 'Nav2 NavigateToPose unavailable'
    const recovery = nav2?.clientAvailable === true && nav2?.serverAvailable === false
      ? 'The Docker ROS client is available, but no NavigateToPose action server exists in the ROS graph. Map waypoints need a real Nav2 server or navigation executor.'
      : 'Start the ROS2/Nav2 bridge or container before sending map waypoints.'
    return {
      ready: false,
      health,
      error: `Waypoint navigation unavailable on DOGZILLA Direct Bridge: ${reason}. ${recovery}`,
    }
  }

  return { ready: true, health }
}

function isWaypointGotoPreview(preview = {}) {
  return preview?.canonicalPlan?.kind === 'locomotion.goto'
    || preview?.payload?.canonicalPlan?.kind === 'locomotion.goto'
}

function resolveRobotCommandTimeoutMs(preview = {}, transport = {}) {
  if (!isWaypointGotoPreview(preview)) {
    return transport.timeoutMs || DEFAULT_ROBOT_COMMAND_TIMEOUT_MS
  }

  const params = preview?.canonicalPlan?.params || preview?.payload?.canonicalPlan?.params || {}
  const timeoutSec = Number(params.timeoutSec ?? params.timeout_sec)
  if (Number.isFinite(timeoutSec) && timeoutSec > 0) {
    return Math.ceil(timeoutSec * 1000)
  }

  const configuredMovementTimeoutMs = Number(transport.waypointTimeoutMs ?? transport.navigationTimeoutMs)
  if (Number.isFinite(configuredMovementTimeoutMs) && configuredMovementTimeoutMs > 0) {
    return configuredMovementTimeoutMs
  }

  return DEFAULT_WAYPOINT_COMMAND_TIMEOUT_MS
}

async function postRobotCommandEnvelope({ targetUrl, envelope, action = null, timeoutMs }) {
  try {
    const body = action
      ? {
        action,
        envelope,
      }
      : {
        envelope,
      }
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const responseBody = await safeReadJson(response)

    return {
      attempted: true,
      status: response.ok ? 'sent' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      body: responseBody,
      ...(response.ok ? {} : { error: formatRobotCommandResponseError(responseBody) }),
    }
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      error: formatRobotCommandFetchError(error, timeoutMs),
    }
  }
}

function formatRobotCommandFetchError(error, timeoutMs) {
  const base = formatFetchError(error)
  if (!isTimeoutError(error)) {
    return base
  }

  return `${base} after ${timeoutMs}ms waiting for robot command response. Check bridge feedback; the bridge may still finish after the desktop request times out.`
}

function isTimeoutError(error) {
  const name = typeof error?.name === 'string' ? error.name : ''
  const message = typeof error?.message === 'string' ? error.message : ''
  return name === 'TimeoutError'
    || name === 'AbortError'
    || /aborted due to timeout|timed out|timeout/i.test(message)
}

function formatRobotCommandResponseError(body) {
  if (!body || typeof body !== 'object') {
    return ''
  }

  const result = body.result && typeof body.result === 'object' ? body.result : null
  const primary = normalizeErrorText(body.error)
    || normalizeErrorText(result?.error)
    || normalizeErrorText(result?.delivery)
    || normalizeErrorText(body.status)

  if (!primary) {
    return ''
  }

  const detail = normalizeErrorText(result?.kind)
  return detail && !primary.includes(detail) ? `${primary} (${detail})` : primary
}

function normalizeErrorText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function shouldPreemptBeforeCommand(preview = {}) {
  if (!preview || typeof preview !== 'object') {
    return false
  }

  if (preview.command === 'manual') {
    return false
  }

  const canonicalPlan = preview.canonicalPlan
  if (!canonicalPlan || typeof canonicalPlan !== 'object') {
    return false
  }

  if (canonicalPlan.kind === 'noop') {
    return false
  }

  if (canonicalPlan.kind === 'locomotion.relative') {
    return false
  }

  if (canonicalPlan.kind === 'action.loop' && canonicalPlan.params?.enabled === false) {
    return false
  }

  return true
}

export function withLidarAidedWaypointSafety(preview = {}) {
  if (!preview || typeof preview !== 'object') {
    return preview
  }

  const canonicalPlan = addLidarAvoidanceToGoto(preview.canonicalPlan)
  const payloadPlan = addLidarAvoidanceToGoto(preview.payload?.canonicalPlan)
  const payload = preview.payload && typeof preview.payload === 'object'
    ? {
        ...preview.payload,
        canonicalPlan: payloadPlan || canonicalPlan || preview.payload.canonicalPlan,
      }
    : preview.payload

  return {
    ...preview,
    canonicalPlan: canonicalPlan || preview.canonicalPlan,
    payload,
  }
}

function addLidarAvoidanceToGoto(canonicalPlan) {
  if (!canonicalPlan || typeof canonicalPlan !== 'object' || canonicalPlan.kind !== 'locomotion.goto') {
    return canonicalPlan
  }

  const params = canonicalPlan.params && typeof canonicalPlan.params === 'object' ? canonicalPlan.params : {}
  const existing = params.obstacleAvoidance && typeof params.obstacleAvoidance === 'object'
    ? params.obstacleAvoidance
    : {}

  return {
    ...canonicalPlan,
    params: {
      ...params,
      obstacleAvoidance: {
        ...LIDAR_AIDED_OBSTACLE_AVOIDANCE,
        ...existing,
        required: true,
      },
    },
  }
}

export async function sendRobotEmergencyStop(runtimeConfig = {}, ros2Config = {}) {
  const transport = ros2Config.transport ?? {}
  const envelope = buildEmergencyStopEnvelope(runtimeConfig, ros2Config)

  if (!isRobotHttpTarget(runtimeConfig)) {
    return {
      attempted: false,
      status: 'inactive-target',
      destination: transport.baseUrl || '',
      activeTarget: runtimeConfig.activeTarget?.id || '',
      envelope,
    }
  }

  if (!transport.enabled) {
    return {
      attempted: false,
      status: 'disabled',
      destination: transport.baseUrl || '',
      envelope,
    }
  }

  if (transport.kind !== 'http') {
    return {
      attempted: false,
      status: 'unsupported-transport',
      destination: transport.baseUrl || '',
      envelope,
    }
  }

  const targetUrl = buildTargetUrl(transport.baseUrl, transport.commandsPath)

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'stop',
        envelope,
      }),
      signal: AbortSignal.timeout(transport.timeoutMs || 4000),
    })
    const body = await safeReadJson(response)

    return {
      attempted: true,
      status: response.ok ? 'sent' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      envelope,
      body,
    }
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      envelope,
      error: formatFetchError(error),
    }
  }
}

export async function fetchRobotBridgeState(runtimeConfig = {}, ros2Config = {}) {
  const transport = ros2Config.transport ?? {}

  if (!isRobotHttpTarget(runtimeConfig)) {
    return {
      attempted: false,
      status: 'inactive-target',
      destination: transport.baseUrl || '',
      state: null,
    }
  }

  if (!transport.enabled) {
    return {
      attempted: false,
      status: 'disabled',
      destination: transport.baseUrl || '',
      state: null,
    }
  }

  const targetUrl = buildTargetUrl(transport.baseUrl, '/state')

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(transport.timeoutMs || 4000),
    })
    const body = await safeReadJson(response)

    return {
      attempted: true,
      status: response.ok ? 'ok' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      state: body,
    }
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      error: formatFetchError(error),
      state: null,
    }
  }
}

export function isRobotHttpTarget(runtimeConfig = {}) {
  return ROBOT_HTTP_TARGET_KINDS.has(runtimeConfig.activeTarget?.kind || '')
}

function buildEmergencyStopEnvelope(runtimeConfig = {}, ros2Config = {}) {
  return buildStopEnvelope(runtimeConfig, ros2Config, {
    command: 'safety',
    reason: 'emergency_stop',
  })
}

function buildPreemptiveStopEnvelope(runtimeConfig = {}, ros2Config = {}) {
  return buildStopEnvelope(runtimeConfig, ros2Config, {
    command: 'preempt',
    reason: 'command_preempt',
  })
}

function buildStopEnvelope(runtimeConfig = {}, ros2Config = {}, { command, reason }) {
  const identity = buildRobotIdentity(runtimeConfig)

  return {
    status: 'ready',
    target: runtimeConfig.activeTarget?.id || 'ros2_real',
    targetKind: runtimeConfig.activeTarget?.kind || 'ros2-bridge',
    targetLabel: runtimeConfig.activeTarget?.label || 'ROS2 Real Robot',
    ...identity,
    protocolVersion: 1,
    command,
    action: 'stop',
    canonicalPlan: {
      kind: 'noop',
      params: {
        reason,
        action: 'stop',
      },
    },
    payload: {
      ...identity,
      robotModel: runtimeConfig.robotModel || 'dogzilla-s2',
      planTopic: ros2Config.bridge?.commandPlanTopic || '/dogzilla/command_plan',
      stateTopic: ros2Config.topics?.state || '/dogzilla/state',
      canonicalPlan: {
        kind: 'noop',
        params: {
          reason,
          action: 'stop',
        },
      },
    },
    warnings: [],
    missingRequired: [],
    dispatchPlan: {
      target: runtimeConfig.activeTarget?.id || 'ros2_real',
      targetKind: runtimeConfig.activeTarget?.kind || 'ros2-bridge',
      active: isRobotHttpTarget(runtimeConfig),
      enabled: runtimeConfig.enabled !== false && ros2Config.transport?.enabled !== false,
      dryRun: false,
      dispatchOnChat: false,
      destination: ros2Config.transport?.baseUrl || '',
      commandsPath: ros2Config.transport?.commandsPath || '/commands',
    },
  }
}

function buildRobotIdentity(runtimeConfig = {}) {
  const robotId = runtimeConfig.robot_id || runtimeConfig.robotId || 'dogzilla-local'
  const robotName = runtimeConfig.robot_name || runtimeConfig.robotName || 'Questing Beast'

  return {
    robotId,
    robotName,
    robot_id: robotId,
    robot_name: robotName,
  }
}

function buildTargetUrl(baseUrl, routePath) {
  return new URL(routePath || '/', baseUrl || 'http://127.0.0.1:8892').toString()
}

async function safeReadJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}
