#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildDogzillaMapOriginSnapshot,
  DEFAULT_MAP_ORIGIN_FILE,
  loadDogzillaMapOrigin,
  mapPoseToAppPose,
} from '../lib/dogzilla-map-frame.mjs'

const SCRIPT_FILE = fileURLToPath(import.meta.url)
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_FILE), '..')
const DEFAULT_WAYPOINT_FILE = path.join(ROOT_DIR, 'config', 'robot-waypoints.json')

export async function migrateMapFrameWaypoints({
  waypointFile = DEFAULT_WAYPOINT_FILE,
  originFile = DEFAULT_MAP_ORIGIN_FILE,
  dryRun = true,
} = {}) {
  const mapOrigin = await loadDogzillaMapOrigin(originFile)
  if (!mapOrigin) {
    return {
      ok: false,
      reason: 'no-map-origin',
      message: 'No DOGZILLA map origin found. Run set-dogzilla-map-origin.mjs first to save the current SLAM map origin.',
      migratedCount: 0,
      skippedCount: 0,
    }
  }

  const configRaw = await readFile(waypointFile, 'utf-8')
  const config = JSON.parse(configRaw)
  const activeSetId = config.activeSet || Object.keys(config.sets || {})[0]
  if (!activeSetId || !config.sets?.[activeSetId]?.waypoints) {
    return {
      ok: false,
      reason: 'no-waypoints-found',
      message: 'No waypoints found in the active set.',
      migratedCount: 0,
      skippedCount: 0,
    }
  }

  const waypoints = config.sets[activeSetId].waypoints
  const migrated = []
  const skipped = []

  for (const [name, wp] of Object.entries(waypoints)) {
    if (wp.kind !== 'map_pose' || wp.frame !== 'map') {
      skipped.push({ name, reason: wp.kind !== 'map_pose' ? 'not a map_pose' : `frame is already "${wp.frame}"` })
      continue
    }

    const x = Number(wp.x)
    const y = Number(wp.y)
    const yaw = Number(wp.yaw ?? wp.theta)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(yaw)) {
      skipped.push({ name, reason: 'invalid coordinates' })
      continue
    }

    if (x === 0 && y === 0) {
      skipped.push({ name, reason: 'zero coordinates (placeholder)' })
      continue
    }

    const appPose = mapPoseToAppPose({ frame: 'map', x, y, yaw }, mapOrigin)
    if (!appPose) {
      skipped.push({ name, reason: 'mapPoseToAppPose conversion failed' })
      continue
    }

    const oldCoords = { x: wp.x, y: wp.y, yaw: wp.yaw }

    wp.frame = 'app_map'
    wp.x = appPose.x
    wp.y = appPose.y
    wp.yaw = appPose.yaw
    wp.capturedMapPose = { frame: 'map', x: oldCoords.x, y: oldCoords.y, yaw: oldCoords.yaw }
    wp.mapOrigin = buildDogzillaMapOriginSnapshot(mapOrigin)
    wp.verified = false
    wp.notes = wp.notes || []
    wp.notes.push(`Migrated from map frame at ${new Date().toISOString()}. Capture origin: x=${mapOrigin.x}, y=${mapOrigin.y}, yaw=${mapOrigin.yaw}. RECAPTURE REQUIRED if SLAM origin has changed since original capture.`)

    migrated.push({
      name,
      oldFrame: 'map',
      oldCoords,
      newFrame: 'app_map',
      newCoords: { x: appPose.x, y: appPose.y, yaw: appPose.yaw },
    })
  }

  if (!dryRun && migrated.length > 0) {
    const backupPath = waypointFile.replace(/\.json$/, `.map-frame-backup.${Date.now()}.json`)
    await mkdir(path.dirname(backupPath), { recursive: true })
    await writeFile(backupPath, configRaw, 'utf-8')

    config.sets[activeSetId].waypoints = waypoints
    await writeFile(waypointFile, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')

    return {
      ok: true,
      dryRun: false,
      backupPath,
      migratedCount: migrated.length,
      skippedCount: skipped.length,
      migrated,
      skipped,
      origin: { x: mapOrigin.x, y: mapOrigin.y, yaw: mapOrigin.yaw, label: mapOrigin.label },
    }
  }

  return {
    ok: true,
    dryRun,
    migratedCount: migrated.length,
    skippedCount: skipped.length,
    migrated,
    skipped,
    origin: { x: mapOrigin.x, y: mapOrigin.y, yaw: mapOrigin.yaw, label: mapOrigin.label },
    preview: 'Run with --no-dry-run to apply.',
  }
}

function parseArgs(argv) {
  const args = {
    waypointFile: DEFAULT_WAYPOINT_FILE,
    originFile: DEFAULT_MAP_ORIGIN_FILE,
    dryRun: true,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--file') args.waypointFile = path.resolve(argv[++index])
    else if (token === '--origin-file') args.originFile = path.resolve(argv[++index])
    else if (token === '--no-dry-run') args.dryRun = false
    else throw new Error(`unknown argument: ${token}`)
  }

  return args
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  migrateMapFrameWaypoints(parseArgs(process.argv.slice(2)))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) {
        process.exitCode = 1
      }
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
