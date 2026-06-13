import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAppConfig } from './app-config.mjs'
import { loadDogzillaConnectionConfig } from './dogzilla-connection-center.mjs'
import {
  applyMapOriginToPose,
  getDogzillaMapOriginStatus,
  hasDogzillaMapOriginIdentity,
  loadDogzillaMapOrigin,
} from './dogzilla-map-frame.mjs'
import { loadRobotWaypointsConfig } from './isaacsim-config.mjs'
import { buildIsaacSimPreview } from './isaacsim-command-compiler.mjs'
import { dispatchIsaacSimCommand } from './isaacsim-sidecar-client.mjs'
import { buildRobotRuntimePreview, shouldAutoDispatchRobotRuntime } from './robot-command-compiler.mjs'
import { queryModel } from './model-client.mjs'
import { resolveActiveModelProfile } from './model-profile-config.mjs'
import { dispatchRobotCommand } from './robot-sidecar-client.mjs'
import { loadRobotRos2Config, loadRobotRuntimeConfig } from './robot-runtime-config.mjs'
import { ROBOT_STATE_STREAM_PATH } from './robot-state-stream.mjs'
import { resolveActiveSpeechProfile } from './speech-profile-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const CONFIG_DIR = path.join(ROOT_DIR, 'config')

export async function loadPublicConfig() {
  const [
    appConfig,
    activeProfileConfig,
    activeSpeechProfileConfig,
    robotRuntimeConfig,
    robotRos2Config,
    dogzillaConnectionConfig,
    robotWaypointsConfig,
    commandSpec,
    commandTypes,
    activationPhrases,
    validWaypoints,
    systemTemplate,
    mapOrigin,
  ] = await Promise.all([
    loadAppConfig(),
    resolveActiveModelProfile(),
    resolveActiveSpeechProfile(),
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
    loadDogzillaConnectionConfig(),
    loadRobotWaypointsConfig(),
    loadCommandSpec(),
    loadCommandTypes(),
    loadActivationPhrases(),
    loadValidWaypoints(),
    loadSystemTemplate(),
    loadDogzillaMapOrigin(),
  ])
  const renderedCommandSpec = renderCommandFormat(commandSpec)
  const renderedCommandTypes = renderCommandTypes(commandTypes, validWaypoints)
  const usableMapOrigin = mapOrigin && hasDogzillaMapOriginIdentity(mapOrigin) ? mapOrigin : null
  const mapOriginStatus = getDogzillaMapOriginStatus(mapOrigin)

  return {
    app: appConfig,
    model: activeProfileConfig.activeProfile.model,
    provider: activeProfileConfig.activeProfile.provider,
    activeProfile: {
      id: activeProfileConfig.activeProfileId,
      label: activeProfileConfig.activeProfile.label,
      provider: activeProfileConfig.activeProfile.provider,
      model: activeProfileConfig.activeProfile.model,
      baseUrl: activeProfileConfig.activeProfile.baseUrl,
      modelPath: activeProfileConfig.activeProfile.modelPath,
      modelFileName: activeProfileConfig.activeProfile.modelFileName,
      modelRepo: activeProfileConfig.activeProfile.modelRepo,
      modelDownloadUrl: activeProfileConfig.activeProfile.modelDownloadUrl,
      temperature: activeProfileConfig.activeProfile.temperature,
      maxTokens: activeProfileConfig.activeProfile.maxTokens,
      contextTokens: activeProfileConfig.activeProfile.contextTokens,
      threads: activeProfileConfig.activeProfile.threads,
      source: activeProfileConfig.source,
      selectionLocked: activeProfileConfig.selectionLocked,
    },
    availableProfiles: activeProfileConfig.availableProfiles,
    speech: {
      activeProfile: {
        id: activeSpeechProfileConfig.activeProfileId,
        label: activeSpeechProfileConfig.activeProfile.label,
        provider: activeSpeechProfileConfig.activeProfile.provider,
        libraryUrl: activeSpeechProfileConfig.activeProfile.libraryUrl,
        modelId: activeSpeechProfileConfig.activeProfile.modelId,
        sidecarModelId: activeSpeechProfileConfig.activeProfile.sidecarModelId,
        sidecarSourceUrl: activeSpeechProfileConfig.activeProfile.sidecarSourceUrl,
        modelUrl: activeSpeechProfileConfig.activeProfile.modelUrl,
        device: activeSpeechProfileConfig.activeProfile.device,
        dtype: activeSpeechProfileConfig.activeProfile.dtype,
        fallbackDevice: activeSpeechProfileConfig.activeProfile.fallbackDevice,
        fallbackDtype: activeSpeechProfileConfig.activeProfile.fallbackDtype,
        language: activeSpeechProfileConfig.activeProfile.language,
        task: activeSpeechProfileConfig.activeProfile.task,
        chunkLengthSeconds: activeSpeechProfileConfig.activeProfile.chunkLengthSeconds,
        strideLengthSeconds: activeSpeechProfileConfig.activeProfile.strideLengthSeconds,
        maxBufferSeconds: activeSpeechProfileConfig.activeProfile.maxBufferSeconds,
        precision: activeSpeechProfileConfig.activeProfile.precision,
        timestamps: activeSpeechProfileConfig.activeProfile.timestamps,
        useVad: activeSpeechProfileConfig.activeProfile.useVad,
        autoStart: activeSpeechProfileConfig.activeProfile.autoStart,
        moonshineAssetBaseUrl: activeSpeechProfileConfig.activeProfile.moonshineAssetBaseUrl,
        onnxRuntimeBaseUrl: activeSpeechProfileConfig.activeProfile.onnxRuntimeBaseUrl,
        vadAssetBaseUrl: activeSpeechProfileConfig.activeProfile.vadAssetBaseUrl,
        silenceDurationMs: activeSpeechProfileConfig.activeProfile.silenceDurationMs,
        activationCommandWindowMs: activeSpeechProfileConfig.activeProfile.activationCommandWindowMs,
        minimumSpeechMs: activeSpeechProfileConfig.activeProfile.minimumSpeechMs,
        speechThreshold: activeSpeechProfileConfig.activeProfile.speechThreshold,
        source: activeSpeechProfileConfig.source,
        selectionLocked: activeSpeechProfileConfig.selectionLocked,
      },
      availableProfiles: activeSpeechProfileConfig.availableProfiles,
      profileFile: relativeConfigPath('speech-profiles.json'),
      runtimeFile: relativeConfigPath('speech-runtime.json'),
      sidecarConfigFile: relativeConfigPath('speech-sidecar.json'),
      activationPhrasesFile: relativeConfigPath('activation_phrases.txt'),
      activationPhrases,
    },
    systemPromptFile: relativeConfigPath('system-prompt.txt'),
    commandFormatFile: relativeConfigPath('command-response-format.json'),
    commandTypesFile: relativeConfigPath('command-types.txt'),
    validWaypointsFile: relativeConfigPath('valid-waypoints.txt'),
    isaacSim: {
      commandMapFile: relativeConfigPath('isaacsim-command-map.json'),
      sidecarConfigFile: relativeConfigPath('isaacsim-sidecar.json'),
      cadSplitPlanFile: relativeConfigPath('isaacsim-cad-split-plan.json'),
    },
    robotRuntime: {
      robotId: robotRuntimeConfig.robotId,
      robotName: robotRuntimeConfig.robotName,
      robot_id: robotRuntimeConfig.robotId,
      robot_name: robotRuntimeConfig.robotName,
      robotModel: robotRuntimeConfig.robotModel,
      activeTarget: robotRuntimeConfig.activeTarget,
      availableTargets: robotRuntimeConfig.availableTargets,
      enabled: robotRuntimeConfig.enabled,
      dryRun: robotRuntimeConfig.dryRun,
      runtimeFile: relativeConfigPath('robot-runtime.json'),
      ros2ConfigFile: relativeConfigPath('robot-ros2.json'),
      waypointsFile: relativeConfigPath('robot-waypoints.json'),
      motionFile: relativeConfigPath('robot-motion.json'),
      feedbackPollMs: robotRos2Config.feedback.pollMs,
      statePollMs: robotRuntimeConfig.feedback.statePollMs,
      stateStreamPath: ROBOT_STATE_STREAM_PATH,
      stateSnapshotPath: '/api/robot/state',
      waypointSet: robotWaypointsConfig.activeSet,
      mapOrigin: {
        ...mapOriginStatus,
        configured: !!usableMapOrigin,
      },
      waypoints: buildPublicRobotWaypoints(robotWaypointsConfig, usableMapOrigin),
      profileFile: relativeConfigPath('robot-motion.json'),
      selectionLocked: robotRuntimeConfig.selectionLocked,
      source: robotRuntimeConfig.source,
    },
    dogzilla: {
      ssh: dogzillaConnectionConfig.ssh,
      bridges: dogzillaConnectionConfig.bridges,
      camera: dogzillaConnectionConfig.camera,
      vision: dogzillaConnectionConfig.vision,
      audio: dogzillaConnectionConfig.audio,
      lidar: dogzillaConnectionConfig.lidar,
    },
    systemPromptPreview: renderTemplate(systemTemplate.trim(), {
      ASSISTANT_NAME: appConfig.assistantName,
      COMMAND_TYPES: renderedCommandTypes,
      COMMAND_RESPONSE_FORMAT: renderedCommandSpec,
    }),
    commandFormatPreview: commandSpec,
    commandTypesPreview: renderedCommandTypes,
    validWaypointsPreview: validWaypoints.trim(),
  }
}

