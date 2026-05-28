import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')

export const DEFAULT_RECON_SNAPSHOT_CACHE_DIR = path.join(ROOT_DIR, 'output', 'app-cache', 'recon-snapshots')
export const RECON_SNAPSHOT_API_PATH = '/api/recon/snapshots'

export async function saveReconSnapshot({
  imageBuffer,
  imageContentType = 'image/jpeg',
  robotState = null,
  lidarScan = null,
  map = null,
  camera = null,
  note = '',
  tags = [],
  capturedAt = new Date(),
  cacheDir = DEFAULT_RECON_SNAPSHOT_CACHE_DIR,
} = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error('Recon snapshot image must be a non-empty Buffer.')
  }

  const capturedDate = normalizeDate(capturedAt)
  const id = buildSnapshotId(capturedDate)
  const safeContentType = normalizeImageContentType(imageContentType)
  const extension = extensionForContentType(safeContentType)
  const imageFileName = `${id}.${extension}`
  const metadataFileName = `${id}.json`
  const snapshotDir = path.resolve(cacheDir)
  const imagePath = resolveCacheFile(snapshotDir, imageFileName)
  const metadataPath = resolveCacheFile(snapshotDir, metadataFileName)
  const imageHash = createHash('sha256').update(imageBuffer).digest('hex')

  await mkdir(snapshotDir, { recursive: true })
  await writeFile(imagePath, imageBuffer)

  const record = normalizeReconSnapshotRecord({
    id,
    kind: 'recon.snapshot',
    capturedAt: capturedDate.toISOString(),
    note: normalizeNote(note),
    tags: normalizeTags(tags),
    image: {
      contentType: safeContentType,
      bytes: imageBuffer.length,
      sha256: imageHash,
      fileName: imageFileName,
      path: imagePath,
      url: `${RECON_SNAPSHOT_API_PATH}/${encodeURIComponent(id)}/image`,
    },
    camera: cloneJson(camera),
    robotState: cloneJson(robotState),
    activeRobot: cloneJson(robotState?.activeRobot ?? null),
    lidarScan: cloneJson(lidarScan),
    map: cloneJson(map),
  }, snapshotDir)

  await writeFile(metadataPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8')
  return record
}

export async function listReconSnapshots({
  cacheDir = DEFAULT_RECON_SNAPSHOT_CACHE_DIR,
  limit = 24,
} = {}) {
  const snapshotDir = path.resolve(cacheDir)
  let entries

  try {
    entries = await readdir(snapshotDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return []
    }
    throw error
  }

  const records = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }

    try {
      const raw = await readFile(resolveCacheFile(snapshotDir, entry.name), 'utf-8')
      records.push(normalizeReconSnapshotRecord(JSON.parse(raw), snapshotDir))
    } catch {
      // Ignore partial or hand-edited cache records; future saves keep working.
    }
  }

  records.sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))
  return records.slice(0, normalizeLimit(limit))
}

export async function readReconSnapshotImage(id, {
  cacheDir = DEFAULT_RECON_SNAPSHOT_CACHE_DIR,
} = {}) {
  const snapshotDir = path.resolve(cacheDir)
  const metadata = await readReconSnapshotMetadata(id, { cacheDir: snapshotDir })
  const imageFileName = normalizeCacheFileName(metadata.image?.fileName)

  if (!imageFileName) {
    const error = new Error(`Recon snapshot "${id}" does not have an image file.`)
    error.code = 'ENOENT'
    throw error
  }

  return {
    metadata,
    buffer: await readFile(resolveCacheFile(snapshotDir, imageFileName)),
    contentType: normalizeImageContentType(metadata.image?.contentType),
  }
}

export async function readReconSnapshotMetadata(id, {
  cacheDir = DEFAULT_RECON_SNAPSHOT_CACHE_DIR,
} = {}) {
  const snapshotDir = path.resolve(cacheDir)
  const safeId = normalizeSnapshotId(id)

  if (!safeId) {
    const error = new Error('Invalid recon snapshot id.')
    error.code = 'EINVAL'
    throw error
  }

  const metadataPath = resolveCacheFile(snapshotDir, `${safeId}.json`)
  try {
    const raw = await readFile(metadataPath, 'utf-8')
    return normalizeReconSnapshotRecord(JSON.parse(raw), snapshotDir)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const notFound = new Error(`Recon snapshot "${safeId}" was not found.`)
      notFound.code = 'ENOENT'
      throw notFound
    }
    throw error
  }
}

