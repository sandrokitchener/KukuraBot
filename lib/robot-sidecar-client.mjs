import { performance } from 'node:perf_hooks'
import { loadRobotRos2Config, loadRobotRuntimeConfig } from './robot-runtime-config.mjs'
import { formatFetchError } from './http-error.mjs'
import { loadDogzillaConnectionConfig } from './dogzilla-connection-center.mjs'
import { normalizeDogzillaMapMetadata, validatePoseInsideDogzillaMap, validateWaypointMapIdentity } from './dogzilla-map-metadata.mjs'
import { getDogzillaWaypointNavigationReadiness } from './dogzilla-navigation-readiness.mjs'
import {
  isNav2StabilityTrackerEnabled,
  recordNav2CommandFailure,
  recordNav2CommandRetryResult,
} from './dogzilla-nav2-stability.mjs'

export const ROBOT_HTTP_TARGET_KINDS = new Set(['ros2-bridge', 'dogzilla-direct'])
const DEFAULT_ROBOT_COMMAND_TIMEOUT_MS = 12000
const HEALTHZ_LITE_TIMEOUT_MS = 8000
const NAV2_SCAN_INFO_TIMEOUT_MS = 4000
const FULL_HEALTHZ_FAST_TIMEOUT_MS = 6000
const PREEMPT_TIMEOUT_MS = 4000
const LIDAR_AIDED_OBSTACLE_AVOIDANCE = Object.freeze({
  required: true,
  mode: 'nav2_costmap',
  lidarTopic: '/scan_nav2',
  command: 'verify Nav2 costmaps have live /scan_nav2; do not start Yahboom laser_Avoidance_xgo_RS200 during Nav2 waypoint control',
  docs: 'sidecars/dogzilla_navigation/README.md',
})

export async function getRobotSidecarHealth(options = {}) {
  const [runtimeConfig, ros2Config] = await Promise.all([
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
  ])

  return probeRobotSidecarHealth(runtimeConfig, ros2Config, options)
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

export async function dispatchRobotEmergencyStopClear() {
  const [runtimeConfig, ros2Config] = await Promise.all([
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
  ])

  return sendRobotEmergencyStopClear(runtimeConfig, ros2Config)
}

export async function probeRobotSidecarHealth(runtimeConfig = {}, ros2Config = {}, options = {}) {
  return probeRobotSidecarHealthPath(runtimeConfig, ros2Config, options)
}

async function probeRobotSidecarHealthPath(runtimeConfig = {}, ros2Config = {}, options = {}) {
  const transport = ros2Config.transport ?? {}

  if (!isRobotHttpTarget(runtimeConfig)) {
    return {
      attempted: false,
      status: 'inactive-target',
      destination: transport.baseUrl || '',
      activeTarget: runtimeConfig.activeTarget?.id || '',
      durationMs: 0,
    }
  }

  if (!transport.enabled) {
    return {
      attempted: false,
      status: 'disabled',
      destination: transport.baseUrl || '',
      durationMs: 0,
    }
  }

  if (transport.kind !== 'http') {
    return {
      attempted: false,
      status: 'unsupported-transport',
      destination: transport.baseUrl || '',
      durationMs: 0,
    }
  }

  const targetPath = options.path || transport.healthPath || '/healthz'
  const targetUrl = buildTargetUrl(transport.baseUrl, targetPath)
  const timeoutMs = options.timeoutMs ?? transport.timeoutMs ?? 4000
  const start = performance.now()

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await safeReadJson(response)
    const runtimeOk = body && typeof body === 'object' && body.ok === false ? false : true
    const durationMs = Math.round(performance.now() - start)

    return {
      attempted: true,
      status: response.ok && runtimeOk ? 'ok' : response.ok ? 'degraded' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      body,
      durationMs,
    }
  } catch (error) {
    const durationMs = Math.round(performance.now() - start)

    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      error: formatFetchError(error),
      durationMs,
      timedOut: isTimeoutError(error),
    }
  }
}