function buildPublicRobotWaypoints(waypointConfig = {}, mapOrigin = null) {
  const activeSetId = waypointConfig.activeSet || Object.keys(waypointConfig.sets ?? {})[0] || ''
  const activeSet = waypointConfig.sets?.[activeSetId] ?? {}
  const waypoints = activeSet.waypoints && typeof activeSet.waypoints === 'object' ? activeSet.waypoints : {}

  return Object.entries(waypoints)
    .map(([id, waypoint]) => normalizePublicRobotWaypoint(id, waypoint, mapOrigin))
    .filter(Boolean)
}

function normalizePublicRobotWaypoint(id, waypoint = {}, mapOrigin = null) {
  if (!waypoint || waypoint.kind !== 'map_pose') {
    return null
  }

  const x = Number(waypoint.x)
  const y = Number(waypoint.y)
  const yaw = Number(waypoint.yaw ?? waypoint.theta ?? 0)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null
  }

  const sourceVerified = waypoint.verified === true
  const publicWaypoint = {
    id,
    label: formatWaypointLabel(id),
    frame: typeof waypoint.frame === 'string' && waypoint.frame.trim() ? waypoint.frame.trim() : 'map',
    x,
    y,
    yaw: Number.isFinite(yaw) ? yaw : 0,
    sourceVerified,
    verified: sourceVerified,
    enabled: sourceVerified,
    navigable: sourceVerified,
    verificationProblem: sourceVerified ? '' : 'not verified',
    disabledReason: sourceVerified ? '' : 'not verified',
    advisoryProblems: getPublicWaypointAdvisories(waypoint),
    mapId: normalizePublicString(waypoint.mapId || waypoint.map_id || waypoint.map?.id || waypoint.map?.map_id),
    mapFingerprint: normalizePublicString(waypoint.mapFingerprint || waypoint.map_fingerprint || waypoint.map?.fingerprint || waypoint.map?.map_fingerprint),
  }

  const appMapPose = applyMapOriginToPose(publicWaypoint, mapOrigin)
  if (appMapPose?.frame === 'app_map' && appMapPose.sourceFrame === publicWaypoint.frame) {
    publicWaypoint.appMapPose = {
      frame: appMapPose.frame,
      x: appMapPose.x,
      y: appMapPose.y,
      yaw: appMapPose.yaw,
      sourceFrame: appMapPose.sourceFrame,
      originLabel: appMapPose.originLabel,
    }
  }

  return publicWaypoint
}

