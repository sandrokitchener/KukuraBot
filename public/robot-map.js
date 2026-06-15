const ROBOT_MAP_RANGE_METERS = 3

export function createRobotMapRenderer({
  elements,
  getRuntimeConfig,
  defaultRobotRuntime,
  formatEventTimestamp,
} = {}) {
  let baseMeta = ''
  let waypointReadinessSummary = ''
  let lidarSummary = ''
  let lastRenderedRobot = null
  const accumulatedPoints = []
  const ACCUMULATION_MS = 15_000
  const MAX_ACCUMULATED_POINTS = 15_000

  function renderWaypoints(robot = null) {
    if (!elements.waypoints) {
      return
    }

    const rangeMeters = getRobotMapRangeMeters(getWaypoints(), robot)
    const markers = []

    getRenderableRobotMapWaypoints(getWaypoints()).forEach((waypoint) => {
      const position = poseToMapPosition(waypoint, rangeMeters)
      if (!position) {
        return
      }

      const marker = document.createElement('span')
      marker.className = 'robot-map-waypoint'
      marker.dataset.waypointId = waypoint.id
      marker.dataset.frame = waypoint.frame
      marker.dataset.verified = waypoint.verified ? 'true' : 'false'
      marker.dataset.enabled = waypoint.enabled ? 'true' : 'false'
      if (waypoint.sourceFrame) {
        marker.dataset.sourceFrame = waypoint.sourceFrame
      }
      marker.style.left = `${position.xPercent}%`
      marker.style.top = `${position.yPercent}%`
      marker.style.setProperty('--waypoint-heading', `${headingRadiansToCssRotation(waypoint.yaw || 0)}rad`)
      marker.title = formatRobotMapWaypointTitle(waypoint)

      const label = document.createElement('span')
      label.className = 'robot-map-waypoint-label'
      label.textContent = waypoint.label
      marker.append(label)
      markers.push(marker)
    })

    elements.waypoints.replaceChildren(...markers)
  }

  function renderDot(robot) {
    if (!robot?.pose) {
      lastRenderedRobot = null
      hideDot()
      clearPoseTrack()
      setPoseReadout(null)
      setMeta(formatPoseUnavailableMessage(robot, formatEventTimestamp))
      return
    }

    const position = poseToMapPosition(robot.pose, getRobotMapRangeMeters(getWaypoints(), robot))
    if (!position) {
      lastRenderedRobot = null
      hideDot()
      clearPoseTrack()
      setPoseReadout(null)
      setMeta(formatPoseUnavailableMessage(robot, formatEventTimestamp))
      return
    }

    lastRenderedRobot = robot
    elements.dot.style.left = `${position.xPercent}%`
    elements.dot.style.top = `${position.yPercent}%`
    elements.dot.style.opacity = '1'
    elements.dot.style.setProperty('--robot-heading', `${headingRadiansToCssRotation(robot.pose.theta)}rad`)
    setPoseReadout(robot.pose, robot.pose.frame || 'map')
    setMeta(
      `x ${robot.pose.x.toFixed(2)}m, y ${robot.pose.y.toFixed(2)}m, theta ${robot.pose.theta.toFixed(2)}rad. ` +
      `Updated ${formatEventTimestamp(robot.receivedAt)}.`,
    )
  }

  function hideDot() {
    lastRenderedRobot = null
    elements.dot.style.opacity = '0'
  }

  function renderPoseTrack(track, robot) {
    if (!elements.track) {
      return
    }

    if (!robot?.pose) {
      clearPoseTrack()
      return
    }

    const samples = Array.isArray(track) ? track.slice(-40) : []
    const dots = []
    samples.forEach((pose, index) => {
      if (!isRenderableRobotMapFrame(pose?.frame)) {
        return
      }
      const position = poseToMapPosition(pose, getRobotMapRangeMeters(getWaypoints(), robot))
      if (!position) {
        return
      }
      const dot = document.createElement('span')
      const ageRatio = samples.length > 1 ? index / (samples.length - 1) : 1
      dot.className = 'robot-map-track-dot'
      dot.style.left = `${position.xPercent}%`
      dot.style.top = `${position.yPercent}%`
      dot.style.opacity = String(0.18 + ageRatio * 0.55)
      dot.title = `${pose.frame || 'map'} ${pose.x.toFixed(2)}, ${pose.y.toFixed(2)}`
      dots.push(dot)
    })

    elements.track.replaceChildren(...dots)
  }

  function clearPoseTrack() {
    elements.track?.replaceChildren()
  }

  function setPoseReadout(pose, fallbackFrame = '') {
    if (!elements.poseReadout) {
      return
    }

    const x = toFiniteNumber(pose?.x)
    const y = toFiniteNumber(pose?.y)
    const theta = toFiniteNumber(pose?.theta)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(theta)) {
      elements.poseReadout.textContent = 'pose -'
      elements.poseReadout.title = 'No verified robot pose yet'
      return
    }

    const frame = String(pose?.frame || fallbackFrame || 'pose').replace(/^\//, '')
    elements.poseReadout.textContent = `${frame} ${x.toFixed(2)}, ${y.toFixed(2)}, ${theta.toFixed(2)}`
    elements.poseReadout.title = `${frame} pose: x ${x.toFixed(3)} m, y ${y.toFixed(3)} m, theta ${theta.toFixed(3)} rad`
  }

  function setMeta(message) {
    baseMeta = message || ''
    updateMeta()
  }

  function setLidarSummary(summary) {
    lidarSummary = summary || ''
    updateMeta()
  }

  function setWaypointReadiness(summary) {
    waypointReadinessSummary = summary || ''
    updateMeta()
  }

  function updateMeta() {
    elements.meta.textContent = [baseMeta, waypointReadinessSummary, lidarSummary].filter(Boolean).join(' ')
  }

  function renderLidarScan(scan, robot = lastRenderedRobot) {
    if (!elements.lidarScan) {
      return
    }

    const rect = elements.lidarScan.getBoundingClientRect()
    const width = Math.max(1, Math.round(rect.width || elements.lidarScan.width))
    const height = Math.max(1, Math.round(rect.height || elements.lidarScan.height))
    if (elements.lidarScan.width !== width || elements.lidarScan.height !== height) {
      elements.lidarScan.width = width
      elements.lidarScan.height = height
    }

    const context = elements.lidarScan.getContext('2d')
    if (!context) {
      return
    }

    const points = Array.isArray(scan.points) ? scan.points : []
    if (!points.length) {
      return
    }

    const now = Date.now()
    const robotPose = normalizeRobotMapPose(robot?.pose)
    const maxSeen = Math.max(...points.map((point) => toFiniteNumber(point.range)).filter(Number.isFinite), 1)

    if (!robotPose) {
      context.clearRect(0, 0, width, height)
      drawCenteredLidarScan(context, points, {
        width,
        height,
        displayRange: clamp(Math.max(1.5, maxSeen), 1.5, 6),
        now,
      })
      return
    }

    const mapRange = getRobotMapRangeMeters(getWaypoints(), robot)
    const robotPosition = poseToMapPosition(robotPose, mapRange)
    if (!robotPosition) {
      return
    }

    const centerX = (robotPosition.xPercent / 100) * width
    const centerY = (robotPosition.yPercent / 100) * height
    const displayRange = clamp(Math.max(1.5, maxSeen), 1.5, mapRange)
    const scaleX = width / (mapRange * 2)
    const scaleY = height / (mapRange * 2)

    for (const point of points) {
      const mapPoint = lidarPointToMapPose(point, robotPose)
      if (!mapPoint) {
        continue
      }
      const px = mapPoint.x
      const py = mapPoint.y
      if (!Number.isFinite(px) || !Number.isFinite(py)) {
        continue
      }
      accumulatedPoints.push({ x: px, y: py, addedAt: now })
    }

    const cutoff = now - ACCUMULATION_MS
    while (accumulatedPoints.length > 0 && accumulatedPoints[0].addedAt < cutoff) {
      accumulatedPoints.shift()
    }
    if (accumulatedPoints.length > MAX_ACCUMULATED_POINTS) {
      accumulatedPoints.splice(0, accumulatedPoints.length - MAX_ACCUMULATED_POINTS)
    }

    context.clearRect(0, 0, width, height)

    context.save()
    context.lineWidth = 1
    context.strokeStyle = 'rgba(48, 43, 37, 0.22)'
    for (const ring of [0.25, 0.5, 0.75, 1]) {
      const ringMeters = displayRange * ring
      context.beginPath()
      context.ellipse(centerX, centerY, ringMeters * scaleX, ringMeters * scaleY, 0, 0, Math.PI * 2)
      context.stroke()
    }

    for (const accPt of accumulatedPoints) {
      const age = now - accPt.addedAt
      const ageRatio = Math.min(age / ACCUMULATION_MS, 1)
      const pointPosition = poseToMapPosition(accPt, mapRange)
      if (!pointPosition) {
        continue
      }
      const px = (pointPosition.xPercent / 100) * width
      const py = (pointPosition.yPercent / 100) * height
      if (px < 0 || px > width || py < 0 || py > height) {
        continue
      }
      context.fillStyle = `rgba(0, 123, 132, ${(0.12 + (1 - ageRatio) * 0.55).toFixed(3)})`
      context.beginPath()
      context.arc(px, py, 1.4, 0, Math.PI * 2)
      context.fill()
    }

    context.strokeStyle = 'rgba(0, 180, 170, 0.10)'
    context.lineWidth = 0.8
    for (const point of points) {
      const mapPoint = lidarPointToMapPose(point, robotPose)
      if (!mapPoint) {
        continue
      }
      const pointPosition = poseToMapPosition(mapPoint, mapRange)
      if (!pointPosition) {
        continue
      }
      const px = (pointPosition.xPercent / 100) * width
      const py = (pointPosition.yPercent / 100) * height
      if (px < 0 || px > width || py < 0 || py > height) {
        continue
      }
      context.beginPath()
      context.moveTo(centerX, centerY)
      context.lineTo(px, py)
      context.stroke()
    }

    for (const point of points) {
      const mapPoint = lidarPointToMapPose(point, robotPose)
      if (!mapPoint) {
        continue
      }
      const pointPosition = poseToMapPosition(mapPoint, mapRange)
      if (!pointPosition) {
        continue
      }
      const px = (pointPosition.xPercent / 100) * width
      const py = (pointPosition.yPercent / 100) * height
      if (px < 0 || px > width || py < 0 || py > height) {
        continue
      }
      const rangeNorm = clamp(point.range / maxSeen, 0, 1)
      const pointSize = 1.3 + (1 - rangeNorm) * 2.2
      const pointAlpha = 0.5 + (1 - rangeNorm) * 0.45
      context.fillStyle = `rgba(0, 220, 200, ${pointAlpha.toFixed(3)})`
      context.beginPath()
      context.arc(px, py, pointSize, 0, Math.PI * 2)
      context.fill()
    }

    context.restore()
  }

  function clearLidarScan() {
    if (!elements.lidarScan) {
      return
    }

    const context = elements.lidarScan.getContext('2d')
    context?.clearRect(0, 0, elements.lidarScan.width, elements.lidarScan.height)
  }

  function getWaypoints() {
    const runtimeConfig = getRuntimeConfig?.() || {}
    return Array.isArray(runtimeConfig.robotRuntime?.waypoints)
      ? runtimeConfig.robotRuntime.waypoints
      : []
  }

  return {
    clearLidarScan,
    clearPoseTrack,
    formatLidarFailureSummary,
    formatLidarSummary,
    getBaseMeta: () => baseMeta,
    hideDot,
    renderDot,
    renderLidarScan,
    renderPoseTrack,
    renderWaypoints,
    setLidarSummary,
    setMeta,
    setPoseReadout,
    setWaypointReadiness,
    streamPath: () => getRuntimeConfig?.().robotRuntime?.stateStreamPath || defaultRobotRuntime?.stateStreamPath,
  }
}

