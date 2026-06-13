#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APP_MAP_FRAME,
  DEFAULT_MAP_ORIGIN_FILE,
  loadDogzillaMapOrigin,
} from '../lib/dogzilla-map-frame.mjs'
import { normalizeDogzillaMapMetadata } from '../lib/dogzilla-map-metadata.mjs'

const SCRIPT_FILE = fileURLToPath(import.meta.url)
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_FILE), '..')
const DEFAULT_WAYPOINT_FILE = path.join(ROOT_DIR, 'config', 'robot-waypoints.json')
const DEFAULT_CAPTURE_DIR = path.join(ROOT_DIR, 'output', 'app-cache', 'waypoint-captures')
const DEFAULT_POSE_URL = process.env.DOGZILLA_POSE_URL || 'http://10.0.4.32:8896/pose'
const DEFAULT_BRIDGE_HEALTH_URL = process.env.DOGZILLA_BRIDGE_HEALTH_URL || 'http://10.0.4.32:8893/healthz'

export function normalizeWaypointName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

export function poseToWaypoint(pose, {
  physicalSpot = '',
  arrivalToleranceMeters = 0.25,
  mapOrigin = null,
  mapMetadata = null,
} = {}) {
  const body = pose?.pose && typeof pose.pose === 'object' ? pose.pose : pose
  const frame = String(body?.frameId || body?.frame_id || body?.frame || '').trim()
  const source = String(body?.source || '').trim()
  const x = Number(body?.x)
  const y = Number(body?.y)
  const yaw = Number(body?.theta ?? body?.yaw)
  const capturedAt = new Date().toISOString()
  const map = frame === 'map' ? normalizeDogzillaMapMetadata(mapMetadata) : null

  if (!frame || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(yaw)) {
    throw new Error('pose payload missing finite frame/x/y/yaw')
  }

  return {
    kind: 'map_pose',
    frame,
    x,
    y,
    yaw,
    arrivalToleranceMeters,
    physicalSpot,
    verified: frame === 'map' && !!map?.fingerprint,
    capturedAt,
    capturedFrom: source || 'dogzilla pose bridge',
    ...(map?.id ? { mapId: map.id } : {}),
    ...(map?.fingerprint ? { mapFingerprint: map.fingerprint } : {}),
    ...(map ? {
      map: {
        id: map.id,
        fingerprint: map.fingerprint,
        savedAt: map.savedAt,
        yaml: map.yaml,
        pgm: map.pgm,
        pbstream: map.pbstream,
        resolution: map.resolution,
        origin: map.origin,
        bounds: map.bounds,
      },
    } : {}),
    ...(mapOrigin && frame === 'map' ? {
      mapOrigin: {
        label: mapOrigin.label,
        savedAt: mapOrigin.savedAt,
        displayOnly: true,
      },
    } : {}),
    notes: [
      `Captured from ${source || 'dogzilla pose bridge'} at ${capturedAt}.`,
      ...(frame === 'map' ? [`Captured map pose: x=${x}, y=${y}, yaw=${yaw}.`] : []),
      ...(map ? [`Captured map identity: id=${map.id || 'unknown'}, fingerprint=${map.fingerprint || 'unknown'}.`] : []),
      ...(mapOrigin && frame === 'map' ? [`Stored in raw map coordinates; saved ${APP_MAP_FRAME} origin is display-only.`] : []),
      'Use with command JSON: {"command":"move","waypoint":"<name>"}',
    ],
  }
}

export function upsertWaypoint(config, waypointName, waypoint) {
  const activeSet = config.activeSet || Object.keys(config.sets || {})[0] || 'home'
  config.activeSet = activeSet
  config.sets ||= {}
  config.sets[activeSet] ||= { defaultFrame: waypoint.frame || 'map', waypoints: {} }
  config.sets[activeSet].waypoints ||= {}
  config.sets[activeSet].waypoints[waypointName] = {
    ...(config.sets[activeSet].waypoints[waypointName] || {}),
    ...waypoint,
  }
  return config
}

