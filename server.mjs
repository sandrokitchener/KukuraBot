import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAppConfig } from './lib/app-config.mjs'
import {
  createDogzillaBatteryStateTracker,
  normalizeLastKnownBattery,
  normalizeDogzillaBatterySample,
} from './lib/dogzilla-battery-state.mjs'
import {
  loadDogzillaConnectionConfig,
} from './lib/dogzilla-connection-center.mjs'
import {
  getDogzillaLidarScan,
  getDogzillaRobotPose,
  getRosbridgeClient,
  startDogzillaLidarClient,
} from './lib/dogzilla-lidar-client.mjs'
import {
  DOGZILLA_CAMERA_SNAPSHOT_PROXY_PATH,
  DOGZILLA_CAMERA_STREAM_PROXY_PATH,
  getDogzillaCameraSnapshot,
} from './lib/dogzilla-camera-proxy.mjs'
import {
  APP_MAP_FRAME,
  applyMapOriginToPose,
  getDogzillaMapOriginStatus,
  loadDogzillaMapOrigin,
} from './lib/dogzilla-map-frame.mjs'
import { resolveRobotPoseFromBridgeState } from './lib/dogzilla-robot-state.mjs'
import { tryHandleDogzillaRoute } from './lib/http-dogzilla-routes.mjs'
import { tryHandleReconRoute } from './lib/http-recon-routes.mjs'
import { tryHandleRuntimeRoute } from './lib/http-runtime-routes.mjs'
import { warmModel } from './lib/model-client.mjs'
import { resolveActiveModelProfile } from './lib/model-profile-config.mjs'
import { fetchRobotBridgeState, probeRobotSidecarHealth } from './lib/robot-sidecar-client.mjs'
import {
  loadRobotRos2Config,
  loadRobotRuntimeConfig,
} from './lib/robot-runtime-config.mjs'
import {
  saveReconSnapshot,
} from './lib/recon-snapshot-store.mjs'
import {
  getRobotStateSnapshot,
  handleRobotStateStreamUpgrade,
  ROBOT_STATE_STREAM_PATH,
} from './lib/robot-state-stream.mjs'
import { deriveNavigationStatus } from './lib/dogzilla-navigation-status.mjs'
import {
  deriveNav2StabilityFromHealth,
  getNav2Stability,
  isNav2StabilityTrackerEnabled,
} from './lib/dogzilla-nav2-stability.mjs'
import { buildSystemHealthz } from './lib/system-healthz.mjs'
import { green, printStartupBanner } from './lib/startup-banner.mjs'
import { loadRobotWaypointsConfig } from './lib/isaacsim-config.mjs'
import { validateDogzillaWaypoints } from './scripts/validate-dogzilla-waypoints.mjs'

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
const HOST = process.env.APP_HOST || process.env.KUKURA_HOST || '0.0.0.0'
const PORT = Number(process.env.APP_PORT || process.env.KUKURA_PORT || 3037)
const appConfig = await loadAppConfig()
const dogzillaConfig = await loadDogzillaConnectionConfig()
const dogzillaStartupResult = await startSimplifiedDogzillaStack({ logger: console })

if (dogzillaStartupResult.blocked) {
  console.warn(`DOGZILLA startup degraded: ${dogzillaStartupResult.error}`)
}

printStartupBanner({
  appName: appConfig.appName,
  mode: 'server',
  url: `http://${HOST}:${PORT}`,
})
const APP_GENERATION_ID = randomUUID()
const APP_STARTED_AT = new Date().toISOString()
let robotBridgeStateSeq = 0
const DOGZILLA_BATTERY_STATE_FILE = path.join(__dirname, 'output', 'app-cache', 'dogzilla-battery-state.json')
const dogzillaBatteryStateTracker = createDogzillaBatteryStateTracker({
  lastKnown: await loadPersistedDogzillaBatteryState(),
  onUpdate: persistDogzillaBatteryState,
})
const DOGZILLA_POSE_TRACK_LIMIT = 80
const DOGZILLA_HEALTH_CACHE_MAX_AGE_MS = 30_000
const DOGZILLA_HEALTH_REFRESH_TIMEOUT_MS = Number(process.env.APP_DOGZILLA_HEALTH_REFRESH_TIMEOUT_MS || 20_000)
const dogzillaPoseTrack = []
let lastDogzillaBridgeHealth = null
let dogzillaBridgeHealthRefresh = null
const navigationDispatch = {
  waypointName: null,
  dispatchedAt: null,
  arrivedAt: null,
  status: 'idle',
}

