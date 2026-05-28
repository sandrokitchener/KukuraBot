import { loadRobotActionsConfig, loadRobotWaypointsConfig } from './isaacsim-config.mjs'
import { loadRobotMotionConfig, loadRobotRos2Config, loadRobotRuntimeConfig } from './robot-runtime-config.mjs'
import { isRobotHttpTarget } from './robot-sidecar-client.mjs'

export async function buildRobotRuntimePreview(source = {}) {
  const [runtimeConfig, ros2Config, waypointConfig, actionConfig, motionConfig] = await Promise.all([
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
    loadRobotWaypointsConfig(),
    loadRobotActionsConfig(),
    loadRobotMotionConfig(),
  ])

  return compileRobotRuntimePreview({
    source,
    runtimeConfig,
    ros2Config,
    waypointConfig,
    actionConfig,
    motionConfig,
  })
}

export async function buildRobotManualControlPreview(control = {}) {
  const [runtimeConfig, ros2Config, motionConfig] = await Promise.all([
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
    loadRobotMotionConfig(),
  ])

  return compileRobotManualControlPreview({
    control,
    runtimeConfig,
    ros2Config,
    motionConfig,
  })
}

export function compileRobotRuntimePreview({
  source = {},
  runtimeConfig = {},
  ros2Config = {},
  waypointConfig = {},
  actionConfig = {},
  motionConfig = {},
}) {
  const parsed = source.parsed
  const warnings = []
  const activeTarget = runtimeConfig.activeTarget ?? {
    id: 'ros2_real',
    kind: 'ros2-bridge',
    label: 'ROS2 Real Robot',
  }

  if (!parsed || typeof parsed !== 'object') {
    warnings.push('Model reply was not valid JSON, so no ROS2 action was compiled.')

    return buildPreview({
      status: 'no-command',
      activeTarget,
      runtimeConfig,
      ros2Config,
      source,
      warnings,
      resolutions: {},
      canonicalPlan: null,
      payload: null,
      command: '',
      action: '',
    })
  }

  const command = typeof parsed.command === 'string' ? parsed.command.trim() : ''

  if (!command) {
    warnings.push('Parsed JSON did not include a usable "command" field.')

    return buildPreview({
      status: 'invalid',
      activeTarget,
      runtimeConfig,
      ros2Config,
      source,
      warnings,
      missingRequired: ['fields.command'],
      resolutions: {},
      canonicalPlan: null,
      payload: null,
      command,
      action: '',
    })
  }

  const resolutions = {
    waypoint: resolveWaypoint(parsed, waypointConfig),
    trickAction: resolveTrickAction(parsed, actionConfig),
    motionProfile: resolveMotionProfile(motionConfig, runtimeConfig.selectedMotionProfile),
  }

  const compiled = compileCommand(command, parsed, resolutions, warnings)
  const payload = compiled.canonicalPlan
    ? {
      robotId: runtimeConfig.robotId || 'dogzilla-local',
      robotModel: runtimeConfig.robotModel || 'dogzilla-s2',
      waypointSet: resolutions.waypoint.activeSet,
      motionProfile: runtimeConfig.selectedMotionProfile || 'default',
      actionMap: resolutions.trickAction.activeMap,
      planTopic: ros2Config.bridge?.commandPlanTopic || '/dogzilla/command_plan',
      stateTopic: ros2Config.topics?.state || '/dogzilla/state',
      canonicalPlan: compiled.canonicalPlan,
    }
    : null

  return buildPreview({
    status: compiled.status,
    activeTarget,
    runtimeConfig,
    ros2Config,
    source,
    warnings,
    missingRequired: compiled.missingRequired,
    resolutions,
    canonicalPlan: compiled.canonicalPlan,
    payload,
    command,
    action: compiled.action,
  })
}