export async function captureWaypoint({
  name,
  poseUrl = DEFAULT_POSE_URL,
  waypointFile = DEFAULT_WAYPOINT_FILE,
  captureDir = DEFAULT_CAPTURE_DIR,
  originFile = DEFAULT_MAP_ORIGIN_FILE,
  bridgeHealthUrl = DEFAULT_BRIDGE_HEALTH_URL,
  physicalSpot = '',
  arrivalToleranceMeters = 0.25,
  allowOdom = false,
  allowMissingMapIdentity = false,
} = {}) {
  const waypointName = normalizeWaypointName(name)
  if (!waypointName) {
    throw new Error('waypoint name is required')
  }

  const response = await fetch(poseUrl)
  const posePayload = await response.json()
  if (!response.ok || posePayload.ok === false) {
    throw new Error(posePayload.error || posePayload.message || `pose request failed: ${response.status}`)
  }

  const mapOrigin = await loadDogzillaMapOrigin(originFile)
  const mapMetadata = await loadActiveMapMetadata(bridgeHealthUrl)
  const waypoint = poseToWaypoint(posePayload, { physicalSpot, arrivalToleranceMeters, mapOrigin, mapMetadata })
  if (waypoint.frame !== 'map' && !allowOdom) {
    throw new Error(`refusing to save non-map pose frame "${waypoint.frame}"; rerun with --allow-odom for temporary targets`)
  }
  if (waypoint.frame === 'map' && !waypoint.mapFingerprint && !allowMissingMapIdentity) {
    throw new Error('refusing to capture map waypoint without active map identity; start DOGZILLA Direct Bridge or rerun with --allow-missing-map-identity')
  }

  const captureFile = path.join(captureDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${waypointName}.json`)
  await mkdir(captureDir, { recursive: true })
  await writeFile(captureFile, `${JSON.stringify({
    ok: true,
    waypointName,
    waypoint,
    sourceOfTruthFile: waypointFile,
    writePolicy: 'proposal-only; config/robot-waypoints.json is not overwritten by capture',
    mapIdentityRequired: !allowMissingMapIdentity,
  }, null, 2)}\n`, 'utf-8')

  return { waypointName, waypoint, waypointFile, captureFile }
}

async function loadActiveMapMetadata(bridgeHealthUrl) {
  if (!bridgeHealthUrl) {
    return null
  }

  const response = await fetch(bridgeHealthUrl)
  const body = await response.json()
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || body.message || `bridge health failed: ${response.status}`)
  }

  return body.runtime?.map || null
}

function parseArgs(argv) {
  const args = {
    poseUrl: DEFAULT_POSE_URL,
    waypointFile: DEFAULT_WAYPOINT_FILE,
    captureDir: DEFAULT_CAPTURE_DIR,
    originFile: DEFAULT_MAP_ORIGIN_FILE,
    bridgeHealthUrl: DEFAULT_BRIDGE_HEALTH_URL,
    arrivalToleranceMeters: 0.25,
    allowOdom: false,
    allowMissingMapIdentity: false,
    physicalSpot: '',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--pose-url') args.poseUrl = argv[++index]
    else if (token === '--file') args.waypointFile = path.resolve(argv[++index])
    else if (token === '--capture-dir') args.captureDir = path.resolve(argv[++index])
    else if (token === '--origin-file') args.originFile = path.resolve(argv[++index])
    else if (token === '--bridge-health-url') args.bridgeHealthUrl = argv[++index]
    else if (token === '--spot') args.physicalSpot = argv[++index]
    else if (token === '--tolerance') args.arrivalToleranceMeters = Number(argv[++index])
    else if (token === '--allow-odom') args.allowOdom = true
    else if (token === '--allow-missing-map-identity') args.allowMissingMapIdentity = true
    else if (!args.name) args.name = token
    else throw new Error(`unknown argument: ${token}`)
  }

  return args
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  captureWaypoint(parseArgs(process.argv.slice(2)))
    .then(({ waypointName, waypoint, waypointFile, captureFile }) => {
      console.log(JSON.stringify({
        ok: true,
        waypointName,
        waypoint,
        waypointFile,
        captureFile,
        writePolicy: 'proposal-only; config/robot-waypoints.json was not modified',
      }, null, 2))
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
