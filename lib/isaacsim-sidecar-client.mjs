import { loadIsaacSidecarConfig } from './isaacsim-config.mjs'

export async function getIsaacSidecarHealth() {
  const sidecarConfig = await loadIsaacSidecarConfig()
  return probeIsaacSidecarHealth(sidecarConfig)
}

export async function dispatchIsaacSimCommand(preview) {
  const sidecarConfig = await loadIsaacSidecarConfig()
  return sendIsaacSimCommand(preview, sidecarConfig)
}

export async function probeIsaacSidecarHealth(sidecarConfig = {}) {
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

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(transport.timeoutMs || 3000),
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

export async function sendIsaacSimCommand(preview, sidecarConfig = {}) {
  const transport = sidecarConfig.transport ?? {}

  if (!preview || typeof preview !== 'object') {
    return {
      attempted: false,
      status: 'invalid-preview',
      destination: transport.baseUrl || '',
    }
  }

  if (preview.status !== 'ready') {
    return {
      attempted: false,
      status: 'preview-not-ready',
      destination: transport.baseUrl || '',
      previewStatus: preview.status,
    }
  }

  if (!transport.enabled) {
    return {
      attempted: false,
      status: 'disabled',
      destination: transport.baseUrl || '',
    }
  }

  if (transport.dryRun) {
    return {
      attempted: false,
      status: 'dry-run',
      destination: buildTargetUrl(transport.baseUrl, transport.commandsPath),
    }
  }

  if (transport.kind !== 'http') {
    return {
      attempted: false,
      status: 'unsupported-transport',
      destination: transport.baseUrl || '',
    }
  }

  const targetUrl = buildTargetUrl(transport.baseUrl, transport.commandsPath)

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        envelope: preview,
      }),
      signal: AbortSignal.timeout(transport.timeoutMs || 3000),
    })
    const body = await safeReadJson(response)

    return {
      attempted: true,
      status: response.ok ? 'sent' : 'error',
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
  return new URL(routePath || '/', baseUrl || 'http://127.0.0.1:8891').toString()
}

async function safeReadJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}
