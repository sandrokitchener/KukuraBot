import {
  loadIsaacCommandMapConfig,
  loadIsaacSceneWaypointsConfig,
  loadIsaacSidecarConfig,
  loadRobotActionsConfig,
  loadRobotWaypointsConfig,
} from './isaacsim-config.mjs'

const EXACT_PLACEHOLDER_PATTERN = /^\{\{\s*([^}]+?)\s*\}\}$/
const INLINE_PLACEHOLDER_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g

export async function buildIsaacSimPreview(source = {}) {
  const [commandMapConfig, sidecarConfig, waypointConfig, sceneWaypointConfig, actionConfig] = await Promise.all([
    loadIsaacCommandMapConfig(),
    loadIsaacSidecarConfig(),
    loadRobotWaypointsConfig(),
    loadIsaacSceneWaypointsConfig(),
    loadRobotActionsConfig(),
  ])

  return compileIsaacSimPreview({
    source,
    commandMapConfig,
    sidecarConfig,
    waypointConfig,
    sceneWaypointConfig,
    actionConfig,
  })
}

export function compileIsaacSimPreview({
  source = {},
  commandMapConfig = {},
  sidecarConfig = {},
  waypointConfig = {},
  sceneWaypointConfig = {},
  actionConfig = {},
}) {
  const parsed = source.parsed
  const warnings = []
  const activeProfileId = resolveActiveProfileId(commandMapConfig)
  const activeProfile = commandMapConfig.profiles?.[activeProfileId] ?? {}

  if (!parsed || typeof parsed !== 'object') {
    warnings.push('Model reply was not valid JSON, so no Isaac Sim action was compiled.')

    return {
      status: 'no-command',
      target: activeProfile.target || 'isaacsim',
      protocolVersion: activeProfile.protocolVersion ?? 1,
      mappingProfile: activeProfileId,
      action: null,
      payload: null,
      warnings,
      missingRequired: [],
      resolutions: {},
      source: summarizeSource(source),
      dispatchPlan: describeIsaacDispatchPlan(sidecarConfig),
    }
  }

  const command = typeof parsed.command === 'string' ? parsed.command.trim() : ''

  if (!command) {
    warnings.push('Parsed JSON did not include a usable "command" field.')

    return {
      status: 'invalid',
      target: activeProfile.target || 'isaacsim',
      protocolVersion: activeProfile.protocolVersion ?? 1,
      mappingProfile: activeProfileId,
      command,
      action: null,
      payload: null,
      warnings,
      missingRequired: ['fields.command'],
      resolutions: {},
      source: summarizeSource(source),
      dispatchPlan: describeIsaacDispatchPlan(sidecarConfig),
    }
  }

  const rule = activeProfile.commands?.[command]

  if (!rule) {
    warnings.push(`No Isaac Sim mapping rule is configured for command "${command}".`)

    return {
      status: 'unsupported',
      target: activeProfile.target || 'isaacsim',
      protocolVersion: activeProfile.protocolVersion ?? 1,
      mappingProfile: activeProfileId,
      command,
      action: null,
      payload: null,
      warnings,
      missingRequired: [],
      resolutions: {},
      source: summarizeSource(source),
      dispatchPlan: describeIsaacDispatchPlan(sidecarConfig),
    }
  }

  const resolutions = resolveCommandContext(parsed, rule, waypointConfig, sceneWaypointConfig, actionConfig, warnings)
  const context = createTemplateContext(source, parsed, resolutions)
  const payload = applyDefaults(
    rule.defaults ?? {},
    renderTemplateStructure(rule.payloadTemplate ?? {}, context, warnings),
  )
  const missingRequired = (rule.requiredFields ?? []).filter((path) => isMissingValue(getPathValue(context, path)))

  if (usesResolver(rule, 'waypoint') && resolutions.waypoint && resolutions.waypoint.exists === false) {
    warnings.push(`Waypoint "${resolutions.waypoint.name}" is not defined in robot-waypoints config.`)
  }

  if (usesResolver(rule, 'sceneWaypoint') && resolutions.sceneWaypoint && resolutions.sceneWaypoint.exists === false) {
    warnings.push(`Waypoint "${resolutions.sceneWaypoint.name}" is not defined in isaacsim-waypoints config.`)
  }

  if (usesResolver(rule, 'trickAction') && resolutions.trickAction && resolutions.trickAction.exists === false) {
    warnings.push(`Trick "${resolutions.trickAction.name}" is not defined in robot-actions config.`)
  }

  if (
    usesResolver(rule, 'trickAction')
    && resolutions.trickAction
    && resolutions.trickAction.exists
    && resolutions.trickAction.actionId == null
  ) {
    warnings.push(`Trick "${resolutions.trickAction.name}" has no actionId yet.`)
  }

  const status = missingRequired.length > 0 ? 'invalid' : 'ready'

  return {
    status,
    target: activeProfile.target || 'isaacsim',
    protocolVersion: activeProfile.protocolVersion ?? 1,
    mappingProfile: activeProfileId,
    command,
    action: typeof rule.action === 'string' ? rule.action : '',
    payload,
    warnings,
    missingRequired,
    resolutions,
    source: summarizeSource(source),
    dispatchPlan: describeIsaacDispatchPlan(sidecarConfig),
  }
}

