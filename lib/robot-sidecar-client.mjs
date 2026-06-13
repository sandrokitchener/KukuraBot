import { loadRobotRos2Config, loadRobotRuntimeConfig } from './robot-runtime-config.mjs'
import { formatFetchError } from './http-error.mjs'
import { loadDogzillaConnectionConfig, runDogzillaConnectionAction } from './dogzilla-connection-center.mjs'
import { validatePoseInsideDogzillaMap, validateWaypointMapIdentity } from './dogzilla-map-metadata.mjs'
import { getDogzillaWaypointNavigationReadiness } from './dogzilla-navigation-readiness.mjs'

export const ROBOT_HTTP_TARGET_KINDS = new Set(['ros2-bridge', 'dogzilla-direct'])
const DEFAULT_ROBOT_COMMAND_TIMEOUT_MS = 12000
const WAYPOINT_NAVIGATION_HEALTH_TIMEOUT_MS = 30000
const WAYPOINT_NAVIGATION_REPAIR_TIMEOUT_MS = 45000
const WAYPOINT_NAVIGATION_REPAIR_POLL_MS = 1000
const LIDAR_AIDED_OBSTACLE_AVOIDANCE = Object.freeze({
  required: true,
  mode: 'nav2_costmap',
  lidarTopic: '/scan',
  command: 'verify Nav2 costmaps have live /scan; do not start Yahboom laser_Avoidance_xgo_RS200 during Nav2 waypoint control',
  docs: 'sidecars/dogzilla_navigation/README.md',
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

export async function sendRobotCommand(preview, runtimeConfig = {}, ros2Config = {}, options = {}) {
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
  const waypointNavigation = await verifyWaypointNavigationReady(preview, runtimeConfig, ros2Config, options)
  if (!waypointNavigation.ready) {
    return {
      attempted: false,
      status: waypointNavigation.status || 'navigation-unavailable',
      destination: targetUrl,
      error: waypointNavigation.error,
      operatorMessage: waypointNavigation.operatorMessage,
      kind: waypointNavigation.kind,
      recovery: waypointNavigation.recovery,
      directControlAvailable: waypointNavigation.directControlAvailable,
      health: waypointNavigation.health,
      map: waypointNavigation.map,
      navigationRepair: waypointNavigation.repair,
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

async function verifyWaypointNavigationReady(preview = {}, runtimeConfig = {}, ros2Config = {}, options = {}) {
  if (!isWaypointGotoPreview(preview)) {
    return { ready: true }
  }

  const healthRos2Config = withMinimumTransportTimeout(
    ros2Config,
    options.waypointNavigationHealthTimeoutMs || WAYPOINT_NAVIGATION_HEALTH_TIMEOUT_MS,
  )
  const health = await probeRobotSidecarHealth(runtimeConfig, healthRos2Config)
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
  let readiness = getDogzillaWaypointNavigationReadiness(runtime)
  readiness = await maybeFillOdomReadinessFromPoseService(readiness, runtimeConfig, options)
  const mapValidation = validateWaypointAgainstActiveMap(preview, runtime?.map)
  if (!mapValidation.ready) {
    return {
      ...mapValidation,
      health,
    }
  }

  if (
    runtimeConfig.activeTarget?.kind === 'dogzilla-direct'
    && !readiness.ready
    && readiness.actionAvailable
  ) {
    const recovery = `Start/fix DOGZILLA odometry so ${readiness.odomTopic} has a live publisher before sending map waypoints. Nav2 has an action server, but it cannot safely control waypoint motion without odometry.`
    return {
      ready: false,
      health,
      kind: 'map-waypoint',
      operatorMessage: 'Waypoint not sent: DOGZILLA Nav2 exists, but odometry is not publishing, so map waypoints are unsafe. Manual controls and non-waypoint actions are still available.',
      recovery,
      directControlAvailable: true,
      error: `Waypoint blocked: Nav2 waypoint prerequisites failed. ${readiness.reason || recovery}`,
      nav2Readiness: readiness,
    }
  }

  if (runtimeConfig.activeTarget?.kind === 'dogzilla-direct' && !readiness.ready) {
    const repair = options.autoStartWaypointNavigation === false
      ? null
      : await tryStartDogzillaWaypointNavigation({
        runtimeConfig,
        ros2Config: healthRos2Config,
        probeRobotSidecarHealthImpl: options.probeRobotSidecarHealthImpl || probeRobotSidecarHealth,
        runDogzillaConnectionActionImpl: options.runDogzillaConnectionActionImpl || runDogzillaConnectionAction,
        sleepImpl: options.sleepImpl || sleep,
        timeoutMs: options.waypointNavigationRepairTimeoutMs || WAYPOINT_NAVIGATION_REPAIR_TIMEOUT_MS,
        pollIntervalMs: options.waypointNavigationRepairPollMs || WAYPOINT_NAVIGATION_REPAIR_POLL_MS,
      })

    if (repair?.ready) {
      return {
        ready: true,
        health: repair.health,
        repair,
      }
    }

    const finalHealth = repair?.health || health
    const finalRuntime = finalHealth.body?.runtime && typeof finalHealth.body.runtime === 'object' ? finalHealth.body.runtime : runtime
    const finalNav2 = finalRuntime?.nav2 && typeof finalRuntime.nav2 === 'object' ? finalRuntime.nav2 : nav2
    const finalNavigation = finalRuntime?.navigation && typeof finalRuntime.navigation === 'object' ? finalRuntime.navigation : navigation
    let finalReadiness = getDogzillaWaypointNavigationReadiness(finalRuntime)
    finalReadiness = await maybeFillOdomReadinessFromPoseService(finalReadiness, runtimeConfig, options)
    const reason = normalizeErrorText(finalNav2?.importError)
      || normalizeErrorText(finalNav2?.serverError)
      || normalizeErrorText(finalReadiness.reason)
      || normalizeErrorText(finalRuntime?.importError)
      || 'Nav2 NavigateToPose unavailable'
    const fallbackText = finalNavigation?.primary && finalNavigation.primary !== 'nav2'
      ? ` The bridge also reports ${finalNavigation.primary}, but that is not a safe waypoint navigator and will not be used.`
      : ''
    const repairText = repair?.startResult?.status === 'error'
      ? ` Tried to start the waypoint navigator, but startup failed: ${repair.startResult.error || repair.startResult.stderr || 'unknown error'}.`
      : repair && !repair.ready
        ? ' Tried to start the waypoint navigator, but it did not become ready.'
        : ''
    const recovery = finalNav2?.clientAvailable === true && finalNav2?.serverAvailable === false
      ? 'The Docker ROS client is available, but no NavigateToPose action server exists in the ROS graph. Start/install a real navigation server before sending map waypoints.'
      : 'Start the ROS2/Nav2 bridge or container before sending map waypoints.'
    const operatorMessage = 'Waypoint not sent: DOGZILLA has map pose, but no waypoint navigation server is running. Manual controls and non-waypoint actions are still available.'
    return {
      ready: false,
      health: finalHealth,
      repair,
      kind: 'map-waypoint',
      operatorMessage,
      recovery,
      directControlAvailable: true,
      error: `Waypoint blocked: no DOGZILLA waypoint navigation server is running. ${reason}.${fallbackText}${repairText} ${recovery}`,
      nav2Readiness: finalReadiness,
    }
  }

  return { ready: true, health }
}

async function maybeFillOdomReadinessFromPoseService(readiness = {}, runtimeConfig = {}, options = {}) {
  if (
    readiness.ready
    || readiness.actionAvailable !== true
    || readiness.nav2?.odom
    || runtimeConfig.activeTarget?.kind !== 'dogzilla-direct'
    || options.probeDogzillaPoseOdomReadiness === false
  ) {
    return readiness
  }

  const probe = await probeDogzillaPoseOdomReadiness({
    fetchImpl: options.fetchImpl || fetch,
    loadDogzillaConnectionConfigImpl: options.loadDogzillaConnectionConfigImpl || loadDogzillaConnectionConfig,
  })

  if (!probe.checked) {
    return readiness
  }

  if (probe.odomReady) {
    return {
      ...readiness,
      ready: true,
      odomReady: true,
      odomTopic: probe.odomTopic,
      odomPublisherCount: probe.odomPublisherCount,
      blockers: [],
      reason: '',
      poseOdomProbe: probe,
    }
  }

  const blockers = [
    ...(Array.isArray(readiness.blockers) ? readiness.blockers : []).filter((blocker) => !/No publishers on \/odom/i.test(blocker)),
    probe.reason || `No publishers on ${probe.odomTopic || '/odom'}`,
  ].filter(Boolean)

  return {
    ...readiness,
    blockers,
    reason: blockers.join('; '),
    poseOdomProbe: probe,
  }
}

async function probeDogzillaPoseOdomReadiness({
  fetchImpl = fetch,
  loadDogzillaConnectionConfigImpl = loadDogzillaConnectionConfig,
} = {}) {
  try {
    const config = await loadDogzillaConnectionConfigImpl()
    const poseUrl = config.lidar?.poseUrl || ''
    if (!poseUrl || typeof fetchImpl !== 'function') {
      return { checked: false, reason: 'DOGZILLA pose service is not configured' }
    }

    const response = await fetchImpl(poseUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(4000),
    })
    const body = await safeReadJson(response)
    const topic = body?.rosGraph?.topics?.['/odom'] && typeof body.rosGraph.topics['/odom'] === 'object'
      ? body.rosGraph.topics['/odom']
      : null
    const publisherCount = Number(topic?.publisherCount ?? 0)
    const odomReady = response.ok && Number.isFinite(publisherCount) && publisherCount > 0

    return {
      checked: true,
      odomReady,
      odomTopic: '/odom',
      odomPublisherCount: Number.isFinite(publisherCount) ? publisherCount : 0,
      reason: odomReady ? '' : 'No publishers on /odom',
      poseUrl,
    }
  } catch (error) {
    return {
      checked: true,
      odomReady: false,
      odomTopic: '/odom',
      odomPublisherCount: 0,
      reason: formatFetchError(error),
    }
  }
}

function validateWaypointAgainstActiveMap(preview = {}, activeMap = null) {
  const params = preview.canonicalPlan?.params && typeof preview.canonicalPlan.params === 'object'
    ? preview.canonicalPlan.params
    : {}
  if (params.verified !== true) {
    const waypoint = params.waypoint || 'waypoint'
    return {
      ready: false,
      status: 'waypoint-blocked',
      kind: 'map-waypoint',
      directControlAvailable: true,
      recovery: 'Mark the waypoint verified in config/robot-waypoints.json only after the coordinates are intentionally trusted.',
      operatorMessage: `Waypoint not sent: ${waypoint} is not verified in robot-waypoints config.`,
      error: `Waypoint blocked: ${waypoint} is not verified in robot-waypoints config.`,
    }
  }

  const identityValidation = validateWaypointMapIdentity(params, activeMap)
  if (!identityValidation.ok) {
    return {
      ready: true,
      warning: identityValidation.message,
      map: identityValidation.map,
      mapIdentity: identityValidation.waypointIdentity,
    }
  }

  const validation = validatePoseInsideDogzillaMap(params, activeMap)
  if (validation.ok) {
    return { ready: true, map: validation.map, mapIdentity: identityValidation.waypointIdentity }
  }

  return {
    ready: true,
    warning: validation.message,
    map: validation.map,
    mapIdentity: identityValidation.waypointIdentity,
  }
}

async function tryStartDogzillaWaypointNavigation({
  runtimeConfig,
  ros2Config,
  probeRobotSidecarHealthImpl,
  runDogzillaConnectionActionImpl,
  sleepImpl,
  timeoutMs,
  pollIntervalMs,
}) {
  const startResult = await runDogzillaConnectionActionImpl('start-navigation')

  if (startResult.status === 'error') {
    return {
      ready: false,
      startResult,
      health: null,
    }
  }

  const startedAt = Date.now()
  let health = null

  do {
    health = await probeRobotSidecarHealthImpl(runtimeConfig, ros2Config)
    const runtime = health.body?.runtime && typeof health.body.runtime === 'object' ? health.body.runtime : null
    let readiness = getDogzillaWaypointNavigationReadiness(runtime)
    readiness = await maybeFillOdomReadinessFromPoseService(readiness, runtimeConfig, {})
    const ready = health.status === 'ok' && readiness.ready

    if (ready) {
      return {
        ready: true,
        startResult,
        health,
      }
    }

    await sleepImpl(pollIntervalMs)
  } while (Date.now() - startedAt < timeoutMs)

  return {
    ready: false,
    startResult,
    health,
  }
}

function isWaypointGotoPreview(preview = {}) {
  return preview?.canonicalPlan?.kind === 'locomotion.goto'
    || preview?.payload?.canonicalPlan?.kind === 'locomotion.goto'
}

function resolveRobotCommandTimeoutMs(preview = {}, transport = {}) {
  if (!isWaypointGotoPreview(preview)) {
    return transport.timeoutMs || DEFAULT_ROBOT_COMMAND_TIMEOUT_MS
  }

  return null
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
    const requestOptions = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      requestOptions.signal = AbortSignal.timeout(timeoutMs)
    }

    const response = await fetch(targetUrl, requestOptions)
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

function withMinimumTransportTimeout(ros2Config = {}, timeoutMs) {
  const transport = ros2Config.transport ?? {}
  const currentTimeoutMs = Number(transport.timeoutMs)
  const nextTimeoutMs = Math.max(
    Number.isFinite(currentTimeoutMs) && currentTimeoutMs > 0 ? currentTimeoutMs : 0,
    timeoutMs,
  )

  return {
    ...ros2Config,
    transport: {
      ...transport,
      timeoutMs: nextTimeoutMs,
    },
  }
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

  const canonicalPlan = prepareAppWaypointGoto(preview.canonicalPlan)
  const payloadPlan = prepareAppWaypointGoto(preview.payload?.canonicalPlan)
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

function prepareAppWaypointGoto(canonicalPlan) {
  if (!canonicalPlan || typeof canonicalPlan !== 'object' || canonicalPlan.kind !== 'locomotion.goto') {
    return canonicalPlan
  }

  const params = canonicalPlan.params && typeof canonicalPlan.params === 'object' ? canonicalPlan.params : {}
  const {
    timeoutSec: _timeoutSec,
    timeoutSeconds: _timeoutSeconds,
    timeout_sec: _timeout_sec,
    ...paramsWithoutTimeout
  } = params
  const existing = params.obstacleAvoidance && typeof params.obstacleAvoidance === 'object'
    ? params.obstacleAvoidance
    : {}

  return {
    ...canonicalPlan,
    params: {
      ...paramsWithoutTimeout,
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