function recordNavigationDispatch({ waypointName, waypoint, arrivalTolerance } = {}) {
  navigationDispatch.waypointName = String(waypointName || waypoint || '').trim() || null
  navigationDispatch.dispatchedAt = Date.now()
  navigationDispatch.arrivedAt = null
  navigationDispatch.status = 'navigating'
}

function resetNavigationDispatch() {
  navigationDispatch.waypointName = null
  navigationDispatch.dispatchedAt = null
  navigationDispatch.arrivedAt = null
  navigationDispatch.status = 'idle'
}

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

    const routeContext = {
      request,
      requestUrl,
      response,
      readJsonBody,
      sendJson,
      recordNavigationDispatch,
      resetNavigationDispatch,
    }

    if ((await tryHandleDogzillaRoute({
      ...routeContext,
      getDogzillaPoseTrack,
    })) !== false) {
      return
    }

    if ((await tryHandleReconRoute({
      ...routeContext,
      captureReconSnapshot,
    })) !== false) {
      return
    }

    if ((await tryHandleRuntimeRoute({
      ...routeContext,
      buildCurrentRobotStateSnapshot,
    })) !== false) {
      return
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
  console.log()
  console.log(green(`     |\\_/|`))
  console.log(green(`     | @ @   Woof!`))
  console.log(green(`     |   <>              _`))
  console.log(green(`     |  _/\\------____ ((| |))`))
  console.log(green(`     |               \`--' |`))
  console.log(green(` ____|_       ___|   |___.'`))
  console.log(green(`/_/_____/____/_______|`))
startRosbridgeConnectionMonitor()
void warmActiveModel(profileConfig.activeProfile)
})

async function startSimplifiedDogzillaStack({ logger = console } = {}) {
  if (dogzillaConfig.lidar?.enabled === true) {
    logger.log?.('Connecting to DOGZILLA rosbridge...')
    await startDogzillaLidarClient({ config: dogzillaConfig })
    const rosbridge = getRosbridgeClient()
    await waitFor(() => rosbridge.connected, 5000, 250)
    if (!rosbridge.connected) {
      return {
        blocked: true,
        error: 'Could not connect to DOGZILLA rosbridge. Start the Pi rosbridge stack first.',
      }
    }
    logger.log?.(green(`Connected to DOGZILLA rosbridge at ${rosbridge.url}.`))
  }

  return { blocked: false }
}

function startRosbridgeConnectionMonitor({
  env = process.env,
  logger = console,
  intervalMs = 12_000,
} = {}) {
  const override = String(env.APP_DOGZILLA_STARTUP_MONITOR ?? env.DOGZILLA_STARTUP_MONITOR ?? '').trim().toLowerCase()
  if (['0', 'false', 'no', 'off'].includes(override)) {
    return null
  }

  const rosbridge = getRosbridgeClient()
  if (!rosbridge) {
    return null
  }

  rosbridge.on('disconnected', () => {
    logger.warn?.(`DOGZILLA rosbridge disconnected from ${rosbridge.url}.`)
  })
  rosbridge.on('connected', () => {
    logger.log?.(green(`DOGZILLA rosbridge reconnected to ${rosbridge.url}.`))
  })

  const interval = setInterval(() => {
    if (!rosbridge.connected) {
      logger.warn?.(`DOGZILLA rosbridge still disconnected from ${rosbridge.url}; will retry.`)
    }
  }, intervalMs)
  interval.unref?.()
  return { interval }
}

async function waitFor(predicate, timeoutMs, intervalMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return true
    }
    await new Promise((resolve) => { setTimeout(resolve, intervalMs) })
  }
  return predicate()
}

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

async function loadPersistedDogzillaBatteryState() {
  try {
    const raw = await readFile(DOGZILLA_BATTERY_STATE_FILE, 'utf-8')
    return normalizeLastKnownBattery(JSON.parse(raw))
  } catch {
    return null
  }
}

