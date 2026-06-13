export function normalizeDogzillaMapMetadata(value = {}) {
  if (!value || typeof value !== 'object') {
    return null
  }

  const resolution = finiteNumber(value.resolution)
  const widthCells = finiteNumber(value.widthCells ?? value.width_cells ?? value.width)
  const heightCells = finiteNumber(value.heightCells ?? value.height_cells ?? value.height)
  const origin = normalizeMapOriginArray(value.origin)
  const bounds = normalizeMapBounds(value.bounds)
  const normalizedBounds = bounds || (
    resolution && widthCells && heightCells && origin
      ? {
        minX: origin[0],
        maxX: origin[0] + widthCells * resolution,
        minY: origin[1],
        maxY: origin[1] + heightCells * resolution,
      }
      : null
  )

  return {
    available: value.available === true,
    id: normalizeString(value.id || value.mapId || value.map_id || value.name),
    yaml: normalizeString(value.yaml),
    pgm: normalizeString(value.pgm),
    pbstream: normalizeString(value.pbstream),
    savedAt: normalizeString(value.savedAt),
    resolution,
    widthCells,
    heightCells,
    widthMeters: finiteNumber(value.widthMeters ?? value.width_meters) || (resolution && widthCells ? widthCells * resolution : null),
    heightMeters: finiteNumber(value.heightMeters ?? value.height_meters) || (resolution && heightCells ? heightCells * resolution : null),
    origin,
    bounds: normalizedBounds,
    fingerprint: normalizeString(value.fingerprint || value.mapFingerprint || value.map_fingerprint),
    error: normalizeString(value.error),
  }
}

export function validatePoseInsideDogzillaMap(pose = {}, mapMetadata = {}) {
  const map = normalizeDogzillaMapMetadata(mapMetadata)
  if (!map?.available || !map.bounds) {
    return {
      ok: false,
      reason: 'map-metadata-unavailable',
      message: 'active DOGZILLA map metadata is unavailable',
      map,
    }
  }

  const frame = normalizeString(pose.frame).replace(/^\/+/, '')
  const x = Number(pose.x)
  const y = Number(pose.y)
  if (frame !== 'map') {
    return {
      ok: false,
      reason: 'unsupported-frame',
      message: `waypoint frame "${frame || 'unknown'}" is not the saved map frame`,
      map,
    }
  }

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return {
      ok: false,
      reason: 'invalid-pose',
      message: 'waypoint target has non-finite map coordinates',
      map,
    }
  }

  const { minX, maxX, minY, maxY } = map.bounds
  if (x < minX || x > maxX || y < minY || y > maxY) {
    return {
      ok: false,
      reason: 'off-map',
      message: `waypoint target (${formatNumber(x)}, ${formatNumber(y)}) is outside active map bounds x ${formatNumber(minX)}..${formatNumber(maxX)}, y ${formatNumber(minY)}..${formatNumber(maxY)}`,
      map,
    }
  }

  return { ok: true, map }
}

export function normalizeDogzillaWaypointMapIdentity(value = {}) {
  if (!value || typeof value !== 'object') {
    return {
      id: '',
      fingerprint: '',
      savedAt: '',
      yaml: '',
      pgm: '',
      pbstream: '',
    }
  }

  const map = value.map && typeof value.map === 'object'
    ? value.map
    : value.mapIdentity && typeof value.mapIdentity === 'object'
      ? value.mapIdentity
      : {}

  return {
    id: normalizeString(value.mapId || value.map_id || value.id || map.id || map.mapId || map.map_id),
    fingerprint: normalizeString(value.mapFingerprint || value.map_fingerprint || value.fingerprint || map.fingerprint || map.mapFingerprint || map.map_fingerprint),
    savedAt: normalizeString(value.mapSavedAt || value.map_saved_at || value.savedAt || map.savedAt || map.map_saved_at),
    yaml: normalizeString(value.mapYaml || value.map_yaml || map.yaml || map.map_yaml),
    pgm: normalizeString(value.mapPgm || value.map_pgm || map.pgm || map.map_pgm),
    pbstream: normalizeString(value.mapPbstream || value.map_pbstream || map.pbstream || map.map_pbstream),
  }
}

export function validateWaypointMapIdentity(waypoint = {}, mapMetadata = {}) {
  const map = normalizeDogzillaMapMetadata(mapMetadata)
  if (!map?.available) {
    return {
      ok: false,
      reason: 'map-metadata-unavailable',
      message: 'active DOGZILLA map identity is unavailable',
      map,
      waypointIdentity: normalizeDogzillaWaypointMapIdentity(waypoint),
    }
  }

  const waypointIdentity = normalizeDogzillaWaypointMapIdentity(waypoint)
  if (map.id && waypointIdentity.id && waypointIdentity.id !== map.id) {
    return {
      ok: false,
      reason: 'map-id-mismatch',
      message: `waypoint belongs to map "${waypointIdentity.id}", but active map is "${map.id}"`,
      map,
      waypointIdentity,
    }
  }

  if (map.fingerprint && waypointIdentity.fingerprint && waypointIdentity.fingerprint !== map.fingerprint) {
    return {
      ok: false,
      reason: 'map-fingerprint-mismatch',
      message: 'waypoint map fingerprint does not match active map fingerprint',
      map,
      waypointIdentity,
    }
  }

  return {
    ok: true,
    reason: waypointIdentity.id || waypointIdentity.fingerprint ? 'map-identity-match' : 'map-identity-unspecified',
    message: waypointIdentity.id || waypointIdentity.fingerprint
      ? 'waypoint map identity matches active map'
      : 'waypoint has no map identity; accepting config coordinates against active map bounds',
    map,
    waypointIdentity,
  }
}

function normalizeMapOriginArray(value) {
  if (!Array.isArray(value) || value.length < 2) {
    return null
  }

  const x = Number(value[0])
  const y = Number(value[1])
  const yaw = Number(value[2] ?? 0)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(yaw)) {
    return null
  }

  return [x, y, yaw]
}

function normalizeMapBounds(value) {
  if (!value || typeof value !== 'object') {
    return null
  }

  const minX = Number(value.minX ?? value.min_x)
  const maxX = Number(value.maxX ?? value.max_x)
  const minY = Number(value.minY ?? value.min_y)
  const maxY = Number(value.maxY ?? value.max_y)
  if (![minX, maxX, minY, maxY].every(Number.isFinite)) {
    return null
  }

  return { minX, maxX, minY, maxY }
}

function finiteNumber(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function formatNumber(value) {
  return Number(value).toFixed(2)
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}
