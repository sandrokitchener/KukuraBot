export function getDogzillaWaypointNavigationReadiness(runtime = {}, poseState = null) {
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
  const odomStatus = getOdomReadiness(odom)
  const odomReady = odomStatus.ready
  const lifecycleStatus = getLifecycleReadiness(effectiveNav2.lifecycle)
  const lifecycleActive = lifecycleStatus.active
  const scanStatus = getScanReadiness(effectiveNav2.scan)
  const scanReady = scanStatus.ready
  const poseStatus = getPoseReadiness(poseState)
  const poseReady = poseStatus.ready
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
      odomStatus.reason
      || `No live odometry on ${odomStatus.topic}`,
    )
  }

  if (!lifecycleActive) {
    blockers.push(
      lifecycleStatus.reason
      || 'Nav2 lifecycle state was not proven active',
    )
  }

  if (!scanReady) {
    blockers.push(
      scanStatus.reason
      || `Nav2 filtered scan topic ${scanStatus.topic} is not ready`,
    )
  }

  if (!poseReady && poseStatus.reason) {
    blockers.push(poseStatus.reason)
  }

  const baseReady = actionAvailable && odomReady && lifecycleActive && scanReady
  const ready = explicitReady === null
    ? poseReady && baseReady
    : explicitReady && poseReady && baseReady

  return {
    ready,
    actionAvailable,
    odomReady,
    odomTopic: odomStatus.topic,
    odomPublisherCount: odomStatus.publisherCount,
    odomMessageAvailable: odomStatus.messageAvailable,
    odomTfAvailable: odomStatus.tfAvailable,
    odomLiveProbeKnown: odomStatus.liveProbeKnown,
    lifecycleActive,
    lifecycleKnown: lifecycleStatus.known,
    lifecycleNodes: lifecycleStatus.nodes,
    scanReady,
    scanTopic: scanStatus.topic,
    scanPublisherCount: scanStatus.publisherCount,
    scanSubscriptionCount: scanStatus.subscriptionCount,
    scanLiveProbeKnown: scanStatus.liveProbeKnown,
    poseReady,
    blockers,
    reason: blockers.join('; '),
    nav2: effectiveNav2,
    navigation,
  }
}

export function buildDogzillaWaypointNavigationReadinessSteps(readiness = {}) {
  const nav2 = readiness.nav2 && typeof readiness.nav2 === 'object' ? readiness.nav2 : {}
  const actionDetail = normalizeString(nav2.importError)
    || normalizeString(nav2.serverError)
    || (readiness.actionAvailable ? 'NavigateToPose action server available.' : 'NavigateToPose action server is not available.')
  const odomTopic = normalizeString(readiness.odomTopic) || '/odom'
  const odomPublishers = Number.isFinite(Number(readiness.odomPublisherCount)) ? Number(readiness.odomPublisherCount) : 0
  const scanTopic = normalizeString(readiness.scanTopic) || '/scan_nav2'
  const scanPublishers = Number.isFinite(Number(readiness.scanPublisherCount)) ? Number(readiness.scanPublisherCount) : 0
  const scanSubscribers = Number.isFinite(Number(readiness.scanSubscriptionCount)) ? Number(readiness.scanSubscriptionCount) : 0

  return [
    {
      id: 'action',
      label: 'Nav2 action server',
      ok: readiness.actionAvailable === true,
      detail: actionDetail,
    },
    {
      id: 'odom-message',
      label: `${odomTopic} odom samples`,
      ok: readiness.odomMessageAvailable === true,
      detail: readiness.odomMessageAvailable === true
        ? `${odomTopic} publishes live samples (${odomPublishers} publisher(s)).`
        : buildOdomMessageDetail({ topic: odomTopic, publisherCount: odomPublishers, readiness }),
    },
    {
      id: 'odom-tf',
      label: 'odom->base TF',
      ok: readiness.odomTfAvailable === true,
      detail: readiness.odomTfAvailable === true
        ? 'odom->base_link/base_footprint TF available.'
        : `${odomTopic} publishes samples, but odom->base_link/base_footprint TF is unavailable.`,
    },
    {
      id: 'lifecycle',
      label: 'Nav2 lifecycle nodes',
      ok: readiness.lifecycleActive === true,
      detail: readiness.lifecycleActive === true
        ? 'Nav2 lifecycle nodes active.'
        : buildLifecycleStepDetail(readiness),
    },
    {
      id: 'scan',
      label: `${scanTopic} filtered scan`,
      ok: readiness.scanReady === true,
      detail: readiness.scanReady === true
        ? `${scanTopic} has ${scanPublishers} publisher(s) and ${scanSubscribers} subscriber(s).`
        : buildScanBlocker({
          topic: scanTopic,
          publisherCount: scanPublishers,
          subscriptionCount: scanSubscribers,
        }),
    },
    {
      id: 'map-pose',
      label: 'map-frame pose',
      ok: readiness.poseReady === true,
      detail: readiness.poseReady === true
        ? 'Map-frame pose waypoint-safe.'
        : findBlocker(readiness, /pose|localization|waypointSafe|map-frame/i) || 'Map-frame pose is not waypoint-safe.',
    },
  ]
}

