import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeRobotActionsConfig, normalizeRobotWaypointsConfig } from './isaacsim-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const CONFIG_DIR = path.join(ROOT_DIR, 'config')

const DEFAULT_RUNTIME_TARGETS = {
  isaacsim: {
    label: 'Isaac Sim',
    kind: 'isaacsim',
    managedByApp: true,
    notes: [
      'Use this target when you want local Isaac sidecar dispatch and app-managed Isaac launch.',
    ],
  },
  ros2_real: {
    label: 'ROS2 Real Robot',
    kind: 'ros2-bridge',
    managedByApp: true,
    notes: [
      'Use this target when you want the app to dispatch into the ROS2 bridge sidecar instead of Isaac.',
      'Point transport.baseUrl at the machine that can reach your DOGZILLA ROS2 graph.',
    ],
  },
}

export async function loadRobotRuntimeConfig(options = {}) {
  const rawConfig = await readJsonConfig('robot-runtime.json')
  return normalizeRobotRuntimeConfig(rawConfig, options.env)
}

export async function loadRobotRos2Config() {
  const rawConfig = await readJsonConfig('robot-ros2.json')
  return normalizeRobotRos2Config(rawConfig)
}

export async function loadRobotMotionConfig() {
  const rawConfig = await readJsonConfig('robot-motion.json')
  return normalizeRobotMotionConfig(rawConfig)
}

export async function setActiveRobotTarget(targetId) {
  const nextTargetId = typeof targetId === 'string' ? targetId.trim() : ''

  if (!nextTargetId) {
    throw new Error('Select a robot target first.')
  }

  const configPath = path.join(CONFIG_DIR, 'robot-runtime.json')
  const rawConfig = JSON.parse(await readFile(configPath, 'utf-8'))
  const normalized = normalizeRobotRuntimeConfig(rawConfig)

  if (!normalized.targets[nextTargetId]) {
    throw new Error(`Unknown robot target "${nextTargetId}".`)
  }

  rawConfig.defaultTarget = nextTargetId
  await writeFile(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, 'utf-8')
}

export function normalizeRobotRuntimeConfig(rawConfig = {}, env = process.env) {
  const targets = normalizeRuntimeTargets(rawConfig.targets)
  const targetIds = Object.keys(targets)
  const envTargetId = normalizeString(env.ROBOT_RUNTIME_TARGET)
  const defaultTargetId = normalizeString(rawConfig.defaultTarget)
  const activeTargetId = resolveActiveTargetId(targetIds, envTargetId, defaultTargetId)
  const enabled = resolveBooleanOverride(env.ROBOT_RUNTIME_ENABLED, rawConfig.enabled ?? true)
  const dryRun = resolveBooleanOverride(env.ROBOT_RUNTIME_DRY_RUN, rawConfig.dryRun ?? true)
  const feedback = rawConfig.feedback && typeof rawConfig.feedback === 'object' ? rawConfig.feedback : {}

  return {
    enabled,
    dryRun,
    requiresOperatorConfirmation: rawConfig.requiresOperatorConfirmation ?? true,
    robotId: normalizeString(rawConfig.robotId) || 'dogzilla-local',
    robotModel: normalizeString(rawConfig.robotModel) || 'dogzilla-s2',
    defaultTarget: activeTargetId,
    targets,
    activeTargetId,
    activeTarget: buildRuntimeTargetDescriptor(targets, activeTargetId, envTargetId ? 'override' : 'runtime'),
    availableTargets: targetIds.map((id) => buildRuntimeTargetDescriptor(targets, id, id === activeTargetId ? (envTargetId ? 'override' : 'runtime') : 'runtime')),
    previewTargets: Array.isArray(rawConfig.previewTargets) && rawConfig.previewTargets.length > 0
      ? rawConfig.previewTargets.filter((id) => targets[id])
      : targetIds,
    selectedMotionProfile: normalizeString(rawConfig.selectedMotionProfile) || 'default',
    selectedWaypointSet: normalizeString(rawConfig.selectedWaypointSet) || 'home',
    selectedActionMap: normalizeString(rawConfig.selectedActionMap) || 'default',
    feedback: {
      pollMs: Number.isFinite(feedback.pollMs) ? feedback.pollMs : 2500,
      historyLimit: Number.isFinite(feedback.historyLimit) ? feedback.historyLimit : 20,
    },
    source: envTargetId ? 'override' : 'runtime',
    selectionLocked: !!envTargetId,
    notes: Array.isArray(rawConfig.notes) ? rawConfig.notes : [],
  }
}