async function probeNav2ScanInfo(ros2Config = {}, options = {}) {
  const transport = ros2Config.transport ?? {}
  const targetUrl = buildTargetUrl(transport.baseUrl, '/nav2/scan_info')
  const timeoutMs = options.timeoutMs ?? transport.timeoutMs ?? DEFAULT_ROBOT_COMMAND_TIMEOUT_MS
  const start = performance.now()

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await safeReadJson(response)
    const scan = body && typeof body === 'object' ? body : {}
    const publisherCount = Number(scan.publisherCount ?? 0)
    const subscriptionCount = Number(scan.subscriptionCount ?? 0)
    const available = scan.available === true && publisherCount > 0 && subscriptionCount > 0
    const durationMs = Math.round(performance.now() - start)

    return {
      attempted: true,
      status: response.ok ? 'ok' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      scan: {
        topic: scan.topic || '/scan_nav2',
        publisherCount,
        subscriptionCount,
        available,
        checkedAt: scan.checkedAt,
        ageSec: scan.ageSec,
        error: scan.error,
      },
      body: scan,
      durationMs,
    }
  } catch (error) {
    const durationMs = Math.round(performance.now() - start)

    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      error: formatFetchError(error),
      durationMs,
      timedOut: isTimeoutError(error),
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
  const stages = {}
  const waypointNavigation = await verifyWaypointNavigationReady(preview, runtimeConfig, ros2Config, options)

  stages.preflight = {
    status: waypointNavigation.ready ? 'ok' : waypointNavigation.status || 'failed',
    durationMs: waypointNavigation.durationMs ?? 0,
    stage: waypointNavigation.failedStage || null,
  }

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
      mapIdentity: waypointNavigation.mapIdentity,
      stages,
    }
  }

  try {
    const preempt = await runPreemptIfNeeded(preview, targetUrl, runtimeConfig, ros2Config)
    if (preempt) {
      stages.preempt = {
        status: preempt.status,
        durationMs: preempt.durationMs,
        destination: preempt.destination,
        responseStatus: preempt.responseStatus,
      }
    }

    const commandTimeoutMs = resolveRobotCommandTimeoutMs(preview, transport)
    const command = await postRobotCommandEnvelope({
      targetUrl,
      envelope,
      timeoutMs: commandTimeoutMs,
    })

    stages.command = {
      status: command.status,
      durationMs: command.durationMs ?? 0,
      responseStatus: command.responseStatus,
      destination: command.destination,
    }

    if (command.status === 'sent') {
      return {
        ...command,
        preempt,
        stages,
      }
    }

    if (isRecoverableNav2CommandError(command) && waypointNavigation.ready) {
      if (isNav2StabilityTrackerEnabled()) {
        recordNav2CommandFailure({
          source: 'command-dispatch',
          blocker: command.error || command.body?.result?.error || command.body?.error || 'Nav2 NavigateToPose action server unavailable',
          bridgeDestination: targetUrl,
          retryAction: 'command-retry',
          readinessStep: 'action_server',
          probeDurationMs: stages.preflight.durationMs,
        })
      }

      const retry = await postRobotCommandEnvelope({
        targetUrl,
        envelope,
        timeoutMs: commandTimeoutMs,
      })

      stages.retry = {
        status: retry.status,
        durationMs: retry.durationMs ?? 0,
        responseStatus: retry.responseStatus,
        destination: retry.destination,
      }

      if (retry.status === 'sent') {
        if (isNav2StabilityTrackerEnabled()) {
          recordNav2CommandRetryResult(true, {
            source: 'command-dispatch',
            retryAction: 'command-retry',
            bridgeDestination: targetUrl,
          })
        }

        return {
          ...retry,
          preempt,
          stages,
          firstAttempt: command,
          retriedAfterCommandFailure: true,
        }
      }

      if (isNav2StabilityTrackerEnabled()) {
        recordNav2CommandRetryResult(false, {
          source: 'command-dispatch',
          retryAction: 'command-retry',
          blocker: retry.error || retry.body?.result?.error || retry.body?.error || 'Nav2 NavigateToPose retry still unavailable',
          bridgeDestination: targetUrl,
        })
      }

      return {
        ...retry,
        preempt,
        stages,
        firstAttempt: command,
        retriedAfterCommandFailure: true,
      }
    }


    return {
      ...command,
      preempt,
      stages,
    }
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      error: formatFetchError(error),
      stages,
    }
  }
}

