import {
  ensureDogzillaRobotIdentity,
  getDogzillaConnectionCenter,
  loadDogzillaConnectionConfig,
  probeDogzillaVisionHealth,
  runDogzillaConnectionAction,
  saveDogzillaAudioVolume,
  saveDogzillaConnectionConfig,
  saveDogzillaRobotName,
  setDogzillaVisionDetection,
} from './dogzilla-connection-center.mjs'
import {
  getDogzillaAudioCueHealth,
  sendDogzillaAudioCue,
  setDogzillaAudioCueVolume,
} from './dogzilla-audio-cue-client.mjs'
import {
  getDogzillaLidarDiagnostics,
  getDogzillaLidarHealth,
  getDogzillaLidarScan,
  getDogzillaMapData,
  getDogzillaRobotPose,
} from './dogzilla-lidar-client.mjs'
import {
  clearDogzillaMapOrigin,
  loadDogzillaMapOrigin,
} from './dogzilla-map-frame.mjs'
import {
  DOGZILLA_CAMERA_SNAPSHOT_PROXY_PATH,
  DOGZILLA_CAMERA_STATUS_PATH,
  DOGZILLA_CAMERA_STREAM_PROXY_PATH,
  getDogzillaCameraStatus,
  proxyDogzillaCameraStream,
  sendDogzillaCameraSnapshot,
} from './dogzilla-camera-proxy.mjs'
import { runDogzillaPreflight } from './dogzilla-preflight.mjs'
import { getDogzillaPiPerformance } from './dogzilla-pi-performance.mjs'
import { getRobotSidecarHealth } from './robot-sidecar-client.mjs'
import {
  normalizeDogzillaMapMetadata,
  normalizeDogzillaWaypointMapIdentity,
} from './dogzilla-map-metadata.mjs'
import {
  validateDogzillaWaypoints,
  validateDogzillaWaypointsFromFiles,
} from '../scripts/validate-dogzilla-waypoints.mjs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTES_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(ROUTES_DIR, '..')
const DEFAULT_WAYPOINT_FILE = path.join(ROOT_DIR, 'config', 'robot-waypoints.json')

