import { performance } from 'node:perf_hooks'
import { loadRobotRos2Config, loadRobotRuntimeConfig } from './robot-runtime-config.mjs'
import { formatFetchError } from './http-error.mjs'
import { loadDogzillaConnectionConfig, runDogzillaConnectionAction } from './dogzilla-connection-center.mjs'
import { normalizeDogzillaMapMetadata, validatePoseInsideDogzillaMap, validateWaypointMapIdentity } from './dogzilla-map-metadata.mjs'
import { getDogzillaWaypointNavigationReadiness } from './dogzilla-navigation-readiness.mjs'
import {
  isNav2StabilityTrackerEnabled,
  recordNav2CommandFailure,
  recordNav2RepairResult,
} from './dogzilla-nav2-stability.mjs'

export const ROBOT_HTTP_TARGET_KINDS = new Set(['ros2-bridge', 'dogzilla-direct'])
const DEFAULT_ROBOT_COMMAND_TIMEOUT_MS = 12000
const WAYPOINT_NAVIGATION_HEALTH_TIMEOUT_MS = 30000
const HEALTHZ_LITE_TIMEOUT_MS = 2000
const NAV2_SCAN_INFO_TIMEOUT_MS = 4000
const FULL_HEALTHZ_FAST_TIMEOUT_MS = 6000
const PREEMPT_TIMEOUT_MS = 4000
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

const DEFAULT_NAV_MODE_TIMEOUT_MS = 120_000

export async function enterDogzillaNavMode(runtimeConfig = {}, ros2Config = {}, mode = 'navigate', options = {}) {
  const transport = ros2Config.transport ?? {}

  if (!isRobotHttpTarget(runtimeConfig)) {
    return {
      ok: false,
      status: 'inactive-target',
      mode,
      destination: transport.baseUrl || '',
    }
  }

  if (transport.kind !== 'http') {
    return {
      ok: false,
      status: 'unsupported-transport',
      mode,
      destination: transport.baseUrl || '',
    }
  }

  const targetUrl = buildTargetUrl(transport.baseUrl, '/mode')
  const transportTimeoutMs = Number(transport.timeoutMs)
  const timeoutMs = options.timeoutMs ?? (
    Number.isFinite(transportTimeoutMs)
      ? Math.max(transportTimeoutMs, DEFAULT_NAV_MODE_TIMEOUT_MS)
      : DEFAULT_NAV_MODE_TIMEOUT_MS
  )
  const start = performance.now()

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await safeReadJson(response)
    const durationMs = Math.round(performance.now() - start)

    const ok = response.ok && body?.ok !== false
    return {
      ok,
      status: ok ? 'ok' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      mode: body?.mode || mode,
      previousMode: body?.previousMode,
      body,
      durationMs,
    }
  } catch (error) {
    const durationMs = Math.round(performance.now() - start)

    return {
      ok: false,
      status: 'error',
      mode,
      destination: targetUrl,
      error: formatFetchError(error),
      durationMs,
      timedOut: isTimeoutError(error),
    }
  }
}