export function compileRobotManualControlPreview({
  control = {},
  runtimeConfig = {},
  ros2Config = {},
  motionConfig = {},
}) {
  const warnings = []
  const activeTarget = runtimeConfig.activeTarget ?? {
    id: 'ros2_real',
    kind: 'ros2-bridge',
    label: 'ROS2 Real Robot',
  }
  const motionProfile = resolveMotionProfile(motionConfig, runtimeConfig.selectedMotionProfile)
  const calibration = motionProfile.twistCalibration ?? {}
  const limits = motionProfile.limits ?? {}
  const deadband = finiteNumber(calibration.deadband, 0.05)
  const linearXFullScaleStep = finiteNumber(calibration.linearXFullScaleStep, 25)
  const linearYFullScaleStep = finiteNumber(calibration.linearYFullScaleStep, 18)
  const angularZFullScaleStep = finiteNumber(calibration.angularZFullScaleStep, 100)
  const forward = normalizeControlAxis(control.forward ?? control.linearX ?? control.x, deadband)
  const strafe = normalizeControlAxis(control.strafe ?? control.linearY ?? control.y, deadband)
  const turn = normalizeControlAxis(control.turn ?? control.angularZ ?? control.rotation, deadband)
  const xStep = clampToLimit(
    control.xStep ?? control.x_step ?? forward * linearXFullScaleStep,
    limits.xStep,
    -25,
    25,
  )
  const yStep = clampToLimit(
    control.yStep ?? control.y_step ?? strafe * linearYFullScaleStep,
    limits.yStep,
    -18,
    18,
  )
  const turnRate = clampToLimit(
    control.turnRate ?? control.turn_rate ?? turn * angularZFullScaleStep,
    limits.turnRate,
    -100,
    100,
  )
  const gait = normalizeChoice(control.gait, motionProfile.gaits, 'walk')
  const pace = normalizeChoice(control.pace, motionProfile.paceModes, 'normal')
  const sourceLabel = typeof control.source === 'string' && control.source.trim()
    ? control.source.trim()
    : 'manual-gamepad'
  const canonicalPlan = {
    kind: 'locomotion.relative',
    params: {
      x_step: xStep,
      y_step: yStep,
      turn_rate: turnRate,
      gait,
      pace,
      source: sourceLabel,
    },
  }
  const payload = {
    robotId: runtimeConfig.robotId || 'dogzilla-local',
    robotModel: runtimeConfig.robotModel || 'dogzilla-s2',
    motionProfile: runtimeConfig.selectedMotionProfile || motionConfig.activeProfile || 'default',
    planTopic: ros2Config.bridge?.commandPlanTopic || '/dogzilla/command_plan',
    stateTopic: ros2Config.topics?.state || '/dogzilla/state',
    canonicalPlan,
  }

  if (!motionProfile.twistCalibration) {
    warnings.push('Manual control is using built-in DOGZILLA motion calibration defaults.')
  }

  return buildPreview({
    status: 'ready',
    activeTarget,
    runtimeConfig,
    ros2Config,
    source: {
      input: 'manual-control',
      rawResponse: JSON.stringify({
        forward,
        strafe,
        turn,
        source: sourceLabel,
      }),
    },
    warnings,
    resolutions: {
      motionProfile,
      manualControl: {
        forward,
        strafe,
        turn,
        deadband,
        source: sourceLabel,
      },
    },
    canonicalPlan,
    payload,
    command: 'manual',
    action: 'dogzilla.manual_control',
  })
}

export function shouldAutoDispatchRobotRuntime(preview) {
  return !!(preview && typeof preview === 'object' && preview.dispatchPlan?.dispatchOnChat)
}

function buildPreview({
  status,
  activeTarget,
  runtimeConfig,
  ros2Config,
  source,
  warnings = [],
  missingRequired = [],
  resolutions = {},
  canonicalPlan,
  payload,
  command,
  action,
}) {
  return {
    status,
    target: activeTarget.id || 'ros2_real',
    targetKind: activeTarget.kind || 'ros2-bridge',
    targetLabel: activeTarget.label || 'ROS2 Real Robot',
    protocolVersion: 1,
    command,
    action,
    canonicalPlan,
    payload,
    warnings,
    missingRequired,
    resolutions,
    source: summarizeSource(source),
    dispatchPlan: describeRobotDispatchPlan(runtimeConfig, ros2Config),
    feedbackPlan: describeRobotFeedbackPlan(runtimeConfig, ros2Config),
  }
}

function describeRobotDispatchPlan(runtimeConfig = {}, ros2Config = {}) {
  const activeTarget = runtimeConfig.activeTarget ?? {}
  const transport = ros2Config.transport ?? {}
  const active = isRobotHttpTarget(runtimeConfig)
  const enabled = active && runtimeConfig.enabled !== false && transport.enabled !== false
  const dryRun = runtimeConfig.dryRun ?? transport.dryRun ?? true

  return {
    target: activeTarget.id || 'ros2_real',
    targetKind: activeTarget.kind || 'ros2-bridge',
    active,
    enabled,
    dryRun,
    dispatchOnChat: enabled && transport.dispatchOnChat !== false,
    destination: transport.baseUrl || '',
    commandsPath: transport.commandsPath || '/commands',
  }
}

function describeRobotFeedbackPlan(runtimeConfig = {}, ros2Config = {}) {
  const activeTarget = runtimeConfig.activeTarget ?? {}
  const transport = ros2Config.transport ?? {}
  const feedback = ros2Config.feedback ?? {}

  return {
    target: activeTarget.id || 'ros2_real',
    active: isRobotHttpTarget(runtimeConfig),
    destination: transport.baseUrl || '',
    feedbackPath: transport.feedbackPath || '/feedback',
    pollMs: feedback.pollMs ?? runtimeConfig.feedback?.pollMs ?? 2500,
  }
}

