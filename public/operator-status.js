export const DANGEROUS_CONNECTION_ACTIONS = Object.freeze({
  'start-map-pose-mapping': {
    title: 'Start New SLAM Map',
    message: 'This switches Cartographer into live mapping. Drive slowly, save only when the map is stable, then recapture waypoints that no longer align.',
  },
  'start-map-pose': {
    title: 'Relocalize Robot',
    message: 'This pauses waypoint navigation, matches live LiDAR against the full saved map, and enables navigation only after Cartographer proves a global match.',
  },
  'start-autonomous-mapping': {
    title: 'Map This Floor',
    message: 'Robot will autonomously navigate to conservative LiDAR frontiers. Keep stairs, people, pets, and fragile objects out of its reachable area. Finish Mapping saves a candidate only; it does not replace the active map.',
  },
  'continue-autonomous-mapping': {
    title: 'Extend Active Map',
    message: 'Robot will relocalize against the map currently used for navigation, explore its unknown edges, and save the result as a draft. The active map and waypoints stay unchanged until Use New Map.',
  },
  'resume-draft-mapping': {
    title: 'Resume Draft Map',
    message: 'Robot will relocalize against the newest unpromoted draft map and continue exploring its unknown edges. The draft remains separate from the active navigation map.',
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

export function formatLocalizationRecoveryMessage(message) {
  const text = String(message || '').trim()
  if (!/Global localization timed out without \d+ distinct frozen-map constraint matches/i.test(text)) {
    return text
  }

  return 'Robot location could not be verified, so autonomous navigation remains blocked. Use Manual Control to move the robot to a distinctive spot already shown on the saved map, keep the LiDAR unobstructed, face roughly the mapped direction, then retry Relocalize on Map. If it fails from two different known spots, use Map This Floor and then Use New Map.'
}

export function buildNavChainComponents(readinessPayload) {
  if (!readinessPayload || !readinessPayload.navigation) {
    return NAV_CHAIN_COMPONENTS.map((component) => ({
      ...component,
      status: 'unknown',
      detail: 'Readiness payload missing',
    }))
  }

  const nav = readinessPayload.navigation
  const lidar = readinessPayload.sensors?.lidar
  const localization = readinessPayload.sensors?.localization
  const localizedPose = localization?.mapPose || localization?.pose || localization
  const localizationBlocker = Array.isArray(nav.blockers)
    ? nav.blockers.find((blocker) => /location|localiz|global match|relocal/i.test(String(blocker || '')))
    : ''
  const lidarStatus = lidar ? (lidar.ok === true ? 'ok' : 'fail') : 'unknown'
  const localizationReady = localization?.ok === true
    && localization?.waypointSafe === true
    && localizedPose?.frame === 'map'
    && !localizationBlocker
  const localizationDetail = formatLocalizationRecoveryMessage(
    localizationBlocker || localization?.error || 'Verified map-frame location unavailable',
  )
  const localizationStatus = localization ? (localizationReady ? 'ok' : 'fail') : 'unknown'
  const odomBlocker = findNavigationBlocker(nav, /odom|odometry/i)
  const odomReady = nav.odomReady === true
    && isTrueWhenReported(nav, 'odomFresh')
    && isTrueWhenReported(nav, 'odomTfFresh')
    && !/stale|not ready|unavailable/i.test(odomBlocker)
  const odomDetail = !nav.odomReady
    ? 'Odom not ready'
    : nav.odomFresh === false
      ? 'Odom samples are stale'
      : nav.odomTfAvailable === false
        ? 'TF unavailable'
        : nav.odomTfFresh === false
          ? 'Odom TF is stale'
          : odomBlocker
            ? odomBlocker
            : 'OK'

  const components = [
    {
      ...NAV_CHAIN_COMPONENTS[0],
      status: lidarStatus,
      detail: lidar
        ? (lidar.ok === true
            ? `Raw scan flowing on ${lidar.topic || '/scan'}`
            : lidar.error || `Raw scan unavailable on ${lidar.topic || '/scan'}`)
        : 'Raw LiDAR status not reported',
    },
    {
      ...NAV_CHAIN_COMPONENTS[1],
      status: localizationStatus,
      detail: localization
        ? (localizationReady ? 'Map location verified by global match' : localizationDetail)
        : 'Localization status not reported',
    },
    {
      ...NAV_CHAIN_COMPONENTS[2],
      status: odomReady && nav.odomTfAvailable === true ? 'ok' : 'fail',
      detail: odomDetail,
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

  const activeMapNeedsPromotion = readinessPayload.autonomousMapping?.candidateAvailable === true
    && String(readinessPayload.autonomousMapping?.detail || '').includes('active_map_has_no_verified_pbstream')
  if (activeMapNeedsPromotion) {
    for (const component of components) {
      component.relevant = component.id === 'localization'
    }
    Object.assign(components[1], {
      label: 'Active map',
      status: 'fail',
      detail: 'Active map has no verified Cartographer PBSTREAM. Promote the saved candidate map to resume localization and navigation.',
      action: 'promote-map-candidate',
      rootCause: true,
      summary: 'Blocked: active map cannot start Cartographer localization',
    })
  }

  return components
}

function isTrueWhenReported(value, property) {
  return !Object.hasOwn(value, property) || value[property] === true
}

function findNavigationBlocker(navigation, pattern) {
  return Array.isArray(navigation?.blockers)
    ? navigation.blockers.find((blocker) => pattern.test(String(blocker || '')))
    : ''
}

export function summarizeNavChain(components) {
  const rootCause = components.find((component) => component.rootCause === true)
  if (rootCause) return rootCause.summary

  const relevant = components.filter((component) => component.relevant !== false)
  const total = relevant.length
  const okCount = relevant.filter((c) => c.status === 'ok').length
  const unknownCount = relevant.filter((c) => c.status === 'unknown').length
  const failed = relevant.filter((c) => c.status === 'fail')
  const summary = `${okCount}/${total} ready`
  if (unknownCount === total) {
    return `${summary} (unknown)`
  }
  if (failed.length > 0) {
    const labels = failed.map((c) => c.label).join(', ')
    const unknown = relevant.filter((c) => c.status === 'unknown').map((c) => c.label).join(', ')
    return `${summary} (${labels}${unknown ? `; unknown: ${unknown}` : ''})`
  }
  if (unknownCount > 0) {
    const unknown = relevant.filter((c) => c.status === 'unknown').map((c) => c.label).join(', ')
    return `${summary} (unknown: ${unknown})`
  }
  return summary
}
