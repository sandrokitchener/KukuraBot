import { getDogzillaAudioCueHealth } from './dogzilla-audio-cue-client.mjs'
import { getDogzillaCameraStatus } from './dogzilla-camera-proxy.mjs'
import { loadDogzillaConnectionConfig } from './dogzilla-connection-center.mjs'
import {
  getDogzillaLidarHealth,
  getDogzillaRobotPose,
} from './dogzilla-lidar-client.mjs'
import { getIsaacSidecarHealth } from './isaacsim-sidecar-client.mjs'
import { getRobotSidecarHealth } from './robot-sidecar-client.mjs'
import { getSpeechSidecarHealth } from './speech-sidecar-client.mjs'

const DEFAULT_PROBE_TIMEOUT_MS = 1800
const DEFAULT_ROBOT_BRIDGE_PROBE_TIMEOUT_MS = 8_000
const ROBOT_HTTP_TARGET_KINDS = new Set(['dogzilla-direct', 'ros2-bridge'])

export async function buildSystemHealthz(options = {}) {
  const checkedAt = normalizeDate(options.checkedAt || options.now) || new Date()
  const probeResults = options.probeResults || await collectHealthzProbes(options)

  return buildHealthzPayload({
    ...options,
    checkedAt,
    probeResults,
  })
}

export async function collectHealthzProbes(options = {}) {
  const timeoutMs = normalizePositiveNumber(options.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS)
  const robotBridgeTimeoutMs = normalizePositiveNumber(
    options.robotBridgeTimeoutMs,
    Math.max(timeoutMs, DEFAULT_ROBOT_BRIDGE_PROBE_TIMEOUT_MS),
  )
  const loadDogzillaConnectionConfigImpl =
    options.loadDogzillaConnectionConfigImpl || loadDogzillaConnectionConfig
  const getRobotSidecarHealthImpl = options.getRobotSidecarHealthImpl || getRobotSidecarHealth
  const getDogzillaLidarHealthImpl = options.getDogzillaLidarHealthImpl || getDogzillaLidarHealth
  const getDogzillaRobotPoseImpl = options.getDogzillaRobotPoseImpl || getDogzillaRobotPose
  const getDogzillaCameraStatusImpl = options.getDogzillaCameraStatusImpl || getDogzillaCameraStatus
  const getDogzillaAudioCueHealthImpl = options.getDogzillaAudioCueHealthImpl || getDogzillaAudioCueHealth
  const getSpeechSidecarHealthImpl = options.getSpeechSidecarHealthImpl || getSpeechSidecarHealth
  const getIsaacSidecarHealthImpl = options.getIsaacSidecarHealthImpl || getIsaacSidecarHealth
  const buildRobotStateSnapshotImpl = options.buildRobotStateSnapshotImpl || null
  const fetchImpl = options.fetchImpl || fetch

  const dogzillaConfig = await runTimedProbe(
    'dogzilla-config',
    () => loadDogzillaConnectionConfigImpl(),
    timeoutMs,
  )
  const config = dogzillaConfig && typeof dogzillaConfig === 'object' && dogzillaConfig.status !== 'error'
    ? dogzillaConfig
    : {}

  const [
    robotState,
    robotBridge,
    lidarHealth,
    pose,
    camera,
    vision,
    audio,
    speech,
    isaac,
  ] = await Promise.all([
    buildRobotStateSnapshotImpl
      ? runTimedProbe('robot-state', () => buildRobotStateSnapshotImpl(), timeoutMs)
      : Promise.resolve(null),
    runTimedProbe('robot-bridge', () => getRobotSidecarHealthImpl(), robotBridgeTimeoutMs),
    runTimedProbe('lidar-health', () => getDogzillaLidarHealthImpl({ config, timeoutMs }), timeoutMs),
    runTimedProbe('pose', () => getDogzillaRobotPoseImpl({ config, timeoutMs }), timeoutMs),
    runTimedProbe('camera', () => getDogzillaCameraStatusImpl({ config, tcpTimeoutMs: timeoutMs }), timeoutMs),
    runTimedProbe('vision', () => fetchVisionHealth(config, { fetchImpl, timeoutMs }), timeoutMs),
    runTimedProbe('audio', () => getDogzillaAudioCueHealthImpl({ config, timeoutMs }), timeoutMs),
    runTimedProbe('speech', () => getSpeechSidecarHealthImpl(), timeoutMs),
    runTimedProbe('isaac', () => getIsaacSidecarHealthImpl(), timeoutMs),
  ])

  return {
    dogzillaConfig: config,
    robotState,
    robotBridge,
    lidarHealth,
    pose,
    camera,
    vision,
    audio,
    speech,
    isaac,
  }
}

