const ROBOT_MAP_RANGE_METERS = 3

const MAP_CELL_FREE = 0
const MAP_CELL_UNKNOWN = -1

function rangeToRGBA(rangeNorm, alpha = 1) {
  const t = clamp(rangeNorm, 0, 1)
  let r, g, b
  if (t <= 0.5) {
    const u = t / 0.5
    r = 255
    g = Math.round(50 + u * 170)
    b = Math.round(u * 50)
  } else {
    const u = (t - 0.5) / 0.5
    r = Math.round(255 - u * 255)
    g = 220
    b = Math.round(50 + u * 205)
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`
}

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
  let lastRenderedScan = null
  let lastPoseTrack = []
  const accumulatedPoints = []
  const ACCUMULATION_MS = 1_500
  const MAX_ACCUMULATED_POINTS = 2_000
  let mapGrid = null
  let mapGridMeta = null
  let viewCenterX = 0
  let viewCenterY = 0
  let mapViewMode = 'follow'
  // Cached app_map→map origin derived from rawPose.mapFramePose
  let appMapOriginCache = null

  function getCurrentMapView(mapRangeFallback, robotPose = null) {
    if (mapViewMode === 'map' && mapGrid) {
      return getMapGridView(mapGrid)
    }

    const centerX = toFiniteNumber(robotPose?.x)
    const centerY = toFiniteNumber(robotPose?.y)
    return {
      centerX: Number.isFinite(centerX) ? centerX : 0,
      centerY: Number.isFinite(centerY) ? centerY : 0,
      rangeMeters: mapRangeFallback,
    }
  }

  // Derive the map origin from a robot pose that has mapFramePose attached
  function deriveAppMapOrigin(pose) {
    if (!pose || !pose.mapFramePose || pose.frame !== 'app_map') {
      return
    }
    const mapX = toFiniteNumber(pose.mapFramePose.x)
    const mapY = toFiniteNumber(pose.mapFramePose.y)
    const appPose = normalizeRobotMapPose(pose)
    if (!appPose) { return }
    const oyaw = toFiniteNumber(pose.mapFramePose.yaw - appPose.theta)
    if (!Number.isFinite(mapX) || !Number.isFinite(mapY) || !Number.isFinite(oyaw)) {
      return
    }
    const cy = Math.cos(oyaw)
    const sy = Math.sin(oyaw)
    // origin = reverse of mapPoseToAppPose transform
    appMapOriginCache = {
      ox: mapX - cy * appPose.x + sy * appPose.y,
      oy: mapY - sy * appPose.x - cy * appPose.y,
      cy,
      sy,
    }
  }

  // Convert an app_map pose to map frame using cached origin
  function appMapToMapPose(pose) {
    if (!appMapOriginCache || !pose) { return pose }
    const x = toFiniteNumber(pose.x)
    const y = toFiniteNumber(pose.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) { return null }
    const { ox, oy, cy, sy } = appMapOriginCache
    const theta = toFiniteNumber(pose.theta ?? pose.yaw)
    return {
      x: ox + cy * x - sy * y,
      y: oy + sy * x + cy * y,
      theta,
      yaw: theta,
      frame: 'map',
    }
  }

  // Get robot pose in map frame for canvas rendering (converts from app_map if needed)
  function getCanvasRobotPose(robot) {
    const raw = robot?.pose
    if (!raw) { return null }
    // If already map frame, use directly
    if (raw.frame === 'map' || !raw.frame) {
      return normalizeRobotMapPose(raw)
    }
    // If app_map with mapFramePose, derive origin and use map-frame coords
    if (raw.frame === 'app_map' && raw.mapFramePose) {
      deriveAppMapOrigin(raw)
      const mapPose = normalizeRobotMapPose(raw.mapFramePose)
      if (mapPose) {
        mapPose.frame = 'map'
        return mapPose
      }
    }
    // Fallback: return normalized as-is
    return normalizeRobotMapPose(raw)
  }
  function setMapData(mapPayload) {
    if (!mapPayload || mapPayload.ok !== true || !mapPayload.cells) {
      mapGrid = null
      mapGridMeta = null
      return
    }

    try {
      const binaryStr = atob(mapPayload.cells)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i)
      }
      const cells = new Int8Array(bytes.buffer)
      mapGrid = {
        width: mapPayload.width,
        height: mapPayload.height,
        resolution: mapPayload.resolution,
        originX: mapPayload.origin.x,
        originY: mapPayload.origin.y,
        cells,
      }
      mapGridMeta = `map ${mapPayload.width}x${mapPayload.height} @ ${mapPayload.resolution}m/px`
    } catch {
      mapGrid = null
      mapGridMeta = null
    }
  }

  function drawMapGrid(context, width, height, mapRange, centerX = 0, centerY = 0) {
    if (!mapGrid || width < 1 || height < 1) {
      return
    }

    const { width: gridW, height: gridH, resolution, originX, originY, cells } = mapGrid
    if (!cells || cells.length < gridW * gridH) {
      return
    }

    const xMin = centerX - mapRange
    const yMax = centerY + mapRange
    const scale = (width) / (mapRange * 2)
    const imageData = context.createImageData(width, height)
    const data = imageData.data

    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const viewX = xMin + px / scale
        const viewY = yMax - py / scale

        // Map frame is the native frame for the grid — no coordinate transform needed
        const mapX = viewX
        const mapY = viewY

        const col = Math.floor((mapX - originX) / resolution)
        const row = Math.floor((mapY - originY) / resolution)
        const idx = py * width + px
        const byteOffset = idx * 4

        if (col < 0 || col >= gridW || row < 0 || row >= gridH) {
          // Outside map bounds — darker blue-gray
          data[byteOffset] = 130
          data[byteOffset + 1] = 150
          data[byteOffset + 2] = 170
          data[byteOffset + 3] = 255
          continue
        }

        const cell = cells[row * gridW + col]
        if (cell === MAP_CELL_UNKNOWN) {
          // Unexplored area — muted blue-gray
          data[byteOffset] = 170
          data[byteOffset + 1] = 190
          data[byteOffset + 2] = 210
        } else if (cell === MAP_CELL_FREE) {
          // Free space — light cyan-blue
          data[byteOffset] = 210
          data[byteOffset + 1] = 235
          data[byteOffset + 2] = 245
        } else {
          // Occupied — gradient from light cyan to dark navy
          const t = Math.min(100, Math.max(0, cell)) / 100
          data[byteOffset] = Math.round(210 - t * 200)
          data[byteOffset + 1] = Math.round(235 - t * 205)
          data[byteOffset + 2] = Math.round(245 - t * 175)
        }
        data[byteOffset + 3] = 255
      }
    }

    context.putImageData(imageData, 0, 0)
  }

  function renderWaypoints(robot = null) {
    if (!elements.waypoints) {
      return
    }

    // Initialize appMapOriginCache via getCanvasRobotPose so app_map waypoints can convert
    const canvasPose = robot ? getCanvasRobotPose(robot) : null
    const centerPose = canvasPose || normalizeRobotMapPose(robot?.pose)
    const view = getCurrentMapView(getRobotMapRangeMeters(getWaypoints(), robot), centerPose)
    const markers = []

    getRenderableRobotMapWaypoints(getWaypoints()).forEach((waypoint) => {
      // Convert app_map waypoints to map frame so they align with grid.
      // Prefer capturedMapPose (always map frame) over live conversion via appMapToMapPose,
      // because appMapToMapPose depends on the saved origin which may not match the capture
      // session's Cartographer origin.
      const mapWaypoint = waypoint.frame === 'app_map'
        ? (waypoint.capturedMapPose || appMapToMapPose(waypoint) || waypoint)
        : waypoint
      const position = poseToMapPosition(mapWaypoint, view.rangeMeters, view.centerX, view.centerY)
      if (!position) {
        return
      }

      const marker = document.createElement('span')
      marker.className = 'robot-map-waypoint'
      marker.dataset.waypointId = waypoint.id
      marker.dataset.frame = mapWaypoint.frame
      marker.dataset.verified = waypoint.verified ? 'true' : 'false'
      marker.dataset.enabled = waypoint.enabled ? 'true' : 'false'
      if (waypoint.sourceFrame) {
        marker.dataset.sourceFrame = waypoint.sourceFrame
      }
      marker.style.left = `${position.xPercent}%`
      marker.style.top = `${position.yPercent}%`
      marker.style.setProperty('--waypoint-heading', `${headingRadiansToCssRotation(mapWaypoint.yaw || 0)}rad`)
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

    const canvasPose = getCanvasRobotPose(robot)
    const robotPose = canvasPose || normalizeRobotMapPose(robot.pose)
    if (!robotPose) {
      lastRenderedRobot = null
      hideDot()
      clearPoseTrack()
      setPoseReadout(null)
      setMeta(formatPoseUnavailableMessage(robot, formatEventTimestamp))
      return
    }

    const view = getCurrentMapView(getRobotMapRangeMeters(getWaypoints(), robot), robotPose)
    const position = poseToMapPosition(robotPose, view.rangeMeters, view.centerX, view.centerY)
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
    elements.dot.style.setProperty('--robot-heading', `${headingRadiansToCssRotation(robotPose.theta)}rad`)
    setPoseReadout(robotPose, robotPose.frame || 'map')
    setMeta(
      `x ${robotPose.x.toFixed(2)}m, y ${robotPose.y.toFixed(2)}m, theta ${robotPose.theta.toFixed(2)}rad. ` +
      `Updated ${formatEventTimestamp(robot.receivedAt)}.`,
    )
  }

  function hideDot() {
    lastRenderedRobot = null
    elements.dot.style.opacity = '0'
  }

  function renderPoseTrack(track, robot) {
    // Store track for canvas route drawing (raw map-frame poses)
    lastPoseTrack = Array.isArray(track) ? track.slice(-60) : []

    if (!elements.track) {
      return
    }

    if (!robot?.pose) {
      clearPoseTrack()
      return
    }

    const canvasPose = getCanvasRobotPose(robot)
    const centerPose = canvasPose || normalizeRobotMapPose(robot.pose)
    const view = getCurrentMapView(getRobotMapRangeMeters(getWaypoints(), robot), centerPose)
    const samples = Array.isArray(track) ? track.slice(-40) : []
    const dots = []
    samples.forEach((pose, index) => {
      if (!isRenderableRobotMapFrame(pose?.frame)) {
        return
      }
      // Convert app_map track poses to map frame so track dots align with grid
      const mapPose = (pose.frame === 'app_map' || !pose.frame)
        ? (appMapToMapPose(pose) || pose)
        : pose
      const position = poseToMapPosition(mapPose, view.rangeMeters, view.centerX, view.centerY)
      if (!position) {
        return
      }
      const dot = document.createElement('span')
      const ageRatio = samples.length > 1 ? index / (samples.length - 1) : 1
      dot.className = 'robot-map-track-dot'
      dot.style.left = `${position.xPercent}%`
      dot.style.top = `${position.yPercent}%`
      dot.style.opacity = String(0.18 + ageRatio * 0.55)
      dot.title = `${mapPose.frame || 'map'} ${mapPose.x.toFixed(2)}, ${mapPose.y.toFixed(2)}`
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

    if (scan && scan.points) {
      lastRenderedScan = scan
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

    const now = Date.now()
    const robotPose = normalizeRobotMapPose(robot?.pose)
    // Use map-frame pose for canvas rendering so robot aligns with occupancy grid
    const canvasPose = getCanvasRobotPose(robot)

    const fallbackRange = getRobotMapRangeMeters(getWaypoints(), robot)
    const view = getCurrentMapView(fallbackRange, canvasPose)
    const mapRange = view.rangeMeters

    const points = Array.isArray(scan.points) ? scan.points : []
    const maxSeen = Math.max(...points.map((point) => toFiniteNumber(point.range)).filter(Number.isFinite), 1)
    const viewCenterMetersX = view.centerX
    const viewCenterMetersY = view.centerY

    // Layer 1: Dark background
    context.fillStyle = '#161618'
    context.fillRect(0, 0, width, height)

    // Layer 2: Subtle 1m grid
    if (robotPose) {
      const scaleX = width / (mapRange * 2)
      const scaleY = height / (mapRange * 2)
      const originPx = width / 2
      const originPy = height / 2
      context.strokeStyle = 'rgba(255, 255, 255, 0.045)'
      context.lineWidth = 0.5
      const firstMeterX = Math.ceil(-mapRange)
      const lastMeterX = Math.floor(mapRange)
      for (let mx = firstMeterX; mx <= lastMeterX; mx++) {
        const px = originPx + mx * scaleX
        context.beginPath()
        context.moveTo(px, 0)
        context.lineTo(px, height)
        context.stroke()
      }
      const firstMeterY = Math.ceil(-mapRange)
      const lastMeterY = Math.floor(mapRange)
      for (let my = firstMeterY; my <= lastMeterY; my++) {
        const py = originPy - my * scaleY
        context.beginPath()
        context.moveTo(0, py)
        context.lineTo(width, py)
        context.stroke()
      }
    }

    // Layer 3: Occupancy grid dimmed behind route and points (grid is in map frame)
    if (mapGrid) {
      drawMapGrid(context, width, height, mapRange, viewCenterMetersX, viewCenterMetersY)
      context.fillStyle = 'rgba(22, 22, 24, 0.55)'
      context.fillRect(0, 0, width, height)
    }

    if (!robotPose) {
      if (points.length) {
        drawCenteredLidarScan(context, points, {
          width,
          height,
          displayRange: clamp(Math.max(1.5, maxSeen), 1.5, 6),
          now,
        })
      }
      return
    }

    const robotPosition = poseToMapPosition(canvasPose || robotPose, mapRange, viewCenterMetersX, viewCenterMetersY)
    if (!robotPosition) {
      return
    }

    const centerX = (robotPosition.xPercent / 100) * width
    const centerY = (robotPosition.yPercent / 100) * height
    const displayRange = clamp(Math.max(1.5, maxSeen), 1.5, mapRange)
    const scaleX = width / (mapRange * 2)
    const scaleY = height / (mapRange * 2)

    // Accumulate LiDAR points (use canvasPose so points align with grid in map frame)
    for (const point of points) {
      const mapPoint = lidarPointToMapPose(point, canvasPose || robotPose)
      if (!mapPoint) { continue }
      accumulatedPoints.push({ x: mapPoint.x, y: mapPoint.y, addedAt: now })
    }

    const cutoff = now - ACCUMULATION_MS
    while (accumulatedPoints.length > 0 && accumulatedPoints[0].addedAt < cutoff) {
      accumulatedPoints.shift()
    }
    if (accumulatedPoints.length > MAX_ACCUMULATED_POINTS) {
      accumulatedPoints.splice(0, accumulatedPoints.length - MAX_ACCUMULATED_POINTS)
    }

    context.save()

    // Layer 4: Route polyline (red, drawn before points so points sit on top)
    if (Array.isArray(lastPoseTrack) && lastPoseTrack.length >= 2) {
      const routePoses = lastPoseTrack.filter((p) => isRenderableRobotMapFrame(p?.frame))
      context.beginPath()
      let started = false
      for (const tp of routePoses) {
        // Convert app_map track poses to map frame so route aligns with grid
        const mapPose = appMapOriginCache && (tp.frame === 'app_map' || tp.frame === undefined)
          ? appMapToMapPose(tp)
          : tp
        const pos = poseToMapPosition(mapPose, mapRange, viewCenterMetersX, viewCenterMetersY)
        if (!pos) { continue }
        const px = (pos.xPercent / 100) * width
        const py = (pos.yPercent / 100) * height
        if (!started) {
          context.moveTo(px, py)
          started = true
        } else {
          context.lineTo(px, py)
        }
      }
      context.strokeStyle = '#ff4444'
      context.lineWidth = 3
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.stroke()
    }

    // Layer 5: Range rings (very transparent)
    context.lineWidth = 0.5
    context.strokeStyle = 'rgba(255, 255, 255, 0.04)'
    for (const ring of [0.25, 0.5, 0.75, 1]) {
      const ringMeters = displayRange * ring
      context.beginPath()
      context.ellipse(centerX, centerY, ringMeters * scaleX, ringMeters * scaleY, 0, 0, Math.PI * 2)
      context.stroke()
    }

    // Layer 6: Accumulated points (white ghosts)
    for (const accPt of accumulatedPoints) {
      const age = now - accPt.addedAt
      const ageRatio = Math.min(age / ACCUMULATION_MS, 1)
      const pointPosition = poseToMapPosition(accPt, mapRange, viewCenterMetersX, viewCenterMetersY)
      if (!pointPosition) { continue }
      const px = (pointPosition.xPercent / 100) * width
      const py = (pointPosition.yPercent / 100) * height
      if (px < 0 || px > width || py < 0 || py > height) { continue }
      context.fillStyle = `rgba(255, 255, 255, ${(0.08 + (1 - ageRatio) * 0.18).toFixed(3)})`
      context.beginPath()
      context.arc(px, py, 1, 0, Math.PI * 2)
      context.fill()
    }

    // Layer 7: Live scan points (colored by distance — near red/orange, mid yellow, far cyan)
    for (const point of points) {
      const mapPoint = lidarPointToMapPose(point, canvasPose || robotPose)
      if (!mapPoint) { continue }
      const pointPosition = poseToMapPosition(mapPoint, mapRange, viewCenterMetersX, viewCenterMetersY)
      if (!pointPosition) { continue }
      const px = (pointPosition.xPercent / 100) * width
      const py = (pointPosition.yPercent / 100) * height
      if (px < 0 || px > width || py < 0 || py > height) { continue }
      const rangeNorm = clamp(point.range / maxSeen, 0, 1)
      const pointSize = 1.5 + (1 - rangeNorm) * 2.5
      const pointAlpha = 0.30 + (1 - rangeNorm) * 0.45
      context.fillStyle = rangeToRGBA(rangeNorm, pointAlpha)
      context.beginPath()
      context.arc(px, py, pointSize, 0, Math.PI * 2)
      context.fill()
    }

    // Layer 8: Heading cone (maroon, behind center dot)
    const coneLen = Math.min(width, height) * 0.055
    const headingTheta = (canvasPose || robotPose).theta
    const dirX = Math.cos(headingTheta)
    const dirY = -Math.sin(headingTheta)
    const perpX = Math.sin(headingTheta)
    const perpY = Math.cos(headingTheta)
    const halfBase = coneLen * 0.35
    const baseCx = centerX + coneLen * dirX
    const baseCy = centerY + coneLen * dirY
    context.fillStyle = 'rgba(180, 40, 30, 0.55)'
    context.beginPath()
    context.moveTo(centerX, centerY)
    context.lineTo(baseCx + perpX * halfBase, baseCy + perpY * halfBase)
    context.lineTo(baseCx - perpX * halfBase, baseCy - perpY * halfBase)
    context.closePath()
    context.fill()

    // Layer 9: Robot center dot (sits on top of everything)
    context.fillStyle = 'rgba(255, 255, 255, 0.9)'
    context.beginPath()
    context.arc(centerX, centerY, 3, 0, Math.PI * 2)
    context.fill()

    context.restore()
  }

  function clearLidarScan() {
    if (!elements.lidarScan) {
      return
    }

    const context = elements.lidarScan.getContext('2d')
    context?.clearRect(0, 0, elements.lidarScan.width, elements.lidarScan.height)
  }

  function setViewMode(mode) {
    if (mode !== 'follow' && mode !== 'map') return
    mapViewMode = mode
    // Re-render with last scan data immediately
    if (lastRenderedScan) {
      renderLidarScan(lastRenderedScan)
    }
  }

  function getViewModeLabel() {
    return mapViewMode === 'follow' ? 'Follow' : 'Top-down'
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
    getMapGridMeta: () => mapGridMeta,
    getViewMode: () => mapViewMode,
    getViewModeLabel,
    hideDot,
    renderDot,
    setViewMode,
    renderLidarScan,
    renderPoseTrack,
    renderWaypoints,
    setLidarSummary,
    setMapData,
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
  const capturedMapPose = normalizeRobotMapWaypointSourcePose(waypoint.capturedMapPose)
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
    ...(capturedMapPose ? { capturedMapPose } : {}),
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

export function poseToMapPosition(pose, rangeMeters = ROBOT_MAP_RANGE_METERS, centerX = 0, centerY = 0) {
  const x = toFiniteNumber(pose?.x)
  const y = toFiniteNumber(pose?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null
  }

  const mapRange = Math.max(ROBOT_MAP_RANGE_METERS, toFiniteNumber(rangeMeters) || ROBOT_MAP_RANGE_METERS)
  const dx = x - centerX
  const dy = y - centerY
  const xRatio = clamp(dx / mapRange, -1, 1)
  const yRatio = clamp(dy / mapRange, -1, 1)
  return {
    xPercent: 50 + (xRatio * 50),
    yPercent: 50 - (yRatio * 50),
  }
}

export function getMapGridView(mapGrid) {
  const width = toFiniteNumber(mapGrid?.width)
  const height = toFiniteNumber(mapGrid?.height)
  const resolution = toFiniteNumber(mapGrid?.resolution)
  const originX = toFiniteNumber(mapGrid?.originX ?? mapGrid?.origin?.x)
  const originY = toFiniteNumber(mapGrid?.originY ?? mapGrid?.origin?.y)
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(resolution) ||
      !Number.isFinite(originX) || !Number.isFinite(originY) || width <= 0 || height <= 0 || resolution <= 0) {
    return {
      centerX: 0,
      centerY: 0,
      rangeMeters: ROBOT_MAP_RANGE_METERS,
    }
  }

  const widthMeters = width * resolution
  const heightMeters = height * resolution
  return {
    centerX: originX + widthMeters / 2,
    centerY: originY + heightMeters / 2,
    rangeMeters: Math.ceil((Math.max(widthMeters, heightMeters) / 2) * 2) / 2,
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
  const robotPose = robot?.pose?.frame === 'app_map' && robot.pose.mapFramePose ? robot.pose.mapFramePose : robot?.pose
  const robotX = toFiniteNumber(robotPose?.x)
  const robotY = toFiniteNumber(robotPose?.y)
  if (Number.isFinite(robotX)) {
    extents.push(Math.abs(robotX))
  }
  if (Number.isFinite(robotY)) {
    extents.push(Math.abs(robotY))
  }

  getRenderableRobotMapWaypoints(waypoints).forEach((waypoint) => {
    const renderPose = waypoint.frame === 'app_map'
      ? (waypoint.capturedMapPose || waypoint.mapFramePose || null)
      : waypoint
    if (!renderPose) {
      return
    }
    extents.push(Math.abs(renderPose.x), Math.abs(renderPose.y))
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

  // Range rings
  context.strokeStyle = 'rgba(255, 255, 255, 0.05)'
  context.lineWidth = 0.5
  for (const ring of [0.25, 0.5, 0.75, 1]) {
    context.beginPath()
    context.arc(centerX, centerY, radius * ring, 0, Math.PI * 2)
    context.stroke()
  }

  // Distance-colored points
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
    const pointSize = 1.5 + (1 - rangeNorm) * 2.5
    const pointAlpha = 0.35 + (1 - rangeNorm) * 0.40
    context.fillStyle = rangeToRGBA(rangeNorm, pointAlpha)
    context.beginPath()
    context.arc(px, py, pointSize, 0, Math.PI * 2)
    context.fill()
  }

  // Center dot
  context.fillStyle = 'rgba(255, 255, 255, 0.9)'
  context.beginPath()
  context.arc(centerX, centerY, 3, 0, Math.PI * 2)
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
