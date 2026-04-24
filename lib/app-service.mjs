import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAppConfig } from './app-config.mjs'
import { buildIsaacSimPreview } from './isaacsim-command-compiler.mjs'
import { dispatchIsaacSimCommand } from './isaacsim-sidecar-client.mjs'
import { queryModel } from './model-client.mjs'
import { resolveActiveModelProfile } from './model-profile-config.mjs'
import { resolveActiveSpeechProfile } from './speech-profile-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const CONFIG_DIR = path.join(ROOT_DIR, 'config')

export async function loadPublicConfig() {
  const [
    appConfig,
    activeProfileConfig,
    activeSpeechProfileConfig,
    commandSpec,
    commandTypes,
    activationPhrases,
    validWaypoints,
    systemTemplate,
  ] = await Promise.all([
    loadAppConfig(),
    resolveActiveModelProfile(),
    resolveActiveSpeechProfile(),
    loadCommandSpec(),
    loadCommandTypes(),
    loadActivationPhrases(),
    loadValidWaypoints(),
    loadSystemTemplate(),
  ])
  const renderedCommandSpec = renderCommandFormat(commandSpec)
  const renderedCommandTypes = renderCommandTypes(commandTypes, validWaypoints)

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

export async function processUserInput(input, options = {}) {
  const trimmed = typeof input === 'string' ? input.trim() : ''
  if (!trimmed) {
    throw new Error('Enter a message first.')
  }

  const queryModelImpl = options.queryModelImpl ?? queryModel
  const buildIsaacSimPreviewImpl = options.buildIsaacSimPreviewImpl ?? buildIsaacSimPreview
  const dispatchIsaacSimCommandImpl = options.dispatchIsaacSimCommandImpl ?? dispatchIsaacSimCommand
  const [composed, activeProfileConfig] = await Promise.all([
    composeSystemPrompt(),
    resolveActiveModelProfile(),
  ])
  const result = await queryModelImpl({
    input: trimmed,
    profile: activeProfileConfig.activeProfile,
    systemPrompt: composed.systemPrompt,
  })
  const parsed = tryParseJson(result)
  const isaacSim = await buildIsaacSimPreviewImpl({
    input: trimmed,
    rawResponse: result,
    parsed,
  })
  const isaacDispatch = shouldAutoDispatchIsaacSim(isaacSim)
    ? await dispatchIsaacSimCommandImpl(isaacSim)
    : null

  return {
    input: trimmed,
    model: activeProfileConfig.activeProfile.model,
    provider: activeProfileConfig.activeProfile.provider,
    profileId: activeProfileConfig.activeProfileId,
    profileLabel: activeProfileConfig.activeProfile.label,
    profileSource: activeProfileConfig.source,
    response: result,
    parsed,
    isaacSim,
    isaacDispatch,
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