function getPoseReadiness(poseState) {
  if (!poseState || typeof poseState !== 'object') {
    return { ready: true, reason: '' }
  }

  const waypointSafe = poseState.waypointSafe === true
  const statusOk = poseState.status === 'ok' || poseState.status === 'stale'
  const pose = poseState.pose || poseState.mapPose
  const ageSec = typeof pose?.ageSec === 'number' ? pose.ageSec : null
  const ageOk = ageSec === null || ageSec <= 2.0
  const mapFramePose = (poseState.mapPose || poseState.pose)?.frame === 'map'

  if (!waypointSafe) {
    return { ready: false, reason: 'Map-frame pose is not waypoint-safe (waypointSafe=false). Wait for stable localization.' }
  }

  if (!mapFramePose) {
    return { ready: false, reason: 'Pose is not in map frame. Saved waypoints require map-frame localization.' }
  }

  if (!ageOk) {
    return { ready: false, reason: `Map-frame pose is stale (age ${ageSec?.toFixed(1)}s). Wait for fresh transform.` }
  }

  return { ready: true, reason: '' }
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function getOdomReadiness(odom) {
  const topic = normalizeString(odom?.topic) || '/odom'
  const publisherCount = Number.isFinite(Number(odom?.publisherCount)) ? Number(odom.publisherCount) : 0
  const messageAvailable = odom?.messageAvailable === true || odom?.sampleAvailable === true
  const tfAvailable = odom?.tfAvailable === true
  const liveProbeKnown = Object.hasOwn(odom || {}, 'messageAvailable')
    || Object.hasOwn(odom || {}, 'sampleAvailable')
    || Object.hasOwn(odom || {}, 'tfAvailable')
  const error = normalizeString(odom?.error)

  if (!odom || typeof odom !== 'object') {
    return {
      ready: false,
      topic,
      publisherCount: 0,
      messageAvailable: false,
      tfAvailable: false,
      liveProbeKnown: false,
      reason: `Odometry topic ${topic} status was not reported`,
    }
  }

  if (liveProbeKnown) {
    const ready = odom.available === true && messageAvailable && tfAvailable
    return {
      ready,
      topic,
      publisherCount,
      messageAvailable,
      tfAvailable,
      liveProbeKnown,
      reason: ready ? '' : error || buildLiveOdomBlocker({ topic, publisherCount, messageAvailable, tfAvailable }),
    }
  }

  return {
    ready: false,
    topic,
    publisherCount,
    messageAvailable: false,
    tfAvailable: false,
    liveProbeKnown: false,
    reason: error
      || (publisherCount > 0
        ? `${topic} has ${publisherCount} publisher(s), but readiness did not prove live odom samples or odom->base TF.`
        : `No publishers on ${topic}`),
  }
}

function buildLiveOdomBlocker({ topic, publisherCount, messageAvailable, tfAvailable }) {
  if (publisherCount <= 0) {
    return `No publishers on ${topic}`
  }
  if (!messageAvailable) {
    return `${topic} has ${publisherCount} publisher(s), but no live odometry samples were received.`
  }
  if (!tfAvailable) {
    return `${topic} publishes samples, but odom->base_link/base_footprint TF is unavailable.`
  }
  return `Live odometry on ${topic} is not ready.`
}

function buildOdomMessageDetail({ topic, publisherCount, readiness }) {
  const blocker = findBlocker(readiness, /odom|odometry/i)
  if (blocker && !/TF is unavailable/i.test(blocker)) {
    return blocker
  }

  return publisherCount > 0
    ? `${topic} has ${publisherCount} publisher(s), but no live odometry samples were received.`
    : `No publishers on ${topic}`
}

function buildLifecycleStepDetail(readiness = {}) {
  const blocker = findBlocker(readiness, /lifecycle|controller_server|planner_server|bt_navigator|behavior_server/i)
  return blocker || 'Nav2 lifecycle state was not proven active.'
}

function findBlocker(readiness = {}, pattern) {
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers : []
  return blockers.find((blocker) => pattern.test(String(blocker || ''))) || ''
}

function getLifecycleReadiness(lifecycle) {
  const nodes = Array.isArray(lifecycle?.nodes) ? lifecycle.nodes : []
  const known = Boolean(lifecycle && typeof lifecycle === 'object' && (
    Object.hasOwn(lifecycle, 'active')
    || Object.hasOwn(lifecycle, 'nodes')
    || Object.hasOwn(lifecycle, 'error')
  ))
  const active = lifecycle?.active === true
  const reason = active
    ? ''
    : normalizeString(lifecycle?.error)
      || buildLifecycleBlocker(nodes)
      || 'Nav2 lifecycle state was not reported'

  return {
    active,
    known,
    nodes,
    reason,
  }
}

function buildLifecycleBlocker(nodes) {
  const inactive = nodes
    .filter((node) => node && typeof node === 'object' && node.active !== true)
    .map((node) => normalizeString(node.name))
    .filter(Boolean)
  return inactive.length > 0
    ? `Nav2 lifecycle nodes are not active: ${inactive.join(', ')}`
    : ''
}

function getScanReadiness(scan) {
  const topic = normalizeString(scan?.topic) || '/scan_nav2'
  const publisherCount = Number.isFinite(Number(scan?.publisherCount)) ? Number(scan.publisherCount) : 0
  const subscriptionCount = Number.isFinite(Number(scan?.subscriptionCount)) ? Number(scan.subscriptionCount) : 0
  const liveProbeKnown = Boolean(scan && typeof scan === 'object' && (
    Object.hasOwn(scan, 'available')
    || Object.hasOwn(scan, 'publisherCount')
    || Object.hasOwn(scan, 'subscriptionCount')
    || Object.hasOwn(scan, 'error')
  ))
  const ready = scan?.available === true && publisherCount > 0 && subscriptionCount > 0
  const reason = ready
    ? ''
    : normalizeString(scan?.error)
      || buildScanBlocker({ topic, publisherCount, subscriptionCount })

  return {
    ready,
    topic,
    publisherCount,
    subscriptionCount,
    liveProbeKnown,
    reason,
  }
}

function buildScanBlocker({ topic, publisherCount, subscriptionCount }) {
  if (publisherCount <= 0) {
    return `No LaserScan publishers visible on ${topic}`
  }
  if (subscriptionCount <= 0) {
    return `No Nav2 costmap subscribers visible on ${topic}`
  }
  return `Nav2 filtered scan topic ${topic} is not ready`
}
