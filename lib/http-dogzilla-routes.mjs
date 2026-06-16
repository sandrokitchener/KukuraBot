import {
  ensureDogzillaRobotIdentity,
  getDogzillaConnectionCenter,
  runDogzillaConnectionAction,
  saveDogzillaAudioVolume,
  saveDogzillaConnectionConfig,
  saveDogzillaRobotName,
} from './dogzilla-connection-center.mjs'
import {
  getDogzillaAudioCueHealth,
  sendDogzillaAudioCue,
} from './dogzilla-audio-cue-client.mjs'
import {
  getDogzillaLidarDiagnostics,
  getDogzillaLidarHealth,
  getDogzillaLidarScan,
  getDogzillaMapData,
  getDogzillaRobotPose,
} from './dogzilla-lidar-client.mjs'
import {
  applyMapOriginToPose,
  buildDogzillaMapOriginSnapshot,
  loadDogzillaMapOrigin,
  saveDogzillaMapOriginFromPose,
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
import { getRobotSidecarHealth } from './robot-sidecar-client.mjs'
import { normalizeDogzillaMapMetadata } from './dogzilla-map-metadata.mjs'
import { validateDogzillaWaypointsFromFiles } from '../scripts/validate-dogzilla-waypoints.mjs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTES_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(ROUTES_DIR, '..')
const DEFAULT_WAYPOINT_FILE = path.join(ROOT_DIR, 'config', 'robot-waypoints.json')

export async function tryHandleDogzillaRoute({
  request,
  requestUrl,
  response,
  readJsonBody,
  sendJson,
  getDogzillaPoseTrack,
  validateDogzillaWaypointsFromFilesImpl = validateDogzillaWaypointsFromFiles,
  loadDogzillaMapOriginImpl = loadDogzillaMapOrigin,
  getRobotSidecarHealthImpl = getRobotSidecarHealth,
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
    const result = await runDogzillaConnectionAction(action, {
      live: body?.live === true,
    })
    const statusCode = result.status === 'error' ? 400 : 200
    return sendJson(response, statusCode, result)
  }

  if (method === 'POST' && pathname === '/api/dogzilla/preflight') {
    return sendJson(response, 200, await runDogzillaPreflight())
  }

  if (method === 'GET' && pathname === '/api/dogzilla/waypoint-readiness') {
    try {
      return sendJson(response, 200, await validateDogzillaWaypointsFromFilesImpl())
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
    return sendJson(response, 200, {
      ok: true,
      volume: config.audio.volume,
      audio: config.audio,
    })
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
    const result = await getDogzillaMapData()
    const statusCode = result.ok ? 200 : 502
    return sendJson(response, statusCode, result)
  }

  if (method === 'GET' && pathname === '/api/dogzilla/pose') {
    const result = await getDogzillaRobotPose()
    const statusCode = result.status === 'disabled' ? 404 : 200
    return sendJson(response, statusCode, result)
  }

  if (method === 'GET' && pathname === '/api/dogzilla/map-origin') {
    const origin = await loadDogzillaMapOriginImpl()
    return sendJson(response, 200, {
      ok: true,
      configured: !!origin,
      origin,
    })
  }

  if (method === 'POST' && pathname === '/api/dogzilla/map-origin/capture') {
    const body = await readJsonBody(request)
    const pose = await getDogzillaRobotPose()
    if (pose.status === 'disabled' || pose.ok === false) {
      return sendJson(response, 502, {
        ok: false,
        error: pose.error || 'DOGZILLA map pose unavailable',
        pose,
      })
    }

    const health = await getRobotSidecarHealthImpl().catch(() => null)
    const mapMetadata = normalizeDogzillaMapMetadata(health?.body?.runtime?.map)
    if (!mapMetadata?.available || !mapMetadata.id || !mapMetadata.fingerprint) {
      return sendJson(response, 502, {
        ok: false,
        error: 'DOGZILLA active map identity unavailable; refusing to save a charger origin that cannot be tied to the current saved map.',
        pose,
        map: mapMetadata,
      })
    }

    const origin = await saveDogzillaMapOriginFromPose(pose, {
      label: body?.label || 'home_origin',
      mapMetadata,
      requireMapIdentity: true,
    })
    return sendJson(response, 200, {
      ok: true,
      origin,
      map: mapMetadata,
    })
  }

  if (method === 'POST' && pathname === '/api/dogzilla/waypoints') {
    const body = await readJsonBody(request)
    const name = String(body?.name || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
    const label = String(body?.label || name || 'waypoint').trim()
    const arrivalToleranceMeters = Number(body?.arrivalToleranceMeters) || 0.25

    if (!name) {
      return sendJson(response, 400, { ok: false, error: 'Waypoint name is required' })
    }

    const pose = await getDogzillaRobotPose()
    if (!pose?.ok || !pose?.waypointSafe) {
      return sendJson(response, 502, {
        ok: false,
        error: pose?.error || 'Robot pose not waypoint-safe',
        pose,
      })
    }

    // Convert raw bridge pose to app_map frame for stable waypoints
    // across Cartographer restarts (same as capture-dogzilla-map-pose.mjs).
    const health = await getRobotSidecarHealthImpl().catch(() => null)
    const mapMetadata = normalizeDogzillaMapMetadata(health?.body?.runtime?.map)
    const origin = await loadDogzillaMapOriginImpl()
    const appPose = origin ? applyMapOriginToPose(pose, origin) : null
    const useAppMap = appPose && appPose.frame === 'app_map'
    const capturedAt = new Date().toISOString()
    const mapOriginSnapshot = useAppMap
      ? buildDogzillaMapOriginSnapshot({
        ...origin,
        ...(mapMetadata && !origin.map ? { map: mapMetadata } : {}),
      })
      : null

    const waypoint = {
      kind: 'map_pose',
      frame: useAppMap ? 'app_map' : (pose.frame || 'map'),
      x: Number(useAppMap ? appPose.x : pose.x),
      y: Number(useAppMap ? appPose.y : pose.y),
      yaw: Number(useAppMap ? appPose.yaw : (pose.theta ?? 0)),
      arrivalToleranceMeters,
      physicalSpot: label,
      verified: true,
      capturedAt,
      capturedFrom: pose.source || 'dogzilla pose bridge',
      ...(mapMetadata?.id ? { mapId: mapMetadata.id } : {}),
      ...(mapMetadata?.fingerprint ? { mapFingerprint: mapMetadata.fingerprint } : {}),
      ...(mapMetadata ? { map: mapMetadata } : {}),
      ...(mapOriginSnapshot ? { mapOrigin: mapOriginSnapshot } : {}),
      ...(useAppMap ? { capturedMapPose: appPose.mapFramePose } : {}),
      notes: [
        useAppMap
          ? `Captured from app at ${capturedAt} (app_map frame).`
          : `Captured from app at ${capturedAt}.`,
      ],
    }

    try {
      const raw = await readFile(waypointFile, 'utf-8')
      const config = JSON.parse(raw)
      const waypointSet = config.sets?.[config.activeSet] || config.sets?.home
      if (waypointSet?.waypoints) {
        waypointSet.waypoints[name] = waypoint
      }
      await writeFile(waypointFile, JSON.stringify(config, null, 2) + '\n', 'utf-8')
      return sendJson(response, 200, { ok: true, waypoint, name, file: waypointFile })
    } catch (error) {
      return sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to save waypoint',
      })
    }
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