export function getRenderableRobotMapWaypoints(waypoints) {
  return (Array.isArray(waypoints) ? waypoints : [])
    .map(normalizeRobotMapWaypoint)
    .filter((waypoint) => waypoint && isRenderableRobotMapFrame(waypoint.frame))
}

export function normalizeRobotMapWaypoint(waypoint) {
  const x = toFiniteNumber(waypoint?.x)
  const y = toFiniteNumber(waypoint?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null
  }

  const frame = String(waypoint.frame || 'map').trim().replace(/^\/+/, '')
  const sourceFrame = String(waypoint.sourceFrame || waypoint.source_frame || '').trim().replace(/^\/+/, '')
  const originLabel = String(waypoint.originLabel || waypoint.origin_label || '').trim()
  const verificationProblem = String(waypoint.verificationProblem || '').trim()
  const disabledReason = String(waypoint.disabledReason || waypoint.disabled_reason || '').trim()
  const advisoryProblems = normalizeRobotMapWaypointAdvisories(waypoint.advisoryProblems || waypoint.advisory_problems)
  const mapFramePose = normalizeRobotMapWaypointSourcePose(waypoint.mapFramePose)
  const enabled = waypoint.enabled !== false && waypoint.navigable !== false

  return {
    id: String(waypoint.id || '').trim(),
    label: String(waypoint.label || waypoint.id || 'Waypoint').trim(),
    frame,
    x,
    y,
    yaw: toFiniteNumber(waypoint.yaw ?? waypoint.theta) || 0,
    verified: waypoint.verified === true,
    enabled,
    ...(sourceFrame ? { sourceFrame } : {}),
    ...(originLabel ? { originLabel } : {}),
    ...(verificationProblem ? { verificationProblem } : {}),
    ...(disabledReason ? { disabledReason } : {}),
    ...(advisoryProblems.length ? { advisoryProblems } : {}),
    ...(mapFramePose ? { mapFramePose } : {}),
  }
}

