import { loadDogzillaConnectionConfig } from './dogzilla-connection-center.mjs'
import { defaultClient as rosbridgeClient } from './rosbridge-client.mjs'

export function getRosbridgeClient() {
  return rosbridgeClient
}

export async function startDogzillaLidarClient(options = {}) {
  const config = options.config || await loadDogzillaConnectionConfig()
  const lidar = config?.lidar || {}

  if (lidar.enabled !== true) {
    return { enabled: false, status: 'skipped' }
  }

  const url = lidar.rosbridgeUrl || 'ws://10.0.4.32:9090'
  rosbridgeClient.url = url
  if (lidar.rosbridgeTopics) {
    rosbridgeClient.topics = lidar.rosbridgeTopics
  }
  if (lidar.maxPoints) {
    rosbridgeClient.maxPoints = Number(lidar.maxPoints)
  }
  if (lidar.mapFrame) {
    rosbridgeClient.mapFrame = lidar.mapFrame
  }
  if (lidar.odomFrame) {
    rosbridgeClient.odomFrame = lidar.odomFrame
  }
  if (Array.isArray(lidar.baseFrames)) {
    rosbridgeClient.baseFrames = new Set(lidar.baseFrames)
  }

  rosbridgeClient.connect()
  return { enabled: true, status: 'started', url }
}

export async function getDogzillaLidarHealth(options = {}) {
  const config = options.config || await loadDogzillaConnectionConfig()
  const lidar = config?.lidar || {}

  if (lidar.enabled === true && rosbridgeClient.connectionState === 'disconnected' && !rosbridgeClient.intentionalClose) {
    await startDogzillaLidarClient({ config })
  }

  if (lidar.enabled !== true) {
    return {
      status: 'disabled',
      ok: false,
      detail: 'DOGZILLA lidar bridge is not configured.',
    }
  }

  const health = rosbridgeClient.getHealth()
  return {
    ...health,
    destination: rosbridgeClient.url,
  }
}

export async function getDogzillaLidarScan(options = {}) {
  const config = options.config || await loadDogzillaConnectionConfig()
  const lidar = config?.lidar || {}

  if (lidar.enabled === true && rosbridgeClient.connectionState === 'disconnected' && !rosbridgeClient.intentionalClose) {
    await startDogzillaLidarClient({ config })
  }

  if (lidar.enabled !== true) {
    return {
      status: 'disabled',
      ok: false,
      error: 'DOGZILLA lidar bridge is not configured.',
      points: [],
    }
  }

  const scan = rosbridgeClient.getScan()
  return {
    ...scan,
    destination: rosbridgeClient.url,
  }
}

export async function getDogzillaLidarDiagnostics(options = {}) {
  const config = options.config || await loadDogzillaConnectionConfig()
  const lidar = config?.lidar || {}

  if (lidar.enabled === true && rosbridgeClient.connectionState === 'disconnected' && !rosbridgeClient.intentionalClose) {
    await startDogzillaLidarClient({ config })
  }

  if (lidar.enabled !== true) {
    return {
      status: 'disabled',
      ok: false,
      error: 'DOGZILLA lidar diagnostics are not configured.',
      diagnostics: [],
      nextChecks: [],
    }
  }

  const health = rosbridgeClient.getHealth()
  const scan = rosbridgeClient.getScan()
  return {
    ok: health.ok,
    status: health.ok ? 'ok' : health.status,
    connected: health.connected,
    frames: health.frames,
    latestFrameAgeSeconds: health.latestScanAgeSec,
    latestError: health.error,
    diagnostics: health.ok
      ? []
      : [
          `rosbridge URL: ${rosbridgeClient.url}`,
          `Subscribed topics: ${rosbridgeClient.topics.map((t) => t.topic).join(', ')}`,
          scan.status === 'no-scan' ? 'No LaserScan frames received yet.' : `Last scan had ${scan.rangeCount} ranges.`,
        ],
    nextChecks: [
      'Confirm the Pi and rosbridge container are running.',
      'Confirm /scan is published on the Pi ROS2 graph.',
      'Do not enable waypoint navigation until LaserScan frames and a real pose source are verified.',
    ],
    destination: rosbridgeClient.url,
  }
}

export async function getDogzillaMapData(options = {}) {
  const config = options.config || await loadDogzillaConnectionConfig()
  const lidar = config?.lidar || {}

  if (lidar.enabled === true && rosbridgeClient.connectionState === 'disconnected' && !rosbridgeClient.intentionalClose) {
    await startDogzillaLidarClient({ config })
  }

  if (lidar.enabled !== true) {
    return {
      status: 'disabled',
      ok: false,
      error: 'DOGZILLA lidar bridge is not configured.',
    }
  }

  const map = rosbridgeClient.getMap()
  return {
    ...map,
    destination: rosbridgeClient.url,
  }
}

export async function getDogzillaRobotPose(options = {}) {
  const config = options.config || await loadDogzillaConnectionConfig()
  const lidar = config?.lidar || {}

  if (lidar.enabled === true && rosbridgeClient.connectionState === 'disconnected' && !rosbridgeClient.intentionalClose) {
    await startDogzillaLidarClient({ config })
  }

  if (lidar.enabled !== true) {
    return {
      status: 'disabled',
      ok: false,
      error: 'DOGZILLA pose bridge is not configured.',
      pose: null,
      mapPose: null,
      waypointSafe: false,
    }
  }

  const result = rosbridgeClient.getPose()
  // The map pose service previously returned coordinates nested under
  // a mapPose or pose key. Flatten x/y/theta/frame to the top level so
  // capture/dispatch handlers can access them directly.
  if (result?.ok && result?.waypointSafe) {
    const nestedPose = result.mapPose || result.pose
    if (nestedPose && typeof nestedPose === 'object') {
      return {
        ...result,
        x: nestedPose.x,
        y: nestedPose.y,
        theta: nestedPose.theta ?? nestedPose.yaw,
        frame: nestedPose.frame || result.frame || 'map',
        destination: rosbridgeClient.url,
      }
    }
  }
  return {
    ...result,
    destination: rosbridgeClient.url,
  }
}
