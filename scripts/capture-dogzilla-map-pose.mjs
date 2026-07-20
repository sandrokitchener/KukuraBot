#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getDogzillaRobotPose,
  startDogzillaLidarClient,
} from '../lib/dogzilla-lidar-client.mjs'
import { normalizeDogzillaMapMetadata } from '../lib/dogzilla-map-metadata.mjs'
import { getRobotSidecarHealth } from '../lib/robot-sidecar-client.mjs'

const SCRIPT_FILE = fileURLToPath(import.meta.url)
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_FILE), '..')
const DEFAULT_WAYPOINT_FILE = path.join(ROOT_DIR, 'config', 'robot-waypoints.json')
const DEFAULT_CAPTURE_DIR = path.join(ROOT_DIR, 'output', 'app-cache', 'waypoint-captures')

export function normalizeWaypointName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

export function poseToWaypoint(pose, {
  physicalSpot = '',
  arrivalToleranceMeters = 0.25,
  mapMetadata = null,
} = {}) {
  const body = pose?.pose && typeof pose.pose === 'object' ? pose.pose : pose
  const rawFrame = String(body?.frameId || body?.frame_id || body?.frame || '').trim()
  const source = String(body?.source || '').trim()
  const rawX = Number(body?.x)
  const rawY = Number(body?.y)
  const rawYaw = Number(body?.theta ?? body?.yaw)
  const capturedAt = new Date().toISOString()

  if (!rawFrame || !Number.isFinite(rawX) || !Number.isFinite(rawY) || !Number.isFinite(rawYaw)) {
    throw new Error('pose payload missing finite frame/x/y/yaw')
  }

  return {
    kind: 'map_pose',
    frame: rawFrame,
    x: rawX,
    y: rawY,
    yaw: rawYaw,
    arrivalToleranceMeters,
    physicalSpot,
    verified: rawFrame === 'map',
    capturedAt,
    capturedFrom: source || 'dogzilla rosbridge',
    ...(mapMetadata?.id ? { mapId: mapMetadata.id } : {}),
    ...(mapMetadata?.fingerprint ? { mapFingerprint: mapMetadata.fingerprint } : {}),
    ...(mapMetadata ? { map: mapMetadata } : {}),
    notes: [
      `Captured from ${source || 'dogzilla rosbridge'} at ${capturedAt} in ${rawFrame} frame.`,
      ...(mapMetadata?.id ? [`Captured map identity: id=${mapMetadata.id}.`] : []),
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
  waypointFile = DEFAULT_WAYPOINT_FILE,
  captureDir = DEFAULT_CAPTURE_DIR,
  physicalSpot = '',
  arrivalToleranceMeters = 0.25,
  allowOdom = false,
  allowMissingMapIdentity = false,
  poseTimeoutMs = 10_000,
  startDogzillaLidarClientImpl = startDogzillaLidarClient,
  getDogzillaRobotPoseImpl = getDogzillaRobotPose,
  getRobotSidecarHealthImpl = getRobotSidecarHealth,
} = {}) {
  const waypointName = normalizeWaypointName(name)
  if (!waypointName) {
    throw new Error('waypoint name is required')
  }

  await startDogzillaLidarClientImpl()
  const posePayload = await waitForMapPose(poseTimeoutMs, getDogzillaRobotPoseImpl)
  if (!posePayload.ok) {
    throw new Error(posePayload.error || 'pose not available')
  }

  const health = await getRobotSidecarHealthImpl().catch(() => null)
  const mapMetadata = normalizeDogzillaMapMetadata(health?.body?.runtime?.map)
  const waypoint = poseToWaypoint(posePayload, { physicalSpot, arrivalToleranceMeters, mapMetadata })
  if (waypoint.frame !== 'map' && !allowOdom) {
    throw new Error(`refusing to save non-map pose frame "${waypoint.frame}"; rerun with --allow-odom for temporary targets`)
  }
  if (waypoint.frame === 'map' && (!waypoint.mapId || !waypoint.mapFingerprint) && !allowMissingMapIdentity) {
    throw new Error('refusing to save map waypoint without active map identity')
  }

  const captureFile = path.join(captureDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${waypointName}.json`)
  await mkdir(captureDir, { recursive: true })
  await writeFile(captureFile, `${JSON.stringify({
    ok: true,
    waypointName,
    waypoint,
    mapIdentityRequired: !allowMissingMapIdentity,
    sourceOfTruthFile: waypointFile,
    writePolicy: 'proposal-only; config/robot-waypoints.json is not overwritten by capture',
  }, null, 2)}\n`, 'utf-8')

  return { waypointName, waypoint, waypointFile, captureFile }
}

async function waitForMapPose(timeoutMs, getDogzillaRobotPoseImpl = getDogzillaRobotPose) {
  const startedAt = Date.now()
  do {
    const pose = await getDogzillaRobotPoseImpl()
    if (pose.ok && pose.waypointSafe) {
      return pose
    }
    await sleep(250)
  } while (Date.now() - startedAt < timeoutMs)

  const last = await getDogzillaRobotPoseImpl()
  return last
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function parseArgs(argv) {
  const args = {
    waypointFile: DEFAULT_WAYPOINT_FILE,
    captureDir: DEFAULT_CAPTURE_DIR,
    arrivalToleranceMeters: 0.25,
    allowOdom: false,
    allowMissingMapIdentity: false,
    poseTimeoutMs: 10_000,
    physicalSpot: '',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--file') args.waypointFile = path.resolve(argv[++index])
    else if (token === '--capture-dir') args.captureDir = path.resolve(argv[++index])
    else if (token === '--spot') args.physicalSpot = argv[++index]
    else if (token === '--tolerance') args.arrivalToleranceMeters = Number(argv[++index])
    else if (token === '--allow-odom') args.allowOdom = true
    else if (token === '--allow-missing-map-identity') args.allowMissingMapIdentity = true
    else if (token === '--pose-timeout') args.poseTimeoutMs = Number(argv[++index])
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