export function buildHealthzPayload({
  generationId = '',
  startedAt = '',
  checkedAt = new Date(),
  uptimeSec = null,
  pid = process.pid,
  probeResults = {},
} = {}) {
  const checkedDate = normalizeDate(checkedAt) || new Date()
  const checkedIso = checkedDate.toISOString()
  const appStartedAt = normalizeIsoTimestamp(startedAt)
  const sensors = buildSensors(probeResults, checkedDate)
  const sidecars = buildSidecars(probeResults)
  const requiredSensors = Object.values(sensors).filter((sensor) => sensor.required)
  const failedRequiredSensors = requiredSensors.filter((sensor) => sensor.ok !== true)
  const failedEnabledSensors = Object.values(sensors)
    .filter((sensor) => sensor.enabled !== false && sensor.status !== 'disabled' && sensor.ok !== true)

  return {
    ok: failedRequiredSensors.length === 0,
    status: failedRequiredSensors.length > 0
      ? 'error'
      : failedEnabledSensors.length > 0
        ? 'degraded'
        : 'ok',
    generationId: normalizeString(generationId),
    startedAt: appStartedAt,
    checkedAt: checkedIso,
    uptimeSec: normalizeNullableNumber(uptimeSec),
    pid,
    authority: 'robo-doge-node-app',
    sensors,
    sidecars,
    failedRequiredSensors: failedRequiredSensors.map((sensor) => sensor.name),
    failedEnabledSensors: failedEnabledSensors.map((sensor) => sensor.name),
  }
}