async function runPreemptIfNeeded(preview, targetUrl, runtimeConfig, ros2Config) {
  if (!shouldPreemptBeforeCommand(preview)) {
    return null
  }

  const { result, durationMs } = await measureAsync(() => postRobotCommandEnvelope({
    targetUrl,
    envelope: buildPreemptiveStopEnvelope(runtimeConfig, ros2Config),
    action: 'stop',
    timeoutMs: PREEMPT_TIMEOUT_MS,
  }))

  return {
    ...result,
    durationMs,
  }
}

async function verifyWaypointNavigationReady(preview = {}, runtimeConfig = {}, ros2Config = {}, options = {}) {
  const startedAt = performance.now()

  if (!isWaypointGotoPreview(preview)) {
    return { ready: true, durationMs: 0 }
  }

  const trust = validateWaypointTrust(preview)
  if (!trust.ready) {
    return { ...trust, durationMs: Math.round(performance.now() - startedAt) }
  }

  const transport = ros2Config.transport ?? {}
  const stages = {}
  const isDogzillaDirect = runtimeConfig.activeTarget?.kind === 'dogzilla-direct'

  const lite = await probeRobotSidecarHealthPath(runtimeConfig, ros2Config, {
    path: '/healthz-lite',
    timeoutMs: options.healthzLiteTimeoutMs || HEALTHZ_LITE_TIMEOUT_MS,
  })
  stages.healthLite = lite

  if (lite.status !== 'ok') {
    return buildWaypointNavigationUnavailable({
      startedAt,
      stages,
      stage: 'healthLite',
      status: 'bridge-unreachable',
      health: lite,
      error: `Waypoint navigation unavailable: robot bridge reachability check failed (${lite.status}${lite.error ? `; ${lite.error}` : ''}).`,
    })
  }

  const scanInfo = await probeNav2ScanInfo(ros2Config, {
    timeoutMs: options.scanInfoTimeoutMs || NAV2_SCAN_INFO_TIMEOUT_MS,
  })
  stages.scanInfo = scanInfo

  if (!isDogzillaDirect && (scanInfo.status !== 'ok' || scanInfo.scan?.available !== true)) {
    return buildWaypointNavigationUnavailable({
      startedAt,
      stages,
      stage: 'scanInfo',
      status: 'scan-not-ready',
      health: scanInfo,
      error: scanInfo.scan?.error
        ? `Waypoint navigation unavailable: ${scanInfo.scan.error}`
        : `Waypoint navigation unavailable: filtered scan ${scanInfo.scan?.topic || '/scan_nav2'} is not ready.`,
    })
  }

  const fullHealth = await probeRobotSidecarHealthPath(runtimeConfig, ros2Config, {
    path: transport.healthPath || '/healthz',
    timeoutMs: options.fullHealthTimeoutMs || FULL_HEALTHZ_FAST_TIMEOUT_MS,
  })
  stages.fullHealth = fullHealth

  if (!isDogzillaDirect && fullHealth.status !== 'ok' && !fullHealth.timedOut) {
    return buildWaypointNavigationUnavailable({
      startedAt,
      stages,
      stage: 'fullHealth',
      status: fullHealth.status === 'degraded' ? 'navigation-degraded' : 'navigation-unavailable',
      health: fullHealth,
      error: `Waypoint navigation unavailable: full bridge health is ${fullHealth.status}${fullHealth.error ? ` (${fullHealth.error})` : ''}.`,
    })
  }

  const runtime = fullHealth.body?.runtime && typeof fullHealth.body.runtime === 'object'
    ? fullHealth.body.runtime
    : null

  const mapValidation = validateWaypointAgainstActiveMap(preview, runtime?.map)
  if (!mapValidation.ready) {
    return {
      ...mapValidation,
      stages,
      durationMs: Math.round(performance.now() - startedAt),
    }
  }

  const readinessStart = performance.now()
  let readiness = getDogzillaWaypointNavigationReadiness(runtime)
  const readinessDurationMs = Math.round(performance.now() - readinessStart)

  stages.readiness = {
    status: readiness.ready ? 'ok' : 'degraded',
    durationMs: readinessDurationMs,
    readiness,
  }

  if (
    isDogzillaDirect
    && !readiness.ready
    && readiness.actionAvailable
    && options.autoStartWaypointNavigation === false
  ) {
    const recovery = `Pi-owned Nav2 is present but not waypoint-ready. Check robodoge-navigation.service on the Pi for live ${readiness.odomTopic} samples with odom->base TF, active Nav2 lifecycle nodes, and filtered scan wiring on ${readiness.scanTopic || '/scan_nav2'}. App/server will not repair or restart Nav2.`
    return {
      ready: false,
      failedStage: 'readiness',
      health: fullHealth,
      stages,
      kind: 'map-waypoint',
      operatorMessage: `Waypoint not sent: DOGZILLA Nav2 exists, but waypoint prerequisites are not proven${readiness.reason ? `: ${readiness.reason}` : ''}. Manual controls and non-waypoint actions are still available.`,
      recovery,
      directControlAvailable: true,
      error: `Waypoint blocked: Nav2 waypoint prerequisites failed. ${readiness.reason || recovery}`,
      nav2Readiness: readiness,
      durationMs: Math.round(performance.now() - startedAt),
    }
  }

  if (isDogzillaDirect && !readiness.ready) {
    const finalHealth = fullHealth
    const finalRuntime = finalHealth.body?.runtime && typeof finalHealth.body.runtime === 'object'
      ? finalHealth.body.runtime
      : runtime
    const finalNav2 = finalRuntime?.nav2 && typeof finalRuntime.nav2 === 'object' ? finalRuntime.nav2 : null
    const finalNavigation = finalRuntime?.navigation && typeof finalRuntime.navigation === 'object'
      ? finalRuntime.navigation
      : null
    let finalReadiness = getDogzillaWaypointNavigationReadiness(finalRuntime)
    const reason = normalizeErrorText(finalNav2?.importError)
      || normalizeErrorText(finalNav2?.serverError)
      || normalizeErrorText(finalReadiness.reason)
      || normalizeErrorText(finalRuntime?.importError)
      || 'Nav2 NavigateToPose unavailable'
    const fallbackText = finalNavigation?.primary && finalNavigation.primary !== 'nav2'
      ? ` The bridge also reports ${finalNavigation.primary}, but that is not a safe waypoint navigator and will not be used.`
      : ''
    const recovery = finalReadiness.actionAvailable === true
      ? `Pi-owned Nav2 action server is visible but waypoint prerequisites are not ready. Check robodoge-navigation.service on the Pi for live ${finalReadiness.odomTopic} samples with odom->base TF, active Nav2 lifecycle nodes, and filtered scan wiring on ${finalReadiness.scanTopic || '/scan_nav2'}. App/server will not repair or restart Nav2.`
      : finalNav2?.clientAvailable === true && finalNav2?.serverAvailable === false
        ? 'The Docker ROS client is available, but no NavigateToPose action server exists in ROS graph. Nav2 is Pi-owned; check robodoge-navigation.service instead of starting it from the app/server.'
        : 'Pi-owned Nav2 is down or still booting. Check robodoge-navigation.service on the Pi; app/server will not start, repair, or recreate Nav2.'
    const operatorMessage = 'Waypoint not sent: Pi-owned Nav2 is not ready. Manual controls and non-waypoint actions still available.'
    return {
      ready: false,
      failedStage: 'readiness',
      health: finalHealth,
      stages,
      kind: 'map-waypoint',
      operatorMessage,
      recovery,
      directControlAvailable: true,
      error: `Waypoint blocked: Pi-owned Nav2 is not ready. ${reason}.${fallbackText} ${recovery}`,
      nav2Readiness: finalReadiness,
      durationMs: Math.round(performance.now() - startedAt),
    }
  }

  if (fullHealth.timedOut) {
    return {
      ready: true,
      health: fullHealth,
      stages,
      fullHealthTimeout: true,
      warning: 'Full bridge health probe timed out; waypoint dispatch is proceeding on fast probes only.',
      durationMs: Math.round(performance.now() - startedAt),
    }
  }

  const robotPoseValidation = await validateLiveRobotPoseAgainstActiveMap(runtime, runtimeConfig, options)
  if (!robotPoseValidation.ready) {
    return buildRobotPoseOffMapResult(robotPoseValidation, fullHealth, null, stages, startedAt)
  }

  return {
    ready: true,
    health: fullHealth,
    stages,
    durationMs: Math.round(performance.now() - startedAt),
  }
}

