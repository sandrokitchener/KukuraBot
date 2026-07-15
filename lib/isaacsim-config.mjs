import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const CONFIG_DIR = path.join(ROOT_DIR, 'config')

export async function loadIsaacCommandMapConfig() {
  return normalizeIsaacCommandMapConfig(await readJsonConfig('isaacsim-command-map.json'))
}

export async function loadIsaacSidecarConfig() {
  return normalizeIsaacSidecarConfig(await readJsonConfig('isaacsim-sidecar.json'))
}

export async function loadRobotWaypointsConfig() {
  return normalizeRobotWaypointsConfig(await readJsonConfig('robot-waypoints.json'))
}

export async function loadIsaacSceneWaypointsConfig() {
  return normalizeRobotWaypointsConfig(await readJsonConfig('isaacsim-waypoints.json'))
}

export async function loadRobotActionsConfig() {
  return normalizeRobotActionsConfig(await readJsonConfig('robot-actions.json'))
}

export function normalizeIsaacCommandMapConfig(rawConfig = {}) {
  return {
    activeProfile: typeof rawConfig.activeProfile === 'string' ? rawConfig.activeProfile.trim() : '',
    profiles: rawConfig.profiles && typeof rawConfig.profiles === 'object' ? rawConfig.profiles : {},
  }
}

export function normalizeIsaacSidecarConfig(rawConfig = {}) {
  const transport = rawConfig.transport && typeof rawConfig.transport === 'object' ? rawConfig.transport : {}
  const launch = rawConfig.launch && typeof rawConfig.launch === 'object' ? rawConfig.launch : {}
  const upstream = rawConfig.upstream && typeof rawConfig.upstream === 'object' ? rawConfig.upstream : {}

  return {
    transport: {
      kind: typeof transport.kind === 'string' && transport.kind.trim() ? transport.kind.trim() : 'http',
      enabled: transport.enabled ?? false,
      dryRun: transport.dryRun ?? true,
      dispatchOnChat: transport.dispatchOnChat ?? false,
      baseUrl: typeof transport.baseUrl === 'string' ? transport.baseUrl.trim() : 'http://127.0.0.1:8891',
      healthPath: typeof transport.healthPath === 'string' ? transport.healthPath.trim() : '/healthz',
      commandsPath: typeof transport.commandsPath === 'string' ? transport.commandsPath.trim() : '/commands',
      timeoutMs: Number.isFinite(transport.timeoutMs) ? transport.timeoutMs : 3000,
    },
    launch: {
      managedByApp: launch.managedByApp ?? false,
      pythonPath: typeof launch.pythonPath === 'string' ? launch.pythonPath.trim() : 'python',
      scriptPath: typeof launch.scriptPath === 'string' ? launch.scriptPath.trim() : 'sidecars/isaac_bridge/server.py',
      scriptArgs: Array.isArray(launch.scriptArgs) ? launch.scriptArgs : [],
      workdir: typeof launch.workdir === 'string' ? launch.workdir.trim() : '.',
      sidecarReadyTimeoutMs: Number.isFinite(launch.sidecarReadyTimeoutMs) ? launch.sidecarReadyTimeoutMs : 10000,
      isaacSimLaunchEnabled: launch.isaacSimLaunchEnabled ?? false,
      isaacSimLaunchScriptPath:
        typeof launch.isaacSimLaunchScriptPath === 'string' ? launch.isaacSimLaunchScriptPath.trim() : '',
      isaacSimLaunchArgs: Array.isArray(launch.isaacSimLaunchArgs) ? launch.isaacSimLaunchArgs : [],
      notes: Array.isArray(launch.notes) ? launch.notes : [],
    },
    upstream: {
      integrationMode:
        typeof upstream.integrationMode === 'string' && upstream.integrationMode.trim()
          ? upstream.integrationMode.trim()
          : 'external-python-sidecar',
      isaacEntryPath: typeof upstream.isaacEntryPath === 'string' ? upstream.isaacEntryPath.trim() : '',
      stagePath: typeof upstream.stagePath === 'string' ? upstream.stagePath.trim() : '',
      notes: Array.isArray(upstream.notes) ? upstream.notes : [],
    },
  }
}

export function normalizeRobotWaypointsConfig(rawConfig = {}) {
  return {
    schemaVersion: Number.isInteger(rawConfig.schemaVersion) ? rawConfig.schemaVersion : 1,
    activeSet: typeof rawConfig.activeSet === 'string' ? rawConfig.activeSet.trim() : '',
    sets: rawConfig.sets && typeof rawConfig.sets === 'object' ? rawConfig.sets : {},
  }
}

export function normalizeRobotActionsConfig(rawConfig = {}) {
  return {
    activeMap: typeof rawConfig.activeMap === 'string' ? rawConfig.activeMap.trim() : '',
    maps: rawConfig.maps && typeof rawConfig.maps === 'object' ? rawConfig.maps : {},
  }
}

async function readJsonConfig(fileName) {
  const file = await readFile(path.join(CONFIG_DIR, fileName), 'utf-8')
  return JSON.parse(file)
}
