import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
export const DEFAULT_MAP_ORIGIN_FILE = path.join(ROOT_DIR, 'output', 'app-cache', 'dogzilla-map-origin.json')
export const APP_MAP_FRAME = 'app_map'

export async function loadDogzillaMapOrigin(originFile = DEFAULT_MAP_ORIGIN_FILE) {
  try {
    return normalizeMapOrigin(JSON.parse(await readFile(originFile, 'utf-8')))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function saveDogzillaMapOriginFromOccupancyGrid(mapPayload, {
  originFile = DEFAULT_MAP_ORIGIN_FILE,
  label = 'home_origin',
  mapMetadata = null,
} = {}) {
  if (!mapPayload?.ok || !mapPayload?.origin) {
    throw new Error('refusing to save map origin without valid occupancy grid origin')
  }

  const origin = {
    frame: APP_MAP_FRAME,
    sourceFrame: 'map',
    source: 'occupancy-grid',
    label: normalizeString(label) || 'home_origin',
    x: Number(mapPayload.origin.x),
    y: Number(mapPayload.origin.y),
    yaw: Number(mapPayload.origin.yaw ?? mapPayload.origin.theta ?? 0),
    savedAt: new Date().toISOString(),
    ...(mapMetadata ? { map: mapMetadata } : {}),
  }

  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !Number.isFinite(origin.yaw)) {
    throw new Error(`invalid occupancy grid origin: x=${origin.x} y=${origin.y} yaw=${origin.yaw}`)
  }

  await mkdir(path.dirname(originFile), { recursive: true })
  await writeFile(originFile, `${JSON.stringify(origin, null, 2)}\n`, 'utf-8')
  return origin
}

export async function fetchDogzillaMapOriginFromBridge(poseUrl, {
  originFile = DEFAULT_MAP_ORIGIN_FILE,
  label = 'home_origin',
  mapMetadata = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const mapUrl = poseUrl.replace(/\/pose\/?$/, '').replace(/\/+$/, '') + '/map'
  try {
    const response = await fetchImpl(mapUrl)
    const payload = await response.json()
    if (payload?.ok && payload?.origin) {
      return await saveDogzillaMapOriginFromOccupancyGrid(payload, { originFile, label, mapMetadata })
    }
  } catch {
    // Fall through to pose-based origin
  }

  try {
    const response = await fetchImpl(poseUrl)
    const posePayload = await response.json()
    if (response.ok && posePayload?.ok !== false) {
      return await saveDogzillaMapOriginFromPose(posePayload, { originFile, label, mapMetadata })
    }
  } catch {
    // No fallback available
  }

  return null
}

export async function saveDogzillaMapOriginFromPose(posePayload, {
  originFile = DEFAULT_MAP_ORIGIN_FILE,
  label = 'home_origin',
  mapMetadata = null,
  requireMapIdentity = false,
} = {}) {
  const pose = normalizePose(posePayload?.mapPose || posePayload?.pose || posePayload)
  if (!pose || pose.frame !== 'map') {
    throw new Error('refusing to save map origin without verified map-frame pose')
  }
  if (requireMapIdentity && !isUsableMapIdentity(mapMetadata)) {
    throw new Error('refusing to save map origin without active map identity')
  }

  const origin = {
    frame: APP_MAP_FRAME,
    sourceFrame: 'map',
    label: normalizeString(label) || 'home_origin',
    x: pose.x,
    y: pose.y,
    yaw: pose.yaw,
    source: pose.source,
    savedAt: new Date().toISOString(),
    ...(mapMetadata ? { map: mapMetadata } : {}),
  }

  await mkdir(path.dirname(originFile), { recursive: true })
  await writeFile(originFile, `${JSON.stringify(origin, null, 2)}\n`, 'utf-8')
  return origin
}

export function mapPoseToAppPose(posePayload, origin) {
  const pose = normalizePose(posePayload?.mapPose || posePayload?.pose || posePayload)
  const normalizedOrigin = normalizeMapOrigin(origin)
  if (!pose || !normalizedOrigin || pose.frame !== 'map') {
    return null
  }
  if (!isDogzillaAppMapTransformOrigin(normalizedOrigin)) {
    return null
  }

  const dx = pose.x - normalizedOrigin.x
  const dy = pose.y - normalizedOrigin.y
  const c = Math.cos(normalizedOrigin.yaw)
  const s = Math.sin(normalizedOrigin.yaw)

  return {
    ...pose,
    frame: APP_MAP_FRAME,
    sourceFrame: 'map',
    x: roundPose(c * dx + s * dy),
    y: roundPose(-s * dx + c * dy),
    yaw: roundPose(wrapRadians(pose.yaw - normalizedOrigin.yaw)),
    theta: roundPose(wrapRadians(pose.yaw - normalizedOrigin.yaw)),
    originLabel: normalizedOrigin.label,
    originSavedAt: normalizedOrigin.savedAt,
  }
}

export function appPoseToMapPose(posePayload, origin) {
  const pose = normalizePose(posePayload)
  const normalizedOrigin = normalizeMapOrigin(origin)
  if (!pose || !normalizedOrigin || pose.frame !== APP_MAP_FRAME) {
    return null
  }
  if (!isDogzillaAppMapTransformOrigin(normalizedOrigin)) {
    return null
  }

  const c = Math.cos(normalizedOrigin.yaw)
  const s = Math.sin(normalizedOrigin.yaw)

  return {
    ...pose,
    frame: 'map',
    sourceFrame: APP_MAP_FRAME,
    x: roundPose(normalizedOrigin.x + c * pose.x - s * pose.y),
    y: roundPose(normalizedOrigin.y + s * pose.x + c * pose.y),
    yaw: roundPose(wrapRadians(pose.yaw + normalizedOrigin.yaw)),
    theta: roundPose(wrapRadians(pose.yaw + normalizedOrigin.yaw)),
    originLabel: normalizedOrigin.label,
    originSavedAt: normalizedOrigin.savedAt,
    originMap: normalizedOrigin.map,
  }
}

export function buildDogzillaMapOriginSnapshot(origin) {
  const normalizedOrigin = normalizeMapOrigin(origin)
  if (!normalizedOrigin) {
    return null
  }

  const identity = getDogzillaMapOriginIdentity(normalizedOrigin)
  return {
    frame: APP_MAP_FRAME,
    sourceFrame: 'map',
    label: normalizedOrigin.label,
    x: normalizedOrigin.x,
    y: normalizedOrigin.y,
    yaw: normalizedOrigin.yaw,
    source: normalizedOrigin.source,
    savedAt: normalizedOrigin.savedAt,
    ...(identity.id ? { mapId: identity.id } : {}),
    ...(identity.fingerprint ? { mapFingerprint: identity.fingerprint } : {}),
    ...(normalizedOrigin.map ? { map: normalizedOrigin.map } : {}),
  }
}

export function resolveAppMapPoseToMapPose(posePayload, {
  currentOrigin = null,
  waypointOrigin = null,
  capturedMapPose = null,
} = {}) {
  const pose = normalizePose(posePayload)
  if (!pose || pose.frame !== APP_MAP_FRAME) {
    return null
  }

  const capturedPose = normalizePose(capturedMapPose)
  const savedWaypointOrigin = normalizeMapOrigin(waypointOrigin)
  if (savedWaypointOrigin) {
    const mapPose = appPoseToMapPose(pose, savedWaypointOrigin)
    if (!mapPose) {
      return null
    }
    return {
      ...mapPose,
      appMapResolution: 'waypoint-origin',
    }
  }

  if (capturedPose?.frame === 'map') {
    return {
      ...capturedPose,
      sourceFrame: APP_MAP_FRAME,
      appMapResolution: 'captured-map-pose',
    }
  }

  const normalizedCurrentOrigin = normalizeMapOrigin(currentOrigin)
  if (!normalizedCurrentOrigin) {
    return null
  }

  const mapPose = appPoseToMapPose(pose, normalizedCurrentOrigin)
  return mapPose ? {
    ...mapPose,
    appMapResolution: 'current-origin',
  } : null
}

export function applyMapOriginToPose(posePayload, origin, { requireMapIdentity = true } = {}) {
  const pose = normalizePose(posePayload)
  const normalizedOrigin = normalizeMapOrigin(origin)
  if (!pose || !normalizedOrigin || pose.frame !== 'map') {
    return posePayload
  }
  if (requireMapIdentity && !hasDogzillaMapOriginIdentity(normalizedOrigin)) {
    return posePayload
  }
  if (!isDogzillaAppMapTransformOrigin(normalizedOrigin)) {
    return posePayload
  }

  const appPose = mapPoseToAppPose(posePayload, normalizedOrigin)
  if (!appPose) {
    return posePayload
  }

  return {
    ...posePayload,
    frame: APP_MAP_FRAME,
    sourceFrame: 'map',
    x: appPose.x,
    y: appPose.y,
    yaw: appPose.yaw,
    theta: appPose.theta,
    originLabel: appPose.originLabel,
    originSavedAt: appPose.originSavedAt,
    mapFramePose: {
      frame: 'map',
      x: pose.x,
      y: pose.y,
      yaw: pose.yaw,
      theta: pose.yaw,
      source: pose.source,
    },
  }
}

export function normalizeMapOrigin(value) {
  if (!value || typeof value !== 'object') {
    return null
  }

  const x = Number(value.x)
  const y = Number(value.y)
  const yaw = Number(value.yaw ?? value.theta)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(yaw)) {
    return null
  }

  return {
    frame: APP_MAP_FRAME,
    sourceFrame: 'map',
    label: normalizeString(value.label) || 'home_origin',
    x,
    y,
    yaw,
    source: normalizeString(value.source),
    savedAt: normalizeString(value.savedAt),
    map: value.map && typeof value.map === 'object' ? value.map : null,
  }
}

export function getDogzillaMapOriginIdentity(origin) {
  const normalizedOrigin = normalizeMapOrigin(origin)
  const map = normalizedOrigin?.map && typeof normalizedOrigin.map === 'object'
    ? normalizedOrigin.map
    : {}

  return {
    id: normalizeString(map.id || map.mapId),
    fingerprint: normalizeString(map.fingerprint || map.mapFingerprint),
    savedAt: normalizeString(map.savedAt),
    yaml: normalizeString(map.yaml),
    pgm: normalizeString(map.pgm),
    pbstream: normalizeString(map.pbstream),
  }
}

export function hasDogzillaMapOriginIdentity(origin) {
  const identity = getDogzillaMapOriginIdentity(origin)
  return !!(identity.id && identity.fingerprint)
}

export function isDogzillaAppMapTransformOrigin(origin) {
  const normalizedOrigin = normalizeMapOrigin(origin)
  return !!normalizedOrigin && normalizedOrigin.source !== 'occupancy-grid'
}

export function getDogzillaMapOriginStatus(origin, activeMap = null, options = {}) {
  const normalizedOrigin = normalizeMapOrigin(origin)
  if (!normalizedOrigin) {
    return {
      configured: false,
      status: 'missing',
      origin: null,
      identity: getDogzillaMapOriginIdentity(null),
      activeMap: normalizeMapIdentity(activeMap),
    }
  }

  const identity = getDogzillaMapOriginIdentity(normalizedOrigin)
  const activeIdentity = normalizeMapIdentity(activeMap)
  if (!identity.id || !identity.fingerprint) {
    return {
      configured: false,
      status: 'stale-missing-map-identity',
      origin: normalizedOrigin,
      identity,
      activeMap: activeIdentity,
    }
  }

  if (!activeIdentity.id || !activeIdentity.fingerprint) {
    if (options.bridgeReachable === false) {
      return {
        configured: false,
        status: 'bridge-timeout',
        origin: normalizedOrigin,
        identity,
        activeMap: activeIdentity,
      }
    }
    return {
      configured: false,
      status: 'active-map-identity-unavailable',
      origin: normalizedOrigin,
      identity,
      activeMap: activeIdentity,
    }
  }

  if (
    (activeIdentity.id && identity.id !== activeIdentity.id)
    || (activeIdentity.fingerprint && identity.fingerprint !== activeIdentity.fingerprint)
  ) {
    return {
      configured: false,
      status: 'stale-map-mismatch',
      origin: normalizedOrigin,
      identity,
      activeMap: activeIdentity,
    }
  }

  return {
    configured: true,
    status: 'ready',
    origin: normalizedOrigin,
    identity,
    activeMap: activeIdentity,
  }
}

function normalizeMapIdentity(map) {
  const value = map && typeof map === 'object' ? map : {}
  return {
    id: normalizeString(value.id || value.mapId),
    fingerprint: normalizeString(value.fingerprint || value.mapFingerprint),
    savedAt: normalizeString(value.savedAt),
    yaml: normalizeString(value.yaml),
    pgm: normalizeString(value.pgm),
    pbstream: normalizeString(value.pbstream),
  }
}

function isUsableMapIdentity(map) {
  const identity = normalizeMapIdentity(map)
  return !!(identity.id && identity.fingerprint)
}

export function normalizePose(value) {
  if (!value || typeof value !== 'object') {
    return null
  }

  const x = Number(value.x)
  const y = Number(value.y)
  const yaw = Number(value.yaw ?? value.theta)
  const frame = normalizeString(value.frame || value.frameId || value.frame_id).replace(/^\/+/, '')
  if (!frame || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(yaw)) {
    return null
  }

  return {
    frame,
    x,
    y,
    yaw,
    source: normalizeString(value.source),
  }
}

export function wrapRadians(value) {
  let angle = Number(value)
  if (!Number.isFinite(angle)) {
    return 0
  }

  while (angle > Math.PI) angle -= Math.PI * 2
  while (angle <= -Math.PI) angle += Math.PI * 2
  return angle
}

function roundPose(value) {
  return Math.round(Number(value) * 100000) / 100000
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}