function buildWaypointNavigationUnavailable({ startedAt, stages, stage, status, health, error }) {
  return {
    ready: false,
    failedStage: stage,
    status,
    health,
    stages,
    kind: 'map-waypoint',
    operatorMessage: 'Waypoint not sent: navigation prerequisites are not satisfied. Manual controls and non-waypoint actions are still available.',
    recovery: 'Check DOGZILLA bridge, rosbridge, Cartographer localization, and Nav2 lifecycle state, then retry.',
    directControlAvailable: true,
    error,
    durationMs: Math.round(performance.now() - startedAt),
  }
}

function validateWaypointTrust(preview = {}) {
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

  return { ready: true }
}

function formatNumber(value) {
  return Number(value).toFixed(2)
}

function validateWaypointAgainstActiveMap(preview = {}, activeMap = null) {
  const params = preview.canonicalPlan?.params && typeof preview.canonicalPlan.params === 'object'
    ? preview.canonicalPlan.params
    : {}

  const mapAvailable = validateWaypointMapIdentity(params, activeMap)
  if (!mapAvailable.ok) {
    return {
      ready: false,
      status: 'waypoint-map-blocked',
      kind: 'map-waypoint',
      directControlAvailable: true,
      operatorMessage: `Waypoint not sent: ${mapAvailable.message}. The saved waypoint remains unchanged.`,
      recovery: 'Relocalize against the intended active map or recapture the waypoint on the current map before retrying.',
      error: `Waypoint blocked: ${mapAvailable.message}.`,
      map: mapAvailable.map,
      mapIdentity: mapAvailable.waypointIdentity,
    }
  }

  const validation = validatePoseInsideDogzillaMap(params, activeMap)
  if (validation.ok) {
    return { ready: true, map: validation.map, mapIdentity: mapAvailable.waypointIdentity }
  }

  return {
    ready: true,
    warning: validation.message,
    map: validation.map,
    mapIdentity: mapAvailable.waypointIdentity,
  }
}

