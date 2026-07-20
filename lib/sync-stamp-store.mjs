import { readFile, writeFile, stat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STAMP_PATH = path.resolve(__dirname, '..', 'output', 'pi-ssh', 'sync-stamps.json')

const SYNC_SOURCES = [
  'sidecars/ros2_bridge',
  'sidecars/dogzilla_lib_bridge',
  'sidecars/dogzilla_navigation',
  'sidecars/dogzilla_yolo_vision',
  'sidecars/dogzilla_audio_cue',
  'ros2/dogzilla_bridge',
  'config/robot-ros2.json',
  'config/robot-motion.json',
  'config/robot-actions.json',
  'config/robot-obstacle-avoidance.json',
  'docs/dogzilla-hardware-adapter.md',
  'docs/dogzilla-ssh-workflow.md',
]

export function getSyncSources() {
  return SYNC_SOURCES
}

function stampPath() {
  return STAMP_PATH
}

export async function readSyncStamps() {
  try {
    const raw = await readFile(STAMP_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export async function writeSyncStamps(stamps) {
  await writeFile(STAMP_PATH, JSON.stringify(stamps, null, 2) + '\n', 'utf-8')
}

async function walkMaxMtime(dirPath) {
  let max = 0
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      const sub = await walkMaxMtime(fullPath)
      if (sub > max) max = sub
    } else if (entry.isFile()) {
      try {
        const s = await stat(fullPath)
        if (s.mtimeMs > max) max = s.mtimeMs
      } catch {}
    }
  }

  return max
}

async function computeSourceIdentity(source, rootDir) {
  const absPath = path.resolve(rootDir, source)
  try {
    const s = await stat(absPath)
    if (s.isDirectory()) {
      const maxMtime = await walkMaxMtime(absPath)
      return maxMtime || s.mtimeMs
    }
    return s.mtimeMs
  } catch {
    return 0
  }
}

export async function needsSync(rootDir = path.resolve(__dirname, '..')) {
  const stamps = await readSyncStamps()

  for (const source of SYNC_SOURCES) {
    const current = await computeSourceIdentity(source, rootDir)
    const stored = stamps.sources?.[source]
    if (current !== stored) {
      return true
    }
  }

  return false
}

export async function computeSyncIdentity(rootDir = path.resolve(__dirname, '..')) {
  const sources = {}

  for (const source of SYNC_SOURCES) {
    sources[source] = await computeSourceIdentity(source, rootDir)
  }

  return { sources, _syncedAt: new Date().toISOString() }
}

export async function markSynced(rootDir = path.resolve(__dirname, '..')) {
  const identity = await computeSyncIdentity(rootDir)
  await writeSyncStamps(identity)
  return identity
}
