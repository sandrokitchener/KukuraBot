const ROBOT_MAP_RANGE_METERS = 3

const MAP_CELL_FREE = 0
const MAP_CELL_UNKNOWN = -1
const MAP_CELL_FREE_THRESHOLD = 50
const MAP_CELL_OCCUPIED_THRESHOLD = 65
const EGO_VIEW_MAX_RANGE_METERS = 6
const EGO_HISTORY_MS = 1_800
const MAX_EGO_HISTORY_POINTS = 1_200
const EGO_CLUSTER_DISTANCE_METERS = 0.42
const EGO_CLUSTER_MIN_POINTS = 3
const ROBOT_POSE_GRACE_MS = 5_000

function rangeToRGBA(rangeNorm, alpha = 1) {
  const t = clamp(rangeNorm, 0, 1)
  const near = [197, 142, 72]
  const mid = [132, 165, 154]
  const far = [218, 226, 220]
  let r, g, b
  if (t <= 0.5) {
    const u = t / 0.5
    r = Math.round(near[0] + (mid[0] - near[0]) * u)
    g = Math.round(near[1] + (mid[1] - near[1]) * u)
    b = Math.round(near[2] + (mid[2] - near[2]) * u)
  } else {
    const u = (t - 0.5) / 0.5
    r = Math.round(mid[0] + (far[0] - mid[0]) * u)
    g = Math.round(mid[1] + (far[1] - mid[1]) * u)
    b = Math.round(mid[2] + (far[2] - mid[2]) * u)
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`
}

export function occupancyGridCellToRGBA(cell) {
  if (cell === MAP_CELL_UNKNOWN) {
    return { r: 206, g: 208, b: 205, a: 255 }
  } else if (cell <= MAP_CELL_FREE_THRESHOLD) {
    return { r: 246, g: 247, b: 242, a: 255 }
  } else if (cell >= MAP_CELL_OCCUPIED_THRESHOLD) {
    const t = Math.min(100, cell) / 100
    return {
      r: Math.round(246 - t * 230),
      g: Math.round(247 - t * 230),
      b: Math.round(242 - t * 224),
      a: 255,
    }
  } else {
    // Cells with probability between the free and occupied thresholds are
    // uncertain; render them as unknown (gray) so the minimap matches the
    // thresholded saved PGM rather than showing noisy Cartographer probabilities.
    return { r: 206, g: 208, b: 205, a: 255 }
  }
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
  let poseTrusted = false
  const accumulatedPoints = []
  const egoScanHistory = []
  const ACCUMULATION_MS = 1_500
  const MAX_ACCUMULATED_POINTS = 2_000
  let mapGrid = null
  let mapGridMeta = null
  let cachedGridCanvas = null
  let viewCenterX = 0
  let viewCenterY = 0
  let panStart = null
  let mapViewMode = 'map'
  let lastMapCanvasWidth = 0
  let lastMapCanvasHeight = 0
  let previousGrid = null
  let cellDeltaFlashes = []
  let lastDeltaCount = 0
  let lastDeltaShownAt = 0

  const ZOOM_MIN = 0.5
  const ZOOM_MAX = 4
  const ZOOM_STEP = 0.25
  let zoomLevel = 1

  function applyZoomToRange(rangeMeters) {
    return rangeMeters * zoomLevel
  }

  function setZoom(level) {
    const clamped = clamp(Number(level) || 1, ZOOM_MIN, ZOOM_MAX)
    if (clamped === zoomLevel) return
    zoomLevel = clamped
    updateZoomIndicator()
    reRenderCurrentView()
  }

  function getZoom() {
    return zoomLevel
  }

  function resetZoom() {
    setZoom(1)
  }

  function updateZoomIndicator() {
    const indicator = elements?.map?.querySelector?.('.robot-map-zoom-indicator')
    if (!indicator) return
    const pct = Math.round(zoomLevel * 100)
    indicator.textContent = `${pct}%`
    indicator.title = `Zoom: ${pct}% — scroll to zoom, click to reset`
  }

  function reRenderCurrentView() {
    if (lastRenderedRobot) {
      renderDot(lastRenderedRobot)
      if (mapViewMode === 'map') {
        renderWaypoints(lastRenderedRobot)
        renderPoseTrack(lastPoseTrack, lastRenderedRobot)
      }
    }
    if (lastRenderedScan) {
      renderLidarScan(lastRenderedScan)
    }
  }

  function handleMapWheel(event) {
    event.preventDefault()
    const delta = event.deltaY
    if (delta < 0) {
      setZoom(zoomLevel - ZOOM_STEP)
    } else if (delta > 0) {
      setZoom(zoomLevel + ZOOM_STEP)
    }
  }

  function handleMapPointerDown(event) {
    if (mapViewMode !== 'map' || event.button !== 0 || event.target?.closest?.('button, a, input, select')) return
    const width = elements?.map?.clientWidth || lastMapCanvasWidth
    const height = elements?.map?.clientHeight || lastMapCanvasHeight
    if (!width || !height) return
    panStart = { x: event.clientX, y: event.clientY, width, height }
    elements.map.setPointerCapture?.(event.pointerId)
  }

  function handleMapPointerMove(event) {
    if (!panStart) return
    const view = getCurrentMapView(ROBOT_MAP_RANGE_METERS)
    const unpanned = { ...view, centerX: view.centerX - viewCenterX, centerY: view.centerY - viewCenterY }
    const next = panMapView(unpanned, event.clientX - panStart.x, event.clientY - panStart.y, panStart.width, panStart.height)
    if (!next) return
    viewCenterX = next.centerX - unpanned.centerX
    viewCenterY = next.centerY - unpanned.centerY
    reRenderCurrentView()
  }

  function handleMapPointerUp(event) {
    if (!panStart) return
    panStart = null
    elements.map.releasePointerCapture?.(event.pointerId)
  }

  elements?.map?.setAttribute?.('data-view-mode', mapViewMode)
  if (elements?.map) {
    elements.map.addEventListener('wheel', handleMapWheel, { passive: false })
    elements.map.addEventListener('pointerdown', handleMapPointerDown)
    elements.map.addEventListener('pointermove', handleMapPointerMove)
    elements.map.addEventListener('pointerup', handleMapPointerUp)
    elements.map.addEventListener('pointercancel', handleMapPointerUp)
    const zoomIndicator = elements.map.querySelector('.robot-map-zoom-indicator')
    if (zoomIndicator) {
      zoomIndicator.addEventListener('click', resetZoom)
    }
  }

  function getCurrentMapView(mapRangeFallback, robotPose = null) {
    if (mapViewMode === 'map' && mapGrid) {
      const slamView = getSlamMapView(mapGrid, lastMapCanvasWidth || 1, lastMapCanvasHeight || 1) || getMapGridView(mapGrid)
      if (slamView) {
        return {
          ...slamView,
          centerX: slamView.centerX + viewCenterX,
          centerY: slamView.centerY + viewCenterY,
          rangeMeters: applyZoomToRange(slamView.rangeMeters),
          rangeYMeters: applyZoomToRange(slamView.rangeYMeters || slamView.rangeMeters),
        }
      }
    }

    const centerX = toFiniteNumber(robotPose?.x)
    const centerY = toFiniteNumber(robotPose?.y)
    const range = applyZoomToRange(mapRangeFallback)
    return {
      centerX: (Number.isFinite(centerX) ? centerX : 0) + viewCenterX,
      centerY: (Number.isFinite(centerY) ? centerY : 0) + viewCenterY,
      rangeMeters: range,
      rangeYMeters: range,
    }
  }

  // Live poses render only from map coordinates. Legacy app_map payloads must
  // carry their immutable map-frame capture; mutable origins are never inferred.
  function getCanvasRobotPose(robot) {
    const raw = robot?.pose
    if (!raw) { return null }
    // If already map frame, use directly
    if (raw.frame === 'map' || !raw.frame) {
      return normalizeRobotMapPose(raw)
    }
    if (raw.frame === 'app_map' && raw.mapFramePose) {
      const mapPose = normalizeRobotMapPose(raw.mapFramePose)
      if (mapPose) {
        mapPose.frame = 'map'
        return mapPose
      }
    }
    return null
  }
  function setMapData(mapPayload) {
    if (!mapPayload || mapPayload.ok !== true || !mapPayload.cells) {
      mapGrid = null
      mapGridMeta = null
      cachedGridCanvas = null
      previousGrid = null
      cellDeltaFlashes = []
      lastDeltaCount = 0
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
        occupiedCount: typeof mapPayload.occupiedCount === 'number' ? mapPayload.occupiedCount : 0,
      }
      mapGridMeta = `map ${mapPayload.width}x${mapPayload.height} @ ${mapPayload.resolution}m/px`

      if (previousGrid && previousGrid.width === mapGrid.width && previousGrid.height === mapGrid.height) {
        const prev = previousGrid.cells
        const curr = cells
        const now = Date.now()
        let newlyOccupied = 0
        const newFlashes = []
        for (let row = 0; row < mapGrid.height && newlyOccupied < 4000; row++) {
          for (let col = 0; col < mapGrid.width && newlyOccupied < 4000; col++) {
            const idx = row * mapGrid.width + col
            if (curr[idx] >= 50 && prev[idx] < 50) {
              newFlashes.push({ col, row, ts: now })
              newlyOccupied++
            }
          }
        }
        if (newlyOccupied > 0) {
          cellDeltaFlashes = cellDeltaFlashes.concat(newFlashes)
          lastDeltaCount = newlyOccupied
          lastDeltaShownAt = now
        }
      }
      previousGrid = {
        width: mapGrid.width,
        height: mapGrid.height,
        cells: new Int8Array(cells),
      }

      cacheOccupancyGrid()
    } catch {
      mapGrid = null
      mapGridMeta = null
      cachedGridCanvas = null
    }
  }

  function cacheOccupancyGrid() {
    if (!mapGrid) {
      cachedGridCanvas = null
      return
    }
    const { width: gridW, height: gridH, cells } = mapGrid
    const canvas = document.createElement('canvas')
    canvas.width = gridW
    canvas.height = gridH
    const ctx = canvas.getContext('2d')
    if (!ctx) { return }
    const imageData = ctx.createImageData(gridW, gridH)
    const data = imageData.data
    for (let row = 0; row < gridH; row++) {
      for (let col = 0; col < gridW; col++) {
        const cell = cells[row * gridW + col]
        const idx = ((gridH - 1 - row) * gridW + col) * 4
        const { r, g, b, a } = occupancyGridCellToRGBA(cell)
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = a
      }
    }
    ctx.putImageData(imageData, 0, 0)
    cachedGridCanvas = canvas
  }

  function renderOccupancyGrid(context, width, height, view) {
    if (!cachedGridCanvas || !mapGrid) { return }
    const { resolution, originX, originY, width: gridW, height: gridH } = mapGrid
    const halfRangeX = view.rangeMeters
    const halfRangeY = view.rangeYMeters || halfRangeX
    const xMin = view.centerX - halfRangeX
    const yMax = view.centerY + halfRangeY  // north edge of viewport (map Y-up)
    const scaleX = width / (halfRangeX * 2)
    const scaleY = height / (halfRangeY * 2)

    // Source rect in cached grid pixels (cached canvas row 0 = map north)
    const srcCol = Math.max(0, Math.floor((xMin - originX) / resolution))
    const srcRow = Math.max(0, Math.floor((originY + gridH * resolution - yMax) / resolution))
    const srcW = Math.min(gridW - srcCol, Math.ceil((xMin + halfRangeX * 2 - originX) / resolution) - srcCol)
    const southEdge = originY + gridH * resolution - (yMax - halfRangeY * 2)
    const srcH = Math.min(gridH - srcRow, Math.max(0, Math.ceil(southEdge / resolution) - srcRow))
    if (srcW <= 0 || srcH <= 0) { return }

    context.imageSmoothingEnabled = false
    const destX = (originX + srcCol * resolution - xMin) * scaleX
    const destY = (yMax - (originY + (gridH - srcRow) * resolution)) * scaleY
    const destW = srcW * resolution * scaleX
    const destH = srcH * resolution * scaleY
    context.drawImage(cachedGridCanvas, srcCol, srcRow, srcW, srcH, destX, destY, destW, destH)
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

    // Reset stale tracking
    staleWaypointCount = 0
    staleWaypointIds = []

    if (mapViewMode === 'follow') {
      elements.waypoints.replaceChildren()
      updateMeta()
      return
    }

    const canvasPose = robot ? getCanvasRobotPose(robot) : null
    const view = getCurrentMapView(getRobotMapRangeMeters(getWaypoints(), robot), canvasPose)
    const markers = []

    getRenderableRobotMapWaypoints(getWaypoints()).forEach((waypoint) => {
      // Skip disabled/stale waypoints — they should not render
      if (waypoint.enabled === false) {
        staleWaypointCount++
        staleWaypointIds.push(waypoint.id)
        return
      }

      const mapWaypoint = waypoint.frame === 'app_map'
        ? (waypoint.capturedMapPose || waypoint.mapFramePose || null)
        : waypoint
      if (!mapWaypoint) {
        return
      }
      const position = poseToMapPosition(mapWaypoint, view.rangeMeters, view.centerX, view.centerY, view.rangeYMeters)
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
      if (showLastRenderedPoseAsStale(formatPoseUnavailableMessage(robot, formatEventTimestamp))) {
        return
      }
      hideDot({ force: true })
      clearPoseTrack()
      setPoseReadout(null)
      setMeta(formatPoseUnavailableMessage(robot, formatEventTimestamp))
      return
    }

    const canvasPose = getCanvasRobotPose(robot)
    const robotPose = canvasPose || normalizeRobotMapPose(robot.pose)
    if (!robotPose) {
      if (showLastRenderedPoseAsStale(formatPoseUnavailableMessage(robot, formatEventTimestamp))) {
        return
      }
      hideDot({ force: true })
      clearPoseTrack()
      setPoseReadout(null)
      setMeta(formatPoseUnavailableMessage(robot, formatEventTimestamp))
      return
    }

    if (!poseTrusted && mapViewMode === 'map') {
      hideDot({ force: true })
      clearPoseTrack()
      setPoseReadout(null)
      setMeta('Robot location unknown. Run Relocalize on Map before using floor-plan position or navigation.')
      return
    }

    const view = getCurrentMapView(getRobotMapRangeMeters(getWaypoints(), robot), robotPose)
    const position = poseToMapPosition(robotPose, view.rangeMeters, view.centerX, view.centerY, view.rangeYMeters)
    if (!position) {
      if (showLastRenderedPoseAsStale(formatPoseUnavailableMessage(robot, formatEventTimestamp))) {
        return
      }
      hideDot({ force: true })
      clearPoseTrack()
      setPoseReadout(null)
      setMeta(formatPoseUnavailableMessage(robot, formatEventTimestamp))
      return
    }

    lastRenderedRobot = robot
    if (mapViewMode === 'follow') {
      elements.dot.style.left = '50%'
      elements.dot.style.top = '82%'
      elements.dot.style.opacity = poseTrusted ? '1' : '0.35'
      elements.dot.style.setProperty('--robot-heading', '0rad')
      setPoseReadout(robotPose, robotPose.frame || 'map')
      const trustSuffix = poseTrusted ? '' : ' — POSE UNTRUSTED (localizing)'
      setMeta(
        `x ${robotPose.x.toFixed(2)}m, y ${robotPose.y.toFixed(2)}m, θ ${robotPose.theta.toFixed(2)}rad. Updated ${formatEventTimestamp(robot.receivedAt)}.${trustSuffix}`,
      )
      return
    }

    elements.dot.style.left = `${position.xPercent}%`
    elements.dot.style.top = `${position.yPercent}%`
    elements.dot.style.opacity = poseTrusted ? '1' : '0.35'
    elements.dot.style.setProperty('--robot-heading', `${headingRadiansToCssRotation(robotPose.theta)}rad`)
    setPoseReadout(robotPose, robotPose.frame || 'map')
    const trustSuffix = poseTrusted ? '' : ' — POSE UNTRUSTED (localizing)'
    setMeta(
      `x ${robotPose.x.toFixed(2)}m, y ${robotPose.y.toFixed(2)}m, θ ${robotPose.theta.toFixed(2)}rad. Updated ${formatEventTimestamp(robot.receivedAt)}.${trustSuffix}`,
    )
  }
  function hideDot({ force = false } = {}) {
    if (!force && showLastRenderedPoseAsStale()) {
      return
    }
    lastRenderedRobot = null
    elements.dot.style.opacity = '0'
  }

  function getRobotReceivedAtMs(robot) {
    const receivedAt = Date.parse(robot?.receivedAt || robot?.timestamp || '')
    return Number.isFinite(receivedAt) ? receivedAt : Date.now()
  }

  function showLastRenderedPoseAsStale(message = '') {
    if (!lastRenderedRobot?.pose || Date.now() - getRobotReceivedAtMs(lastRenderedRobot) > ROBOT_POSE_GRACE_MS) {
      return false
    }
    elements.dot.style.opacity = '0.35'
    const robotPose = getCanvasRobotPose(lastRenderedRobot)
    setPoseReadout(robotPose, robotPose?.frame || 'map')
    if (message) {
      setMeta(message)
    }
    return true
  }

  function renderPoseTrack(track, robot) {
    // Store track for canvas route drawing (raw map-frame poses)
    lastPoseTrack = Array.isArray(track) ? track.slice(-60) : []

    if (!elements.track) {
      return
    }

    if (!robot?.pose || mapViewMode === 'follow' || !poseTrusted) {
      clearPoseTrack()
      return
    }

    const canvasPose = getCanvasRobotPose(robot)
    const view = getCurrentMapView(getRobotMapRangeMeters(getWaypoints(), robot), canvasPose)
    const samples = Array.isArray(track) ? track.slice(-40) : []
    const dots = []
    samples.forEach((pose, index) => {
      if (String(pose?.frame || '').replace(/^\/+/, '') !== 'map') {
        return
      }
      const position = poseToMapPosition(pose, view.rangeMeters, view.centerX, view.centerY, view.rangeYMeters)
      if (!position) {
        return
      }
      const dot = document.createElement('span')
      const ageRatio = samples.length > 1 ? index / (samples.length - 1) : 1
      dot.className = 'robot-map-track-dot'
      dot.style.left = `${position.xPercent}%`
      dot.style.top = `${position.yPercent}%`
      dot.style.opacity = String(0.18 + ageRatio * 0.55)
      dot.title = `map ${pose.x.toFixed(2)}, ${pose.y.toFixed(2)}`
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
    const staleInfo = staleWaypointCount > 0
      ? `${staleWaypointCount} stale waypoint(s) hidden`
      : ''
    elements.meta.textContent = [baseMeta, staleInfo, waypointReadinessSummary, lidarSummary].filter(Boolean).join(' ')
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
    let view = getCurrentMapView(fallbackRange, canvasPose)
    if (mapViewMode === 'map' && mapGrid) {
      lastMapCanvasWidth = width
      lastMapCanvasHeight = height
      const slamView = getSlamMapView(mapGrid, width, height)
      if (slamView) {
        view = {
          ...slamView,
          rangeMeters: applyZoomToRange(slamView.rangeMeters),
          rangeYMeters: applyZoomToRange(slamView.rangeYMeters || slamView.rangeMeters),
        }
      }
    }
    const mapRange = view.rangeMeters
    const mapRangeY = view.rangeYMeters || mapRange

    const points = Array.isArray(scan.points) ? scan.points : []
    const maxSeen = Math.max(...points.map((point) => toFiniteNumber(point.range)).filter(Number.isFinite), 1)

    if (mapViewMode === 'follow') {
      const egoMaxRange = EGO_VIEW_MAX_RANGE_METERS * zoomLevel
      renderEgoLidarView(context, {
        width,
        height,
        points,
        now,
        maxSeen,
        poseTrusted,
        history: egoScanHistory,
        egoMaxRange,
      })
      return
    }

    const viewCenterMetersX = view.centerX
    const viewCenterMetersY = view.centerY

    // Layer 1: SLAM map background
    context.fillStyle = '#d0d2cf'
    context.fillRect(0, 0, width, height)

    // Layer 2: Subtle 1m grid only when no real SLAM grid is present.
    if (robotPose && !mapGrid) {
      const scaleX = width / (mapRange * 2)
      const scaleY = height / (mapRangeY * 2)
      const originPx = ((0 - viewCenterMetersX) / mapRange + 1) * width / 2
      const originPy = (1 - ((0 - viewCenterMetersY) / mapRangeY)) * height / 2
      context.strokeStyle = 'rgba(0, 0, 0, 0.08)'
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

    // Layer 3: Occupancy grid as primary map background (cached offscreen canvas)
    renderOccupancyGrid(context, width, height, view)

    // Layer 3.5: Diff overlay — highlight newly occupied cells (red flash, 1s fade)
    if (mapGrid && cellDeltaFlashes.length > 0) {
      const nowPrune = Date.now()
      cellDeltaFlashes = cellDeltaFlashes.filter((f) => nowPrune - f.ts < 1000)
      if (cellDeltaFlashes.length > 0) {
        const { resolution, originX, originY } = mapGrid
        const halfRangeX = view.rangeMeters
        const halfRangeY = view.rangeYMeters || halfRangeX
        const xMin = view.centerX - halfRangeX
        const yMax = view.centerY + halfRangeY
        const scaleX = width / (halfRangeX * 2)
        const scaleY = height / (halfRangeY * 2)
        context.save()
        context.imageSmoothingEnabled = false
        for (const flash of cellDeltaFlashes) {
          const age = (nowPrune - flash.ts) / 1000
          const alpha = (1 - age) * 0.85
          const cx = originX + (flash.col + 0.5) * resolution
          const cy = originY + (flash.row + 0.5) * resolution
          const px = (cx - xMin) * scaleX
          const py = (yMax - cy) * scaleY
          if (px >= 0 && px < width && py >= 0 && py < height) {
            const cellPixelW = Math.max(1, resolution * scaleX)
            const cellPixelH = Math.max(1, resolution * scaleY)
            context.fillStyle = `rgba(220, 50, 50, ${alpha.toFixed(3)})`
            context.fillRect(px - cellPixelW / 2, py - cellPixelH / 2, cellPixelW, cellPixelH)
          }
        }
        context.restore()
      }

      // Green "Δ +N cells" badge
      if (lastDeltaShownAt > nowPrune - 1500 && lastDeltaCount > 0) {
        const badgeAge = (nowPrune - lastDeltaShownAt) / 1500
        const badgeAlpha = Math.max(0, 1 - badgeAge * 1.2).toFixed(2)
        context.save()
        context.font = 'bold 11px sans-serif'
        context.textAlign = 'left'
        context.textBaseline = 'top'
        const badgeText = `Δ +${lastDeltaCount} cells`
        const textMetrics = context.measureText(badgeText)
        const badgeW = textMetrics.width + 12
        const badgeH = 20
        const badgeX = 6
        const badgeY = 6
        context.fillStyle = `rgba(30, 130, 60, ${badgeAlpha})`
        context.beginPath()
        context.moveTo(badgeX + 4, badgeY)
        context.lineTo(badgeX + badgeW - 4, badgeY)
        context.arcTo(badgeX + badgeW, badgeY, badgeX + badgeW, badgeY + 4, 4)
        context.lineTo(badgeX + badgeW, badgeY + badgeH - 4)
        context.arcTo(badgeX + badgeW, badgeY + badgeH, badgeX + badgeW - 4, badgeY + badgeH, 4)
        context.lineTo(badgeX + 4, badgeY + badgeH)
        context.arcTo(badgeX, badgeY + badgeH, badgeX, badgeY + badgeH - 4, 4)
        context.lineTo(badgeX, badgeY + 4)
        context.arcTo(badgeX, badgeY, badgeX + 4, badgeY, 4)
        context.closePath()
        context.fill()
        context.fillStyle = `rgba(255, 255, 255, ${Math.min(1, badgeAlpha * 1.1).toFixed(2)})`
        context.fillText(badgeText, badgeX + 6, badgeY + 3)
        context.restore()
      }
    }

    if (!poseTrusted) {
      accumulatedPoints.length = 0
      return
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

    const robotPosition = poseToMapPosition(canvasPose || robotPose, mapRange, viewCenterMetersX, viewCenterMetersY, mapRangeY)
    if (!robotPosition) {
      return
    }

    const centerX = (robotPosition.xPercent / 100) * width
    const centerY = (robotPosition.yPercent / 100) * height
    const displayRange = clamp(Math.max(1.5, maxSeen), 1.5, mapRange)
    const scaleX = width / (mapRange * 2)
    const scaleY = height / (mapRangeY * 2)

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

    // Layer 4: Recent pose trail, drawn before points so points sit on top.
    if (Array.isArray(lastPoseTrack) && lastPoseTrack.length >= 2) {
      const routePoses = lastPoseTrack.filter((p) => String(p?.frame || '').replace(/^\/+/, '') === 'map')
      const maxRouteSegmentMeters = Math.max(1.25, Math.min(2.5, mapRange * 0.25))
      const routeSegments = getRobotMapRouteSegments(routePoses, {
        maxSegmentMeters: maxRouteSegmentMeters,
      })

      for (const segment of routeSegments) {
        context.beginPath()
        let started = false
        for (const mapPose of segment) {
          const pos = poseToMapPosition(mapPose, mapRange, viewCenterMetersX, viewCenterMetersY, mapRangeY)
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
        context.strokeStyle = 'rgba(160, 86, 42, 0.68)'
        context.lineWidth = 1.5
        context.lineCap = 'round'
        context.lineJoin = 'round'
        context.stroke()
      }
    }

    // Layer 5: Range rings (very transparent)
    context.lineWidth = 0.5
    context.strokeStyle = 'rgba(0, 0, 0, 0.08)'
    for (const ring of [0.25, 0.5, 0.75, 1]) {
      const ringMeters = displayRange * ring
      context.beginPath()
      context.ellipse(centerX, centerY, ringMeters * scaleX, ringMeters * scaleY, 0, 0, Math.PI * 2)
      context.stroke()
    }

    // Layer 6: Accumulated points (white ghosts)
    const accAlpha = poseTrusted ? 1 : 0.25
    for (const accPt of accumulatedPoints) {
      const age = now - accPt.addedAt
      const ageRatio = Math.min(age / ACCUMULATION_MS, 1)
      const pointPosition = poseToMapPosition(accPt, mapRange, viewCenterMetersX, viewCenterMetersY, mapRangeY)
      if (!pointPosition) { continue }
      const px = (pointPosition.xPercent / 100) * width
      const py = (pointPosition.yPercent / 100) * height
      if (px < 0 || px > width || py < 0 || py > height) { continue }
      context.fillStyle = `rgba(25, 80, 95, ${((0.03 + (1 - ageRatio) * 0.10) * accAlpha).toFixed(3)})`
      context.beginPath()
      context.arc(px, py, 1, 0, Math.PI * 2)
      context.fill()
    }

    // Layer 7: Live scan points (colored by distance — near red/orange, mid yellow, far cyan)
    const scanDim = poseTrusted ? 1 : 0.25
    for (const point of points) {
      const mapPoint = lidarPointToMapPose(point, canvasPose || robotPose)
      if (!mapPoint) { continue }
      const pointPosition = poseToMapPosition(mapPoint, mapRange, viewCenterMetersX, viewCenterMetersY, mapRangeY)
      if (!pointPosition) { continue }
      const px = (pointPosition.xPercent / 100) * width
      const py = (pointPosition.yPercent / 100) * height
      if (px < 0 || px > width || py < 0 || py > height) { continue }
      const rangeNorm = clamp(point.range / maxSeen, 0, 1)
      const pointSize = 0.9 + (1 - rangeNorm) * 1.1
      const pointAlpha = (0.14 + (1 - rangeNorm) * 0.24) * scanDim
      context.fillStyle = rangeToRGBA(rangeNorm, pointAlpha)
      context.beginPath()
      context.arc(px, py, pointSize, 0, Math.PI * 2)
      context.fill()
    }

    // Layer 8: Untrusted-pose warning text
    if (!poseTrusted) {
      context.save()
      context.font = 'bold 11px sans-serif'
      context.textAlign = 'center'
      context.textBaseline = 'bottom'
      context.fillStyle = 'rgba(160, 80, 20, 0.85)'
      context.fillText('Localizing...', centerX, centerY - 10)
      context.restore()
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

  let staleWaypointCount = 0
  let staleWaypointIds = []

  function setPoseTrust(trusted) {
    poseTrusted = trusted === true
  }

  function setViewMode(mode) {
    if (mode !== 'follow' && mode !== 'map') return
    mapViewMode = mode
    elements?.map?.setAttribute?.('data-view-mode', mode)
    updateZoomIndicator()
    if (mode === 'follow') {
      elements.waypoints?.replaceChildren()
      elements.track?.replaceChildren()
      if (lastRenderedRobot) {
        renderDot(lastRenderedRobot)
      }
    } else if (lastRenderedRobot) {
      renderWaypoints(lastRenderedRobot)
      renderPoseTrack(lastPoseTrack, lastRenderedRobot)
      renderDot(lastRenderedRobot)
    }
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
    getStaleWaypointCount: () => staleWaypointCount,
    getZoom,
    hideDot,
    renderDot,
    resetZoom,
    setPoseTrust,
    setViewMode,
    renderLidarScan,
    renderPoseTrack,
    renderWaypoints,
    setLidarSummary,
    setMapData,
    setMeta,
    setPoseReadout,
    setWaypointReadiness,
    setZoom,
    streamPath: () => getRuntimeConfig?.().robotRuntime?.stateStreamPath || defaultRobotRuntime?.stateStreamPath,
  }
}

// --- Map status formatter (exported for testing and use by app.js) ---

export function formatMapStatusPayload(mapPayload, healthPayload) {
  const result = {
    mode: 'no-map',
    modeLabel: 'No map',
    fresh: false,
    lastUpdateAgeSec: null,
    freshnessLabel: '',
    occupiedCount: 0,
    freeCount: 0,
    bboxLabel: '',
    receivedAtEpoch: null,
  }

  if (!mapPayload || mapPayload.ok !== true) {
    result.modeLabel = mapPayload?.status === 'no-map' ? 'No map' : 'Map unavailable'
    return result
  }

  const mapMode = (
    healthPayload?.map?.mode
    || (healthPayload?.body?.runtime?.map?.mode)
    || 'unknown'
  )
  result.mode = mapMode
  result.modeLabel = mapMode === 'mapping' ? 'Mapping' : mapMode === 'localization' ? 'Localizing' : mapMode

  const ageSec = mapPayload.receivedAtAgeSec
  if (typeof mapPayload.receivedAtEpoch === 'number' && Number.isFinite(mapPayload.receivedAtEpoch)) {
    result.receivedAtEpoch = mapPayload.receivedAtEpoch
  }
  if (typeof ageSec === 'number' && Number.isFinite(ageSec)) {
    result.lastUpdateAgeSec = ageSec
    result.fresh = ageSec <= 5  // fresh if last update within 5 seconds
    result.freshnessLabel = ageSec < 1
      ? `Last update <1s ago`
      : ageSec < 10
        ? `Last update ${ageSec.toFixed(1)}s ago`
        : `Last update ${Math.round(ageSec)}s ago`
  }

  result.occupiedCount = typeof mapPayload.occupiedCount === 'number' ? mapPayload.occupiedCount : 0
  result.freeCount = typeof mapPayload.freeCount === 'number' ? mapPayload.freeCount : 0
  const unknownCount = typeof mapPayload.unknownCount === 'number' ? mapPayload.unknownCount : 0
  if (result.occupiedCount > 0 || result.freeCount > 0) {
    result.cellCountsLabel = `${result.occupiedCount.toLocaleString()} occupied / ${result.freeCount.toLocaleString()} free`
    if (unknownCount > 0) {
      result.cellCountsLabel += ` (${unknownCount.toLocaleString()} unknown)`
    }
  }

  const bbox = mapPayload.bbox
  if (bbox && typeof bbox === 'object') {
    const w = typeof bbox.maxX === 'number' && typeof bbox.minX === 'number'
      ? Math.abs(bbox.maxX - bbox.minX)
      : 0
    const h = typeof bbox.maxY === 'number' && typeof bbox.minY === 'number'
      ? Math.abs(bbox.maxY - bbox.minY)
      : 0
    if (w > 0 && h > 0) {
      result.bboxLabel = `Bounds ${w.toFixed(1)}×${h.toFixed(1)}m explored`
    }
  }

  return result
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

export function poseToMapPosition(pose, rangeMeters = ROBOT_MAP_RANGE_METERS, centerX = 0, centerY = 0, rangeYMeters = rangeMeters) {
  const x = toFiniteNumber(pose?.x)
  const y = toFiniteNumber(pose?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null
  }

  const mapRange = Math.max(ROBOT_MAP_RANGE_METERS, toFiniteNumber(rangeMeters) || ROBOT_MAP_RANGE_METERS)
  const mapRangeY = Math.max(ROBOT_MAP_RANGE_METERS, toFiniteNumber(rangeYMeters) || mapRange)
  const dx = x - centerX
  const dy = y - centerY
  const xRatio = dx / mapRange
  const yRatio = dy / mapRangeY
  return {
    xPercent: 50 + (xRatio * 50),
    yPercent: 50 - (yRatio * 50),
  }
}

export function panMapView(view, deltaXPixels, deltaYPixels, viewportWidth, viewportHeight) {
  const width = toFiniteNumber(viewportWidth)
  const height = toFiniteNumber(viewportHeight)
  const rangeX = toFiniteNumber(view?.rangeMeters)
  const rangeY = toFiniteNumber(view?.rangeYMeters ?? view?.rangeMeters)
  const centerX = toFiniteNumber(view?.centerX)
  const centerY = toFiniteNumber(view?.centerY)
  if (!view || ![width, height, rangeX, rangeY, centerX, centerY].every(Number.isFinite)
    || width <= 0 || height <= 0 || rangeX <= 0 || rangeY <= 0) {
    return null
  }

  return {
    ...view,
    centerX: centerX - (Number(deltaXPixels) * rangeX * 2) / width,
    centerY: centerY + (Number(deltaYPixels) * rangeY * 2) / height,
  }
}

export function getRobotMapRouteSegments(track, {
  convertPose = (pose) => pose,
  maxSegmentMeters = 1.5,
} = {}) {
  const segments = []
  let current = []
  let previousRaw = null
  let previousPose = null

  for (const rawPose of Array.isArray(track) ? track : []) {
    if (!isRenderableRobotMapFrame(rawPose?.frame)) {
      flushRouteSegment()
      previousRaw = null
      previousPose = null
      continue
    }

    const convertedPose = normalizeRobotMapPose(convertPose(rawPose))
    if (!convertedPose) {
      flushRouteSegment()
      previousRaw = null
      previousPose = null
      continue
    }

    if (previousRaw && previousPose && (
      hasRoutePoseContextChanged(previousRaw, rawPose)
      || routePoseDistance(previousPose, convertedPose) > maxSegmentMeters
    )) {
      flushRouteSegment()
    }

    current.push(convertedPose)
    previousRaw = rawPose
    previousPose = convertedPose
  }

  flushRouteSegment()
  return segments

  function flushRouteSegment() {
    if (current.length >= 2) {
      segments.push(current)
    }
    current = []
  }
}

export function getSlamMapView(grid, canvasWidth = 1, canvasHeight = 1) {
  const w = toFiniteNumber(grid?.width)
  const h = toFiniteNumber(grid?.height)
  const res = toFiniteNumber(grid?.resolution)
  const ox = toFiniteNumber(grid?.originX ?? grid?.origin?.x)
  const oy = toFiniteNumber(grid?.originY ?? grid?.origin?.y)
  if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(res) ||
      !Number.isFinite(ox) || !Number.isFinite(oy) || w <= 0 || h <= 0 || res <= 0) {
    return null
  }
  const gridMetersW = w * res
  const gridMetersH = h * res
  // Preserve aspect ratio: fit the entire grid without stretching
  const scaleX = canvasWidth / gridMetersW
  const scaleY = canvasHeight / gridMetersH
  const uniformScale = Math.min(scaleX, scaleY)
  const viewMetersW = canvasWidth / uniformScale
  const viewMetersH = canvasHeight / uniformScale
  return {
    centerX: ox + gridMetersW / 2,
    centerY: oy + gridMetersH / 2,
    rangeMeters: viewMetersW / 2,
    rangeYMeters: viewMetersH / 2,
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
    rangeYMeters: Math.ceil((Math.max(widthMeters, heightMeters) / 2) * 2) / 2,
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

export function projectLidarPointToEgoView(point, {
  width = 360,
  height = 360,
  maxRange = EGO_VIEW_MAX_RANGE_METERS,
} = {}) {
  const forward = toFiniteNumber(point?.x)
  const lateral = toFiniteNumber(point?.y)
  if (!Number.isFinite(forward) || !Number.isFinite(lateral) || forward < -0.15) {
    return null
  }

  const fallbackRange = Math.hypot(forward, lateral)
  const range = toFiniteNumber(point?.range)
  const resolvedRange = Number.isFinite(range) ? range : fallbackRange
  if (!Number.isFinite(resolvedRange) || resolvedRange > maxRange || forward > maxRange + 0.2) {
    return null
  }

  const depthNorm = clamp(forward / maxRange, 0, 1)
  const depthCurve = 1 - Math.pow(1 - depthNorm, 1.72)
  const centerX = width / 2
  const horizonY = height * 0.17
  const egoY = height * 0.82
  const lateralScale = width * (0.13 - depthNorm * 0.07)

  return {
    x: centerX - lateral * lateralScale,
    y: egoY - depthCurve * (egoY - horizonY),
    forward,
    lateral,
    range: resolvedRange,
    depth: depthNorm,
  }
}

export function clusterLidarPoints(points, {
  maxRange = EGO_VIEW_MAX_RANGE_METERS,
  maxClusterDistance = EGO_CLUSTER_DISTANCE_METERS,
  minPoints = EGO_CLUSTER_MIN_POINTS,
} = {}) {
  const candidates = normalizeEgoScanPoints(points, { maxRange })
    .sort((a, b) => Math.atan2(a.y, Math.max(a.x, 0.001)) - Math.atan2(b.y, Math.max(b.x, 0.001)))
  const clusters = []
  let group = []

  for (const point of candidates) {
    const previous = group[group.length - 1]
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) > maxClusterDistance) {
      pushCluster(group)
      group = []
    }
    group.push(point)
  }
  pushCluster(group)

  return clusters

  function pushCluster(items) {
    if (items.length < minPoints) {
      return
    }

    const xs = items.map((item) => item.x)
    const ys = items.map((item) => item.y)
    const ranges = items.map((item) => item.range)
    const centerX = xs.reduce((sum, value) => sum + value, 0) / items.length
    const centerY = ys.reduce((sum, value) => sum + value, 0) / items.length
    clusters.push({
      x: centerX,
      y: centerY,
      range: Math.min(...ranges),
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      count: items.length,
      points: items,
    })
  }
}

function renderEgoLidarView(context, {
  width,
  height,
  points,
  now,
  maxSeen,
  poseTrusted,
  history,
  egoMaxRange = EGO_VIEW_MAX_RANGE_METERS,
}) {
  const scanPoints = normalizeEgoScanPoints(points, { maxRange: egoMaxRange })
  for (const point of scanPoints) {
    history.push({ ...point, addedAt: now })
  }

  const cutoff = now - EGO_HISTORY_MS
  while (history.length > 0 && history[0].addedAt < cutoff) {
    history.shift()
  }
  if (history.length > MAX_EGO_HISTORY_POINTS) {
    history.splice(0, history.length - MAX_EGO_HISTORY_POINTS)
  }

  context.save()
  context.clearRect(0, 0, width, height)
  drawEgoSceneBackground(context, width, height, poseTrusted, egoMaxRange)
  drawEgoScanHistory(context, history, { width, height, now, poseTrusted, egoMaxRange })
  drawEgoLivePoints(context, scanPoints, {
    width,
    height,
    maxSeen: Math.max(maxSeen, egoMaxRange),
    poseTrusted,
    egoMaxRange,
  })
  drawEgoRobotPad(context, width, height, poseTrusted)

  if (!poseTrusted) {
    context.font = 'bold 11px sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'bottom'
    context.fillStyle = 'rgba(126, 91, 40, 0.78)'
    context.fillText('Localizing...', width / 2, height * 0.74)
  }
  context.restore()
}

function drawEgoSceneBackground(context, width, height, poseTrusted, egoMaxRange = EGO_VIEW_MAX_RANGE_METERS) {
  const alpha = poseTrusted ? 1 : 0.42
  const sky = context.createLinearGradient(0, 0, 0, height)
  sky.addColorStop(0, '#f4f5f1')
  sky.addColorStop(0.42, '#e6e8e2')
  sky.addColorStop(1, '#d4d8d0')
  context.fillStyle = sky
  context.fillRect(0, 0, width, height)

  context.globalAlpha = alpha
  context.fillStyle = 'rgba(255, 255, 255, 0.36)'
  context.beginPath()
  context.moveTo(width * 0.5, height * 0.88)
  context.lineTo(width * 0.15, height * 0.18)
  context.quadraticCurveTo(width * 0.5, height * 0.08, width * 0.85, height * 0.18)
  context.closePath()
  context.fill()

  context.lineWidth = 1
  context.strokeStyle = 'rgba(74, 94, 90, 0.18)'
  for (const lateral of [-2.4, -1.2, 0, 1.2, 2.4]) {
    const near = projectLidarPointToEgoView({ x: 0.15, y: lateral }, { width, height })
    const far = projectLidarPointToEgoView({ x: egoMaxRange, y: lateral }, { width, height, maxRange: egoMaxRange })
    if (!near || !far) { continue }
    context.beginPath()
    context.moveTo(near.x, near.y)
    context.quadraticCurveTo(width / 2, height * 0.44, far.x, far.y)
    context.stroke()
  }

  context.strokeStyle = 'rgba(74, 94, 90, 0.12)'
  for (const meters of [1, 2, 3, 4.5, 6]) {
    const left = projectLidarPointToEgoView({ x: meters, y: 2.7 }, { width, height })
    const right = projectLidarPointToEgoView({ x: meters, y: -2.7 }, { width, height })
    if (!left || !right) { continue }
    context.beginPath()
    context.moveTo(left.x, left.y)
    context.quadraticCurveTo(width / 2, left.y + 5, right.x, right.y)
    context.stroke()
  }

  context.globalAlpha = 1
}

function drawEgoScanHistory(context, history, { width, height, now, poseTrusted, egoMaxRange = EGO_VIEW_MAX_RANGE_METERS }) {
  const dim = poseTrusted ? 1 : 0.28
  for (const point of history) {
    const projected = projectLidarPointToEgoView(point, { width, height, maxRange: egoMaxRange })
    if (!projected) { continue }
    const ageRatio = clamp((now - point.addedAt) / EGO_HISTORY_MS, 0, 1)
    context.fillStyle = `rgba(86, 111, 106, ${((0.13 * (1 - ageRatio)) * dim).toFixed(3)})`
    context.beginPath()
    context.arc(projected.x, projected.y, 1.2 + (1 - projected.depth) * 1.3, 0, Math.PI * 2)
    context.fill()
  }
}

function drawEgoLivePoints(context, points, { width, height, maxSeen, poseTrusted, egoMaxRange = EGO_VIEW_MAX_RANGE_METERS }) {
  const dim = poseTrusted ? 1 : 0.28
  for (const point of points) {
    const projected = projectLidarPointToEgoView(point, { width, height, maxRange: egoMaxRange })
    if (!projected) { continue }
    const rangeNorm = clamp(point.range / maxSeen, 0, 1)
    const size = 1.5 + (1 - projected.depth) * 2.2
    const alpha = (0.30 + (1 - rangeNorm) * 0.22) * dim
    context.fillStyle = rangeToRGBA(rangeNorm, alpha)
    context.beginPath()
    context.arc(projected.x, projected.y, size, 0, Math.PI * 2)
    context.fill()
  }
}

function drawEgoRobotPad(context, width, height, poseTrusted) {
  const alpha = poseTrusted ? 1 : 0.35
  const centerX = width / 2
  const baseY = height * 0.84
  const padGradient = context.createRadialGradient(centerX, baseY, 2, centerX, baseY, width * 0.24)
  padGradient.addColorStop(0, `rgba(24, 28, 29, ${(0.24 * alpha).toFixed(3)})`)
  padGradient.addColorStop(1, 'rgba(24, 28, 29, 0)')
  context.fillStyle = padGradient
  context.beginPath()
  context.ellipse(centerX, baseY + 12, width * 0.22, height * 0.06, 0, 0, Math.PI * 2)
  context.fill()
}

function normalizeEgoScanPoints(points, { maxRange = EGO_VIEW_MAX_RANGE_METERS } = {}) {
  return (Array.isArray(points) ? points : [])
    .map((point) => {
      const x = toFiniteNumber(point?.x)
      const y = toFiniteNumber(point?.y)
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < -0.15) {
        return null
      }
      const fallbackRange = Math.hypot(x, y)
      const range = toFiniteNumber(point?.range)
      const resolvedRange = Number.isFinite(range) ? range : fallbackRange
      if (!Number.isFinite(resolvedRange) || resolvedRange > maxRange || x > maxRange + 0.2) {
        return null
      }
      return {
        x,
        y,
        range: resolvedRange,
      }
    })
    .filter(Boolean)
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

function routePoseDistance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function hasRoutePoseContextChanged(a, b) {
  const aFrame = String(a?.frame || '').trim().replace(/^\/+/, '')
  const bFrame = String(b?.frame || '').trim().replace(/^\/+/, '')
  if (aFrame !== bFrame) {
    return true
  }

  return routeContextValue(a, 'originSavedAt') !== routeContextValue(b, 'originSavedAt')
    || routeContextValue(a, 'originLabel') !== routeContextValue(b, 'originLabel')
    || routeContextValue(a, 'originMapFingerprint') !== routeContextValue(b, 'originMapFingerprint')
    || routeContextValue(a, 'mapFingerprint') !== routeContextValue(b, 'mapFingerprint')
    || routeContextValue(a, 'sourceFrame') !== routeContextValue(b, 'sourceFrame')
}

function routeContextValue(pose, key) {
  return String(pose?.[key] || pose?.mapOrigin?.[key] || '').trim()
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function isRenderableRobotMapFrame(frame) {
  return ['map', 'app_map'].includes(String(frame || '').trim().replace(/^\/+/, ''))
}