async function validateLiveRobotPoseAgainstActiveMap(runtime = {}, runtimeConfig = {}, options = {}) {
  if (
    runtimeConfig.activeTarget?.kind !== 'dogzilla-direct'
    || options.probeDogzillaPoseMapBounds === false
  ) {
    return { ready: true, checked: false }
  }

  const map = normalizeDogzillaMapMetadata(runtime?.map)
  if (!map?.available || !map.bounds) {
    return { ready: true, checked: false, map }
  }

  const probe = options.getDogzillaRobotPoseImpl
    ? await options.getDogzillaRobotPoseImpl()
    : await probeDogzillaMapPose({
      fetchImpl: options.fetchImpl || fetch,
      loadDogzillaConnectionConfigImpl: options.loadDogzillaConnectionConfigImpl || loadDogzillaConnectionConfig,
    })

  if (!probe.checked || !probe.pose || probe.ok !== true) {
    return { ready: true, checked: probe.checked, map, pose: probe.pose, warning: probe.reason }
  }

  if (probe.pose.frame !== 'map') {
    return { ready: true, checked: true, map, pose: probe.pose, warning: `live robot pose frame is ${probe.pose.frame || 'unknown'}, not map` }
  }

  const validation = validatePoseInsideDogzillaMap(probe.pose, map)
  if (validation.ok) {
    return { ready: true, checked: true, map, pose: probe.pose }
  }

  if (validation.reason !== 'off-map') {
    return { ready: true, checked: true, map, pose: probe.pose, warning: validation.message }
  }

  return {
    ready: false,
    checked: true,
    map,
    pose: probe.pose,
    reason: validation.reason,
    message: buildRobotOffMapMessage(probe.pose, map),
  }
}

