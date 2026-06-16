#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APP_MAP_FRAME,
  buildDogzillaMapOriginSnapshot,
  DEFAULT_MAP_ORIGIN_FILE,
  loadDogzillaMapOrigin,
  mapPoseToAppPose,
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
  const rawFrame = String(body?.frameId || body?.frame_id || body?.frame || '').trim()
  const source = String(body?.source || '').trim()
  const rawX = Number(body?.x)
  const rawY = Number(body?.y)
  const rawYaw = Number(body?.theta ?? body?.yaw)
  const capturedAt = new Date().toISOString()
  const map = rawFrame === 'map' ? normalizeDogzillaMapMetadata(mapMetadata) : null

  if (!rawFrame || !Number.isFinite(rawX) || !Number.isFinite(rawY) || !Number.isFinite(rawYaw)) {
    throw new Error('pose payload missing finite frame/x/y/yaw')
  }

  let frame = rawFrame
  let x = rawX
  let y = rawY
  let yaw = rawYaw
  let capturedMapPose = null
  const mapOriginSnapshot = rawFrame === 'map' && mapOrigin
    ? buildDogzillaMapOriginSnapshot({
      ...mapOrigin,
      ...(map && !mapOrigin.map ? { map } : {}),
    })
    : null

  if (rawFrame === 'map' && mapOrigin) {
    const appPose = mapPoseToAppPose({ frame: 'map', x: rawX, y: rawY, yaw: rawYaw }, mapOrigin)
    if (appPose) {
      capturedMapPose = { frame: 'map', x: rawX, y: rawY, yaw: rawYaw }
      frame = appPose.frame
      x = appPose.x
      y = appPose.y
      yaw = appPose.yaw
    }
  }

  return {
    kind: 'map_pose',
    frame,
    x,
    y,
    yaw,
    arrivalToleranceMeters,
    physicalSpot,
    verified: rawFrame === 'map' && !!map?.fingerprint,
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
    ...(mapOriginSnapshot ? { mapOrigin: mapOriginSnapshot } : {}),
    ...(capturedMapPose ? { capturedMapPose } : {}),
    notes: [
      `Captured from ${source || 'dogzilla pose bridge'} at ${capturedAt}.`,
      ...(capturedMapPose ? [`Captured map pose: x=${capturedMapPose.x}, y=${capturedMapPose.y}, yaw=${capturedMapPose.yaw}.`] : []),
      ...(map ? [`Captured map identity: id=${map.id || 'unknown'}, fingerprint=${map.fingerprint || 'unknown'}.`] : []),
      ...(frame === APP_MAP_FRAME ? [`Stored in ${APP_MAP_FRAME} frame; stable across Cartographer origin shifts.`] : []),
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
  const effectiveFrame = waypoint.capturedMapPose?.frame || waypoint.frame
  if (effectiveFrame !== 'map' && !allowOdom) {
    throw new Error(`refusing to save non-map pose frame "${effectiveFrame}"; rerun with --allow-odom for temporary targets`)
  }
  if (effectiveFrame === 'map' && !waypoint.mapFingerprint && !allowMissingMapIdentity) {
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
