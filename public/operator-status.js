export const DANGEROUS_CONNECTION_ACTIONS = Object.freeze({
  'capture-map-origin': {
    title: 'Set Charger Origin',
    message: 'This will save the current robot position as the charger origin. Existing app_map waypoints keep their stored capture anchor; only new captures use this origin.',
  },
  'start-map-pose-mapping': {
    title: 'Start New SLAM Map',
    message: 'This switches Cartographer into live mapping. Drive slowly, save only when the map is stable, then recapture waypoints that no longer align.',
  },
  'start-autonomous-mapping': {
    title: 'Map This Floor',
    message: 'Robot will autonomously navigate to conservative LiDAR frontiers. Keep stairs, people, pets, and fragile objects out of its reachable area. Finish Mapping saves a candidate only; it does not replace the active map.',
  },
  'continue-autonomous-mapping': {
    title: 'Continue Current Map',
    message: 'Robot will extend the active Cartographer map from its saved PBSTREAM. Start only when the robot is localized in a recognizable part of that map.',
  },
  'finish-autonomous-mapping': {
    title: 'Finish Autonomous Mapping',
    message: 'Robot will stop, save a candidate map, and restore the previous active map for normal navigation.',
  },
  'promote-map-candidate': {
    title: 'Use Candidate Map',
    message: 'This replaces the active map with the latest candidate and restarts localization and navigation. Existing waypoints may no longer align.',
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