export function formatRobotMapWaypointTitle(waypoint) {
  const frame = String(waypoint?.frame || 'map').trim().replace(/^\/+/, '') || 'map'
  const label = String(waypoint?.label || waypoint?.id || 'Waypoint').trim()
  const yaw = toFiniteNumber(waypoint?.yaw ?? waypoint?.theta)
  const parts = [
    `${label}: ${frame} x ${waypoint.x.toFixed(2)}m, y ${waypoint.y.toFixed(2)}m${Number.isFinite(yaw) ? `, yaw ${yaw.toFixed(2)}rad` : ''}`,
  ]

  const sourcePose = normalizeRobotMapWaypointSourcePose(waypoint?.mapFramePose)
  const sourceFrame = String(waypoint?.sourceFrame || waypoint?.source_frame || sourcePose?.frame || '').trim().replace(/^\/+/, '')
  if (sourcePose && sourceFrame && sourceFrame !== frame) {
    parts.push(
      `source ${sourceFrame} x ${sourcePose.x.toFixed(2)}m, y ${sourcePose.y.toFixed(2)}m, yaw ${sourcePose.yaw.toFixed(2)}rad`,
    )
  }

  const originLabel = String(waypoint?.originLabel || waypoint?.origin_label || '').trim()
  if (originLabel) {
    parts.push(`origin ${originLabel}`)
  }

  if (waypoint?.enabled === false) {
    const disabledReason = String(waypoint?.disabledReason || waypoint?.disabled_reason || waypoint?.verificationProblem || 'disabled by config').trim()
    parts.push(`disabled ${disabledReason}`)
  }

  const verificationProblem = String(waypoint?.verificationProblem || '').trim()
  if (verificationProblem) {
    parts.push(`warning ${verificationProblem}`)
  }

  const advisoryProblems = normalizeRobotMapWaypointAdvisories(waypoint?.advisoryProblems || waypoint?.advisory_problems)
  if (advisoryProblems.length) {
    parts.push(`advisory ${advisoryProblems.join('; ')}`)
  }

  return `${parts.join('. ')}.`
}

