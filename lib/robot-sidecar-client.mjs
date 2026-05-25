import { loadRobotRos2Config, loadRobotRuntimeConfig } from './robot-runtime-config.mjs'

export const ROBOT_HTTP_TARGET_KINDS = new Set(['ros2-bridge', 'dogzilla-direct'])

export async function getRobotSidecarHealth() {
  const [runtimeConfig, ros2Config] = await Promise.all([
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
  ])

  return probeRobotSidecarHealth(runtimeConfig, ros2Config)
}

export async function getRobotRuntimeFeedback() {
  const [runtimeConfig, ros2Config] = await Promise.all([
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
  ])

  return fetchRobotRuntimeFeedback(runtimeConfig, ros2Config)
}

export async function getRobotBridgeState() {
  const [runtimeConfig, ros2Config] = await Promise.all([
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
  ])

  return fetchRobotBridgeState(runtimeConfig, ros2Config)
}

export async function dispatchRobotCommand(preview) {
  const [runtimeConfig, ros2Config] = await Promise.all([
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
  ])

  return sendRobotCommand(preview, runtimeConfig, ros2Config)
}

export async function dispatchRobotEmergencyStop() {
  const [runtimeConfig, ros2Config] = await Promise.all([
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
  ])

  return sendRobotEmergencyStop(runtimeConfig, ros2Config)
}

export async function probeRobotSidecarHealth(runtimeConfig = {}, ros2Config = {}) {
  const transport = ros2Config.transport ?? {}

  if (!isRobotHttpTarget(runtimeConfig)) {
    return {
      attempted: false,
      status: 'inactive-target',
      destination: transport.baseUrl || '',
      activeTarget: runtimeConfig.activeTarget?.id || '',
    }
  }

  if (!transport.enabled) {
    return {
      attempted: false,
      status: 'disabled',
      destination: transport.baseUrl || '',
    }
  }

  if (transport.kind !== 'http') {
    return {
      attempted: false,
      status: 'unsupported-transport',
      destination: transport.baseUrl || '',
    }
  }

  const targetUrl = buildTargetUrl(transport.baseUrl, transport.healthPath)

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(transport.timeoutMs || 4000),
    })
    const body = await safeReadJson(response)
    const runtimeOk = body && typeof body === 'object' && body.ok === false ? false : true

    return {
      attempted: true,
      status: response.ok && runtimeOk ? 'ok' : response.ok ? 'degraded' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      body,
    }
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function fetchRobotRuntimeFeedback(runtimeConfig = {}, ros2Config = {}) {
  const transport = ros2Config.transport ?? {}

  if (!isRobotHttpTarget(runtimeConfig)) {
    return {
      attempted: false,
      status: 'inactive-target',
      destination: transport.baseUrl || '',
      feedback: null,
    }
  }

  if (!transport.enabled) {
    return {
      attempted: false,
      status: 'disabled',
      destination: transport.baseUrl || '',
      feedback: null,
    }
  }

  const targetUrl = buildTargetUrl(transport.baseUrl, transport.feedbackPath)

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(transport.timeoutMs || 4000),
    })
    const body = await safeReadJson(response)

    return {
      attempted: true,
      status: response.ok ? 'ok' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      feedback: body,
    }
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      error: error instanceof Error ? error.message : String(error),
      feedback: null,
    }
  }
}

