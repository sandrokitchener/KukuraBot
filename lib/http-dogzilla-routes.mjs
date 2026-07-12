import {
  ensureDogzillaRobotIdentity,
  getDogzillaConnectionCenter,
  loadDogzillaConnectionConfig,
  runDogzillaConnectionAction,
  saveDogzillaAudioVolume,
  saveDogzillaConnectionConfig,
  saveDogzillaRobotName,
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
  applyMapOriginToPose,
  buildDogzillaMapOriginSnapshot,
  clearDogzillaMapOrigin,
  getDogzillaMapOriginStatus,
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
import { getDogzillaPiPerformance } from './dogzilla-pi-performance.mjs'
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
  loadDogzillaConnectionConfigImpl = loadDogzillaConnectionConfig,
  runDogzillaConnectionActionImpl = runDogzillaConnectionAction,
  saveDogzillaConnectionConfigImpl = saveDogzillaConnectionConfig,
  clearDogzillaMapOriginImpl = clearDogzillaMapOrigin,
  loadDogzillaMapOriginImpl = loadDogzillaMapOrigin,
  getDogzillaRobotPoseImpl = getDogzillaRobotPose,
  getDogzillaLidarHealthImpl = getDogzillaLidarHealth,
  getRobotSidecarHealthImpl = getRobotSidecarHealth,
  mapOriginFile,
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
        const pose = await waitForDogzillaMapPose(getDogzillaRobotPoseImpl)
        const health = await getRobotSidecarHealthImpl().catch(() => null)
        const mapMetadata = normalizeDogzillaMapMetadata(health?.body?.runtime?.map)
        const origin = await saveDogzillaMapOriginFromPose(pose, {
          originFile: mapOriginFile,
          label: body?.originLabel || 'charger_origin',
          mapMetadata,
          requireMapIdentity: false,
        })
        result.origin = origin
        result.message = result.message
          ? `${result.message} Localization restarted and origin captured.`
          : 'Map saved, localization restarted, and origin captured.'
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
    const statusCode = result.status === 'error' ? 400 : 200
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
      const currentEnabled = currentConfig.vision?.detectionEnabled === true
      const nextEnabled = desiredEnabled !== undefined ? desiredEnabled : !currentEnabled

      if (nextEnabled === currentEnabled) {
        return sendJson(response, 200, {
          ok: true,
          enabled: currentEnabled,
          camera: currentConfig.camera,
          vision: currentConfig.vision,
          message: nextEnabled ? 'YOLO detection is already enabled.' : 'YOLO detection is already disabled.',
        })
      }

      const startResult = await runDogzillaConnectionActionImpl('start-yolo', {
        live: true,
        detectionEnabled: nextEnabled,
      })
      if (startResult.status === 'error') {
        return sendJson(response, 502, {
          ok: false,
          error: startResult.error || startResult.stderr || 'Could not restart DOGZILLA camera stream.',
        })
      }

      const updatedConfig = await saveDogzillaConnectionConfigImpl({
        vision: { enabled: true, detectionEnabled: nextEnabled },
      })

      return sendJson(response, 200, {
        ok: true,
        enabled: nextEnabled,
        camera: updatedConfig.camera,
        vision: updatedConfig.vision,
        message: nextEnabled ? 'YOLO detection enabled.' : 'YOLO detection disabled. Using raw camera stream.',
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
    const pose = await getDogzillaRobotPoseImpl()
    if (pose.status === 'disabled' || pose.ok === false) {
      return sendJson(response, 502, {
        ok: false,
        error: pose.error || 'DOGZILLA map pose unavailable',
        pose,
      })
    }

    const origin = await saveDogzillaMapOriginFromPose(pose, {
      label: body?.label || 'home_origin',
      requireMapIdentity: false,
    })
    return sendJson(response, 200, {
      ok: true,
      origin,
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

    const pose = await getDogzillaRobotPoseImpl()
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
    const originStatus = getDogzillaMapOriginStatus(origin, mapMetadata)
    const appPose = originStatus.configured ? applyMapOriginToPose(pose, origin) : null
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
        ...(origin && !originStatus.configured
          ? [`Saved map origin was ${originStatus.status}; captured raw map pose instead of stale app_map coordinates.`]
          : []),
      ],
    }

    let existingConfig = null
    try {
      existingConfig = JSON.parse(await readFile(waypointFile, 'utf-8'))
    } catch {
      existingConfig = null
    }

    const warnings = []
    if (useAppMap && originStatus.configured) {
      const distanceFromOrigin = Math.hypot(waypoint.x, waypoint.y)
      if (distanceFromOrigin < 0.3) {
        warnings.push(
          `Captured pose is only ${distanceFromOrigin.toFixed(2)}m from the map origin. `
          + 'If localization is lost, this waypoint is probably wrong. Verify on the minimap before using.',
        )
      }

      const waypointSet = existingConfig?.sets?.[existingConfig.activeSet] || existingConfig?.sets?.home
      if (waypointSet?.waypoints) {
        for (const [otherName, other] of Object.entries(waypointSet.waypoints)) {
          if (otherName === name || other?.verified !== true || other?.kind !== 'map_pose') {
            continue
          }
          const dx = Number(other.x ?? 0) - waypoint.x
          const dy = Number(other.y ?? 0) - waypoint.y
          const d = Math.hypot(dx, dy)
          if (d < 0.2) {
            warnings.push(
              `This waypoint is ${d.toFixed(2)}m from "${otherName}". `
              + 'Two waypoints this close usually means localization is stuck at the same wrong pose.',
            )
          }
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
      await writeFile(waypointFile, JSON.stringify(config, null, 2) + '\n', 'utf-8')
      return sendJson(response, 200, { ok: true, waypoint, name, warnings, file: waypointFile })
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

function sensorProbeFailure(error) {
  return {
    ok: false,
    status: 'error',
    error: error instanceof Error ? error.message : String(error || 'Sensor probe failed'),
  }
}

async function waitForDogzillaMapPose(getDogzillaRobotPoseImpl, {
  attempts = 15,
  intervalMs = 2000,
} = {}) {
  let lastPose = null
  for (let index = 0; index < attempts; index += 1) {
    lastPose = await getDogzillaRobotPoseImpl().catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))
    if (lastPose?.ok !== false && (lastPose?.mapPose || lastPose?.pose || lastPose?.frame === 'map')) {
      return lastPose
    }
    if (index < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  const reason = lastPose?.error || lastPose?.status || 'map pose unavailable after localization restart'
  throw new Error(`Could not capture DOGZILLA map origin: ${reason}`)
}