export function poseToMapPosition(pose, rangeMeters = ROBOT_MAP_RANGE_METERS) {
  const x = toFiniteNumber(pose?.x)
  const y = toFiniteNumber(pose?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null
  }

  const mapRange = Math.max(ROBOT_MAP_RANGE_METERS, toFiniteNumber(rangeMeters) || ROBOT_MAP_RANGE_METERS)
  const xRatio = clamp(x / mapRange, -1, 1)
  const yRatio = clamp(y / mapRange, -1, 1)
  return {
    xPercent: 50 + (xRatio * 50),
    yPercent: 50 - (yRatio * 50),
  }
}

export function headingRadiansToCssRotation(theta) {
  const heading = toFiniteNumber(theta)
  return Number.isFinite(heading) ? (Math.PI / 2) - heading : 0
}

export function lidarPointToMapPose(point, robotPose) {
  const robot = normalizeRobotMapPose(robotPose)
  const localX = toFiniteNumber(point?.x)
  const localY = toFiniteNumber(point?.y)
  if (!robot || !Number.isFinite(localX) || !Number.isFinite(localY)) {
    return null
  }

  const c = Math.cos(robot.theta)
  const s = Math.sin(robot.theta)
  return {
    frame: robot.frame,
    x: robot.x + c * localX - s * localY,
    y: robot.y + s * localX + c * localY,
  }
}