async function probeDogzillaMapPose({
  fetchImpl = fetch,
  loadDogzillaConnectionConfigImpl = loadDogzillaConnectionConfig,
} = {}) {
  try {
    const config = await loadDogzillaConnectionConfigImpl()
    const poseUrl = config.lidar?.poseUrl || buildTargetUrl(config.lidar?.baseUrl || '', config.lidar?.posePath || '/pose')
    if (!poseUrl || typeof fetchImpl !== 'function') {
      return { checked: false, reason: 'DOGZILLA pose service is not configured' }
    }

    const response = await fetchImpl(poseUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(4000),
    })
    const body = await safeReadJson(response)
    const poseSource = body?.pose && typeof body.pose === 'object' ? body.pose : body && typeof body === 'object' ? body : {}
    const pose = {
      frame: normalizeErrorText(poseSource.frame || body?.frame),
      x: Number(poseSource.x),
      y: Number(poseSource.y),
      theta: Number(poseSource.theta),
      source: normalizeErrorText(poseSource.source || body?.source),
      waypointSafe: body?.waypointSafe === true,
      poseUrl,
    }
    const poseOk = response.ok
      && body?.ok !== false
      && Number.isFinite(pose.x)
      && Number.isFinite(pose.y)

    return {
      checked: true,
      ok: poseOk,
      pose,
      poseUrl,
      reason: poseOk ? '' : normalizeErrorText(body?.error) || 'DOGZILLA map pose service did not return a finite pose',
    }
  } catch (error) {
    return {
      checked: true,
      ok: false,
      pose: null,
      reason: formatFetchError(error),
    }
  }
}

function buildRobotOffMapMessage(pose = {}, map = {}) {
  const bounds = map.bounds || {}
  return `robot pose (${formatNumber(pose.x)}, ${formatNumber(pose.y)}) is outside active map bounds x ${formatNumber(bounds.minX)}..${formatNumber(bounds.maxX)}, y ${formatNumber(bounds.minY)}..${formatNumber(bounds.maxY)}`
}

