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
import {
  getDogzillaRobotPose,
  startDogzillaLidarClient,
} from '../lib/dogzilla-lidar-client.mjs'

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
  mapOrigin = null,
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

  let frame = rawFrame
  let x = rawX
  let y = rawY
  let yaw = rawYaw
  let capturedMapPose = null
  const mapOriginSnapshot = rawFrame === 'map' && mapOrigin
    ? buildDogzillaMapOriginSnapshot(mapOrigin)
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
    verified: rawFrame === 'map',
    capturedAt,
    capturedFrom: source || 'dogzilla rosbridge',
    ...(mapOriginSnapshot ? { mapOrigin: mapOriginSnapshot } : {}),
    ...(capturedMapPose ? { capturedMapPose } : {}),
    notes: [
      `Captured from ${source || 'dogzilla rosbridge'} at ${capturedAt}.`,
      ...(capturedMapPose ? [`Captured map pose: x=${capturedMapPose.x}, y=${capturedMapPose.y}, yaw=${capturedMapPose.yaw}.`] : []),
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
  waypointFile = DEFAULT_WAYPOINT_FILE,
  captureDir = DEFAULT_CAPTURE_DIR,
  originFile = DEFAULT_MAP_ORIGIN_FILE,
  physicalSpot = '',
  arrivalToleranceMeters = 0.25,
  allowOdom = false,
  poseTimeoutMs = 10_000,
} = {}) {
  const waypointName = normalizeWaypointName(name)
  if (!waypointName) {
    throw new Error('waypoint name is required')
  }

  await startDogzillaLidarClient()
  const posePayload = await waitForMapPose(poseTimeoutMs)
  if (!posePayload.ok) {
    throw new Error(posePayload.error || 'pose not available')
  }

  const mapOrigin = await loadDogzillaMapOrigin(originFile)
  const waypoint = poseToWaypoint(posePayload, { physicalSpot, arrivalToleranceMeters, mapOrigin })
  const effectiveFrame = waypoint.capturedMapPose?.frame || waypoint.frame
  if (effectiveFrame !== 'map' && !allowOdom) {
    throw new Error(`refusing to save non-map pose frame "${effectiveFrame}"; rerun with --allow-odom for temporary targets`)
  }

  const captureFile = path.join(captureDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${waypointName}.json`)
  await mkdir(captureDir, { recursive: true })
  await writeFile(captureFile, `${JSON.stringify({
    ok: true,
    waypointName,
    waypoint,
    sourceOfTruthFile: waypointFile,
    writePolicy: 'proposal-only; config/robot-waypoints.json is not overwritten by capture',
  }, null, 2)}\n`, 'utf-8')

  return { waypointName, waypoint, waypointFile, captureFile }
}

async function waitForMapPose(timeoutMs) {
  const startedAt = Date.now()
  do {
    const pose = await getDogzillaRobotPose()
    if (pose.ok && pose.waypointSafe) {
      return pose
    }
    await sleep(250)
  } while (Date.now() - startedAt < timeoutMs)

  const last = await getDogzillaRobotPose()
  return last
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function parseArgs(argv) {
  const args = {
    waypointFile: DEFAULT_WAYPOINT_FILE,
    captureDir: DEFAULT_CAPTURE_DIR,
    originFile: DEFAULT_MAP_ORIGIN_FILE,
    arrivalToleranceMeters: 0.25,
    allowOdom: false,
    poseTimeoutMs: 10_000,
    physicalSpot: '',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--file') args.waypointFile = path.resolve(argv[++index])
    else if (token === '--capture-dir') args.captureDir = path.resolve(argv[++index])
    else if (token === '--origin-file') args.originFile = path.resolve(argv[++index])
    else if (token === '--spot') args.physicalSpot = argv[++index]
    else if (token === '--tolerance') args.arrivalToleranceMeters = Number(argv[++index])
    else if (token === '--allow-odom') args.allowOdom = true
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
