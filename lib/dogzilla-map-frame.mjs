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

export async function saveDogzillaMapOriginFromPose(posePayload, {
  originFile = DEFAULT_MAP_ORIGIN_FILE,
  label = 'home_origin',
} = {}) {
  const pose = normalizePose(posePayload?.mapPose || posePayload?.pose || posePayload)
  if (!pose || pose.frame !== 'map') {
    throw new Error('refusing to save map origin without verified map-frame pose')
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

  const c = Math.cos(normalizedOrigin.yaw)
  const s = Math.sin(normalizedOrigin.yaw)

  return {
    ...pose,
    frame: 'map',
    sourceFrame: APP_MAP_FRAME,
    x: roundPose(normalizedOrigin.x + c * pose.x - s * pose.y),
    y: roundPose(normalizedOrigin.y + s * pose.x + c * pose.y),
    yaw: roundPose(wrapRadians(pose.yaw + normalizedOrigin.yaw)),
    originLabel: normalizedOrigin.label,
    originSavedAt: normalizedOrigin.savedAt,
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
  }
}

export function normalizePose(value) {
  if (!value || typeof value !== 'object') {
    return null
  }

  const x = Number(value.x)
  const y = Number(value.y)
  const yaw = Number(value.yaw ?? value.theta)
  const frame = normalizeString(value.frame || value.frameId || value.frame_id)
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