function compileCommand(command, parsed, resolutions, warnings) {
  switch (command) {
    case 'move':
      return compileMove(parsed, resolutions, warnings)
    case 'follow':
      return compileFollow(parsed, resolutions, warnings)
    case 'detect':
      return compileDetect(parsed, resolutions, warnings)
    case 'trick':
      return compileTrick(parsed, resolutions, warnings)
    case 'talk':
      return {
        status: 'no-action',
        action: 'dialog.local_only',
        canonicalPlan: null,
        missingRequired: [],
      }
    default:
      warnings.push(`No ROS2 mapping rule is configured for command "${command}".`)

      return {
        status: 'unsupported',
        action: '',
        canonicalPlan: null,
        missingRequired: [],
      }
  }
}

function compileMove(parsed, resolutions, warnings) {
  const waypointName = typeof parsed.waypoint === 'string' ? parsed.waypoint.trim() : ''
  const resolvedWaypointName = resolutions.waypoint.resolvedName || waypointName
  const definition = resolutions.waypoint.definition

  if (!waypointName) {
    return {
      status: 'invalid',
      action: 'dogzilla.navigate_named_target',
      canonicalPlan: null,
      missingRequired: ['fields.waypoint'],
    }
  }

  if (!definition) {
    warnings.push(`Waypoint "${waypointName}" is not defined in robot-waypoints config.`)

    return {
      status: 'invalid',
      action: 'dogzilla.navigate_named_target',
      canonicalPlan: null,
      missingRequired: ['waypoint.definition'],
    }
  }

  if (definition.kind === 'special' && definition.mode === 'stay_put') {
    return {
      status: 'no-op',
      action: 'dogzilla.noop',
      canonicalPlan: {
        kind: 'noop',
        params: {
          reason: 'already_at_target',
          waypoint: waypointName,
        },
      },
      missingRequired: [],
    }
  }

  if (definition.kind !== 'map_pose') {
    warnings.push(`Waypoint "${waypointName}" resolved to kind "${definition.kind || 'unknown'}", not a map pose.`)

    return {
      status: 'unsupported',
      action: 'dogzilla.navigate_named_target',
      canonicalPlan: null,
      missingRequired: [],
    }
  }

  if (definition.verified === false) {
    warnings.push(`Waypoint "${waypointName}" is still marked unverified.`)
  }

  return {
    status: 'ready',
    action: 'dogzilla.navigate_named_target',
    canonicalPlan: {
      kind: 'locomotion.goto',
      params: {
        targetKind: 'waypoint',
        waypoint: resolvedWaypointName,
        frame: definition.frame || 'map',
        x: Number(definition.x) || 0,
        y: Number(definition.y) || 0,
        yaw: Number(definition.yaw) || 0,
        arrivalToleranceMeters: Number(definition.arrivalToleranceMeters) || 0.25,
        verified: definition.verified ?? false,
        physicalSpot: definition.physicalSpot || '',
      },
    },
    missingRequired: [],
  }
}

function compileFollow(parsed, resolutions, warnings) {
  const waypointName = typeof parsed.waypoint === 'string' ? parsed.waypoint.trim() : ''
  const resolvedWaypointName = resolutions.waypoint.resolvedName || waypointName
  const definition = resolutions.waypoint.definition

  if (!waypointName) {
    return {
      status: 'invalid',
      action: 'dogzilla.follow_operator',
      canonicalPlan: null,
      missingRequired: ['fields.waypoint'],
    }
  }

  if (definition?.kind === 'special' && definition.mode === 'operator_source') {
    return {
      status: 'ready',
      action: 'dogzilla.follow_operator',
      canonicalPlan: {
        kind: 'behavior.follow_operator',
        params: {
          source: resolvedWaypointName,
          frame: definition.frame || 'map',
        },
      },
      missingRequired: [],
    }
  }

  if (definition?.kind === 'map_pose') {
    warnings.push(`Follow command with waypoint "${waypointName}" compiles as a behavior request, not raw chassis motion.`)

    return {
      status: 'ready',
      action: 'dogzilla.follow_named_anchor',
      canonicalPlan: {
        kind: 'behavior.follow_named_anchor',
        params: {
          waypoint: resolvedWaypointName,
          frame: definition.frame || 'map',
          x: Number(definition.x) || 0,
          y: Number(definition.y) || 0,
          yaw: Number(definition.yaw) || 0,
        },
      },
      missingRequired: [],
    }
  }

  warnings.push(`Follow command could not resolve a usable source for "${waypointName}".`)

  return {
    status: 'unsupported',
    action: 'dogzilla.follow_operator',
    canonicalPlan: null,
    missingRequired: [],
  }
}

