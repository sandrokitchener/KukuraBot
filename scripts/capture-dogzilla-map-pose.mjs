#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APP_MAP_FRAME,
  DEFAULT_MAP_ORIGIN_FILE,
  loadDogzillaMapOrigin,
  mapPoseToAppPose,
} from '../lib/dogzilla-map-frame.mjs'

const SCRIPT_FILE = fileURLToPath(import.meta.url)
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_FILE), '..')
const DEFAULT_WAYPOINT_FILE = path.join(ROOT_DIR, 'config', 'robot-waypoints.json')
const DEFAULT_POSE_URL = process.env.DOGZILLA_POSE_URL || 'http://10.0.4.32:8896/pose'

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
  const appPose = mapOrigin ? mapPoseToAppPose(body, mapOrigin) : null
  const sourceBody = appPose || body
  const frame = String(body?.frameId || body?.frame_id || body?.frame || '').trim()
  const source = String(body?.source || '').trim()
  const waypointFrame = appPose?.frame || frame
  const x = Number(sourceBody?.x)
  const y = Number(sourceBody?.y)
  const yaw = Number(sourceBody?.theta ?? sourceBody?.yaw)

  if (!waypointFrame || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(yaw)) {
    throw new Error('pose payload missing finite frame/x/y/yaw')
  }

  return {
    kind: 'map_pose',
    frame: waypointFrame,
    x,
    y,
    yaw,
    arrivalToleranceMeters,
    physicalSpot,
    verified: frame === 'map',
    ...(appPose ? {
      sourceFrame: 'map',
      mapOrigin: {
        label: appPose.originLabel,
        savedAt: appPose.originSavedAt,
      },
    } : {}),
    notes: [
      `Captured from ${source || 'dogzilla pose bridge'} at ${new Date().toISOString()}.`,
      ...(appPose ? [`Stored relative to saved ${APP_MAP_FRAME} origin.`] : []),
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
  originFile = DEFAULT_MAP_ORIGIN_FILE,
  physicalSpot = '',
  arrivalToleranceMeters = 0.25,
  allowOdom = false,
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
  const waypoint = poseToWaypoint(posePayload, { physicalSpot, arrivalToleranceMeters, mapOrigin })
  if (waypoint.frame !== 'map' && waypoint.frame !== APP_MAP_FRAME && !allowOdom) {
    throw new Error(`refusing to save non-map pose frame "${waypoint.frame}"; rerun with --allow-odom for temporary targets`)
  }

  const config = JSON.parse(await readFile(waypointFile, 'utf-8'))
  upsertWaypoint(config, waypointName, waypoint)
  await writeFile(waypointFile, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')

  return { waypointName, waypoint, waypointFile }
}

function parseArgs(argv) {
  const args = {
    poseUrl: DEFAULT_POSE_URL,
    waypointFile: DEFAULT_WAYPOINT_FILE,
    originFile: DEFAULT_MAP_ORIGIN_FILE,
    arrivalToleranceMeters: 0.25,
    allowOdom: false,
    physicalSpot: '',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--pose-url') args.poseUrl = argv[++index]
    else if (token === '--file') args.waypointFile = path.resolve(argv[++index])
    else if (token === '--origin-file') args.originFile = path.resolve(argv[++index])
    else if (token === '--spot') args.physicalSpot = argv[++index]
    else if (token === '--tolerance') args.arrivalToleranceMeters = Number(argv[++index])
    else if (token === '--allow-odom') args.allowOdom = true
    else if (!args.name) args.name = token
    else throw new Error(`unknown argument: ${token}`)
  }

  return args
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  captureWaypoint(parseArgs(process.argv.slice(2)))
    .then(({ waypointName, waypoint, waypointFile }) => {
      console.log(JSON.stringify({ ok: true, waypointName, waypoint, waypointFile }, null, 2))
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
