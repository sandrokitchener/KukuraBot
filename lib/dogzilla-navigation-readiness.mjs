export function getDogzillaWaypointNavigationReadiness(runtime = {}) {
  const nav2 = runtime?.nav2 && typeof runtime.nav2 === 'object' ? runtime.nav2 : null
  const navigation = runtime?.navigation && typeof runtime.navigation === 'object' ? runtime.navigation : null
  const nav2FromNavigation = navigation?.nav2 && typeof navigation.nav2 === 'object' ? navigation.nav2 : null
  const effectiveNav2 = nav2FromNavigation || nav2 || {}
  const odom = effectiveNav2.odom && typeof effectiveNav2.odom === 'object' ? effectiveNav2.odom : null
  const actionAvailable = effectiveNav2.available === true
    || (navigation?.primary === 'nav2' && navigation?.actionServerAvailable === true)
  const explicitReady = typeof effectiveNav2.waypointReady === 'boolean'
    ? effectiveNav2.waypointReady
    : typeof navigation?.waypointReady === 'boolean'
      ? navigation.waypointReady
      : null
  const odomReady = odom
    ? odom.available === true || Number(odom.publisherCount) > 0
    : false
  const blockers = []

  if (!actionAvailable) {
    blockers.push(
      normalizeString(effectiveNav2.importError)
      || normalizeString(effectiveNav2.serverError)
      || 'Nav2 NavigateToPose action server is not available',
    )
  }

  if (!odomReady) {
    blockers.push(
      normalizeString(odom?.error)
      || `No publishers on ${normalizeString(odom?.topic) || '/odom'}`,
    )
  }

  const ready = explicitReady === null
    ? actionAvailable && odomReady
    : explicitReady && actionAvailable && odomReady

  return {
    ready,
    actionAvailable,
    odomReady,
    odomTopic: normalizeString(odom?.topic) || '/odom',
    odomPublisherCount: Number.isFinite(Number(odom?.publisherCount)) ? Number(odom.publisherCount) : 0,
    blockers,
    reason: blockers.join('; '),
    nav2: effectiveNav2,
    navigation,
  }
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}