function buildSensors(probeResults, checkedAt) {
  const robotState = objectOrNull(probeResults.robotState)
  const activeRobot = objectOrNull(robotState?.activeRobot)
  const telemetry = objectOrNull(activeRobot?.telemetry)
  const activeTarget = objectOrNull(robotState?.activeTarget)
  const targetKind = normalizeString(activeTarget?.kind)
  const robotBridge = objectOrNull(probeResults.robotBridge)
  const lidarHealth = objectOrNull(probeResults.lidarHealth)
  const pose = objectOrNull(probeResults.pose)
  const camera = objectOrNull(probeResults.camera)
  const vision = objectOrNull(probeResults.vision)
  const audio = objectOrNull(probeResults.audio)
  const speech = objectOrNull(probeResults.speech)
  const dogzillaConfig = objectOrNull(probeResults.dogzillaConfig)

  return {
    robotControl: compactObject({
      name: 'robotControl',
      ok: robotBridge?.status === 'ok',
      status: normalizeStatus(robotBridge),
      required: ROBOT_HTTP_TARGET_KINDS.has(targetKind),
      enabled: robotBridge?.status !== 'inactive-target' && robotBridge?.status !== 'disabled',
      authority: robotControlAuthority(robotState, robotBridge),
      ageSec: ageFromIso(activeRobot?.receivedAt || activeRobot?.timestamp, checkedAt),
      receivedAt: normalizeIsoTimestamp(activeRobot?.receivedAt || activeRobot?.timestamp),
      destination: normalizeString(robotBridge?.destination),
      activeTarget: targetKind || normalizeString(robotBridge?.activeTarget),
      error: normalizeProbeError(robotBridge),
      detail: normalizeString(robotBridge?.body?.runtime?.importError || robotBridge?.body?.runtime?.robotError),
    }),
    battery: compactObject({
      name: 'battery',
      ok: telemetry?.battery !== null && telemetry?.battery !== undefined,
      status: normalizeString(telemetry?.batteryStatus)
        || normalizeString(telemetry?.batteryReadStatus)
        || (activeRobot ? 'unavailable' : normalizeStatus(robotState)),
      required: targetKind === 'dogzilla-direct',
      enabled: Boolean(activeRobot || robotState),
      authority: normalizeString(telemetry?.batterySource) || 'DOGZILLA Direct Bridge /state',
      ageSec: ageFromIso(telemetry?.batteryLastKnownAt || activeRobot?.timestamp || activeRobot?.receivedAt, checkedAt),
      receivedAt: normalizeIsoTimestamp(telemetry?.batteryLastKnownAt || activeRobot?.timestamp || activeRobot?.receivedAt),
      value: telemetry?.battery ?? null,
      raw: telemetry?.batteryRaw ?? null,
      unit: normalizeString(telemetry?.batteryUnit),
      readStatus: normalizeString(telemetry?.batteryReadStatus),
      error: normalizeString(telemetry?.batteryReadError),
    }),
    imu: compactObject({
      name: 'imu',
      ok: Number.isFinite(telemetry?.roll) || Number.isFinite(telemetry?.pitch) || Number.isFinite(telemetry?.yaw),
      status: activeRobot ? 'ok' : normalizeStatus(robotState),
      required: false,
      enabled: Boolean(activeRobot || robotState),
      authority: 'DOGZILLA Direct Bridge /state',
      ageSec: ageFromIso(activeRobot?.timestamp || activeRobot?.receivedAt, checkedAt),
      receivedAt: normalizeIsoTimestamp(activeRobot?.timestamp || activeRobot?.receivedAt),
      roll: normalizeNullableNumber(telemetry?.roll),
      pitch: normalizeNullableNumber(telemetry?.pitch),
      yaw: normalizeNullableNumber(telemetry?.yaw),
    }),
    lidarScan: compactObject({
      name: 'lidarScan',
      ok: lidarHealth?.ok === true,
      status: normalizeStatus(lidarHealth),
      required: dogzillaConfig?.lidar?.enabled === true,
      enabled: lidarHealth?.status !== 'disabled',
      authority: lidarAuthority(lidarHealth),
      ageSec: normalizeNullableNumber(lidarHealth?.latestScanAgeSec),
      destination: normalizeString(lidarHealth?.destination || dogzillaConfig?.lidar?.rosbridgeUrl),
      topic: normalizeString(lidarHealth?.topic || dogzillaConfig?.lidar?.topic || '/scan'),
      frames: normalizeNullableNumber(lidarHealth?.frames),
      error: normalizeProbeError(lidarHealth),
    }),
    mapPose: buildMapPoseSensor({ pose, telemetry, activeRobot, dogzillaConfig, checkedAt }),
    mapOrigin: buildMapOriginSensor({ robotState, activeTarget }),
    camera: compactObject({
      name: 'camera',
      ok: camera?.ok === true,
      status: normalizeStatus(camera),
      required: Boolean(dogzillaConfig?.camera?.streamUrl),
      enabled: camera?.status !== 'unconfigured',
      authority: dogzillaConfig?.camera?.processed === true
        ? 'DOGZILLA YOLO vision sidecar'
        : 'Yahboom DOGZILLA vendor camera app',
      ageSec: null,
      destination: normalizeString(camera?.streamUrl || dogzillaConfig?.camera?.streamUrl),
      detail: normalizeString(camera?.detail),
      error: normalizeProbeError(camera),
    }),
    yoloVision: compactObject({
      name: 'yoloVision',
      ok: vision?.ok === true,
      status: normalizeStatus(vision),
      required: dogzillaConfig?.vision?.enabled === true && dogzillaConfig?.camera?.processed === true,
      enabled: dogzillaConfig?.vision?.enabled === true,
      authority: 'DOGZILLA YOLO vision sidecar',
      ageSec: normalizeNullableNumber(vision?.latestFrameAgeSec),
      destination: normalizeString(vision?.destination || dogzillaConfig?.vision?.statusUrl),
      frames: normalizeNullableNumber(vision?.frames),
      inferences: normalizeNullableNumber(vision?.inferences),
      detections: normalizeNullableNumber(vision?.detections),
      modelLoaded: vision?.modelLoaded === true,
      error: normalizeProbeError(vision),
    }),
    audioCue: compactObject({
      name: 'audioCue',
      ok: audio?.ok === true || audio?.body?.ok === true,
      status: normalizeStatus(audio),
      required: dogzillaConfig?.audio?.enabled === true,
      enabled: audio?.status !== 'disabled',
      authority: 'DOGZILLA audio cue sidecar',
      ageSec: null,
      destination: normalizeString(audio?.destination || dogzillaConfig?.audio?.healthUrl),
      lastCue: normalizeString(audio?.body?.lastCue),
      playCount: normalizeNullableNumber(audio?.body?.playCount),
      error: normalizeProbeError(audio) || normalizeString(audio?.body?.lastError),
    }),
    speech: compactObject({
      name: 'speech',
      ok: speech?.status === 'ok' || speech?.body?.ok === true,
      status: normalizeStatus(speech),
      required: false,
      enabled: speech?.status !== 'disabled',
      authority: normalizeString(speech?.body?.backend)
        ? `speech sidecar:${speech.body.backend}`
        : 'speech sidecar',
      ageSec: null,
      destination: normalizeString(speech?.destination),
      modelId: normalizeString(speech?.body?.modelId),
      error: normalizeProbeError(speech) || normalizeString(speech?.body?.lastError),
    }),
  }
}