function getPublicWaypointAdvisories(waypoint = {}) {
  const advisories = []
  if (!normalizePublicString(waypoint.mapId || waypoint.map_id || waypoint.map?.id || waypoint.map?.map_id)) {
    advisories.push('missing map id')
  }

  if (!normalizePublicString(waypoint.mapFingerprint || waypoint.map_fingerprint || waypoint.map?.fingerprint || waypoint.map?.map_fingerprint)) {
    advisories.push('missing map fingerprint')
  }

  return advisories
}

function normalizePublicString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function formatWaypointLabel(id) {
  return String(id || '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export async function processUserInput(input, options = {}) {
  const trimmed = typeof input === 'string' ? input.trim() : ''
  if (!trimmed) {
    throw new Error('Enter a message first.')
  }

  const queryModelImpl = options.queryModelImpl ?? queryModel
  const loadRobotRuntimeConfigImpl = options.loadRobotRuntimeConfigImpl ?? loadRobotRuntimeConfig
  const [composed, activeProfileConfig, robotRuntimeConfig] = await Promise.all([
    composeSystemPrompt(),
    resolveActiveModelProfile(),
    loadRobotRuntimeConfigImpl(),
  ])
  const result = await queryModelImpl({
    input: trimmed,
    profile: activeProfileConfig.activeProfile,
    systemPrompt: composed.systemPrompt,
  })
  return processModelResult({
    input: trimmed,
    rawResponse: result,
    activeProfileConfig,
    robotRuntimeConfig,
    options,
  })
}

export async function processModelResult({
  input,
  rawResponse,
  activeProfileConfig = null,
  robotRuntimeConfig = null,
  options = {},
} = {}) {
  const trimmed = typeof input === 'string' ? input.trim() : ''
  if (!trimmed) {
    throw new Error('Enter a message first.')
  }

  const result = typeof rawResponse === 'string' ? rawResponse.trim() : ''
  if (!result) {
    throw new Error('Model returned an empty response.')
  }

  const parsed = tryParseJson(result)
  const resolvedProfileConfig = activeProfileConfig ?? await resolveActiveModelProfile()
  const buildIsaacSimPreviewImpl = options.buildIsaacSimPreviewImpl ?? buildIsaacSimPreview
  const dispatchIsaacSimCommandImpl = options.dispatchIsaacSimCommandImpl ?? dispatchIsaacSimCommand
  const buildRobotRuntimePreviewImpl = options.buildRobotRuntimePreviewImpl ?? buildRobotRuntimePreview
  const dispatchRobotCommandImpl = options.dispatchRobotCommandImpl ?? dispatchRobotCommand
  const loadRobotRuntimeConfigImpl = options.loadRobotRuntimeConfigImpl ?? loadRobotRuntimeConfig
  const resolvedRobotRuntimeConfig = robotRuntimeConfig ?? await loadRobotRuntimeConfigImpl()
  const [isaacSim, robotRuntime] = await Promise.all([
    buildIsaacSimPreviewImpl({
      input: trimmed,
      rawResponse: result,
      parsed,
    }),
    buildRobotRuntimePreviewImpl({
      input: trimmed,
      rawResponse: result,
      parsed,
    }),
  ])
  const isaacDispatch = isIsaacTargetActive(resolvedRobotRuntimeConfig) && shouldAutoDispatchIsaacSim(isaacSim)
    ? await dispatchIsaacSimCommandImpl(isaacSim)
    : null
  const robotDispatch = isRobotTargetActive(resolvedRobotRuntimeConfig) && shouldAutoDispatchRobotRuntime(robotRuntime)
    ? await dispatchRobotCommandImpl(robotRuntime)
    : null

  return {
    input: trimmed,
    model: resolvedProfileConfig.activeProfile.model,
    provider: resolvedProfileConfig.activeProfile.provider,
    profileId: resolvedProfileConfig.activeProfileId,
    profileLabel: resolvedProfileConfig.activeProfile.label,
    profileSource: resolvedProfileConfig.source,
    response: result,
    parsed,
    isaacSim,
    isaacDispatch,
    robotRuntime,
    robotDispatch,
    runtimeTarget: resolvedRobotRuntimeConfig.activeTarget,
  }
}

export async function loadCommandSpec() {
  return readJsonConfig('command-response-format.json')
}

export async function loadCommandTypes() {
  return readFile(path.join(CONFIG_DIR, 'command-types.txt'), 'utf-8')
}

export async function loadActivationPhrases() {
  const raw = await readFile(path.join(CONFIG_DIR, 'activation_phrases.txt'), 'utf-8')

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

export async function loadValidWaypoints() {
  return readFile(path.join(CONFIG_DIR, 'valid-waypoints.txt'), 'utf-8')
}

export async function loadSystemTemplate() {
  return readFile(path.join(CONFIG_DIR, 'system-prompt.txt'), 'utf-8')
}

export async function composeSystemPrompt() {
  const [appConfig, template, commandSpec, commandTypes, activationPhrases, validWaypoints] = await Promise.all([
    loadAppConfig(),
    loadSystemTemplate(),
    loadCommandSpec(),
    loadCommandTypes(),
    loadActivationPhrases(),
    loadValidWaypoints(),
  ])
  const renderedSpec = renderCommandFormat(commandSpec)
  const renderedCommandTypes = renderCommandTypes(commandTypes, validWaypoints)

  return {
    commandSpec,
    systemPrompt: renderTemplate(template, {
      ASSISTANT_NAME: appConfig.assistantName,
      COMMAND_TYPES: renderedCommandTypes,
      ACTIVATION_PHRASES: activationPhrases.join('\n'),
      COMMAND_RESPONSE_FORMAT: renderedSpec,
    }),
  }
}

export function renderCommandFormat(commandSpec) {
  const fieldLines = commandSpec.fields
    .map((field) => `  "${field.name}": ${field.type}`)
    .join('\n')

  const commandRules = Object.entries(commandSpec.allowedCommands)
    .map(([command, description]) => `- "${command}" -> ${description}`)
    .join('\n')
  const conditionalRules = Object.entries(commandSpec.conditionalFields ?? {})
    .map(([command, fields]) => {
      const fieldLines = fields
        .map((field) => `  "${field.name}": ${field.type}`)
        .join('\n')

      return `- If "command" is "${command}", also include:\n${fieldLines}`
    })
    .join('\n')
  const conditionalDefaults = Object.entries(commandSpec.conditionalDefaults ?? {})
    .map(([command, defaults]) => {
      const defaultLines = Object.entries(defaults)
        .map(([fieldName, value]) => `  "${fieldName}": ${JSON.stringify(value)}`)
        .join('\n')

      return `- If "command" is "${command}" and no better value is provided, default to:\n${defaultLines}`
    })
    .join('\n')
  const conditionalNotes = Object.entries(commandSpec.conditionalNotes ?? {})
    .flatMap(([command, notes]) => notes.map((note) => `- If "command" is "${command}": ${note}`))
    .join('\n')
  const conditionalParts = []

  if (conditionalRules) {
    conditionalParts.push(`Fields:\n${conditionalRules}`)
  }

  if (conditionalDefaults) {
    conditionalParts.push(`Defaults:\n${conditionalDefaults}`)
  }

  if (conditionalNotes) {
    conditionalParts.push(`Notes:\n${conditionalNotes}`)
  }

  const examplesSection = Array.isArray(commandSpec.examples) && commandSpec.examples.length > 0
    ? `\n\nExamples:\n${commandSpec.examples
      .map((example) => {
        return `- User: "${example.input}"\n  Output: ${JSON.stringify(example.output)}`
      })
      .join('\n')}`
    : ''
  const conditionalSection = conditionalParts.length
    ? `\n\nConditional rules:\n${conditionalParts.join('\n\n')}`
    : ''

  return `{
${fieldLines}
}

Rules:
${commandRules}
- Always include every base field from the top-level format, including "waypoint", for every command
- Normalize waypoint names to ${commandSpec.waypointNormalization}
- If no clear location is given, default waypoint to "${commandSpec.defaultWaypoint}"${conditionalSection}${examplesSection}`
}

export function renderCommandTypes(commandTypes, validWaypoints) {
  return renderTemplate(commandTypes.trim(), {
    VALID_WAYPOINTS: validWaypoints.trim(),
  })
}

export function tryParseJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function shouldAutoDispatchIsaacSim(preview) {
  return !!(preview && typeof preview === 'object' && preview.dispatchPlan?.dispatchOnChat)
}

function isIsaacTargetActive(robotRuntimeConfig) {
  return (robotRuntimeConfig.activeTarget?.kind || '') === 'isaacsim'
}

function isRobotTargetActive(robotRuntimeConfig) {
  return ['ros2-bridge', 'dogzilla-direct'].includes(robotRuntimeConfig.activeTarget?.kind || '')
}

export function relativeConfigPath(fileName) {
  return `config/${fileName}`
}

export function renderTemplate(template, variables) {
  return Object.entries(variables).reduce((currentValue, [key, replacement]) => {
    return currentValue.replaceAll(`{{${key}}}`, replacement)
  }, template)
}

async function readJsonConfig(fileName) {
  const file = await readFile(path.join(CONFIG_DIR, fileName), 'utf-8')
  return JSON.parse(file)
}