export async function fetchDogzillaNavMode(runtimeConfig = {}, ros2Config = {}, options = {}) {
  const transport = ros2Config.transport ?? {}

  if (!isRobotHttpTarget(runtimeConfig) || transport.kind !== 'http') {
    return { ok: false, status: 'inactive-target', destination: transport.baseUrl || '' }
  }

  const targetUrl = buildTargetUrl(transport.baseUrl, '/mode')
  const timeoutMs = options.timeoutMs ?? transport.timeoutMs ?? 4000

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await safeReadJson(response)
    return {
      ok: response.ok && body?.ok !== false,
      status: response.ok ? 'ok' : 'error',
      destination: targetUrl,
      navMode: body?.navMode || body?.mode || 'unknown',
      body,
    }
  } catch (error) {
    return {
      ok: false,
      status: 'error',
      destination: targetUrl,
      error: formatFetchError(error),
      navMode: 'unknown',
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
      navigationRepair: waypointNavigation.repair,
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
          repairAction: 'command-retry',
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
          recordNav2RepairResult(true, {
            source: 'command-dispatch',
            repairAction: 'command-retry',
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
        recordNav2RepairResult(false, {
          source: 'command-dispatch',
          repairAction: 'command-retry',
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

  if (scanInfo.status !== 'ok' || scanInfo.scan?.available !== true) {
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

  if (fullHealth.status !== 'ok' && !fullHealth.timedOut) {
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
    runtimeConfig.activeTarget?.kind === 'dogzilla-direct'
    && !readiness.ready
    && isDogzillaDirectGoalPathReady(runtime, scanInfo)
  ) {
    stages.commandPath = {
      status: 'ok',
      detail: 'Direct bridge can send goals; treating lifecycle-only readiness failure as diagnostic.',
      readiness,
    }
    const robotPoseValidation = await validateLiveRobotPoseAgainstActiveMap(runtime, runtimeConfig, options)
    if (!robotPoseValidation.ready) {
      return buildRobotPoseOffMapResult(robotPoseValidation, fullHealth, null, stages, startedAt)
    }
    return {
      ready: true,
      health: fullHealth,
      stages,
      warning: readiness.reason
        ? `Full health reported diagnostic Nav2 readiness issue: ${readiness.reason}`
        : 'Full health reported diagnostic Nav2 readiness issue.',
      durationMs: Math.round(performance.now() - startedAt),
    }
  }

  if (
    runtimeConfig.activeTarget?.kind === 'dogzilla-direct'
    && !readiness.ready
    && readiness.actionAvailable
    && options.autoStartWaypointNavigation === false
  ) {
    const recovery = `Start/fix DOGZILLA Nav2 prerequisites before sending map waypoints: live ${readiness.odomTopic} samples with odom->base TF, active Nav2 lifecycle nodes, and filtered scan wiring on ${readiness.scanTopic || '/scan_nav2'}. Nav2 has an action server, but waypoint control is unsafe until all prerequisites are proven.`
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

  if (runtimeConfig.activeTarget?.kind === 'dogzilla-direct' && !readiness.ready) {
    const healthRos2Config = withMinimumTransportTimeout(
      ros2Config,
      options.waypointNavigationHealthTimeoutMs || WAYPOINT_NAVIGATION_HEALTH_TIMEOUT_MS,
    )
    const repair = null

    if (repair?.ready) {
      const repairRuntime = repair.health?.body?.runtime && typeof repair.health.body.runtime === 'object'
        ? repair.health.body.runtime
        : runtime
      const robotPoseValidation = await validateLiveRobotPoseAgainstActiveMap(repairRuntime, runtimeConfig, options)
      if (!robotPoseValidation.ready) {
        return buildRobotPoseOffMapResult(robotPoseValidation, repair.health, repair, stages, startedAt)
      }
      return {
        ready: true,
        health: repair.health,
        repair,
        stages,
        durationMs: Math.round(performance.now() - startedAt),
      }
    }

    const finalHealth = repair?.health || fullHealth
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
    const repairText = repair?.startResult?.status === 'error'
      ? ` Tried to start the waypoint navigator, but startup failed: ${repair.startResult.error || repair.startResult.stderr || 'unknown error'}.`
      : repair && !repair.ready
        ? ' Tried to start the waypoint navigator, but it did not become ready.'
        : ''
    const recovery = finalReadiness.actionAvailable === true
      ? `Repair DOGZILLA Nav2 prerequisites before sending map waypoints: live ${finalReadiness.odomTopic} samples with odom->base TF, active Nav2 lifecycle nodes, and filtered scan wiring on ${finalReadiness.scanTopic || '/scan_nav2'}.`
      : finalNav2?.clientAvailable === true && finalNav2?.serverAvailable === false
        ? 'The Docker ROS client is available, but no NavigateToPose action server exists in the ROS graph. Start/install a real navigation server before sending map waypoints.'
        : 'Start the ROS2/Nav2 bridge or container before sending map waypoints.'
    const operatorMessage = 'Waypoint not sent: DOGZILLA has map pose, but no waypoint navigation server is running. Manual controls and non-waypoint actions are still available.'
    return {
      ready: false,
      failedStage: 'readiness',
      health: finalHealth,
      repair,
      stages,
      kind: 'map-waypoint',
      operatorMessage,
      recovery,
      directControlAvailable: true,
      error: `Waypoint blocked: no DOGZILLA waypoint navigation server is running. ${reason}.${fallbackText}${repairText} ${recovery}`,
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

function isDogzillaDirectGoalPathReady(runtime = {}, scanInfo = {}) {
  const navigation = runtime?.navigation && typeof runtime.navigation === 'object' ? runtime.navigation : null
  const nav2FromNavigation = navigation?.nav2 && typeof navigation.nav2 === 'object' ? navigation.nav2 : null
  const nav2 = nav2FromNavigation || (runtime?.nav2 && typeof runtime.nav2 === 'object' ? runtime.nav2 : null)
  if (!nav2) {
    return false
  }

  const odom = nav2.odom && typeof nav2.odom === 'object' ? nav2.odom : {}
  const scan = nav2.scan && typeof nav2.scan === 'object' ? nav2.scan : {}
  const actionReady = nav2.canSendGoal === true
    && (nav2.serverAvailable === true || nav2.actionServerDiscovered === true || nav2.available === true)
  const odomReady = odom.available === true || (odom.messageAvailable === true && odom.tfAvailable === true)
  const scanReady = scanInfo?.scan?.available === true || scan.available === true

  return actionReady && odomReady && scanReady
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
    const blockers = [
      ...(Array.isArray(readiness.blockers) ? readiness.blockers : []),
    ].filter((blocker) => !/(No publishers|no live odom|live odometry|readiness did not prove)/i.test(blocker))
    const ready = readiness.actionAvailable === true
      && readiness.lifecycleActive === true
      && readiness.scanReady === true
    return {
      ...readiness,
      ready,
      odomReady: true,
      odomTopic: probe.odomTopic,
      odomPublisherCount: probe.odomPublisherCount,
      odomMessageAvailable: probe.messageAvailable,
      odomTfAvailable: probe.tfAvailable,
      odomLiveProbeKnown: true,
      blockers,
      reason: ready ? '' : blockers.join('; '),
      poseOdomProbe: probe,
    }
  }

  const blockers = [
    ...(Array.isArray(readiness.blockers) ? readiness.blockers : []).filter((blocker) => !/(No publishers|no live odom|live odometry|readiness did not prove)/i.test(blocker)),
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
    const poseUrl = config.lidar?.poseUrl || buildTargetUrl(config.lidar?.baseUrl || '', config.lidar?.posePath || '/pose')
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
    const odom = body?.odom && typeof body.odom === 'object' ? body.odom : {}
    const publisherCount = Number(topic?.publisherCount ?? odom.publisherCount ?? 0)
    const messageAvailable = odom.messageAvailable === true || odom.sampleAvailable === true
    const tfAvailable = odom.tfAvailable === true
    const odomReady = response.ok && messageAvailable && tfAvailable

    return {
      checked: true,
      odomReady,
      odomTopic: '/odom',
      odomPublisherCount: Number.isFinite(publisherCount) ? publisherCount : 0,
      messageAvailable,
      tfAvailable,
      reason: odomReady ? '' : normalizeErrorText(odom.error) || buildOdomProbeReason({
        topic: '/odom',
        publisherCount: Number.isFinite(publisherCount) ? publisherCount : 0,
        messageAvailable,
        tfAvailable,
      }),
      poseUrl,
    }
  } catch (error) {
    return {
      checked: true,
      odomReady: false,
      odomTopic: '/odom',
      odomPublisherCount: 0,
      messageAvailable: false,
      tfAvailable: false,
      reason: formatFetchError(error),
    }
  }
}

function buildOdomProbeReason({ topic, publisherCount, messageAvailable, tfAvailable }) {
  if (publisherCount <= 0) {
    return `No publishers on ${topic}`
  }
  if (!messageAvailable) {
    return `${topic} has ${publisherCount} publisher(s), but no live odometry samples were received.`
  }
  if (!tfAvailable) {
    return `${topic} publishes samples, but odom->base_link/base_footprint TF is unavailable.`
  }
  return `Live odometry on ${topic} is not ready.`
}

function formatNumber(value) {
  return Number(value).toFixed(2)
}

function validateWaypointAgainstActiveMap(preview = {}, activeMap = null) {
  const params = preview.canonicalPlan?.params && typeof preview.canonicalPlan.params === 'object'
    ? preview.canonicalPlan.params
    : {}

  const identityValidation = validateWaypointMapIdentity(params, activeMap)
  if (!identityValidation.ok) {
    const waypoint = params.waypoint || 'waypoint'
    return {
      ready: false,
      status: identityValidation.reason || 'stale-map-identity',
      kind: 'map-waypoint',
      directControlAvailable: true,
      recovery: 'Use the current active SLAM map, then recapture the charger origin and waypoint so their map fingerprint matches before sending map navigation.',
      operatorMessage: `Waypoint not sent: ${waypoint} is tied to a stale or unknown map identity. Manual controls and non-waypoint actions are still available.`,
      error: `Waypoint blocked: ${identityValidation.message}`,
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
    repair,
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
