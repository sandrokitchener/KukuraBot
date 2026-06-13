import { loadDogzillaConnectionConfig } from './dogzilla-connection-center.mjs'
import { formatFetchError } from './http-error.mjs'

const DEFAULT_TIMEOUT_MS = 2500

export async function getDogzillaAudioCueHealth(options = {}) {
  const config = options.config || await loadDogzillaConnectionConfig()
  const audio = config?.audio || {}

  if (!audio.enabled || !audio.healthUrl) {
    return {
      status: 'disabled',
      ok: false,
      detail: 'DOGZILLA Pi audio cues are not configured.',
    }
  }

  try {
    const fetchImpl = options.fetchImpl || fetch
    const response = await fetchImpl(audio.healthUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    const body = await safeReadJson(response)
    const ok = response.ok && body?.ok === true
    return {
      status: ok ? 'ok' : 'error',
      ok,
      destination: audio.healthUrl,
      responseStatus: response.status,
      body,
      detail: ok ? 'DOGZILLA Pi audio cues are ready.' : body?.error || `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      status: 'error',
      ok: false,
      destination: audio.healthUrl,
      error: formatFetchError(error),
    }
  }
}

export async function sendDogzillaAudioCue(cue, options = {}) {
  const config = options.config || await loadDogzillaConnectionConfig()
  const audio = config?.audio || {}
  const normalizedCue = normalizeCue(cue)
  const volume = normalizeVolume(options.volume, audio.volume)

  if (!normalizedCue) {
    return {
      status: 'invalid',
      ok: false,
      error: 'Missing DOGZILLA audio cue name.',
    }
  }

  if (!audio.enabled || !audio.cueUrl) {
    return {
      status: 'disabled',
      ok: false,
      cue: normalizedCue,
      error: 'DOGZILLA Pi audio cues are not configured.',
    }
  }

  try {
    const fetchImpl = options.fetchImpl || fetch
    const response = await fetchImpl(audio.cueUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        cue: normalizedCue,
        ...(volume == null ? {} : { volume }),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    const body = await safeReadJson(response)
    const ok = response.ok && body?.ok === true
    return {
      status: ok ? 'ok' : 'error',
      ok,
      cue: normalizedCue,
      volume,
      destination: audio.cueUrl,
      responseStatus: response.status,
      body,
      error: ok ? '' : body?.error || `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      status: 'error',
      ok: false,
      cue: normalizedCue,
      volume,
      destination: audio.cueUrl,
      error: formatFetchError(error),
    }
  }
}

function normalizeCue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeVolume(value, fallback = null) {
  if (value == null || value === '') {
    return fallback == null ? null : normalizeVolume(fallback)
  }

  let parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return null
  }

  if (parsed > 1 && parsed <= 100) {
    parsed /= 100
  }

  return Math.max(0, Math.min(1, parsed))
}

async function safeReadJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}
