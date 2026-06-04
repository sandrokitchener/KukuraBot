import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAppConfig } from './lib/app-config.mjs'
import {
  createDogzillaBatteryStateTracker,
  normalizeDogzillaBatterySample,
} from './lib/dogzilla-battery-state.mjs'
import { buildIsaacSimPreview } from './lib/isaacsim-command-compiler.mjs'
import {
  ensureDogzillaRobotIdentity,
  getDogzillaConnectionCenter,
  loadDogzillaConnectionConfig,
  runDogzillaConnectionAction,
  saveDogzillaConnectionConfig,
  saveDogzillaRobotName,
} from './lib/dogzilla-connection-center.mjs'
import {
  getDogzillaAudioCueHealth,
  sendDogzillaAudioCue,
} from './lib/dogzilla-audio-cue-client.mjs'
import {
  getDogzillaLidarDiagnostics,
  getDogzillaLidarHealth,
  getDogzillaRobotPose,
  getDogzillaLidarScan,
} from './lib/dogzilla-lidar-client.mjs'
import {
  DOGZILLA_CAMERA_SNAPSHOT_PROXY_PATH,
  DOGZILLA_CAMERA_STATUS_PATH,
  DOGZILLA_CAMERA_STREAM_PROXY_PATH,
  getDogzillaCameraSnapshot,
  getDogzillaCameraStatus,
  proxyDogzillaCameraStream,
  sendDogzillaCameraSnapshot,
} from './lib/dogzilla-camera-proxy.mjs'
import { runDogzillaPreflight } from './lib/dogzilla-preflight.mjs'
import {
  dispatchIsaacSimCommand,
  getIsaacRuntimeFeedback,
  getIsaacSidecarHealth,
} from './lib/isaacsim-sidecar-client.mjs'
import { loadPublicConfig, processModelResult, processUserInput } from './lib/app-service.mjs'
import { warmModel } from './lib/model-client.mjs'
import { resolveActiveModelProfile, setActiveModelProfile } from './lib/model-profile-config.mjs'
import { buildRobotManualControlPreview, buildRobotRuntimePreview } from './lib/robot-command-compiler.mjs'
import {
  dispatchRobotEmergencyStop,
  dispatchRobotCommand,
  fetchRobotBridgeState,
  getRobotRuntimeFeedback,
  getRobotSidecarHealth,
} from './lib/robot-sidecar-client.mjs'
import {
  loadRobotRos2Config,
  loadRobotRuntimeConfig,
  setActiveRobotTarget,
} from './lib/robot-runtime-config.mjs'
import {
  deleteReconSnapshot,
  listReconSnapshots,
  readReconSnapshotArtifact,
  readReconSnapshotImage,
  RECON_SNAPSHOT_API_PATH,
  saveReconSnapshot,
  updateReconSnapshotNote,
} from './lib/recon-snapshot-store.mjs'
import {
  getRobotStateSnapshot,
  handleRobotStateStreamUpgrade,
  ROBOT_STATE_STREAM_PATH,
} from './lib/robot-state-stream.mjs'
import {
  resolveActiveSpeechProfile,
  saveSpeechRuntimeConfig,
} from './lib/speech-profile-config.mjs'
import {
  getSpeechSidecarHealth,
  transcribeSpeechInput,
} from './lib/speech-sidecar-client.mjs'
import { buildSystemHealthz } from './lib/system-healthz.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')
const MOONSHINE_DIST_DIR = path.join(__dirname, 'node_modules', '@moonshine-ai', 'moonshine-js', 'dist')
const ONNX_RUNTIME_DIST_DIR = path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist')
const VAD_DIST_DIR = path.join(__dirname, 'node_modules', '@ricky0123', 'vad-web', 'dist')
const TRANSFORMERS_DIST_DIR = path.join(__dirname, 'node_modules', '@huggingface', 'transformers', 'dist')
const TRANSFORMERS_ORT_DIST_DIR = path.join(
  __dirname,
  'node_modules',
  '@huggingface',
  'transformers',
  'node_modules',
  'onnxruntime-web',
  'dist',
)
const HOST = process.env.APP_HOST || process.env.KUKURA_HOST || '127.0.0.1'
const PORT = Number(process.env.APP_PORT || process.env.KUKURA_PORT || 3037)
const appConfig = await loadAppConfig()
const APP_GENERATION_ID = randomUUID()
const APP_STARTED_AT = new Date().toISOString()
let robotBridgeStateSeq = 0
const dogzillaBatteryStateTracker = createDogzillaBatteryStateTracker()
const DOGZILLA_POSE_TRACK_LIMIT = 80
const dogzillaPoseTrack = []

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
}

