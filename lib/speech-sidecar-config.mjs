import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const CONFIG_DIR = path.join(ROOT_DIR, 'config')

export async function loadSpeechSidecarConfig() {
  return normalizeSpeechSidecarConfig(await readJsonConfig('speech-sidecar.json'))
}

export function normalizeSpeechSidecarConfig(rawConfig = {}) {
  const transport = rawConfig.transport && typeof rawConfig.transport === 'object' ? rawConfig.transport : {}
  const launch = rawConfig.launch && typeof rawConfig.launch === 'object' ? rawConfig.launch : {}

  return {
    transport: {
      kind: typeof transport.kind === 'string' && transport.kind.trim() ? transport.kind.trim() : 'http',
      enabled: transport.enabled ?? true,
      baseUrl: typeof transport.baseUrl === 'string' ? transport.baseUrl.trim() : 'http://127.0.0.1:8892',
      healthPath: typeof transport.healthPath === 'string' ? transport.healthPath.trim() : '/healthz',
      transcribePath: typeof transport.transcribePath === 'string' ? transport.transcribePath.trim() : '/transcribe',
      timeoutMs: Number.isFinite(transport.timeoutMs) ? transport.timeoutMs : 60000,
    },
    launch: {
      managedByApp: launch.managedByApp ?? false,
      pythonPath: typeof launch.pythonPath === 'string' ? launch.pythonPath.trim() : 'python',
      scriptPath: typeof launch.scriptPath === 'string' ? launch.scriptPath.trim() : 'sidecars/parakeet_bridge/server.py',
      scriptArgs: Array.isArray(launch.scriptArgs) ? launch.scriptArgs : [],
      workdir: typeof launch.workdir === 'string' ? launch.workdir.trim() : '.',
      sidecarReadyTimeoutMs: Number.isFinite(launch.sidecarReadyTimeoutMs) ? launch.sidecarReadyTimeoutMs : 120000,
      notes: Array.isArray(launch.notes) ? launch.notes : [],
    },
  }
}

async function readJsonConfig(fileName) {
  const file = await readFile(path.join(CONFIG_DIR, fileName), 'utf-8')
  return JSON.parse(file)
}