export function normalizeRobotRos2Config(rawConfig = {}) {
  const bridge = rawConfig.bridge && typeof rawConfig.bridge === 'object' ? rawConfig.bridge : {}
  const transport = rawConfig.transport && typeof rawConfig.transport === 'object' ? rawConfig.transport : {}
  const launch = rawConfig.launch && typeof rawConfig.launch === 'object' ? rawConfig.launch : {}
  const feedback = rawConfig.feedback && typeof rawConfig.feedback === 'object' ? rawConfig.feedback : {}
  const windows = rawConfig.windows && typeof rawConfig.windows === 'object' ? rawConfig.windows : {}

  return {
    bridge: {
      enabled: bridge.enabled ?? true,
      dryRun: bridge.dryRun ?? true,
      packageName: normalizeString(bridge.packageName) || 'dogzilla_bridge',
      nodeName: normalizeString(bridge.nodeName) || 'dogzilla_bridge',
      namespace: normalizeString(bridge.namespace) || '/dogzilla',
      commandPlanTopic: normalizeString(bridge.commandPlanTopic) || '/dogzilla/command_plan',
      stateTopic: normalizeString(bridge.stateTopic) || '/dogzilla/state',
    },
    transport: {
      kind: normalizeString(transport.kind) || 'http',
      enabled: transport.enabled ?? true,
      dryRun: transport.dryRun ?? true,
      dispatchOnChat: transport.dispatchOnChat ?? true,
      baseUrl: normalizeString(transport.baseUrl) || 'http://127.0.0.1:8892',
      healthPath: normalizeString(transport.healthPath) || '/healthz',
      commandsPath: normalizeString(transport.commandsPath) || '/commands',
      feedbackPath: normalizeString(transport.feedbackPath) || '/feedback',
      timeoutMs: Number.isFinite(transport.timeoutMs) ? transport.timeoutMs : 4000,
    },
    launch: {
      managedByApp: launch.managedByApp ?? true,
      pythonPath: normalizeString(launch.pythonPath) || 'python',
      commandPath: normalizeString(launch.commandPath) || '',
      scriptPath: normalizeString(launch.scriptPath) || 'sidecars/ros2_bridge/server.py',
      scriptArgs: Array.isArray(launch.scriptArgs) ? launch.scriptArgs.map((value) => String(value)) : [],
      workdir: normalizeString(launch.workdir) || '.',
      sidecarReadyTimeoutMs: Number.isFinite(launch.sidecarReadyTimeoutMs) ? launch.sidecarReadyTimeoutMs : 10000,
      rosWorkspacePath: normalizeString(launch.rosWorkspacePath) || 'ros2',
      rosSetupScriptPath: normalizeString(launch.rosSetupScriptPath) || '',
      windowsSetupScriptPath: normalizeString(launch.windowsSetupScriptPath) || 'scripts/setup-ros2-humble-windows.ps1',
      launchBridgeScriptPath: normalizeString(launch.launchBridgeScriptPath) || 'scripts/launch-ros2-dogzilla-bridge.bat',
      notes: Array.isArray(launch.notes) ? launch.notes : [],
    },
    topics: {
      cmdVel: normalizeString(rawConfig.topics?.cmdVel) || '/dogzilla/cmd_vel',
      action: normalizeString(rawConfig.topics?.action) || '/dogzilla/action',
      stabilize: normalizeString(rawConfig.topics?.stabilize) || '/dogzilla/stabilize',
      state: normalizeString(rawConfig.topics?.state) || '/dogzilla/state',
      commandPlan: normalizeString(rawConfig.topics?.commandPlan) || '/dogzilla/command_plan',
    },
    services: {
      setPose: normalizeString(rawConfig.services?.setPose) || '/dogzilla/set_pose',
      setGait: normalizeString(rawConfig.services?.setGait) || '/dogzilla/set_gait',
      getState: normalizeString(rawConfig.services?.getState) || '/dogzilla/get_state',
    },
    actions: {
      navigateNamedTarget: normalizeString(rawConfig.actions?.navigateNamedTarget) || '/dogzilla/navigate_named_target',
    },
    feedback: {
      pollMs: Number.isFinite(feedback.pollMs) ? feedback.pollMs : 2500,
      recentCommandLimit: Number.isFinite(feedback.recentCommandLimit) ? feedback.recentCommandLimit : 20,
    },
    windows: {
      preferredDistro: normalizeString(windows.preferredDistro) || 'humble',
      alternateDistro: normalizeString(windows.alternateDistro) || 'jazzy',
      installRoot: normalizeString(windows.installRoot) || 'C:\\ros2_humble',
      pixiWorkspace: normalizeString(windows.pixiWorkspace) || 'C:\\pixi_ws',
      setupScriptPath: normalizeString(windows.setupScriptPath) || 'scripts/setup-ros2-humble-windows.ps1',
      notes: Array.isArray(windows.notes) ? windows.notes : [],
    },
    notes: Array.isArray(rawConfig.notes) ? rawConfig.notes : [],
  }
}