function compileDetect(parsed, resolutions, warnings) {
  const objectToDetect = typeof parsed.object_to_detect === 'string' ? parsed.object_to_detect.trim() : ''
  const waypointName = typeof parsed.waypoint === 'string' ? parsed.waypoint.trim() : ''

  if (!objectToDetect) {
    warnings.push('Detect command is missing object_to_detect, so the ROS2 behavior request is incomplete.')
  }

  return {
    status: objectToDetect ? 'ready' : 'invalid',
    action: 'dogzilla.detect_in_zone',
    canonicalPlan: objectToDetect
      ? {
        kind: 'behavior.detect',
        params: {
          label: objectToDetect,
          waypoint: resolutions.waypoint.resolvedName || waypointName,
          pose: resolutions.waypoint.definition ?? null,
        },
      }
      : null,
    missingRequired: objectToDetect ? [] : ['fields.object_to_detect'],
  }
}

function compileTrick(parsed, resolutions, warnings) {
  const trickName = typeof parsed.trick === 'string' ? parsed.trick.trim() : ''
  const definition = resolutions.trickAction.definition

  if (!trickName) {
    return {
      status: 'invalid',
      action: 'dogzilla.perform_action',
      canonicalPlan: null,
      missingRequired: ['fields.trick'],
    }
  }

  if (!definition) {
    warnings.push(`Trick "${trickName}" is not defined in robot-actions config.`)

    return {
      status: 'invalid',
      action: 'dogzilla.perform_action',
      canonicalPlan: null,
      missingRequired: ['trickAction.definition'],
    }
  }

  if (!Number.isInteger(definition.actionId)) {
    warnings.push(`Trick "${trickName}" does not have a verified numeric DOGZILLA action id yet.`)

    return {
      status: 'unsupported',
      action: 'dogzilla.perform_action',
      canonicalPlan: null,
      missingRequired: [],
    }
  }

  return {
    status: 'ready',
    action: 'dogzilla.perform_action',
    canonicalPlan: {
      kind: 'action.once',
      params: {
        trick: trickName,
        actionId: definition.actionId,
        verified: definition.verified ?? false,
      },
    },
    missingRequired: [],
  }
}

function resolveWaypoint(parsed, waypointConfig) {
  const waypointName = typeof parsed?.waypoint === 'string' ? parsed.waypoint.trim() : ''
  const activeSetId = waypointConfig.activeSet || Object.keys(waypointConfig.sets ?? {})[0] || ''
  const activeSet = waypointConfig.sets?.[activeSetId] ?? {}
  const normalizedName = normalizeWaypointName(waypointName)
  const exactDefinition = waypointName ? activeSet.waypoints?.[waypointName] : null
  const normalizedDefinition = waypointName ? activeSet.waypoints?.[normalizedName] : null
  const definition = exactDefinition ?? normalizedDefinition ?? null
  const resolvedName = exactDefinition ? waypointName : normalizedDefinition ? normalizedName : waypointName

  return {
    name: waypointName,
    normalizedName,
    resolvedName,
    activeSet: activeSetId,
    exists: waypointName ? !!definition : false,
    definition,
  }
}

function normalizeWaypointName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
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
    definition,
  }
}

function resolveMotionProfile(motionConfig, activeProfileId) {
  return motionConfig.profiles?.[activeProfileId] ?? motionConfig.profiles?.[motionConfig.activeProfile] ?? {}
}

function normalizeControlAxis(value, deadband) {
  const numeric = clamp(finiteNumber(value, 0), -1, 1)
  return Math.abs(numeric) <= deadband ? 0 : numeric
}

function clampToLimit(value, limit = {}, fallbackMin, fallbackMax) {
  const minimum = finiteNumber(limit.min, fallbackMin)
  const maximum = finiteNumber(limit.max, fallbackMax)
  return clamp(finiteNumber(value, 0), minimum, maximum)
}

function normalizeChoice(value, choices = [], fallback) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const allowed = Array.isArray(choices) ? choices : []

  if (normalized && allowed.includes(normalized)) {
    return normalized
  }

  if (allowed.includes(fallback)) {
    return fallback
  }

  return allowed[0] || fallback
}

function finiteNumber(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function summarizeSource(source) {
  return {
    inputText: typeof source.input === 'string' ? source.input : '',
    rawResponse: typeof source.rawResponse === 'string' ? source.rawResponse : '',
  }
}
