#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadDogzillaMapOrigin,
  DEFAULT_MAP_ORIGIN_FILE,
  getDogzillaMapOriginStatus,
} from '../lib/dogzilla-map-frame.mjs'
import { getDogzillaWaypointNavigationReadiness } from '../lib/dogzilla-navigation-readiness.mjs'
import {
  normalizeDogzillaMapMetadata,
  validatePoseInsideDogzillaMap,
  validateWaypointMapIdentity,
} from '../lib/dogzilla-map-metadata.mjs'
import { compileRobotRuntimePreview } from '../lib/robot-command-compiler.mjs'
import { normalizeRobotWaypointsConfig } from '../lib/isaacsim-config.mjs'

const SCRIPT_FILE = fileURLToPath(import.meta.url)
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_FILE), '..')
const DEFAULT_WAYPOINT_FILE = path.join(ROOT_DIR, 'config', 'robot-waypoints.json')
const DEFAULT_BRIDGE_HEALTH_URL = process.env.DOGZILLA_BRIDGE_HEALTH_URL || 'http://10.0.4.32:8893/healthz'

export async function validateDogzillaWaypointsFromFiles({
  waypointFile = DEFAULT_WAYPOINT_FILE,
  originFile = DEFAULT_MAP_ORIGIN_FILE,
  bridgeHealthUrl = DEFAULT_BRIDGE_HEALTH_URL,
  fetchBridgeHealth = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  const waypointConfig = normalizeRobotWaypointsConfig(JSON.parse(await readFile(waypointFile, 'utf-8')))
  const mapOrigin = await loadDogzillaMapOrigin(originFile)
  const mapResult = fetchBridgeHealth
    ? await loadActiveMapMetadata(bridgeHealthUrl, fetchImpl)
    : { map: null, error: 'bridge health lookup skipped' }

  return validateDogzillaWaypoints({
    waypointConfig,
    waypointFile,
    mapOrigin,
    mapMetadata: mapResult.map,
    mapError: mapResult.error,
    bridgeHealth: mapResult.health,
    bridgeHealthUrl: fetchBridgeHealth ? bridgeHealthUrl : '',
  })
}

export function validateDogzillaWaypoints({
  waypointConfig = {},
  waypointFile = '',
  mapOrigin = null,
  mapMetadata = null,
  mapError = '',
  bridgeHealth = null,
  navigationReadiness = null,
  bridgeHealthUrl = '',
} = {}) {
  const normalizedConfig = normalizeRobotWaypointsConfig(waypointConfig)
  const activeSetId = normalizedConfig.activeSet || Object.keys(normalizedConfig.sets)[0] || ''
  const activeSet = normalizedConfig.sets?.[activeSetId] || {}
  const waypoints = activeSet.waypoints && typeof activeSet.waypoints === 'object'
    ? activeSet.waypoints
    : {}
  const normalizedMap = normalizeDogzillaMapMetadata(mapMetadata)
    || normalizeDogzillaMapMetadata(mapOrigin?.map)
  const results = Object.entries(waypoints).map(([name, definition]) => {
    return validateOneWaypoint({
      name,
      definition,
      waypointConfig: normalizedConfig,
      mapOrigin,
      mapMetadata: normalizedMap,
    })
  })

  const navigable = results.filter((result) => result.kind === 'map_pose')
  const invalid = navigable.filter((result) => result.ok === false)
  const ready = navigable.filter((result) => result.enabled !== false && result.status === 'ready')
  const disabled = navigable.filter((result) => result.enabled === false)
  const semantic = results.filter((result) => result.kind === 'special')
  const requiresMapOrigin = navigable.some((result) => result.frame === 'app_map')
  const navigation = navigationReadiness || getDogzillaWaypointNavigationReadiness(bridgeHealth?.runtime || {})
  const mapOriginStatus = getDogzillaMapOriginStatus(mapOrigin, normalizedMap)
  const readinessBlockers = buildReadinessBlockers({
    navigation,
    mapOriginStatus,
    requiresMapOrigin,
    readyCount: ready.length,
    invalidCount: invalid.length,
  })
  const readyForMapWaypoints = navigation.ready
    && (!requiresMapOrigin || mapOriginStatus.configured)
    && ready.length > 0
    && invalid.length === 0

  return {
    ok: invalid.length === 0,
    readyForMapWaypoints,
    blockers: readinessBlockers,
    sourceOfTruthFile: waypointFile,
    writePolicy: 'read-only; config/robot-waypoints.json is never overwritten by this validator',
    activeSet: activeSetId,
    bridgeHealthUrl,
    map: normalizedMap,
    mapError,
    mapOrigin: mapOriginStatus,
    navigation: {
      ready: navigation.ready,
      actionAvailable: navigation.actionAvailable,
      odomReady: navigation.odomReady,
      odomTopic: navigation.odomTopic,
      odomPublisherCount: navigation.odomPublisherCount,
      odomMessageAvailable: navigation.odomMessageAvailable,
      odomTfAvailable: navigation.odomTfAvailable,
      odomLiveProbeKnown: navigation.odomLiveProbeKnown,
      lifecycleActive: navigation.lifecycleActive,
      lifecycleKnown: navigation.lifecycleKnown,
      lifecycleNodes: navigation.lifecycleNodes,
      scanReady: navigation.scanReady,
      scanTopic: navigation.scanTopic,
      scanPublisherCount: navigation.scanPublisherCount,
      scanSubscriptionCount: navigation.scanSubscriptionCount,
      scanLiveProbeKnown: navigation.scanLiveProbeKnown,
      blockers: navigation.blockers,
      reason: navigation.reason,
    },
    summary: {
      total: results.length,
      navigable: navigable.length,
      ready: ready.length,
      disabled: disabled.length,
      invalid: invalid.length,
      semantic: semantic.length,
    },
    results,
  }
}

function buildReadinessBlockers({
  navigation,
  mapOriginStatus,
  requiresMapOrigin,
  readyCount,
  invalidCount,
}) {
  const blockers = []
  if (!navigation?.ready) {
    blockers.push(`navigation not ready: ${navigation?.reason || 'Nav2 waypoint readiness unknown'}`)
  }
  if (requiresMapOrigin && !mapOriginStatus?.configured) {
    blockers.push(`map origin not ready: ${mapOriginStatus?.status || 'unknown'}`)
  }
  if (invalidCount > 0) {
    blockers.push(`${invalidCount} invalid map waypoint(s) in source of truth`)
  }
  if (readyCount < 1) {
    blockers.push('no ready map waypoints in source of truth')
  }
  return blockers
}

function validateOneWaypoint({
  name,
  definition = {},
  waypointConfig = {},
  mapOrigin = null,
  mapMetadata = null,
}) {
  const base = {
    name,
    kind: String(definition?.kind || ''),
    frame: String(definition?.frame || ''),
    verified: definition?.verified === true,
    x: definition?.x,
    y: definition?.y,
    yaw: definition?.yaw,
  }

  if (definition?.kind === 'special') {
    return {
      ...base,
      ok: true,
      status: 'semantic',
      problems: [],
    }
  }

  if (definition?.verified !== true) {
    return {
      ...base,
      ok: true,
      enabled: false,
      status: 'disabled-by-config',
      problems: ['not verified by config'],
    }
  }

  const preview = compileRobotRuntimePreview({
    source: {
      parsed: {
        command: 'move',
        waypoint: name,
      },
    },
    runtimeConfig: {},
    ros2Config: {},
    waypointConfig,
    actionConfig: {},
    motionConfig: {},
    mapOrigin,
  })

  const problems = [
    ...preview.warnings,
    ...(preview.missingRequired || []).map((field) => `Missing required ${field}.`),
  ]

  const candidatePose = extractMapCheckPose(preview, definition)
  const earlyMapCheck = candidatePose
    ? validatePoseInsideDogzillaMap(candidatePose, mapMetadata)
    : null
  const earlyIdentityCheck = candidatePose
    ? validateWaypointMapIdentity(definition, mapMetadata)
    : null
  const earlyMapProblems = earlyMapCheck && !earlyMapCheck.ok
    ? [earlyMapCheck.message]
    : []
  const earlyIdentityProblems = earlyIdentityCheck && !earlyIdentityCheck.ok
    ? [earlyIdentityCheck.message]
    : []
  const earlyMapFailure = earlyMapCheck && !earlyMapCheck.ok
    ? {
      reason: earlyMapCheck.reason,
      message: earlyMapCheck.message,
    }
    : null
  const earlyIdentityFailure = earlyIdentityCheck && !earlyIdentityCheck.ok
    ? {
      reason: earlyIdentityCheck.reason,
      message: earlyIdentityCheck.message,
    }
    : null

  if (preview.status !== 'ready') {
    return {
      ...base,
      enabled: false,
      ok: false,
      status: preview.status,
      problems: [
        ...problems,
        ...earlyMapProblems,
        ...earlyIdentityProblems,
      ],
      ...(candidatePose ? { compiledPose: candidatePose } : {}),
      ...(earlyMapFailure ? { mapCheck: earlyMapFailure } : {}),
      ...(earlyIdentityFailure ? { mapIdentityCheck: earlyIdentityFailure } : {}),
    }
  }

  const params = preview.canonicalPlan?.params || {}
  const identityCheck = validateWaypointMapIdentity(params, mapMetadata)

  const mapCheck = validatePoseInsideDogzillaMap({
    frame: params.frame,
    x: params.x,
    y: params.y,
    yaw: params.yaw,
  }, mapMetadata)

  const advisoryProblems = [
    ...(!identityCheck.ok ? [identityCheck.message] : []),
    ...(!mapCheck.ok ? [mapCheck.message] : []),
  ]

  return {
    ...base,
    enabled: true,
    ok: true,
    status: 'ready',
    compiledPose: {
      frame: params.frame,
      x: params.x,
      y: params.y,
      yaw: params.yaw,
    },
    problems,
    advisoryProblems,
    mapCheck: {
      reason: mapCheck.ok ? 'inside-active-map' : mapCheck.reason,
      message: mapCheck.ok ? 'waypoint target is inside active map bounds' : mapCheck.message,
    },
    mapIdentityCheck: {
      reason: identityCheck.reason,
      message: identityCheck.message,
    },
  }
}

function extractMapCheckPose(preview, definition = {}) {
  const params = preview?.canonicalPlan?.params
  if (params?.frame) {
    return {
      frame: params.frame,
      x: params.x,
      y: params.y,
      yaw: params.yaw,
    }
  }

  const frame = String(definition.frame || 'map').trim()
  const x = Number(definition.x)
  const y = Number(definition.y)
  const yaw = Number(definition.yaw)
  if (frame !== 'map' || ![x, y, yaw].every(Number.isFinite)) {
    return null
  }

  return { frame, x, y, yaw }
}

async function loadActiveMapMetadata(bridgeHealthUrl, fetchImpl) {
  if (!bridgeHealthUrl) {
    return { map: null, error: 'bridge health URL is empty' }
  }

  if (typeof fetchImpl !== 'function') {
    return { map: null, error: 'fetch is unavailable' }
  }

  try {
    const response = await fetchImpl(bridgeHealthUrl)
    const body = await response.json()
    if (!response.ok || body.ok === false) {
      return { map: null, health: body, error: body.error || body.message || `bridge health failed: ${response.status}` }
    }
    return { map: body.runtime?.map || null, health: body, error: '' }
  } catch (error) {
    return { map: null, health: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function parseArgs(argv) {
  const args = {
    waypointFile: DEFAULT_WAYPOINT_FILE,
    originFile: DEFAULT_MAP_ORIGIN_FILE,
    bridgeHealthUrl: DEFAULT_BRIDGE_HEALTH_URL,
    fetchBridgeHealth: true,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--file') args.waypointFile = path.resolve(argv[++index])
    else if (token === '--origin-file') args.originFile = path.resolve(argv[++index])
    else if (token === '--bridge-health-url') args.bridgeHealthUrl = argv[++index]
    else if (token === '--no-bridge') args.fetchBridgeHealth = false
    else throw new Error(`unknown argument: ${token}`)
  }

  return args
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  validateDogzillaWaypointsFromFiles(parseArgs(process.argv.slice(2)))
    .then((report) => {
      console.log(JSON.stringify(report, null, 2))
      if (!report.ok) {
        process.exitCode = 1
      }
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
