import { loadDogzillaConnectionConfig } from './dogzilla-connection-center.mjs'

const DEFAULT_TIMEOUT_MS = 2500

export async function getDogzillaLidarHealth(options = {}) {
  const config = options.config || await loadDogzillaConnectionConfig()
  const lidar = config?.lidar || {}

  if (!lidar.enabled || !lidar.healthUrl) {
    return {
      status: 'disabled',
      ok: false,
      detail: 'DOGZILLA lidar bridge is not configured.',
    }
  }

  return fetchLidarJson(lidar.healthUrl, options)
}

export async function getDogzillaLidarScan(options = {}) {
  const config = options.config || await loadDogzillaConnectionConfig()
  const lidar = config?.lidar || {}

  if (!lidar.enabled || !lidar.scanUrl) {
    return {
      status: 'disabled',
      ok: false,
      error: 'DOGZILLA lidar bridge is not configured.',
      points: [],
    }
  }

  return fetchLidarJson(lidar.scanUrl, options)
}

async function fetchLidarJson(url, options = {}) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    const body = await safeReadJson(response)
    const ok = response.ok && body?.ok === true
    return {
      ...(body && typeof body === 'object' ? body : {}),
      status: ok ? 'ok' : body?.status || 'error',
      ok,
      destination: url,
      responseStatus: response.status,
      error: ok ? '' : body?.error || `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      status: 'error',
      ok: false,
      destination: url,
      error: error instanceof Error ? error.message : String(error),
      points: [],
    }
  }
}

async function safeReadJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}