async function writeWaypointConfig(file, config) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function tryHandleDogzillaRoute({
  request,
  requestUrl,
  response,
  readJsonBody,
  sendJson,
  getDogzillaPoseTrack,
  validateDogzillaWaypointsFromFilesImpl = validateDogzillaWaypointsFromFiles,
  loadDogzillaConnectionConfigImpl = loadDogzillaConnectionConfig,
  runDogzillaConnectionActionImpl = runDogzillaConnectionAction,
  probeDogzillaVisionHealthImpl = probeDogzillaVisionHealth,
  sendDogzillaAudioCueImpl = sendDogzillaAudioCue,
  saveDogzillaConnectionConfigImpl = saveDogzillaConnectionConfig,
  clearDogzillaMapOriginImpl = clearDogzillaMapOrigin,
  loadDogzillaMapOriginImpl = loadDogzillaMapOrigin,
  getDogzillaRobotPoseImpl = getDogzillaRobotPose,
  getDogzillaLidarHealthImpl = getDogzillaLidarHealth,
  getRobotSidecarHealthImpl = getRobotSidecarHealth,
  writeWaypointConfigImpl = writeWaypointConfig,
  waypointFile = DEFAULT_WAYPOINT_FILE,
}) {
  const { method } = request
  const { pathname } = requestUrl

  if (method === 'GET' && pathname === '/api/dogzilla/connection') {
    return sendJson(response, 200, await getDogzillaConnectionCenter())
  }

  if (method === 'POST' && pathname === '/api/dogzilla/connection') {
    const body = await readJsonBody(request)
    const config = await saveDogzillaConnectionConfig(body || {})
    let identity = null

    if (config.ssh.host) {
      identity = await ensureDogzillaRobotIdentity({ config })
    }

    return sendJson(response, 200, await getDogzillaConnectionCenter({ identity }))
  }

  if (method === 'POST' && pathname === '/api/dogzilla/identity') {
    const body = await readJsonBody(request)
    const robotName = typeof body?.robot_name === 'string' ? body.robot_name : body?.robotName

    try {
      const identity = await saveDogzillaRobotName(robotName)
      return sendJson(response, 200, {
        identity,
        connection: await getDogzillaConnectionCenter({ identity }),
      })
    } catch (error) {
      return sendJson(response, 400, {
        error: error instanceof Error ? error.message : 'Could not update robot name.',
      })
    }
  }

  if (method === 'POST' && pathname === '/api/dogzilla/connection/action') {
    const body = await readJsonBody(request)
    const action = typeof body?.action === 'string' ? body.action.trim() : ''
    const result = await runDogzillaConnectionActionImpl(action, {
      live: body?.live === true,
    })
    if (action === 'start-autonomous-mapping' && result.status !== 'error') {
      result.audioCue = await sendDogzillaAudioCueImpl('mapping-start').catch((error) => ({
        status: 'error',
        ok: false,
        cue: 'mapping-start',
        error: error instanceof Error ? error.message : String(error),
      }))
    }
    if (action === 'save-map-pose' && result.status !== 'error') {
      await clearDogzillaMapOriginImpl()
      result.mapOriginCleared = true
      const localization = await runDogzillaConnectionActionImpl('start-map-pose', {
        live: body?.live === true,
      })
      result.localization = localization
      if (localization.status === 'error') {
        result.status = 'error'
        result.error = localization.error || localization.stderr || 'DOGZILLA localization failed after map save.'
      } else {
        result.message = result.message
          ? `${result.message} Localization restarted without a charger-origin seed.`
          : 'Map saved and localization restarted without a charger-origin seed.'
      }
    }
    if (action === 'promote-map-candidate' && result.status !== 'error') {
      await clearDogzillaMapOriginImpl()
      result.mapOriginCleared = true
      const localization = await runDogzillaConnectionActionImpl('start-map-pose', { live: body?.live === true })
      const navigation = localization.status === 'error'
        ? null
        : await runDogzillaConnectionActionImpl('start-navigation', { live: body?.live === true })
      result.localization = localization
      result.navigation = navigation
      if (localization.status === 'error' || navigation?.status === 'error') {
        result.status = 'error'
        result.error = localization.error || navigation?.error || 'Candidate promoted but navigation restart failed.'
      }
    }
    const asyncMappingStart = (action === 'start-autonomous-mapping' || action === 'continue-autonomous-mapping')
      && result.status === 'started'
    const statusCode = result.status === 'error' ? 400 : asyncMappingStart ? 202 : 200
    return sendJson(response, statusCode, result)
  }

  if (method === 'POST' && pathname === '/api/dogzilla/preflight') {
    return sendJson(response, 200, await runDogzillaPreflight())
  }

  if (method === 'POST' && pathname === '/api/dogzilla/pi-performance') {
    const result = await getDogzillaPiPerformance()
    return sendJson(response, result.ok ? 200 : 502, result)
  }

  if (method === 'GET' && pathname === '/api/dogzilla/waypoint-readiness') {
    try {
      const [report, lidar, localization] = await Promise.all([
        validateDogzillaWaypointsFromFilesImpl(),
        getDogzillaLidarHealthImpl().catch((error) => sensorProbeFailure(error)),
        getDogzillaRobotPoseImpl().catch((error) => sensorProbeFailure(error)),
      ])
      return sendJson(response, 200, {
        ...report,
        sensors: { lidar, localization },
      })
    } catch (error) {
      return sendJson(response, 500, {
        ok: false,
        readyForMapWaypoints: false,
        blockers: [error instanceof Error ? error.message : 'DOGZILLA waypoint readiness unavailable'],
        error: error instanceof Error ? error.message : 'DOGZILLA waypoint readiness unavailable',
      })
    }
  }

  if (method === 'GET' && pathname === '/api/dogzilla/audio/health') {
    return sendJson(response, 200, await getDogzillaAudioCueHealth())
  }

  if (method === 'POST' && pathname === '/api/dogzilla/audio/cue') {
    const body = await readJsonBody(request)
    const result = await sendDogzillaAudioCue(body?.cue, { volume: body?.volume })
    const statusCode = result.ok ? 200 : result.status === 'invalid' ? 400 : 502
    return sendJson(response, statusCode, result)
  }

  if (method === 'POST' && pathname === '/api/dogzilla/audio/volume') {
    const body = await readJsonBody(request)
    const config = await saveDogzillaAudioVolume(body?.volume)
    const sidecarVolume = await setDogzillaAudioCueVolume(config.audio.volume, { config })
    return sendJson(response, 200, {
      ok: true,
      volume: config.audio.volume,
      audio: config.audio,
      sidecarVolume,
    })
  }

  if (method === 'POST' && pathname === '/api/dogzilla/vision/toggle') {
    const body = await readJsonBody(request)
    const desiredEnabled = typeof body?.enabled === 'boolean' ? body.enabled : undefined
    try {
      const currentConfig = await loadDogzillaConnectionConfigImpl()
      const nextEnabled = desiredEnabled !== undefined ? desiredEnabled : currentConfig.vision?.detectionEnabled !== true
      const result = await setDogzillaVisionDetection(nextEnabled, {
        loadConfigImpl: async () => currentConfig,
        runActionImpl: runDogzillaConnectionActionImpl,
        saveConfigImpl: saveDogzillaConnectionConfigImpl,
        probeHealthImpl: probeDogzillaVisionHealthImpl,
      })
      if (!result.ok) {
        return sendJson(response, 502, {
          ok: false,
          requestedEnabled: result.requestedEnabled,
          actualEnabled: result.actualEnabled,
          error: result.error,
        })
      }

      return sendJson(response, 200, {
        ok: true,
        enabled: result.actualEnabled,
        requestedEnabled: result.requestedEnabled,
        actualEnabled: result.actualEnabled,
        camera: result.camera,
        vision: result.vision,
        message: result.changed
          ? result.actualEnabled ? 'YOLO detection enabled.' : 'YOLO detection disabled. Using raw camera stream.'
          : result.actualEnabled ? 'YOLO detection is already enabled.' : 'YOLO detection is already disabled.',
      })
    } catch (error) {
      return sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not toggle YOLO vision.',
      })
    }
  }

  if (method === 'GET' && pathname === '/api/dogzilla/lidar/health') {
    return sendJson(response, 200, await getDogzillaLidarHealth())
  }

  if (method === 'GET' && pathname === '/api/dogzilla/lidar/scan') {
    const result = await getDogzillaLidarScan()
    const statusCode = result.ok ? 200 : result.status === 'disabled' ? 404 : 502
    return sendJson(response, statusCode, result)
  }

  if (method === 'GET' && pathname === '/api/dogzilla/map') {
    const stream = requestUrl.searchParams.get('stream') || ''
    const result = await getDogzillaMapData({ stream })
    const statusCode = result.ok ? 200 : 502
    return sendJson(response, statusCode, result)
  }

  if (method === 'GET' && pathname === '/api/dogzilla/pose') {
    const result = await getDogzillaRobotPose()
    const statusCode = result.status === 'disabled' ? 404 : 200
    return sendJson(response, statusCode, result)
  }

  if (method === 'POST' && pathname === '/api/dogzilla/waypoints') {
    const body = await readJsonBody(request)
    const name = String(body?.name || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
    const label = String(body?.label || name || 'waypoint').trim()
    const requestedTolerance = Number(body?.arrivalToleranceMeters)
    const arrivalToleranceMeters = Number.isFinite(requestedTolerance) && requestedTolerance > 0
      ? requestedTolerance
      : 0.25

    if (!name) {
      return sendJson(response, 400, { ok: false, error: 'Waypoint name is required' })
    }

    const explicitPose = body?.pose && typeof body.pose === 'object' ? body.pose : null
    const health = await getRobotSidecarHealthImpl().catch(() => null)
    const mapMetadata = normalizeDogzillaMapMetadata(health?.body?.runtime?.map)
    let pose
    if (explicitPose) {
      const x = Number(explicitPose.x)
      const y = Number(explicitPose.y)
      const theta = Number(explicitPose.yaw ?? explicitPose.theta)
      const frame = String(explicitPose.frame || 'map').replace(/^\/+/, '')
      const bounds = mapMetadata?.bounds
      const requestedMap = normalizeDogzillaWaypointMapIdentity({
        ...explicitPose,
        mapId: body.mapId ?? explicitPose.mapId,
        mapFingerprint: body.mapFingerprint ?? explicitPose.mapFingerprint,
        map: body.map ?? explicitPose.map,
      })
      if (frame !== 'map' || ![x, y, theta].every(Number.isFinite)
        || !mapMetadata?.available || !bounds || !mapMetadata.id || !mapMetadata.fingerprint
        || x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY
        || requestedMap.id !== mapMetadata.id
        || requestedMap.fingerprint !== mapMetadata.fingerprint) {
        return sendJson(response, 422, { ok: false, error: 'Explicit waypoint pose is not valid for the active map' })
      }
      pose = {
        ok: true,
        waypointSafe: true,
        frame,
        x,
        y,
        theta,
        mapId: requestedMap.id,
        mapFingerprint: requestedMap.fingerprint,
        source: 'explicit waypoint pose',
      }
    } else {
      pose = await getDogzillaRobotPoseImpl()
    }
    if (!pose?.ok || !pose?.waypointSafe) {
      return sendJson(response, 502, {
        ok: false,
        error: pose?.error || 'Robot pose not waypoint-safe',
        pose,
      })
    }

    const capturedAt = new Date().toISOString()

    const waypoint = {
      kind: 'map_pose',
      frame: pose.frame || 'map',
      x: Number(pose.x),
      y: Number(pose.y),
      yaw: Number(pose.theta ?? pose.yaw ?? 0),
      arrivalToleranceMeters,
      physicalSpot: label,
      verified: true,
      capturedAt,
      capturedFrom: pose.source || 'dogzilla pose bridge',
      ...(mapMetadata?.id ? { mapId: mapMetadata.id } : {}),
      ...(mapMetadata?.fingerprint ? { mapFingerprint: mapMetadata.fingerprint } : {}),
      ...(mapMetadata ? { map: mapMetadata } : {}),
      notes: [`Captured from app at ${capturedAt} in the active map frame.`],
    }

    let existingConfig = null
    try {
      existingConfig = JSON.parse(await readFile(waypointFile, 'utf-8'))
    } catch {
      existingConfig = null
    }

    const warnings = []
    const waypointSet = existingConfig?.sets?.[existingConfig.activeSet] || existingConfig?.sets?.home
    if (waypointSet?.waypoints) {
      for (const [otherName, other] of Object.entries(waypointSet.waypoints)) {
        if (otherName === name || other?.verified !== true || other?.kind !== 'map_pose') {
          continue
        }
        const otherPose = other.frame === 'map' ? other : other.capturedMapPose
        const dx = Number(otherPose?.x) - waypoint.x
        const dy = Number(otherPose?.y) - waypoint.y
        const d = Math.hypot(dx, dy)
        if (Number.isFinite(d) && d < 0.2) {
          warnings.push(
            `This waypoint is ${d.toFixed(2)}m from "${otherName}". `
            + 'Two waypoints this close usually means localization is stuck at the same wrong pose.',
          )
        }
      }
    }

    try {
      const raw = await readFile(waypointFile, 'utf-8')
      const config = JSON.parse(raw)
      const waypointSet = config.sets?.[config.activeSet] || config.sets?.home
      if (waypointSet?.waypoints) {
        waypointSet.waypoints[name] = waypoint
      }
      await writeWaypointConfigImpl(waypointFile, config)
      return sendJson(response, 200, { ok: true, waypoint, name, warnings, file: waypointFile })
    } catch (error) {
      return sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to save waypoint',
      })
    }
  }

  const waypointMutation = pathname.match(/^\/api\/dogzilla\/waypoints\/([^/]+)$/)
  if (waypointMutation && (method === 'PATCH' || method === 'DELETE')) {
    const currentName = decodeURIComponent(waypointMutation[1]).trim().toLowerCase().replace(/[\s-]+/g, '_')
    const raw = await readFile(waypointFile, 'utf-8')
    const config = JSON.parse(raw)
    const waypointSet = config.sets?.[config.activeSet] || config.sets?.home
    const waypoints = waypointSet?.waypoints
    const current = waypoints?.[currentName]

    if (!current) {
      return sendJson(response, 404, { ok: false, error: `Waypoint "${currentName}" not found` })
    }

    if (method === 'DELETE') {
      delete waypoints[currentName]
      await writeWaypointConfigImpl(waypointFile, config)
      return sendJson(response, 200, { ok: true, deleted: true, name: currentName, file: waypointFile })
    }

    const body = await readJsonBody(request)
    const nextName = String(body?.name || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
    if (!nextName) return sendJson(response, 400, { ok: false, error: 'Waypoint name is required' })
    if (nextName !== currentName && waypoints[nextName]) {
      return sendJson(response, 409, { ok: false, error: `Waypoint "${nextName}" already exists` })
    }

    if (nextName !== currentName) {
      waypoints[nextName] = current
      delete waypoints[currentName]
    }
    await writeWaypointConfigImpl(waypointFile, config)
    return sendJson(response, 200, { ok: true, renamed: nextName !== currentName, name: nextName, waypoint: current, file: waypointFile })
  }

  const revalidateMutation = pathname.match(/^\/api\/dogzilla\/waypoints\/([^/]+)\/revalidate$/)
  if (method === 'POST' && revalidateMutation) {
    const name = decodeURIComponent(revalidateMutation[1]).trim().toLowerCase().replace(/[\s-]+/g, '_')
    const config = JSON.parse(await readFile(waypointFile, 'utf-8'))
    const waypointSet = config.sets?.[config.activeSet] || config.sets?.home
    const waypoint = waypointSet?.waypoints?.[name]
    if (!waypoint) return sendJson(response, 404, { ok: false, error: `Waypoint "${name}" not found` })

    const health = await getRobotSidecarHealthImpl().catch(() => null)
    const mapMetadata = normalizeDogzillaMapMetadata(health?.body?.runtime?.map)
    if (!mapMetadata?.available || !mapMetadata.bounds) {
      return sendJson(response, 409, { ok: false, error: 'Current active map metadata is unavailable' })
    }

    const mapOrigin = await loadDogzillaMapOriginImpl().catch(() => null)
    const report = validateDogzillaWaypoints({
      waypointConfig: config,
      mapOrigin,
      mapMetadata,
      navigationReadiness: { ready: true },
    })
    const result = report.results.find((item) => item.name === name)
    if (!result || result.enabled !== true || result.ok !== true) {
      return sendJson(response, 409, {
        ok: false,
        error: result?.problems?.[0] || 'Waypoint does not validate against the current active map',
        result,
      })
    }

    waypoint.verified = true
    if (mapMetadata.id) waypoint.mapId = mapMetadata.id
    if (mapMetadata.fingerprint) waypoint.mapFingerprint = mapMetadata.fingerprint
    waypoint.map = mapMetadata
    await writeWaypointConfigImpl(waypointFile, config)
    return sendJson(response, 200, { ok: true, revalidated: true, name, waypoint, result, file: waypointFile })
  }

  if (method === 'GET' && pathname === '/api/dogzilla/pose/track') {
    const poses = getDogzillaPoseTrack()
    return sendJson(response, 200, {
      status: 'ok',
      frame: poses.at(-1)?.frame || 'map',
      waypointSafeOnly: true,
      poses,
    })
  }

  if (method === 'GET' && pathname === '/api/dogzilla/lidar/diagnostics') {
    return sendJson(response, 200, await getDogzillaLidarDiagnostics())
  }

  if (method === 'GET' && pathname === DOGZILLA_CAMERA_STATUS_PATH) {
    return sendJson(response, 200, await getDogzillaCameraStatus())
  }

  if (method === 'GET' && pathname === DOGZILLA_CAMERA_SNAPSHOT_PROXY_PATH) {
    return sendDogzillaCameraSnapshot(response)
  }

  if (method === 'GET' && pathname === DOGZILLA_CAMERA_STREAM_PROXY_PATH) {
    return proxyDogzillaCameraStream(response)
  }

  return false
}

function sensorProbeFailure(error) {
  return {
    ok: false,
    status: 'error',
    error: error instanceof Error ? error.message : String(error || 'Sensor probe failed'),
  }
}