export function getRobotMapRangeMeters(waypoints, robot = null) {
  const extents = [ROBOT_MAP_RANGE_METERS]
  const robotPose = robot?.pose
  const robotX = toFiniteNumber(robotPose?.x)
  const robotY = toFiniteNumber(robotPose?.y)
  if (Number.isFinite(robotX)) {
    extents.push(Math.abs(robotX))
  }
  if (Number.isFinite(robotY)) {
    extents.push(Math.abs(robotY))
  }

  getRenderableRobotMapWaypoints(waypoints).forEach((waypoint) => {
    extents.push(Math.abs(waypoint.x), Math.abs(waypoint.y))
  })

  return Math.ceil((Math.max(...extents) + 0.5) * 2) / 2
}

export function formatPoseUnavailableMessage(robot, formatEventTimestamp = String) {
  const telemetry = robot?.telemetry || {}
  const yaw = toFiniteNumber(telemetry.yaw)
  const orientation = Number.isFinite(yaw) ? ` Heading ${yaw.toFixed(2)} deg.` : ''
  const poseError = typeof telemetry.poseError === 'string' ? telemetry.poseError.trim() : ''
  const topicText = typeof telemetry.poseTopicPublishers === 'string' && telemetry.poseTopicPublishers.trim()
    ? ` Pose publishers ${telemetry.poseTopicPublishers.trim()}.`
    : ''
  const diagnostics = Array.isArray(telemetry.poseDiagnostics)
    ? telemetry.poseDiagnostics.map((item) => String(item || '').trim()).filter(Boolean)
    : []
  const diagnosticText = !poseError && diagnostics.length > 0 ? ` ${diagnostics.slice(0, 2).join(' ')}` : ''
  const blocker = poseError ? ` ${poseError}` : diagnosticText
  return `Map pose unavailable from Pi bridge. Waiting for verified map-frame localization.${blocker}${topicText}${orientation} Last update ${formatEventTimestamp(robot?.receivedAt)}.`
}

export function formatLidarSummary(scan) {
  const stats = scan.stats || {}
  const minRange = toFiniteNumber(stats.minRange)
  const points = Array.isArray(scan.points) ? scan.points.length : 0
  const rangeCount = Number.isFinite(Number(scan.rangeCount)) ? Number(scan.rangeCount) : 0
  const nearFront = Number.isFinite(Number(stats.nearFront)) ? Number(stats.nearFront) : 0
  const nearLeft = Number.isFinite(Number(stats.nearLeft)) ? Number(stats.nearLeft) : 0
  const nearRight = Number.isFinite(Number(stats.nearRight)) ? Number(stats.nearRight) : 0
  const minText = Number.isFinite(minRange) ? `min ${minRange.toFixed(2)}m` : 'min n/a'
  return `Lidar: ${points}/${rangeCount} pts, ${minText}, near F/L/R ${nearFront}/${nearLeft}/${nearRight}.`
}

export function formatLidarFailureSummary(payload) {
  const statusText = payload?.status ? String(payload.status) : 'unavailable'
  const errorText = payload?.error ? String(payload.error) : 'scan unavailable'
  const driverText = payload?.driver ? ` Driver ${payload.driver}.` : ''
  const serialText = formatLidarSerialDetail(payload)
  const rosGraph = payload?.rosGraph && typeof payload.rosGraph === 'object' ? payload.rosGraph : {}
  const publisherCount = Number.isFinite(Number(rosGraph.publisherCount)) ? Number(rosGraph.publisherCount) : 0
  const frameCount = Number.isFinite(Number(payload?.frames)) ? Number(payload.frames) : 0
  const graphText = publisherCount > 0
    ? ` ROS publishers ${publisherCount}, frames ${frameCount}.`
    : ''
  const driverTail = Array.isArray(payload?.driverLog) && payload.driverLog.length
    ? ` Driver: ${payload.driverLog[payload.driverLog.length - 1]}.`
    : ''

  return `Lidar ${statusText}: ${errorText}${driverText}${serialText}${graphText}${driverTail}`
}

export function formatLidarSerialDetail(payload) {
  const serialPath = payload?.serialPort || payload?.serialDiagnostics?.path
  if (!serialPath) {
    return ''
  }

  const diagnostics = payload?.serialDiagnostics && typeof payload.serialDiagnostics === 'object'
    ? payload.serialDiagnostics
    : {}
  const baudText = payload?.baudrate ? ` @ ${payload.baudrate}` : ''
  const existsText = diagnostics.exists === false ? 'missing' : diagnostics.exists === true ? 'present' : ''
  const accessText = diagnostics.readable === true && diagnostics.writable === true
    ? 'rw'
    : diagnostics.readable === true
      ? 'read-only'
      : diagnostics.exists === true
        ? 'no-access'
        : ''
  const realPath = diagnostics.realPath && diagnostics.realPath !== serialPath ? diagnostics.realPath : ''
  const detail = [existsText, realPath, accessText].filter(Boolean).join(', ')

  return ` Serial ${serialPath}${baudText}${detail ? ` (${detail})` : ''}.`
}