function buildRobotPoseOffMapResult(robotPoseValidation, health, repair = null, stages = null, startedAt = null) {
  const result = {
    ready: false,
    status: 'navigation-unavailable',
    health,
    kind: 'map-waypoint',
    operatorMessage: `Waypoint not sent: DOGZILLA localization is outside the active map${robotPoseValidation.message ? `: ${robotPoseValidation.message}` : ''}. Manual controls and non-waypoint actions are still available.`,
    recovery: 'Restart DOGZILLA map-pose localization against the saved map, move the robot back inside the mapped area, or rebuild/recapture the map before sending map waypoints.',
    directControlAvailable: true,
    error: `Waypoint blocked: robot pose is outside active DOGZILLA map bounds. ${robotPoseValidation.message || ''}`.trim(),
    map: robotPoseValidation.map,
    robotPose: robotPoseValidation.pose,
  }

  if (stages) {
    result.stages = stages
  }
  if (startedAt !== null) {
    result.durationMs = Math.round(performance.now() - startedAt)
  }

  return result
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
  const start = performance.now()
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
    const durationMs = Math.round(performance.now() - start)

    const delivery = responseBody?.result?.delivery || responseBody?.delivery || ''
    let status
    if (!response.ok) {
      const rejectedValues = ['rejected', 'unavailable', 'blocked', 'nav2-unavailable']
      status = rejectedValues.some((v) => delivery.includes(v)) ? 'rejected' : 'error'
    } else if (delivery === 'accepted') {
      status = 'accepted'
    } else {
      status = 'sent'
    }

    return {
      attempted: true,
      status,
      responseStatus: response.status,
      destination: targetUrl,
      commandId: responseBody?.result?.commandId || responseBody?.commandId || null,
      body: responseBody,
      durationMs,
      ...(response.ok ? {} : { error: formatRobotCommandResponseError(responseBody) }),
    }
  } catch (error) {
    const durationMs = Math.round(performance.now() - start)

    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      error: formatRobotCommandFetchError(error, timeoutMs),
      durationMs,
    }
  }
}


function isRecoverableNav2CommandError(command = {}) {
  const body = command.body && typeof command.body === 'object' ? command.body : {}
  const result = body.result && typeof body.result === 'object' ? body.result : {}
  const text = [
    command.error,
    body.error,
    body.status,
    result.error,
    result.delivery,
  ].map((value) => normalizeErrorText(value)).filter(Boolean).join(' ')

  return /Nav2 NavigateToPose action server unavailable|NavigateToPose action server is not running|nav2-unavailable/i.test(text)
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

  if (canonicalPlan.kind === 'locomotion.goto') {
    return false
  }

  if (canonicalPlan.kind === 'action.loop' && canonicalPlan.params?.enabled === false) {
    return false
  }

  return true
}

function measureAsync(fn) {
  const start = performance.now()
  return Promise.resolve()
    .then(fn)
    .then((result) => ({ result, durationMs: Math.round(performance.now() - start) }))
    .catch((error) => ({ error, durationMs: Math.round(performance.now() - start) }))
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
  return sendRobotSafetyStop(runtimeConfig, ros2Config, buildEmergencyStopEnvelope(runtimeConfig, ros2Config), 'stop')
}

export async function sendRobotEmergencyStopClear(runtimeConfig = {}, ros2Config = {}) {
  return sendRobotSafetyStop(runtimeConfig, ros2Config, buildEmergencyStopClearEnvelope(runtimeConfig, ros2Config), 'clear')
}

async function sendRobotSafetyStop(runtimeConfig, ros2Config, envelope, action) {
  const transport = ros2Config.transport ?? {}

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
        action,
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

function buildEmergencyStopClearEnvelope(runtimeConfig = {}, ros2Config = {}) {
  return buildStopEnvelope(runtimeConfig, ros2Config, {
    command: 'safety',
    reason: 'clear_emergency_stop',
    action: 'clear',
  })
}

function buildPreemptiveStopEnvelope(runtimeConfig = {}, ros2Config = {}) {
  return buildStopEnvelope(runtimeConfig, ros2Config, {
    command: 'preempt',
    reason: 'command_preempt',
  })
}

function buildStopEnvelope(runtimeConfig = {}, ros2Config = {}, { command, reason, action = 'stop' }) {
  const identity = buildRobotIdentity(runtimeConfig)

  return {
    status: 'ready',
    target: runtimeConfig.activeTarget?.id || 'ros2_real',
    targetKind: runtimeConfig.activeTarget?.kind || 'ros2-bridge',
    targetLabel: runtimeConfig.activeTarget?.label || 'ROS2 Real Robot',
    ...identity,
    protocolVersion: 1,
    command,
    action,
    canonicalPlan: {
      kind: 'noop',
      params: {
        reason,
        action,
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
          action,
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
