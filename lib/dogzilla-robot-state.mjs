function normalizeFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeFrameId(value) {
  return normalizeString(value).replace(/^\/+/, '')
}

export function normalizePoseFromBridge(value) {
  if (!value || typeof value !== 'object') {
    return null
  }

  const pose = {
    x: normalizeFiniteNumber(value.x),
    y: normalizeFiniteNumber(value.y),
    theta: normalizeFiniteNumber(value.theta ?? value.yaw),
  }
  if (!Number.isFinite(pose.x) || !Number.isFinite(pose.y) || !Number.isFinite(pose.theta)) {
    return null
  }

  return {
    ...pose,
    frame: normalizeFrameId(value.frame),
    childFrame: normalizeFrameId(value.childFrame),
    source: normalizeString(value.source),
  }
}

export function resolveRobotPoseFromBridgeState(poseState) {
  if (!poseState || typeof poseState !== 'object') {
    return null
  }

  return normalizePoseFromBridge(
    poseState.mapPose
    || poseState.pose
    || poseState,
  )
}