export async function sendRobotCommand(preview, runtimeConfig = {}, ros2Config = {}) {
  const transport = ros2Config.transport ?? {}

  if (!preview || typeof preview !== 'object') {
    return {
      attempted: false,
      status: 'invalid-preview',
      destination: transport.baseUrl || '',
    }
  }

  if (!isRobotHttpTarget(runtimeConfig)) {
    return {
      attempted: false,
      status: 'inactive-target',
      destination: transport.baseUrl || '',
      activeTarget: runtimeConfig.activeTarget?.id || '',
    }
  }

  if (preview.status !== 'ready') {
    return {
      attempted: false,
      status: 'preview-not-ready',
      destination: transport.baseUrl || '',
      previewStatus: preview.status,
    }
  }

  if (!transport.enabled) {
    return {
      attempted: false,
      status: 'disabled',
      destination: transport.baseUrl || '',
    }
  }

  if ((runtimeConfig.dryRun ?? true) || transport.dryRun) {
    return {
      attempted: false,
      status: 'dry-run',
      destination: buildTargetUrl(transport.baseUrl, transport.commandsPath),
    }
  }

  if (transport.kind !== 'http') {
    return {
      attempted: false,
      status: 'unsupported-transport',
      destination: transport.baseUrl || '',
    }
  }

  const targetUrl = buildTargetUrl(transport.baseUrl, transport.commandsPath)

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        envelope: preview,
      }),
      signal: AbortSignal.timeout(transport.timeoutMs || 4000),
    })
    const body = await safeReadJson(response)

    return {
      attempted: true,
      status: response.ok ? 'sent' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      body,
    }
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function sendRobotEmergencyStop(runtimeConfig = {}, ros2Config = {}) {
  const transport = ros2Config.transport ?? {}
  const envelope = buildEmergencyStopEnvelope(runtimeConfig, ros2Config)

  if (!isRobotHttpTarget(runtimeConfig)) {
    return {
      attempted: false,
      status: 'inactive-target',
      destination: transport.baseUrl || '',
      activeTarget: runtimeConfig.activeTarget?.id || '',
      envelope,
    }
  }

  if (!transport.enabled) {
    return {
      attempted: false,
      status: 'disabled',
      destination: transport.baseUrl || '',
      envelope,
    }
  }

  if (transport.kind !== 'http') {
    return {
      attempted: false,
      status: 'unsupported-transport',
      destination: transport.baseUrl || '',
      envelope,
    }
  }

  const targetUrl = buildTargetUrl(transport.baseUrl, transport.commandsPath)

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'stop',
        envelope,
      }),
      signal: AbortSignal.timeout(transport.timeoutMs || 4000),
    })
    const body = await safeReadJson(response)

    return {
      attempted: true,
      status: response.ok ? 'sent' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      envelope,
      body,
    }
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      envelope,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function fetchRobotBridgeState(runtimeConfig = {}, ros2Config = {}) {
  const transport = ros2Config.transport ?? {}

  if (!isRobotHttpTarget(runtimeConfig)) {
    return {
      attempted: false,
      status: 'inactive-target',
      destination: transport.baseUrl || '',
      state: null,
    }
  }

  if (!transport.enabled) {
    return {
      attempted: false,
      status: 'disabled',
      destination: transport.baseUrl || '',
      state: null,
    }
  }

  const targetUrl = buildTargetUrl(transport.baseUrl, '/state')

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(transport.timeoutMs || 4000),
    })
    const body = await safeReadJson(response)

    return {
      attempted: true,
      status: response.ok ? 'ok' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      state: body,
    }
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      error: error instanceof Error ? error.message : String(error),
      state: null,
    }
  }
}

export function isRobotHttpTarget(runtimeConfig = {}) {
  return ROBOT_HTTP_TARGET_KINDS.has(runtimeConfig.activeTarget?.kind || '')
}

function buildEmergencyStopEnvelope(runtimeConfig = {}, ros2Config = {}) {
  return {
    status: 'ready',
    target: runtimeConfig.activeTarget?.id || 'ros2_real',
    targetKind: runtimeConfig.activeTarget?.kind || 'ros2-bridge',
    targetLabel: runtimeConfig.activeTarget?.label || 'ROS2 Real Robot',
    protocolVersion: 1,
    command: 'safety',
    action: 'stop',
    canonicalPlan: {
      kind: 'noop',
      params: {
        reason: 'emergency_stop',
        action: 'stop',
      },
    },
    payload: {
      robotId: runtimeConfig.robotId || 'dogzilla-local',
      robotModel: runtimeConfig.robotModel || 'dogzilla-s2',
      planTopic: ros2Config.bridge?.commandPlanTopic || '/dogzilla/command_plan',
      stateTopic: ros2Config.topics?.state || '/dogzilla/state',
      canonicalPlan: {
        kind: 'noop',
        params: {
          reason: 'emergency_stop',
          action: 'stop',
        },
      },
    },
    warnings: [],
    missingRequired: [],
    dispatchPlan: {
      target: runtimeConfig.activeTarget?.id || 'ros2_real',
      targetKind: runtimeConfig.activeTarget?.kind || 'ros2-bridge',
      active: isRobotHttpTarget(runtimeConfig),
      enabled: runtimeConfig.enabled !== false && ros2Config.transport?.enabled !== false,
      dryRun: false,
      dispatchOnChat: false,
      destination: ros2Config.transport?.baseUrl || '',
      commandsPath: ros2Config.transport?.commandsPath || '/commands',
    },
  }
}

function buildTargetUrl(baseUrl, routePath) {
  return new URL(routePath || '/', baseUrl || 'http://127.0.0.1:8892').toString()
}

async function safeReadJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}
