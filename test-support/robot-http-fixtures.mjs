export { jsonResponse, parseRequestBody, withMockedFetch } from './http-fixtures.mjs'

export function dogzillaDirectRuntime(overrides = {}) {
  return {
    dryRun: false,
    activeTarget: {
      id: 'dogzilla_direct',
      kind: 'dogzilla-direct',
      label: 'DOGZILLA Direct Bridge',
      ...(overrides.activeTarget ?? {}),
    },
    ...withoutKey(overrides, 'activeTarget'),
  }
}

export function ros2Runtime(overrides = {}) {
  return {
    dryRun: false,
    activeTarget: {
      id: 'ros2_real',
      kind: 'ros2-bridge',
      label: 'ROS2 Real Robot',
      ...(overrides.activeTarget ?? {}),
    },
    ...withoutKey(overrides, 'activeTarget'),
  }
}

export function dogzillaTransportConfig(overrides = {}) {
  return {
    transport: {
      kind: 'http',
      enabled: true,
      dryRun: false,
      baseUrl: 'http://10.0.4.32:8893',
      healthPath: '/healthz',
      commandsPath: '/commands',
      timeoutMs: 1000,
      ...overrides,
    },
  }
}

export function ros2TransportConfig(overrides = {}) {
  return {
    transport: {
      kind: 'http',
      enabled: true,
      dryRun: false,
      baseUrl: 'http://192.168.8.88:8892',
      healthPath: '/healthz',
      commandsPath: '/commands',
      timeoutMs: 1000,
      ...overrides,
    },
  }
}

export function manualRelativePreview(overrides = {}) {
  return {
    status: 'ready',
    command: 'manual',
    canonicalPlan: {
      kind: 'locomotion.relative',
      params: {
        x_step: 1,
        y_step: 0,
        turn_rate: 0,
        ...(overrides.params ?? {}),
      },
    },
    ...withoutKey(overrides, 'params'),
  }
}

export function waypointGotoPreview(overrides = {}) {
  return {
    status: 'ready',
    command: 'move',
    canonicalPlan: {
      kind: 'locomotion.goto',
      params: {
        targetKind: 'waypoint',
        waypoint: 'living_room',
        frame: 'map',
        x: 1.25,
        y: -0.5,
        yaw: 0.2,
        ...(overrides.params ?? {}),
      },
    },
    ...withoutKey(overrides, 'params'),
  }
}

export function actionOncePreview(params = {}) {
  return {
    status: 'ready',
    command: 'trick',
    canonicalPlan: {
      kind: 'action.once',
      params: {
        trick: 'sit',
        actionId: 12,
        ...params,
      },
    },
  }
}

export function nav2HealthBody(overrides = {}) {
  return {
    ok: true,
    runtime: {
      nav2: {
        available: true,
        ...(overrides.nav2 ?? {}),
      },
      ...(overrides.runtime ?? {}),
    },
    ...withoutKeys(overrides, ['nav2', 'runtime']),
  }
}

function withoutKey(source, key) {
  const result = { ...source }
  delete result[key]
  return result
}

function withoutKeys(source, keys) {
  const result = { ...source }
  for (const key of keys) {
    delete result[key]
  }
  return result
}