export async function updateReconSnapshotNote(id, {
  note = '',
  tags,
  cacheDir = DEFAULT_RECON_SNAPSHOT_CACHE_DIR,
} = {}) {
  const snapshotDir = path.resolve(cacheDir)
  const safeId = normalizeSnapshotId(id)

  if (!safeId) {
    const error = new Error('Invalid recon snapshot id.')
    error.code = 'EINVAL'
    throw error
  }

  const metadataPath = resolveCacheFile(snapshotDir, `${safeId}.json`)
  const record = await readReconSnapshotMetadata(safeId, { cacheDir: snapshotDir })
  const updated = normalizeReconSnapshotRecord({
    ...record,
    note: normalizeNote(note),
    tags: Array.isArray(tags) ? normalizeTags(tags) : record.tags,
  }, snapshotDir)

  await writeFile(metadataPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf-8')
  return updated
}

function normalizeReconSnapshotRecord(record, snapshotDir) {
  const safeId = normalizeSnapshotId(record?.id)
  if (!safeId) {
    throw new Error('Recon snapshot metadata is missing a valid id.')
  }

  const imageFileName = normalizeCacheFileName(record?.image?.fileName)
  const imagePath = imageFileName
    ? resolveCacheFile(snapshotDir, imageFileName)
    : normalizeString(record?.image?.path)

  return {
    id: safeId,
    kind: record.kind === 'recon.snapshot' ? record.kind : 'recon.snapshot',
    capturedAt: normalizeDate(record.capturedAt).toISOString(),
    note: normalizeNote(record.note),
    tags: normalizeTags(record.tags),
    image: {
      contentType: normalizeImageContentType(record?.image?.contentType),
      bytes: normalizeNonNegativeInteger(record?.image?.bytes),
      sha256: normalizeString(record?.image?.sha256),
      fileName: imageFileName,
      path: imagePath,
      url: `${RECON_SNAPSHOT_API_PATH}/${encodeURIComponent(safeId)}/image`,
    },
    camera: cloneJson(record.camera),
    robotState: cloneJson(record.robotState),
    activeRobot: cloneJson(record.activeRobot ?? record.robotState?.activeRobot ?? null),
    lidarScan: cloneJson(record.lidarScan),
    map: cloneJson(record.map),
  }
}

function buildSnapshotId(date) {
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  return `recon-${stamp}-${randomUUID().slice(0, 8)}`
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : new Date()
}

function normalizeImageContentType(value) {
  const contentType = normalizeString(value).toLowerCase()
  return contentType === 'image/png' ? 'image/png' : 'image/jpeg'
}

function extensionForContentType(contentType) {
  return contentType === 'image/png' ? 'png' : 'jpg'
}

function normalizeNote(value) {
  return normalizeString(value).slice(0, 500)
}

function normalizeTags(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return Array.from(new Set(
    value
      .map((tag) => normalizeString(tag).slice(0, 48))
      .filter(Boolean),
  )).slice(0, 16)
}

function normalizeSnapshotId(value) {
  const id = normalizeString(value)
  return /^[a-z0-9][a-z0-9._-]{0,140}$/i.test(id) ? id : ''
}

function normalizeCacheFileName(value) {
  const fileName = normalizeString(value)
  return /^[a-z0-9][a-z0-9._-]{0,160}\.(jpg|jpeg|png)$/i.test(fileName) ? fileName : ''
}

function normalizeNonNegativeInteger(value) {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : 0
}

function normalizeLimit(value) {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric > 0 ? Math.min(numeric, 100) : 24
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function resolveCacheFile(snapshotDir, fileName) {
  const resolved = path.resolve(snapshotDir, fileName)
  const rootPrefix = `${path.resolve(snapshotDir)}${path.sep}`

  if (!resolved.startsWith(rootPrefix)) {
    throw new Error('Recon snapshot cache path escaped the cache directory.')
  }

  return resolved
}

function cloneJson(value) {
  if (value === undefined) {
    return null
  }

  return JSON.parse(JSON.stringify(value))
}
