const API_BASE_STORAGE_KEY = 'robo-doge.apiBaseUrl'

export function getApiBaseUrl() {
  const override =
    readQueryApiBaseUrl() ||
    readStoredApiBaseUrl() ||
    readGlobalApiBaseUrl()
  return normalizeApiBaseUrl(override)
}

export function setApiBaseUrl(value) {
  const normalized = normalizeApiBaseUrl(value)

  if (normalized) {
    window.localStorage?.setItem(API_BASE_STORAGE_KEY, normalized)
  } else {
    window.localStorage?.removeItem(API_BASE_STORAGE_KEY)
  }

  return normalized
}

export function apiFetch(path, options) {
  return fetch(toApiUrl(path), options)
}

export function toApiUrl(path) {
  const target = String(path || '/')

  if (/^https?:\/\//i.test(target)) {
    return target
  }

  const baseUrl = getApiBaseUrl()

  if (!baseUrl) {
    return target
  }

  return new URL(target.replace(/^\/+/, ''), `${baseUrl}/`).toString()
}

function readStoredApiBaseUrl() {
  try {
    return window.localStorage?.getItem(API_BASE_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

function readGlobalApiBaseUrl() {
  return typeof window.ROBO_DOGE_API_BASE_URL === 'string' ? window.ROBO_DOGE_API_BASE_URL : ''
}

function readQueryApiBaseUrl() {
  try {
    return new URLSearchParams(window.location.search).get('apiBase') || ''
  } catch {
    return ''
  }
}

export function normalizeApiBaseUrl(value) {
  const rawValue = typeof value === 'string' ? value.trim() : ''

  if (!rawValue) {
    return ''
  }

  try {
    const url = new URL(rawValue)
    if (!/^https?:$/.test(url.protocol)) {
      return ''
    }
    url.pathname = url.pathname.replace(/\/+$/, '')
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}