export function formatWaypointReadinessSummary(payload) {
  if (!payload || typeof payload !== 'object') {
    return ''
  }

  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {}
  const ready = Number.isFinite(Number(summary.ready)) ? Number(summary.ready) : 0
  const navigable = Number.isFinite(Number(summary.navigable)) ? Number(summary.navigable) : 0
  if (payload.readyForMapWaypoints === true) {
    return `Waypoints: ready (${ready}/${navigable}).`
  }

  const blockers = Array.isArray(payload.blockers)
    ? payload.blockers.map((item) => String(item || '').trim()).filter(Boolean)
    : []
  const detail = blockers.length > 0
    ? blockers.slice(0, 2).join('; ')
    : payload.error || 'readiness unknown'
  return `Waypoints not ready: ${detail}.`
}

export function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return Number.NaN
  }

  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : Number.NaN
}

function drawCenteredLidarScan(context, points, { width, height, displayRange, now = Date.now() }) {
  const radius = Math.min(width, height) * 0.42
  const centerX = width / 2
  const centerY = height / 2
  const scale = radius / displayRange
  const maxSeen = Math.max(...points.map((p) => toFiniteNumber(p.range)).filter(Number.isFinite), 1)

  context.save()
  context.lineWidth = 1
  context.strokeStyle = 'rgba(48, 43, 37, 0.22)'
  for (const ring of [0.25, 0.5, 0.75, 1]) {
    context.beginPath()
    context.arc(centerX, centerY, radius * ring, 0, Math.PI * 2)
    context.stroke()
  }

  context.strokeStyle = 'rgba(0, 180, 170, 0.10)'
  context.lineWidth = 0.8
  for (const point of points) {
    const x = toFiniteNumber(point.x)
    const y = toFiniteNumber(point.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue
    }
    const px = centerX + x * scale
    const py = centerY - y * scale
    if (px < 0 || px > width || py < 0 || py > height) {
      continue
    }
    context.beginPath()
    context.moveTo(centerX, centerY)
    context.lineTo(px, py)
    context.stroke()
  }

  for (const point of points) {
    const x = toFiniteNumber(point.x)
    const y = toFiniteNumber(point.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue
    }
    const px = centerX + x * scale
    const py = centerY - y * scale
    if (px < 0 || px > width || py < 0 || py > height) {
      continue
    }
    const rangeNorm = clamp(point.range / maxSeen, 0, 1)
    const pointSize = 1.3 + (1 - rangeNorm) * 2.2
    const pointAlpha = 0.5 + (1 - rangeNorm) * 0.45
    context.fillStyle = `rgba(0, 220, 200, ${pointAlpha.toFixed(3)})`
    context.beginPath()
    context.arc(px, py, pointSize, 0, Math.PI * 2)
    context.fill()
  }

  context.fillStyle = 'rgba(255, 114, 79, 0.95)'
  context.beginPath()
  context.arc(centerX, centerY, 4, 0, Math.PI * 2)
  context.fill()
  context.restore()
}

function normalizeRobotMapWaypointSourcePose(value) {
  if (!value || typeof value !== 'object') {
    return null
  }

  const x = toFiniteNumber(value.x)
  const y = toFiniteNumber(value.y)
  const yaw = toFiniteNumber(value.yaw ?? value.theta)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(yaw)) {
    return null
  }

  return {
    frame: String(value.frame || 'map').trim().replace(/^\/+/, '') || 'map',
    x,
    y,
    yaw,
  }
}

function normalizeRobotMapWaypointAdvisories(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
}

function normalizeRobotMapPose(value) {
  const x = toFiniteNumber(value?.x)
  const y = toFiniteNumber(value?.y)
  const theta = toFiniteNumber(value?.theta ?? value?.yaw)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(theta)) {
    return null
  }

  return {
    frame: String(value?.frame || 'map').trim().replace(/^\/+/, '') || 'map',
    x,
    y,
    theta,
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function isRenderableRobotMapFrame(frame) {
  return ['map', 'app_map'].includes(String(frame || '').trim().replace(/^\/+/, ''))
}
