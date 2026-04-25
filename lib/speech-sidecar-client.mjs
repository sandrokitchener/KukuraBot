import { loadSpeechSidecarConfig } from './speech-sidecar-config.mjs'

export async function getSpeechSidecarHealth() {
  const sidecarConfig = await loadSpeechSidecarConfig()
  return probeSpeechSidecarHealth(sidecarConfig)
}

export async function transcribeSpeechInput(request) {
  const sidecarConfig = await loadSpeechSidecarConfig()
  return sendSpeechTranscriptionRequest(request, sidecarConfig)
}

export async function probeSpeechSidecarHealth(sidecarConfig = {}, options = {}) {
  const transport = sidecarConfig.transport ?? {}

  if (!transport.enabled) {
    return {
      attempted: false,
      status: 'disabled',
      destination: transport.baseUrl || '',
    }
  }

  if (transport.kind !== 'http') {
    return {
      attempted: false,
      status: 'unsupported-transport',
      destination: transport.baseUrl || '',
    }
  }

  const targetUrl = buildTargetUrl(transport.baseUrl, transport.healthPath)
  const fetchImpl = options.fetchImpl ?? fetch

  try {
    const response = await fetchImpl(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(transport.timeoutMs || 60000),
    })
    const body = await safeReadJson(response)

    return {
      attempted: true,
      status: response.ok ? 'ok' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      body,
    }
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function sendSpeechTranscriptionRequest(request = {}, sidecarConfig = {}, options = {}) {
  const transport = sidecarConfig.transport ?? {}

  if (!transport.enabled) {
    return {
      attempted: false,
      status: 'disabled',
      destination: transport.baseUrl || '',
    }
  }

  if (transport.kind !== 'http') {
    return {
      attempted: false,
      status: 'unsupported-transport',
      destination: transport.baseUrl || '',
    }
  }

  if (typeof request.audioBase64 !== 'string' || !request.audioBase64.trim()) {
    return {
      attempted: false,
      status: 'invalid-audio',
      destination: transport.baseUrl || '',
    }
  }

  const targetUrl = buildTargetUrl(transport.baseUrl, transport.transcribePath)
  const fetchImpl = options.fetchImpl ?? fetch

  try {
    const response = await fetchImpl(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(transport.timeoutMs || 60000),
    })
    const body = await safeReadJson(response)

    return {
      attempted: true,
      status: response.ok ? 'ok' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      body,
    }
  } catch (error) {
    return {
      attempted: true,
      status: 'error',
      destination: targetUrl,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function buildTargetUrl(baseUrl, routePath) {
  return new URL(routePath || '/', baseUrl || 'http://127.0.0.1:8892').toString()
}

async function safeReadJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}
