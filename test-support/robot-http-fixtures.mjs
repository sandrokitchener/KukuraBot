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
        verified: true,
        mapId: 'test_map',
        mapFingerprint: 'test-map-fingerprint',
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
  const nav2Override = overrides.nav2 ?? {}
  const nav2Available = nav2Override.available !== undefined ? nav2Override.available === true : true
  const odomOverride = nav2Override.odom && typeof nav2Override.odom === 'object' ? nav2Override.odom : {}
  const odomAvailable = odomOverride.available !== undefined ? odomOverride.available === true : nav2Available
  const waypointReady = nav2Override.waypointReady !== undefined
    ? nav2Override.waypointReady === true
    : nav2Available && odomAvailable
  return {
    ok: true,
    runtime: {
      map: {
        available: true,
        id: 'test_map',
        resolution: 0.05,
        widthCells: 400,
        heightCells: 400,
        origin: [-10, -10, 0],
        bounds: {
          minX: -10,
          maxX: 10,
          minY: -10,
          maxY: 10,
        },
        fingerprint: 'test-map-fingerprint',
      },
      nav2: {
        available: nav2Available,
        waypointReady,
        ...withoutKey(nav2Override, 'odom'),
        odom: {
          topic: '/odom',
          publisherCount: odomAvailable ? 1 : 0,
          available: odomAvailable,
          ...odomOverride,
        },
      },
      navigation: {
        available: waypointReady,
        primary: waypointReady ? 'nav2' : 'unavailable',
        actionServerAvailable: nav2Available,
        waypointReady,
        ...(overrides.navigation ?? {}),
      },
      ...(overrides.runtime ?? {}),
    },
    ...withoutKeys(overrides, ['nav2', 'navigation', 'runtime']),
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
