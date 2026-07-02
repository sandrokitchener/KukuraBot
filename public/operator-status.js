export const DANGEROUS_CONNECTION_ACTIONS = Object.freeze({
  'capture-map-origin': {
    title: 'Set Charger Origin',
    message: 'This will save the current robot position as the charger origin. Existing app_map waypoints keep their stored capture anchor; only new captures use this origin.',
  },
  'start-map-pose-mapping': {
    title: 'Start New SLAM Map',
    message: 'This switches Cartographer into live mapping. Drive slowly, save only when the map is stable, then recapture waypoints that no longer align.',
  },
  'save-map-pose': {
    title: 'Save SLAM Map',
    message: 'This commits the current SLAM map and restarts localization against it. Existing waypoints may need recapture if the map origin or walls shifted.',
  },
  'sync-bridges': {
    title: 'Deploy Bridge Code',
    message: 'This will overwrite the bridge scripts on the Pi and restart the direct bridge. Active navigation or mapping may be interrupted.',
  },
  'stop-vendor-app': {
    title: 'Stop Vendor App',
    message: 'This will stop the vendor DOGZILLA app on the Pi. Robot control from the vendor app will be unavailable until it is restarted.',
  },
  'stop-bridges': {
    title: 'Stop Bridges',
    message: 'This will stop all Robo-Doge bridges on the Pi. Telemetry, camera, LiDAR, and navigation will be unavailable until bridges are restarted.',
  },
})

export function getConnectionActionConfirmation(action) {
  const entry = DANGEROUS_CONNECTION_ACTIONS[action]
  return entry ? { title: entry.title, message: entry.message } : null
}

export function isDangerousConnectionAction(action) {
  return Object.prototype.hasOwnProperty.call(DANGEROUS_CONNECTION_ACTIONS, action)
}

const SAFE_NEXT_ACTION_PRIORITY = [
  {
    test: (snapshot) => !snapshot?.activeRobot,
    action: 'Check robot link',
    blocker: null,
  },
  {
    test: (snapshot) => {
      const pose = snapshot?.poseState
      return pose?.status === 'error' || pose?.waypointSafe === false
    },
    action: 'Localize on Map',
    blocker: (snapshot) => snapshot?.poseState?.error || 'Pose not available or not waypoint-safe',
  },
  {
    test: (snapshot) => {
      const nav2 = snapshot?.nav2Stability
      return nav2?.state === 'disconnected' || nav2?.state === 'blocked'
    },
    action: 'Restart Nav',
    blocker: (snapshot) => snapshot?.nav2Stability?.currentBlocker || 'Nav2 not ready',
  },
  {
    test: (snapshot) => {
      const nav = snapshot?.navigationStatus
      return nav?.status === 'blocked' || nav?.status === 'stuck'
    },
    action: 'Check Ready',
    blocker: (snapshot) => snapshot?.navigationStatus?.text || 'Navigation blocked',
  },
  {
    test: (snapshot) => {
      const nav = snapshot?.navigationStatus
      return nav?.status === 'stuck' || nav?.status === 'navigating'
    },
    action: 'Emergency stop',
    blocker: null,
  },
  {
    test: () => true,
    action: 'Send movement command',
    blocker: null,
  },
]

export function deriveSafeNextAction(snapshot) {
  for (const rule of SAFE_NEXT_ACTION_PRIORITY) {
    if (rule.test(snapshot)) {
      const blocker = typeof rule.blocker === 'function' ? rule.blocker(snapshot) : rule.blocker
      return { action: rule.action, blocker }
    }
  }
  return { action: 'Send movement command', blocker: null }
}

export function deriveOperatorLastCommand(snapshot, lastOperatorCommand) {
  if (lastOperatorCommand && lastOperatorCommand.command) {
    const result = lastOperatorCommand.result ? ` → ${lastOperatorCommand.result}` : ''
    return `${lastOperatorCommand.command}${result}`
  }
  const nav = snapshot?.navigationStatus
  if (nav?.targetWaypoint) {
    return nav.targetWaypoint
  }
  return '-'
}

export const NAV_CHAIN_COMPONENTS = Object.freeze([
  { id: 'lidar', label: 'LiDAR' },
  { id: 'localization', label: 'Localization' },
  { id: 'odom', label: 'Odom + TF' },
  { id: 'action', label: 'Nav2 action' },
  { id: 'lifecycle', label: 'Nav2 lifecycle' },
  { id: 'scan', label: 'Filtered scan' },
])

export function buildNavChainComponents(readinessPayload) {
  if (!readinessPayload || !readinessPayload.navigation) {
    return NAV_CHAIN_COMPONENTS.map((component) => ({
      ...component,
      status: 'unknown',
      detail: 'Readiness payload missing',
    }))
  }

  const nav = readinessPayload.navigation
  const mapOrigin = readinessPayload.mapOrigin

  return [
    {
      ...NAV_CHAIN_COMPONENTS[0],
      status: nav.scanReady === true ? 'ok' : 'fail',
      detail: nav.scanReady ? 'Scan data flowing' : 'Scan not ready',
    },
    {
      ...NAV_CHAIN_COMPONENTS[1],
      status: mapOrigin?.configured === true && nav.scanReady === true ? 'ok' : 'fail',
      detail: mapOrigin?.configured ? (nav.scanReady ? 'Map origin + scan OK' : 'Map origin set, scan not ready') : 'Map origin not set',
    },
    {
      ...NAV_CHAIN_COMPONENTS[2],
      status: nav.odomReady === true && nav.odomTfAvailable === true ? 'ok' : 'fail',
      detail: nav.odomReady ? (nav.odomTfAvailable ? 'OK' : 'TF unavailable') : 'Odom not ready',
    },
    {
      ...NAV_CHAIN_COMPONENTS[3],
      status: nav.actionAvailable === true ? 'ok' : 'fail',
      detail: nav.actionAvailable ? 'OK' : 'Action server unavailable',
    },
    {
      ...NAV_CHAIN_COMPONENTS[4],
      status: nav.lifecycleActive === true ? 'ok' : 'fail',
      detail: nav.lifecycleActive ? 'OK' : 'Lifecycle nodes inactive',
    },
    {
      ...NAV_CHAIN_COMPONENTS[5],
      status: nav.scanReady === true ? 'ok' : 'fail',
      detail: nav.scanReady ? 'OK' : 'Scan not ready',
    },
  ]
}

export function summarizeNavChain(components) {
  const total = components.length
  const okCount = components.filter((c) => c.status === 'ok').length
  const unknownCount = components.filter((c) => c.status === 'unknown').length
  const failed = components.filter((c) => c.status === 'fail')
  const summary = `${okCount}/${total} ready`
  if (unknownCount === total) {
    return `${summary} (unknown)`
  }
  if (failed.length > 0) {
    const labels = failed.map((c) => c.label).join(', ')
    return `${summary} (${labels})`
  }
  return summary
}
