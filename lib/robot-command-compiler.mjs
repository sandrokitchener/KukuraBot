import { loadRobotActionsConfig, loadRobotWaypointsConfig } from './isaacsim-config.mjs'
import { loadRobotMotionConfig, loadRobotRos2Config, loadRobotRuntimeConfig } from './robot-runtime-config.mjs'

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
  const active = activeTarget.kind === 'ros2-bridge'
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
    active: activeTarget.kind === 'ros2-bridge',
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
        waypoint: waypointName,
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
          source: waypointName,
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
          waypoint: waypointName,
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
          waypoint: waypointName,
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
    definition,
  }
}

function resolveMotionProfile(motionConfig, activeProfileId) {
  return motionConfig.profiles?.[activeProfileId] ?? motionConfig.profiles?.[motionConfig.activeProfile] ?? {}
}

function summarizeSource(source) {
  return {
    inputText: typeof source.input === 'string' ? source.input : '',
    rawResponse: typeof source.rawResponse === 'string' ? source.rawResponse : '',
  }
}