function buildMapOriginSensor({ robotState, activeTarget }) {
  const mapOrigin = objectOrNull(robotState?.mapOrigin)
  const status = normalizeString(mapOrigin?.status) || 'missing'
  const targetKind = normalizeString(activeTarget?.kind)

  return compactObject({
    name: 'mapOrigin',
    ok: mapOrigin?.configured === true,
    status,
    required: false,
    enabled: targetKind === 'dogzilla-direct' || Boolean(mapOrigin),
    authority: 'Robo-Doge saved DOGZILLA charger origin',
    originLabel: normalizeString(mapOrigin?.origin?.label),
    originSavedAt: normalizeIsoTimestamp(mapOrigin?.origin?.savedAt),
    detail: status === 'ready'
      ? 'Saved charger origin is set.'
      : 'No saved DOGZILLA charger origin.',
  })
}

function buildMapPoseSensor({ pose, telemetry, activeRobot, dogzillaConfig, checkedAt }) {
  const poseBody = objectOrNull(pose?.mapPose) || objectOrNull(pose?.pose) || objectOrNull(activeRobot?.pose)
  const poseAge = normalizeNullableNumber(poseBody?.ageSec)
    ?? ageFromIso(poseBody?.receivedAt || activeRobot?.timestamp || activeRobot?.receivedAt, checkedAt)

  return compactObject({
    name: 'mapPose',
    ok: pose?.waypointSafe === true || (poseBody?.frame === 'map' && telemetry?.waypointSafe === true),
    status: normalizeStatus(pose) || normalizeString(telemetry?.poseStatus),
    required: dogzillaConfig?.lidar?.enabled === true,
    enabled: pose?.status !== 'disabled',
    authority: normalizeString(poseBody?.source || telemetry?.poseSource) || 'DOGZILLA LiDAR bridge map TF',
    ageSec: poseAge,
    receivedAt: normalizeIsoTimestamp(poseBody?.receivedAt || activeRobot?.timestamp || activeRobot?.receivedAt),
    frame: normalizeString(poseBody?.frame || telemetry?.poseFrame),
    childFrame: normalizeString(poseBody?.childFrame),
    waypointSafe: pose?.waypointSafe === true || telemetry?.waypointSafe === true,
    destination: normalizeString(pose?.destination || dogzillaConfig?.lidar?.poseUrl),
    error: normalizeProbeError(pose) || normalizeString(telemetry?.poseError),
  })
}