async function persistDogzillaBatteryState(state) {
  const normalized = normalizeLastKnownBattery(state)
  if (!normalized) return

  try {
    await mkdir(path.dirname(DOGZILLA_BATTERY_STATE_FILE), { recursive: true })
    await writeFile(DOGZILLA_BATTERY_STATE_FILE, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8')
  } catch {
    // Best-effort cache. Battery read itself remains the source of truth.
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
  const robotStateProbeConfig = withRobotStateProbeTimeout(robotRos2Config, 4000)
  const streamSnapshot = getRobotStateSnapshot()
  void refreshDogzillaBridgeHealth(robotRuntimeConfig, robotRos2Config)
const [bridgeState, poseState, mapOrigin, waypointConfig] = await Promise.all([
  fetchRobotBridgeState(robotRuntimeConfig, robotStateProbeConfig),
  getDogzillaRobotPose({ timeoutMs: 1200 }),
  loadDogzillaMapOrigin(),
  loadRobotWaypointsConfig(),
])
const cachedBridgeHealth = getFreshDogzillaBridgeHealth()
const bridgeHealth = cachedBridgeHealth
  ? { ...cachedBridgeHealth, cached: true }
  : {
      attempted: true,
      status: 'pending',
      destination: robotRos2Config.transport?.baseUrl || '',
      error: 'DOGZILLA bridge health refresh pending',
    }
  const effectiveBridgeHealthBody = bridgeHealth?.status === 'ok'
    ? bridgeHealth.body
    : cachedBridgeHealth?.body || null
  const bridgeRuntime = effectiveBridgeHealthBody?.runtime && typeof effectiveBridgeHealthBody.runtime === 'object'
    ? effectiveBridgeHealthBody.runtime
    : null
  const activeMap = bridgeRuntime?.map && typeof bridgeRuntime.map === 'object'
    ? bridgeRuntime.map
    : null
  const mapOriginStatus = getDogzillaMapOriginStatus(mapOrigin, activeMap, { bridgeReachable: bridgeHealth?.status === 'ok' })
  const dogzillaWaypointReadiness = effectiveBridgeHealthBody
    ? validateDogzillaWaypoints({
        waypointConfig,
        mapOrigin,
        mapMetadata: activeMap || mapOrigin?.map || null,
        bridgeHealth: effectiveBridgeHealthBody,
      })
    : null
  const bridgeRobot = applyMapOriginStatusToRobotState(
    applyMapOriginToRobotState(
      buildRobotStateFromBridge(bridgeState, robotRuntimeConfig, poseState),
      mapOriginStatus.configured ? mapOrigin : null,
    ),
    mapOriginStatus,
  )
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
  const poseTrack = bridgeRobot?.pose ? getDogzillaPoseTrack() : []
  const robots = bridgeRobot
    ? [bridgeRobot, ...streamRobots.filter((robot) => robot.uuid !== bridgeRobot.uuid)]
    : streamRobots

  const currentBridgeHealthBody = null
  const bridgeHealthCachedForDisplay = !!cachedBridgeHealth

  if (isNav2StabilityTrackerEnabled() && effectiveBridgeHealthBody) {
    deriveNav2StabilityFromHealth(effectiveBridgeHealthBody, {
      source: bridgeHealthCachedForDisplay ? 'state-snapshot-cache' : 'state-snapshot',
      bridgeDestination: bridgeHealth?.destination || null,
    })
  }

  return {
    ...streamSnapshot,
    status,
    activeRobot,
    robots,
    streamPath: ROBOT_STATE_STREAM_PATH,
    activeTarget: robotRuntimeConfig.activeTarget,
    bridgeState,
    bridgeHealth,
    bridgeHealthCachedForDisplay,
    poseState,
    mapOrigin: mapOriginStatus,
    poseTrack,
    navigationStatus: deriveNavigationStatus({
      poseTrack,
      dispatchState: navigationDispatch,
      mapOriginStatus,
      bridgeRuntime,
      poseState,
      dogzillaWaypointReadiness,
    }),
    nav2Stability: isNav2StabilityTrackerEnabled() ? getNav2Stability() : null,
  }
}

function getFreshDogzillaBridgeHealth(now = Date.now()) {
  if (!lastDogzillaBridgeHealth) {
    return null
  }
  if (now - lastDogzillaBridgeHealth.receivedAt > DOGZILLA_HEALTH_CACHE_MAX_AGE_MS) {
    return null
  }
  return lastDogzillaBridgeHealth
}

function refreshDogzillaBridgeHealth(runtimeConfig = {}, ros2Config = {}) {
  if (dogzillaBridgeHealthRefresh) {
    return dogzillaBridgeHealthRefresh
  }

  const healthConfig = withRobotStateProbeMinimumTimeout(ros2Config, DOGZILLA_HEALTH_REFRESH_TIMEOUT_MS)
  dogzillaBridgeHealthRefresh = probeRobotSidecarHealth(runtimeConfig, healthConfig)
    .then((health) => {
      if (health?.status === 'ok') {
        lastDogzillaBridgeHealth = {
          ...health,
          receivedAt: Date.now(),
        }
      }
      return health
    })
    .finally(() => {
      dogzillaBridgeHealthRefresh = null
    })

  return dogzillaBridgeHealthRefresh
}

function withRobotStateProbeMinimumTimeout(ros2Config = {}, timeoutMs = 4000) {
  const transport = ros2Config.transport ?? {}
  const configuredTimeoutMs = Number(transport.timeoutMs)
  const nextTimeoutMs = Math.max(
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : 0,
    timeoutMs,
  )

  return {
    ...ros2Config,
    transport: {
      ...transport,
      timeoutMs: nextTimeoutMs,
    },
  }
}
function withRobotStateProbeTimeout(ros2Config = {}, timeoutMs = 4000) {
  const transport = ros2Config.transport ?? {}
  const configuredTimeoutMs = Number(transport.timeoutMs)
  const cappedTimeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? Math.min(configuredTimeoutMs, timeoutMs)
    : timeoutMs

  return {
    ...ros2Config,
    transport: {
      ...transport,
      timeoutMs: cappedTimeoutMs,
    },
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

function recordDogzillaMapPose(robot) {
  const pose = robot?.pose
  const telemetry = robot?.telemetry || {}
  if (!pose || !isRenderableMapFrame(pose.frame) || telemetry.waypointSafe !== true) {
    return
  }

  dogzillaPoseTrack.push({
    x: pose.x,
    y: pose.y,
    theta: pose.theta ?? pose.yaw,
    yaw: pose.yaw ?? pose.theta,
    frame: pose.frame,
    sourceFrame: pose.sourceFrame || '',
    originLabel: pose.originLabel || '',
    originSavedAt: pose.originSavedAt || '',
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

function applyMapOriginToRobotState(robot, mapOrigin) {
  if (!robot?.pose || !mapOrigin) {
    return robot
  }

  const pose = applyMapOriginToPose(robot.pose, mapOrigin)
  if (pose === robot.pose || pose?.frame !== APP_MAP_FRAME) {
    return robot
  }

  return {
    ...robot,
    pose,
    telemetry: {
      ...robot.telemetry,
      poseFrame: APP_MAP_FRAME,
      poseSourceFrame: 'map',
      mapOriginConfigured: true,
      mapOriginLabel: pose.originLabel,
      mapOriginSavedAt: pose.originSavedAt,
      mapSource: 'saved-dogzilla-map-origin',
    },
  }
}

function applyMapOriginStatusToRobotState(robot, mapOriginStatus) {
  if (!robot) {
    return robot
  }

  return {
    ...robot,
    telemetry: {
      ...robot.telemetry,
      mapOriginConfigured: mapOriginStatus?.configured === true,
      mapOriginStatus: mapOriginStatus?.status || 'missing',
      mapOriginLabel: mapOriginStatus?.origin?.label || robot.telemetry?.mapOriginLabel || '',
      mapOriginSavedAt: mapOriginStatus?.origin?.savedAt || robot.telemetry?.mapOriginSavedAt || '',
      activeMapId: mapOriginStatus?.activeMap?.id || '',
      activeMapFingerprint: mapOriginStatus?.activeMap?.fingerprint || '',
      originMapId: mapOriginStatus?.identity?.id || '',
      originMapFingerprint: mapOriginStatus?.identity?.fingerprint || '',
    },
  }
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
  const mapPose = resolveRobotPoseFromBridgeState(poseState)
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

function isRenderableMapFrame(frame) {
  return ['map', APP_MAP_FRAME].includes(normalizeFrameId(frame))
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
