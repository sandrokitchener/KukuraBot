import {
  ensureDogzillaRobotIdentity,
  getDogzillaConnectionCenter,
  runDogzillaConnectionAction,
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
  getDogzillaRobotPose,
} from './dogzilla-lidar-client.mjs'
import {
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

export async function tryHandleDogzillaRoute({
  request,
  requestUrl,
  response,
  readJsonBody,
  sendJson,
  getDogzillaPoseTrack,
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

  if (method === 'GET' && pathname === '/api/dogzilla/audio/health') {
    return sendJson(response, 200, await getDogzillaAudioCueHealth())
  }

  if (method === 'POST' && pathname === '/api/dogzilla/audio/cue') {
    const body = await readJsonBody(request)
    const result = await sendDogzillaAudioCue(body?.cue, { volume: body?.volume })
    const statusCode = result.ok ? 200 : result.status === 'invalid' ? 400 : 502
    return sendJson(response, statusCode, result)
  }

  if (method === 'GET' && pathname === '/api/dogzilla/lidar/health') {
    return sendJson(response, 200, await getDogzillaLidarHealth())
  }

  if (method === 'GET' && pathname === '/api/dogzilla/lidar/scan') {
    const result = await getDogzillaLidarScan()
    const statusCode = result.ok ? 200 : result.status === 'disabled' ? 404 : 502
    return sendJson(response, statusCode, result)
  }

  if (method === 'GET' && pathname === '/api/dogzilla/pose') {
    const result = await getDogzillaRobotPose()
    const statusCode = result.status === 'disabled' ? 404 : 200
    return sendJson(response, statusCode, result)
  }

  if (method === 'GET' && pathname === '/api/dogzilla/map-origin') {
    const origin = await loadDogzillaMapOrigin()
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

    const origin = await saveDogzillaMapOriginFromPose(pose, {
      label: body?.label || 'home_origin',
    })
    return sendJson(response, 200, {
      ok: true,
      origin,
    })
  }

  if (method === 'GET' && pathname === '/api/dogzilla/pose/track') {
    return sendJson(response, 200, {
      status: 'ok',
      frame: 'map',
      waypointSafeOnly: true,
      poses: getDogzillaPoseTrack(),
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