const STATIC_ROOTS = [
  { prefix: '/vendor/transformers/', rootDir: TRANSFORMERS_DIST_DIR },
  { prefix: '/vendor/transformers-ort/', rootDir: TRANSFORMERS_ORT_DIST_DIR },
  { prefix: '/vendor/moonshine/', rootDir: MOONSHINE_DIST_DIR },
  { prefix: '/vendor/onnxruntime/', rootDir: ONNX_RUNTIME_DIST_DIR },
  { prefix: '/vendor/vad/', rootDir: VAD_DIST_DIR },
]

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    applyCorsHeaders(request, response)

    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
      return sendJson(response, 200, await buildSystemHealthz({
        generationId: APP_GENERATION_ID,
        startedAt: APP_STARTED_AT,
        uptimeSec: process.uptime(),
        pid: process.pid,
        buildRobotStateSnapshotImpl: buildCurrentRobotStateSnapshot,
      }))
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/config') {
      return sendJson(response, 200, await loadPublicConfig())
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/dogzilla/connection') {
      return sendJson(response, 200, await getDogzillaConnectionCenter())
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/dogzilla/connection') {
      const body = await readJsonBody(request)
      const config = await saveDogzillaConnectionConfig(body || {})
      let identity = null

      if (config.ssh.host) {
        identity = await ensureDogzillaRobotIdentity({ config })
      }

      return sendJson(response, 200, await getDogzillaConnectionCenter({ identity }))
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/dogzilla/identity') {
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

    if (request.method === 'POST' && requestUrl.pathname === '/api/dogzilla/connection/action') {
      const body = await readJsonBody(request)
      const action = typeof body?.action === 'string' ? body.action.trim() : ''
      const result = await runDogzillaConnectionAction(action, {
        live: body?.live === true,
      })
      const statusCode = result.status === 'error' ? 400 : 200
      return sendJson(response, statusCode, result)
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/dogzilla/preflight') {
      return sendJson(response, 200, await runDogzillaPreflight())
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/dogzilla/audio/health') {
      return sendJson(response, 200, await getDogzillaAudioCueHealth())
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/dogzilla/audio/cue') {
      const body = await readJsonBody(request)
      const result = await sendDogzillaAudioCue(body?.cue)
      const statusCode = result.ok ? 200 : result.status === 'invalid' ? 400 : 502
      return sendJson(response, statusCode, result)
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/dogzilla/lidar/health') {
      return sendJson(response, 200, await getDogzillaLidarHealth())
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/dogzilla/lidar/scan') {
      const result = await getDogzillaLidarScan()
      const statusCode = result.ok ? 200 : result.status === 'disabled' ? 404 : 502
      return sendJson(response, statusCode, result)
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/dogzilla/pose') {
      const result = await getDogzillaRobotPose()
      const statusCode = result.status === 'disabled' ? 404 : 200
      return sendJson(response, statusCode, result)
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/dogzilla/pose/track') {
      return sendJson(response, 200, {
        status: 'ok',
        frame: 'map',
        waypointSafeOnly: true,
        poses: getDogzillaPoseTrack(),
      })
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/dogzilla/lidar/diagnostics') {
      return sendJson(response, 200, await getDogzillaLidarDiagnostics())
    }

    if (request.method === 'GET' && requestUrl.pathname === DOGZILLA_CAMERA_STATUS_PATH) {
      return sendJson(response, 200, await getDogzillaCameraStatus())
    }

    if (request.method === 'GET' && requestUrl.pathname === DOGZILLA_CAMERA_SNAPSHOT_PROXY_PATH) {
      return sendDogzillaCameraSnapshot(response)
    }

    if (request.method === 'GET' && requestUrl.pathname === DOGZILLA_CAMERA_STREAM_PROXY_PATH) {
      return proxyDogzillaCameraStream(response)
    }

    if (request.method === 'GET' && requestUrl.pathname === RECON_SNAPSHOT_API_PATH) {
      const limit = parsePositiveInteger(requestUrl.searchParams.get('limit'), 24)
      return sendJson(response, 200, {
        status: 'ok',
        snapshots: await listReconSnapshots({ limit }),
      })
    }

    const reconSnapshotImageId = matchReconSnapshotImagePath(requestUrl.pathname)
    if (request.method === 'GET' && reconSnapshotImageId) {
      return sendReconSnapshotImage(response, reconSnapshotImageId)
    }

    const reconSnapshotArtifact = matchReconSnapshotArtifactPath(requestUrl.pathname)
    if (request.method === 'GET' && reconSnapshotArtifact) {
      return sendReconSnapshotArtifact(response, reconSnapshotArtifact.id, reconSnapshotArtifact.artifact)
    }

    if (request.method === 'POST' && requestUrl.pathname === RECON_SNAPSHOT_API_PATH) {
      const body = await readJsonBody(request)
      const result = await captureReconSnapshot(body || {})

      if (!result.ok) {
        return sendJson(response, result.statusCode || 502, {
          status: 'error',
          error: result.error || 'Recon snapshot failed.',
          robotState: result.robotState,
          lidarScan: result.lidarScan,
        })
      }

      return sendJson(response, 201, result.snapshot)
    }

    const reconSnapshotId = matchReconSnapshotPath(requestUrl.pathname)
    if (request.method === 'PATCH' && reconSnapshotId) {
      const body = await readJsonBody(request)
      try {
        return sendJson(response, 200, await updateReconSnapshotNote(reconSnapshotId, {
          note: body?.note,
          tags: body?.tags,
        }))
      } catch (error) {
        const statusCode = error?.code === 'ENOENT' ? 404 : error?.code === 'EINVAL' ? 400 : 500
        return sendJson(response, statusCode, {
          error: error instanceof Error ? error.message : 'Could not update recon snapshot.',
        })
      }
    }

    if (request.method === 'DELETE' && reconSnapshotId) {
      try {
        return sendJson(response, 200, await deleteReconSnapshot(reconSnapshotId))
      } catch (error) {
        const statusCode = error?.code === 'ENOENT' ? 404 : error?.code === 'EINVAL' ? 400 : 500
        return sendJson(response, statusCode, {
          error: error instanceof Error ? error.message : 'Could not delete recon snapshot.',
        })
      }
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/chat') {
      const body = await readJsonBody(request)
      return sendJson(response, 200, await processUserInput(body?.input))
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/chat/result') {
      const body = await readJsonBody(request)
      return sendJson(response, 200, await processModelResult({
        input: body?.input,
        rawResponse: body?.rawResponse,
      }))
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/settings/profile') {
      const body = await readJsonBody(request)
      const profileId = typeof body?.profileId === 'string' ? body.profileId.trim() : ''

      if (!profileId) {
        return sendJson(response, 400, { error: 'Select a profile first.' })
      }

      try {
        await setActiveModelProfile(profileId)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not update profile.'
        const statusCode = /locked/i.test(message) ? 409 : 400
        return sendJson(response, statusCode, { error: message })
      }

      return sendJson(response, 200, await loadPublicConfig())
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/settings/speech-profile') {
      const body = await readJsonBody(request)
      const profileId = typeof body?.profileId === 'string' ? body.profileId.trim() : ''

      if (!profileId) {
        return sendJson(response, 400, { error: 'Select a speech profile first.' })
      }

      try {
        const speechConfig = await resolveActiveSpeechProfile()
        const profileExists = speechConfig.availableProfiles.some((profile) => profile.id === profileId)

        if (!profileExists) {
          return sendJson(response, 400, { error: `Unknown speech profile "${profileId}".` })
        }

        if (speechConfig.selectionLocked) {
          return sendJson(response, 409, { error: 'Speech profile locked by APP_SPEECH_PROFILE.' })
        }

        await saveSpeechRuntimeConfig({ activeProfile: profileId })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not update speech profile.'
        const statusCode = /locked/i.test(message) ? 409 : 400
        return sendJson(response, statusCode, { error: message })
      }

      return sendJson(response, 200, await loadPublicConfig())
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/settings/robot-target') {
      const body = await readJsonBody(request)
      const targetId = typeof body?.targetId === 'string' ? body.targetId.trim() : ''

      if (!targetId) {
        return sendJson(response, 400, { error: 'Select a robot target first.' })
      }

      try {
        const runtimeConfig = await loadRobotRuntimeConfig()

        if (runtimeConfig.selectionLocked) {
          return sendJson(response, 409, { error: 'Robot target locked by ROBOT_RUNTIME_TARGET.' })
        }

        await setActiveRobotTarget(targetId)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not update robot target.'
        return sendJson(response, 400, { error: message })
      }

      return sendJson(response, 200, await loadPublicConfig())
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/isaac/health') {
      return sendJson(response, 200, await getIsaacSidecarHealth())
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/isaac/feedback') {
      return sendJson(response, 200, await getIsaacRuntimeFeedback())
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/robot/health') {
      return sendJson(response, 200, await getRobotSidecarHealth())
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/robot/feedback') {
      return sendJson(response, 200, await getRobotRuntimeFeedback())
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/robot/state') {
      return sendJson(response, 200, await buildCurrentRobotStateSnapshot())
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/speech/health') {
      return sendJson(response, 200, await getSpeechSidecarHealth())
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/speech/transcribe') {
      const body = await readJsonBody(request)
      const speechConfig = await resolveActiveSpeechProfile()
      const activeSpeechProfile = speechConfig.activeProfile

      if (activeSpeechProfile.provider !== 'parakeet-sidecar') {
        return sendJson(response, 400, {
          error: `Active speech profile "${activeSpeechProfile.label}" does not use server transcription.`,
        })
      }

      const result = await transcribeSpeechInput({
        audioBase64: typeof body?.audioBase64 === 'string' ? body.audioBase64.trim() : '',
        mimeType: typeof body?.mimeType === 'string' ? body.mimeType.trim() : 'audio/wav',
        sampleRate: Number.isFinite(body?.sampleRate) ? body.sampleRate : 16000,
        timestamps: activeSpeechProfile.timestamps ?? true,
        modelId: activeSpeechProfile.sidecarModelId || activeSpeechProfile.modelId,
        language: activeSpeechProfile.language,
        task: activeSpeechProfile.task,
        device: activeSpeechProfile.device,
      })

      const statusCode = result.status === 'ok' ? 200 : result.status === 'invalid-audio' ? 400 : 502
      return sendJson(response, statusCode, result)
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/isaac/dispatch') {
      const body = await readJsonBody(request)
      const preview =
        body?.preview && typeof body.preview === 'object'
          ? body.preview
          : await buildIsaacSimPreview({
            input: body?.input,
            rawResponse: body?.rawResponse,
            parsed: body?.parsed,
          })
      const dispatch = await dispatchIsaacSimCommand(preview)
      const statusCode = dispatch.status === 'error' ? 502 : 200
      return sendJson(response, statusCode, { preview, dispatch })
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/robot/dispatch') {
      const body = await readJsonBody(request)
      const preview =
        body?.preview && typeof body.preview === 'object'
          ? body.preview
          : await buildRobotRuntimePreview({
            input: body?.input,
            rawResponse: body?.rawResponse,
            parsed: body?.parsed,
          })
      const dispatch = await dispatchRobotCommand(preview)
      const statusCode = dispatch.status === 'error' ? 502 : 200
      return sendJson(response, statusCode, { preview, dispatch })
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/robot/manual-control') {
      const body = await readJsonBody(request)
      const preview = await buildRobotManualControlPreview(body || {})
      const dispatch = await dispatchRobotCommand(preview)
      const statusCode = dispatch.status === 'error' ? 502 : 200
      return sendJson(response, statusCode, { preview, dispatch })
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/robot/stop') {
      await readJsonBody(request)
      const dispatch = await dispatchRobotEmergencyStop()
      const statusCode = dispatch.status === 'error' ? 502 : 200
      return sendJson(response, statusCode, { action: 'stop', dispatch })
    }

    if (request.method === 'GET') {
      return serveStaticRequest(requestUrl.pathname, response)
    }

    sendJson(response, 405, { error: 'Method not allowed.' })
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Unexpected server error.',
    })
  }
})