function buildSidecars(probeResults) {
  return {
    robotBridge: summarizeSidecar(probeResults.robotBridge, 'robot bridge'),
    lidarBridge: summarizeSidecar(probeResults.lidarHealth, 'DOGZILLA rosbridge'),
    yoloVision: summarizeSidecar(probeResults.vision, 'DOGZILLA YOLO vision sidecar'),
    audioCue: summarizeSidecar(probeResults.audio, 'DOGZILLA audio cue sidecar'),
    speech: summarizeSidecar(probeResults.speech, 'speech sidecar'),
    isaac: summarizeSidecar(probeResults.isaac, 'Isaac sidecar'),
  }
}

function summarizeSidecar(probe, authority) {
  const value = objectOrNull(probe)
  return compactObject({
    ok: value?.ok === true || value?.status === 'ok',
    status: normalizeStatus(value),
    authority,
    destination: normalizeString(value?.destination),
    responseStatus: normalizeNullableNumber(value?.responseStatus),
    error: normalizeProbeError(value),
  })
}

async function fetchVisionHealth(config = {}, { fetchImpl = fetch, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const vision = config?.vision || {}
  if (vision.enabled !== true || !vision.statusUrl) {
    return {
      ok: false,
      status: 'disabled',
      destination: normalizeString(vision.statusUrl),
      detail: 'DOGZILLA YOLO vision sidecar is not enabled.',
    }
  }

  try {
    const response = await fetchImpl(vision.statusUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await safeReadJson(response)
    const bodyObject = objectOrNull(body) || {}
    const ok = response.ok && bodyObject.ok === true
    return {
      ...bodyObject,
      ok,
      status: ok ? 'ok' : bodyObject.status || 'error',
      destination: vision.statusUrl,
      responseStatus: response.status,
      error: ok ? '' : normalizeString(bodyObject.error) || `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      ok: false,
      status: 'error',
      destination: vision.statusUrl,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runTimedProbe(name, probe, timeoutMs) {
  let timeout = null
  const task = Promise.resolve()
    .then(probe)
    .catch((error) => ({
      ok: false,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    }))
  const deadline = new Promise((resolve) => {
    timeout = setTimeout(() => {
      resolve({
        ok: false,
        status: 'timeout',
        error: `${name} timed out after ${timeoutMs}ms.`,
      })
    }, timeoutMs)
  })

  try {
    return await Promise.race([task, deadline])
  } finally {
    clearTimeout(timeout)
  }
}

async function safeReadJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function robotControlAuthority(robotState, robotBridge) {
  const target = objectOrNull(robotState?.activeTarget)
  const runtime = objectOrNull(robotBridge?.body?.runtime)
  const mode = normalizeString(robotBridge?.body?.mode)
  const targetKind = normalizeString(target?.kind)
  const serialPort = normalizeString(runtime?.serialPort)

  if (targetKind || mode || serialPort) {
    return [targetKind || mode || 'robot bridge', serialPort].filter(Boolean).join(' ')
  }

  return 'robot bridge'
}

function lidarAuthority(lidarHealth) {
  const driver = normalizeString(lidarHealth?.driver) || 'DOGZILLA rosbridge'
  const topic = normalizeString(lidarHealth?.topic) || '/scan'
  return `${driver} ${topic}`
}

function normalizeStatus(value) {
  return normalizeString(value?.status) || (value?.ok === true ? 'ok' : 'unknown')
}

function normalizeProbeError(value) {
  return normalizeString(value?.error || value?.detail)
}

function objectOrNull(value) {
  return value && typeof value === 'object' ? value : null
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) {
      return new Date(parsed)
    }
  }

  return null
}

function normalizeIsoTimestamp(value) {
  const date = normalizeDate(value)
  return date ? date.toISOString() : ''
}

function ageFromIso(value, checkedAt) {
  const date = normalizeDate(value)
  if (!date) {
    return null
  }

  return roundSeconds((checkedAt.getTime() - date.getTime()) / 1000)
}

function normalizePositiveNumber(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback
}

function normalizeNullableNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function roundSeconds(value) {
  if (!Number.isFinite(value)) {
    return null
  }

  return Math.max(0, Math.round(value * 1000) / 1000)
}
