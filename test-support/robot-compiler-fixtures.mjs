import {
  dogzillaDirectRuntime,
  ros2Runtime,
} from './robot-http-fixtures.mjs'

export function runtimePreviewInput({
  source = {},
  runtimeConfig = ros2Runtime({
    enabled: true,
    dryRun: true,
    robotId: 'dogzilla-local',
    robotName: 'Questing Beast',
    robotModel: 'dogzilla-s2',
    selectedMotionProfile: 'default',
  }),
  ros2Config = robotRos2Config(),
  waypoints = {},
  tricks = {},
  motionProfile = {},
  mapOrigin = null,
} = {}) {
  return {
    source,
    runtimeConfig,
    ros2Config,
    waypointConfig: waypointConfig(waypoints),
    actionConfig: actionConfig(tricks),
    motionConfig: motionConfig(motionProfile),
    mapOrigin,
  }
}

export function manualControlInput({
  control = {},
  runtimeConfig = dogzillaDirectRuntime({
    enabled: true,
    dryRun: false,
    robotId: 'dogzilla-local',
    robotName: 'Questing Beast',
    robotModel: 'dogzilla-s2',
    selectedMotionProfile: 'default',
  }),
  ros2Config = robotRos2Config({
    transport: {
      dryRun: false,
      baseUrl: 'http://127.0.0.1:8893',
    },
  }),
  motionProfile = dogzillaMotionProfile(),
} = {}) {
  return {
    control,
    runtimeConfig,
    ros2Config,
    motionConfig: motionConfig(motionProfile),
  }
}

export function robotRos2Config({
  bridge = {},
  topics = {},
  transport = {},
  feedback = {},
} = {}) {
  return {
    bridge: {
      commandPlanTopic: '/dogzilla/command_plan',
      ...bridge,
    },
    topics: {
      state: '/dogzilla/state',
      ...topics,
    },
    transport: {
      enabled: true,
      dryRun: true,
      dispatchOnChat: true,
      baseUrl: 'http://127.0.0.1:8892',
      commandsPath: '/commands',
      feedbackPath: '/feedback',
      ...transport,
    },
    feedback: {
      pollMs: 2500,
      ...feedback,
    },
  }
}

export function waypointConfig(waypoints = {}) {
  return {
    activeSet: 'home',
    sets: {
      home: {
        waypoints,
      },
    },
  }
}

export function actionConfig(tricks = {}) {
  return {
    activeMap: 'default',
    maps: {
      default: {
        tricks,
      },
    },
  }
}

export function motionConfig(defaultProfile = {}) {
  return {
    activeProfile: 'default',
    profiles: {
      default: defaultProfile,
    },
  }
}

export function mapWaypoint(overrides = {}) {
  return {
    kind: 'map_pose',
    frame: 'map',
    x: 0,
    y: 0,
    yaw: 0,
    arrivalToleranceMeters: 0.25,
    verified: true,
    mapId: 'test_map',
    mapFingerprint: 'test-map-fingerprint',
    ...overrides,
  }
}

export function dogzillaMotionProfile(overrides = {}) {
  return {
    gaits: ['walk', 'trot'],
    paceModes: ['slow', 'normal', 'high'],
    limits: {
      xStep: { min: -25, max: 25 },
      yStep: { min: 0, max: 0 },
      turnRate: { min: -100, max: 100 },
    },
    twistCalibration: {
      deadband: 0.05,
      linearXFullScaleStep: 25,
      linearYFullScaleStep: 0,
      angularZFullScaleStep: 100,
    },
    ...overrides,
  }
}