export function describeIsaacDispatchPlan(sidecarConfig = {}) {
  const transport = sidecarConfig.transport ?? {}

  return {
    transport: transport.kind || 'http',
    enabled: transport.enabled ?? false,
    dryRun: transport.dryRun ?? true,
    dispatchOnChat: transport.dispatchOnChat ?? false,
    destination: transport.baseUrl || '',
    commandsPath: transport.commandsPath || '/commands',
  }
}

function resolveActiveProfileId(commandMapConfig) {
  const profileIds = Object.keys(commandMapConfig.profiles ?? {})

  if (profileIds.length === 0) {
    return 'default'
  }

  if (commandMapConfig.activeProfile && commandMapConfig.profiles?.[commandMapConfig.activeProfile]) {
    return commandMapConfig.activeProfile
  }

  return profileIds[0]
}

function resolveCommandContext(parsed, rule, waypointConfig, sceneWaypointConfig, actionConfig) {
  return {
    waypoint: usesResolver(rule, 'waypoint') ? resolveWaypoint(parsed, waypointConfig) : null,
    sceneWaypoint: usesResolver(rule, 'sceneWaypoint') ? resolveWaypoint(parsed, sceneWaypointConfig) : null,
    trickAction: usesResolver(rule, 'trickAction') ? resolveTrickAction(parsed, actionConfig) : null,
  }
}

function usesResolver(rule, resolverName) {
  return Array.isArray(rule?.resolvers) && rule.resolvers.includes(resolverName)
}

function resolveWaypoint(parsed, waypointConfig) {
  const waypointName = typeof parsed?.waypoint === 'string' ? parsed.waypoint.trim() : ''
  const activeSetId = waypointConfig.activeSet || Object.keys(waypointConfig.sets ?? {})[0] || ''
  const activeSet = waypointConfig.sets?.[activeSetId] ?? {}
  const definition = waypointName ? activeSet.waypoints?.[waypointName] ?? null : null

  return {
    name: waypointName,
    activeSet: activeSetId,
    exists: waypointName ? !!definition : false,
    definition,
  }
}

function resolveTrickAction(parsed, actionConfig) {
  const trickName = typeof parsed?.trick === 'string' ? parsed.trick.trim() : ''
  const activeMapId = actionConfig.activeMap || Object.keys(actionConfig.maps ?? {})[0] || ''
  const activeMap = actionConfig.maps?.[activeMapId] ?? {}
  const definition = trickName ? activeMap.tricks?.[trickName] ?? null : null

  return {
    name: trickName,
    activeMap: activeMapId,
    exists: trickName ? !!definition : false,
    actionId: definition?.actionId ?? null,
    verified: definition?.verified ?? false,
    notes: Array.isArray(definition?.notes) ? definition.notes : [],
  }
}

function createTemplateContext(source, parsed, resolutions) {
  return {
    fields: { ...parsed },
    source: {
      inputText: typeof source.input === 'string' ? source.input : '',
      rawResponse: typeof source.rawResponse === 'string' ? source.rawResponse : '',
    },
    waypoint: resolutions.waypoint,
    sceneWaypoint: resolutions.sceneWaypoint,
    trickAction: resolutions.trickAction,
  }
}

function summarizeSource(source) {
  return {
    inputText: typeof source.input === 'string' ? source.input : '',
    rawResponse: typeof source.rawResponse === 'string' ? source.rawResponse : '',
  }
}

function renderTemplateStructure(value, context, warnings) {
  if (Array.isArray(value)) {
    return value.map((item) => renderTemplateStructure(item, context, warnings))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, renderTemplateStructure(entryValue, context, warnings)]),
    )
  }

  if (typeof value !== 'string') {
    return value
  }

  const exactMatch = value.match(EXACT_PLACEHOLDER_PATTERN)

  if (exactMatch) {
    const resolved = getPathValue(context, exactMatch[1].trim())

    if (resolved == null) {
      warnings.push(`Template value "${exactMatch[1].trim()}" resolved to nothing.`)
      return null
    }

    return cloneValue(resolved)
  }

  return value.replace(INLINE_PLACEHOLDER_PATTERN, (_, rawPath) => {
    const resolved = getPathValue(context, rawPath.trim())

    if (resolved == null) {
      warnings.push(`Template value "${rawPath.trim()}" resolved to nothing.`)
      return ''
    }

    return typeof resolved === 'string' ? resolved : JSON.stringify(resolved)
  })
}

function getPathValue(root, dotPath) {
  return dotPath
    .split('.')
    .reduce((currentValue, key) => (currentValue == null ? undefined : currentValue[key]), root)
}

function applyDefaults(defaults, payload) {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    return payload
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return cloneValue(payload)
  }

  return {
    ...cloneValue(defaults),
    ...payload,
  }
}

function isMissingValue(value) {
  return value == null || value === ''
}

function cloneValue(value) {
  if (value == null || typeof value !== 'object') {
    return value
  }

  return structuredClone(value)
}