export function normalizeRobotMotionConfig(rawConfig = {}) {
  const activeProfile = normalizeString(rawConfig.activeProfile) || 'default'
  const profiles = rawConfig.profiles && typeof rawConfig.profiles === 'object' ? rawConfig.profiles : {}

  return {
    activeProfile,
    profiles,
  }
}

function normalizeRuntimeTargets(rawTargets) {
  const mergedTargets = {}
  const rawTargetEntries = rawTargets && typeof rawTargets === 'object' ? Object.entries(rawTargets) : []

  for (const [targetId, defaults] of Object.entries(DEFAULT_RUNTIME_TARGETS)) {
    const rawTarget = rawTargets?.[targetId] && typeof rawTargets[targetId] === 'object' ? rawTargets[targetId] : {}
    mergedTargets[targetId] = normalizeRuntimeTarget({ id: targetId, ...defaults, ...rawTarget })
  }

  for (const [targetId, rawTarget] of rawTargetEntries) {
    if (mergedTargets[targetId]) {
      continue
    }

    mergedTargets[targetId] = normalizeRuntimeTarget({ id: targetId, ...(rawTarget && typeof rawTarget === 'object' ? rawTarget : {}) })
  }

  return mergedTargets
}

function normalizeRuntimeTarget(rawTarget = {}) {
  return {
    id: normalizeString(rawTarget.id),
    label: normalizeString(rawTarget.label) || 'Unnamed target',
    kind: normalizeString(rawTarget.kind) || 'preview-only',
    managedByApp: rawTarget.managedByApp ?? false,
    previewOnly: rawTarget.previewOnly ?? false,
    notes: Array.isArray(rawTarget.notes) ? rawTarget.notes : [],
  }
}

function buildRuntimeTargetDescriptor(targets, targetId, source) {
  const target = targets[targetId] ?? normalizeRuntimeTarget({ id: targetId })

  return {
    id: targetId,
    label: target.label,
    kind: target.kind,
    managedByApp: target.managedByApp,
    previewOnly: target.previewOnly,
    source,
    selectionLocked: source === 'override',
    notes: target.notes,
  }
}

function resolveActiveTargetId(targetIds, envTargetId, defaultTargetId) {
  if (envTargetId && targetIds.includes(envTargetId)) {
    return envTargetId
  }

  if (defaultTargetId && targetIds.includes(defaultTargetId)) {
    return defaultTargetId
  }

  return targetIds[0] || 'isaacsim'
}

function resolveBooleanOverride(value, fallback) {
  if (typeof value !== 'string') {
    return fallback
  }

  const normalized = value.trim().toLowerCase()

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }

  return fallback
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

async function readJsonConfig(fileName) {
  const file = await readFile(path.join(CONFIG_DIR, fileName), 'utf-8')
  return JSON.parse(file)
}