server.on('upgrade', (request, socket, head) => {
  void handleRobotStateStreamUpgrade(request, socket, head, {
    async getRuntimeTargetKind() {
      const robotRuntimeConfig = await loadRobotRuntimeConfig()
      return robotRuntimeConfig.activeTarget?.kind || ''
    },
  }).catch((error) => {
    rejectFailedUpgrade(socket, error)
  })
})

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`App server could not start because http://${HOST}:${PORT} is already in use.`)
    process.exit(1)
  }

  throw error
})

server.listen(PORT, HOST, async () => {
  const profileConfig = await resolveActiveModelProfile()
  console.log(
    `${appConfig.serverReadyLabel} running at http://${HOST}:${PORT} using ${profileConfig.activeProfile.label} (${profileConfig.activeProfile.model})`,
  )
  void warmActiveModel(profileConfig.activeProfile)
})

async function warmActiveModel(profile) {
  if (process.env.APP_MODEL_WARMUP === '0' || process.env.APP_MODEL_WARMUP === 'false') {
    return
  }

  if (profile.provider !== 'ollama') {
    return
  }

  const timeoutMs = Number(process.env.APP_MODEL_WARMUP_TIMEOUT_MS || 120000)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    console.log(`Warming ${profile.label} (${profile.model})...`)
    await warmModel({ profile, signal: controller.signal })
    console.log(`Warmed ${profile.label} (${profile.model}).`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Model warm-up skipped: ${message}`)
  } finally {
    clearTimeout(timeout)
  }
}

async function serveStaticRequest(pathname, response) {
  for (const { prefix, rootDir } of STATIC_ROOTS) {
    if (pathname.startsWith(prefix)) {
      const requestedPath = pathname.slice(prefix.length)
      return serveStaticFile(requestedPath, response, rootDir)
    }
  }

  return serveStaticFile(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''), response, PUBLIC_DIR)
}
async function serveStaticFile(requestedPath, response, rootDir) {
  const cleanedPath = requestedPath.replace(/^\/+/, '')
  const resolved = path.normalize(path.join(rootDir, cleanedPath))
  const normalizedRoot = path.normalize(rootDir)
  const rootPrefix = `${normalizedRoot}${path.sep}`

  if (resolved !== normalizedRoot && !resolved.startsWith(rootPrefix)) {
    return sendJson(response, 403, { error: 'Forbidden.' })
  }

  try {
    const file = await readFile(resolved)
    response.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(resolved)] || 'application/octet-stream',
    })
    response.end(file)
  } catch {
    sendJson(response, 404, { error: 'Not found.' })
  }
}

async function readJsonBody(request) {
  const chunks = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  if (chunks.length === 0) {
    return {}
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
}

async function buildCurrentRobotStateSnapshot() {
  const robotRuntimeConfig = await loadRobotRuntimeConfig()
  const robotRos2Config = await loadRobotRos2Config()
  const streamSnapshot = getRobotStateSnapshot()
  const [bridgeState, poseState] = await Promise.all([
    fetchRobotBridgeState(robotRuntimeConfig, robotRos2Config),
    getDogzillaRobotPose({ timeoutMs: 1200 }),
  ])
  const bridgeRobot = buildRobotStateFromBridge(bridgeState, robotRuntimeConfig, poseState)
  const bridgeOwnsActiveRobot = robotRuntimeConfig.activeTarget?.kind === 'dogzilla-direct'
  const streamRobots = bridgeOwnsActiveRobot && !bridgeRobot
    ? removeDogzillaStreamRobots(streamSnapshot.robots, robotRuntimeConfig)
    : streamSnapshot.robots
  const activeRobot = bridgeOwnsActiveRobot ? bridgeRobot : bridgeRobot || streamSnapshot.activeRobot
  const status = bridgeRobot
    ? 'ok'
    : bridgeOwnsActiveRobot && bridgeState?.attempted
      ? 'error'
      : streamSnapshot.status
  recordDogzillaMapPose(bridgeRobot)
  const robots = bridgeRobot
    ? [bridgeRobot, ...streamRobots.filter((robot) => robot.uuid !== bridgeRobot.uuid)]
    : streamRobots

  return {
    ...streamSnapshot,
    status,
    activeRobot,
    robots,
    streamPath: ROBOT_STATE_STREAM_PATH,
    activeTarget: robotRuntimeConfig.activeTarget,
    bridgeState,
    poseState,
    poseTrack: bridgeRobot?.pose ? getDogzillaPoseTrack() : [],
  }
}

function removeDogzillaStreamRobots(robots, robotRuntimeConfig) {
  const staleBridgeUuid = normalizeString(robotRuntimeConfig.robotId) || 'dogzilla-local'
  return Array.isArray(robots)
    ? robots.filter((robot) => normalizeString(robot?.uuid) !== staleBridgeUuid)
    : []
}

async function captureReconSnapshot(body) {
  const note = typeof body?.note === 'string' ? body.note : ''
  const tags = Array.isArray(body?.tags) ? body.tags : []
  const connectionConfig = await loadDogzillaConnectionConfig()
  const capturedAt = new Date()
  const [cameraSnapshot, robotState, lidarScan] = await Promise.all([
    getDogzillaCameraSnapshot({ config: connectionConfig }),
    buildCurrentRobotStateSnapshot(),
    getDogzillaLidarScan({ config: connectionConfig, timeoutMs: 1200 }),
  ])

  if (!cameraSnapshot.ok) {
    return {
      ok: false,
      statusCode: cameraSnapshot.statusCode || 502,
      error: cameraSnapshot.error || 'Camera snapshot failed.',
      robotState,
      lidarScan,
    }
  }

  const snapshot = await saveReconSnapshot({
    imageBuffer: cameraSnapshot.jpeg,
    imageContentType: cameraSnapshot.contentType || 'image/jpeg',
    robotState,
    lidarScan,
    map: buildReconMapContext(robotState, lidarScan),
    camera: buildReconCameraContext(connectionConfig.camera),
    note,
    tags,
    capturedAt,
  })

  return {
    ok: true,
    snapshot,
  }
}

function buildReconCameraContext(camera = {}) {
  return {
    label: camera.label || 'DOGZILLA camera',
    processed: camera.processed === true,
    streamUrl: camera.streamUrl || '',
    sourceStreamUrl: camera.sourceStreamUrl || '',
    proxyStreamPath: camera.proxyStreamPath || DOGZILLA_CAMERA_STREAM_PROXY_PATH,
    proxySnapshotPath: camera.proxySnapshotPath || DOGZILLA_CAMERA_SNAPSHOT_PROXY_PATH,
    capturedVia: 'backend-camera-snapshot',
  }
}

function buildReconMapContext(robotState, lidarScan) {
  return {
    status: robotState?.activeRobot?.pose ? 'pose' : 'pending-pose',
    pose: robotState?.activeRobot?.pose ?? null,
    poseTrack: Array.isArray(robotState?.poseTrack) ? robotState.poseTrack : [],
    activeTarget: robotState?.activeTarget ?? null,
    lidarStatus: lidarScan?.status || 'unknown',
    lidarPointCount: Array.isArray(lidarScan?.points) ? lidarScan.points.length : 0,
    source: 'robot-state-plus-lidar',
  }
}

async function sendReconSnapshotImage(response, id) {
  try {
    const image = await readReconSnapshotImage(id)
    response.writeHead(200, {
      'content-type': image.contentType,
      'cache-control': 'private, max-age=60',
    })
    response.end(image.buffer)
  } catch (error) {
    const statusCode = error?.code === 'ENOENT' ? 404 : error?.code === 'EINVAL' ? 400 : 500
    return sendJson(response, statusCode, {
      error: error instanceof Error ? error.message : 'Recon snapshot image unavailable.',
    })
  }
}

async function sendReconSnapshotArtifact(response, id, artifact) {
  try {
    const result = await readReconSnapshotArtifact(id, artifact)
    response.writeHead(200, {
      'content-type': result.contentType,
      'cache-control': 'private, max-age=60',
    })
    response.end(result.buffer)
  } catch (error) {
    const statusCode = error?.code === 'ENOENT' ? 404 : error?.code === 'EINVAL' ? 400 : 500
    return sendJson(response, statusCode, {
      error: error instanceof Error ? error.message : 'Recon snapshot artifact unavailable.',
    })
  }
}

function matchReconSnapshotImagePath(pathname) {
  const match = /^\/api\/recon\/snapshots\/([^/]+)\/image$/.exec(pathname)
  return match ? decodeURIComponent(match[1]) : ''
}

function matchReconSnapshotArtifactPath(pathname) {
  const match = /^\/api\/recon\/snapshots\/([^/]+)\/lidar\.(json|csv)$/.exec(pathname)
  return match ? {
    id: decodeURIComponent(match[1]),
    artifact: match[2],
  } : null
}

function matchReconSnapshotPath(pathname) {
  const match = /^\/api\/recon\/snapshots\/([^/]+)$/.exec(pathname)
  return match ? decodeURIComponent(match[1]) : ''
}

function parsePositiveInteger(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback
}

function recordDogzillaMapPose(robot) {
  const pose = robot?.pose
  const telemetry = robot?.telemetry || {}
  if (!pose || pose.frame !== 'map' || telemetry.waypointSafe !== true) {
    return
  }

  dogzillaPoseTrack.push({
    x: pose.x,
    y: pose.y,
    theta: pose.theta,
    frame: 'map',
    source: pose.source || telemetry.poseSource || '',
    receivedAt: robot.receivedAt,
    timestamp: robot.timestamp,
    seq: robot.seq,
  })

  while (dogzillaPoseTrack.length > DOGZILLA_POSE_TRACK_LIMIT) {
    dogzillaPoseTrack.shift()
  }
}

function getDogzillaPoseTrack() {
  return dogzillaPoseTrack.map((pose) => ({ ...pose }))
}

function buildRobotStateFromBridge(bridgeState, robotRuntimeConfig, poseState = null) {
  if (bridgeState?.status !== 'ok' || !bridgeState.state || typeof bridgeState.state !== 'object') {
    return null
  }

  const state = bridgeState.state
  const timestamp = normalizeIsoTimestamp(state.readAt) || new Date().toISOString()
  const yaw = normalizeFiniteNumber(state.yaw)
  const roll = normalizeFiniteNumber(state.roll)
  const pitch = normalizeFiniteNumber(state.pitch)
  const batterySample = normalizeDogzillaBatterySample(state.battery)
  const batteryState = dogzillaBatteryStateTracker.resolve(batterySample, timestamp)
  const mapPose = normalizePoseFromBridge(poseState?.mapPose)
  const poseDiagnostics = Array.isArray(poseState?.diagnostics)
    ? poseState.diagnostics.map((item) => normalizeString(item)).filter(Boolean)
    : []
  const poseTopicPublishers = summarizePoseTopicPublishers(poseState?.rosGraph)

  robotBridgeStateSeq += 1

  return {
    type: 'robot.state',
    uuid: normalizeString(state.robot_id || state.robotId) || robotRuntimeConfig.robotId || 'dogzilla-local',
    name: normalizeString(state.robot_name || state.robotName) || robotRuntimeConfig.robotName || 'Questing Beast',
    pose: mapPose,
    task: 'IDLE',
    timestamp,
    seq: robotBridgeStateSeq,
    receivedAt: new Date().toISOString(),
    sequenceStatus: robotBridgeStateSeq === 1 ? 'first' : 'ok',
    telemetry: {
      battery: batteryState.value,
      batteryRaw: batterySample.raw,
      batteryStatus: batteryState.status,
      batteryReadStatus: batterySample.status,
      batteryReadError: normalizeString(state.readErrors?.battery),
      batteryLastKnownAt: batteryState.lastKnownAt,
      batteryUnit: batteryState.unit,
      batterySource: 'DOGZILLALib.read_battery',
      roll,
      pitch,
      yaw,
      imuRaw: Array.isArray(state.imuRaw) ? state.imuRaw : [],
      motors: Array.isArray(state.motors) ? state.motors : [],
      dryRun: state.dryRun === true,
      source: state.delivery || 'bridge',
      poseStatus: mapPose ? 'map' : normalizeString(poseState?.status) || 'pending-map',
      poseFrame: mapPose?.frame || '',
      poseSource: mapPose?.source || normalizeString(poseState?.source) || 'unavailable',
      poseError: mapPose ? '' : normalizeString(poseState?.error),
      poseDiagnostics,
      poseTopicPublishers,
      waypointSafe: mapPose?.frame === 'map' && poseState?.waypointSafe === true,
      mapSource: mapPose ? 'yahboom-ros2-map-tf' : 'pending-yahboom-ros2-localization',
    },
  }
}

function summarizePoseTopicPublishers(rosGraph) {
  const topics = rosGraph?.topics && typeof rosGraph.topics === 'object' ? rosGraph.topics : {}
  return ['/tf', '/tf_static', '/odom']
    .map((topic) => `${topic}:${Number(topics[topic]?.publisherCount ?? 0)}`)
    .join(', ')
}

function normalizePoseFromBridge(value) {
  if (!value || typeof value !== 'object') {
    return null
  }

  const pose = {
    x: normalizeFiniteNumber(value.x),
    y: normalizeFiniteNumber(value.y),
    theta: normalizeFiniteNumber(value.theta),
  }

  if (!Number.isFinite(pose.x) || !Number.isFinite(pose.y) || !Number.isFinite(pose.theta)) {
    return null
  }

  return {
    ...pose,
    frame: normalizeFrameId(value.frame),
    childFrame: normalizeFrameId(value.childFrame),
    source: normalizeString(value.source),
  }
}

function normalizeFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return ''
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeFrameId(value) {
  return normalizeString(value).replace(/^\/+/, '')
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function applyCorsHeaders(request, response) {
  const allowedOrigin = process.env.APP_CORS_ORIGIN || '*'
  response.setHeader('access-control-allow-origin', allowedOrigin)
  response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  response.setHeader(
    'access-control-allow-headers',
    request.headers['access-control-request-headers'] || 'content-type',
  )
  response.setHeader('access-control-max-age', '86400')
  response.setHeader('access-control-allow-private-network', 'true')
}

function rejectFailedUpgrade(socket, error) {
  const message = error instanceof Error ? error.message : 'Unexpected robot state stream error.'
  socket.write(
    'HTTP/1.1 500 Robot State Stream Error\r\n' +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(message)}\r\n` +
    '\r\n' +
    message,
  )
  socket.destroy()
}
