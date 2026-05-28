import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { loadDogzillaConnectionConfig } from './dogzilla-connection-center.mjs'
import {
  DOGZILLA_CAMERA_SNAPSHOT_PROXY_PATH,
  DOGZILLA_CAMERA_STATUS_PATH,
  DOGZILLA_CAMERA_STREAM_PROXY_PATH,
} from './dogzilla-camera-paths.mjs'

export {
  DOGZILLA_CAMERA_SNAPSHOT_PROXY_PATH,
  DOGZILLA_CAMERA_STATUS_PATH,
  DOGZILLA_CAMERA_STREAM_PROXY_PATH,
}

const DEFAULT_TCP_TIMEOUT_MS = 2500
const DEFAULT_STREAM_CONNECT_TIMEOUT_MS = 8000
const DEFAULT_CONTROL_CONNECT_TIMEOUT_MS = 2500
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 8000
const DEFAULT_STREAM_CONTENT_TYPE = 'multipart/x-mixed-replace; boundary=frame'
const DEFAULT_STANDARD_MODE_COMMAND = '$010F040115#'

export async function getDogzillaCameraStatus(options = {}) {
  const config = options.config || await loadDogzillaConnectionConfig()
  return probeDogzillaCameraStream(config, options)
}

export async function probeDogzillaCameraStream(config, options = {}) {
  const camera = config?.camera || {}
  const streamUrl = normalizeUrl(camera.streamUrl)
  const baseUrl = normalizeUrl(camera.baseUrl)
  const targetUrl = streamUrl || (baseUrl && camera.streamPath ? new URL(camera.streamPath, baseUrl).toString() : '')

  if (!targetUrl) {
    return {
      status: 'unconfigured',
      ok: false,
      error: 'Camera stream URL is not configured.',
      proxyStreamPath: DOGZILLA_CAMERA_STREAM_PROXY_PATH,
      proxySnapshotPath: DOGZILLA_CAMERA_SNAPSHOT_PROXY_PATH,
      proxyStatusPath: DOGZILLA_CAMERA_STATUS_PATH,
    }
  }

  const tcp = await probeTcp(targetUrl, options.tcpTimeoutMs ?? DEFAULT_TCP_TIMEOUT_MS)
  const ok = tcp.status === 'ok'
  const status = ok ? 'ok' : 'error'

  return {
    status,
    ok,
    label: camera.label || 'DOGZILLA camera',
    streamUrl: targetUrl,
    indexUrl: camera.indexUrl || '',
    proxyStreamPath: DOGZILLA_CAMERA_STREAM_PROXY_PATH,
    proxySnapshotPath: DOGZILLA_CAMERA_SNAPSHOT_PROXY_PATH,
    proxyStatusPath: DOGZILLA_CAMERA_STATUS_PATH,
    tcp,
    http: { status: 'skipped' },
    detail: ok
      ? camera.processed
        ? 'YOLO camera stream is reachable.'
        : 'Camera port is reachable. Stream not opened to protect the vendor camera service.'
      : tcp.error || 'Camera TCP port is not reachable.',
  }
}

export async function getDogzillaCameraSnapshot(options = {}) {
  const config = options.config || await loadDogzillaConnectionConfig()
  return readDogzillaCameraSnapshot(config, options)
}

export async function readDogzillaCameraSnapshot(config, options = {}) {
  const camera = config?.camera || {}
  const streamUrl = normalizeUrl(camera.streamUrl)
  const baseUrl = normalizeUrl(camera.baseUrl)
  const targetUrl = streamUrl || (baseUrl && camera.streamPath ? new URL(camera.streamPath, baseUrl).toString() : '')

  if (!targetUrl) {
    return {
      status: 'unconfigured',
      ok: false,
      statusCode: 404,
      error: 'Camera stream URL is not configured.',
    }
  }

  let controlSession = null
  try {
    if (cameraControlConfigured(camera)) {
      controlSession = await openDogzillaCameraControlSession(camera, options)
      if (!controlSession) {
        return {
          status: 'error',
          ok: false,
          statusCode: 502,
          error: 'Camera control wake failed: control session was not opened.',
        }
      }
    }

    const jpeg = await readJpegFrameFromMjpeg(targetUrl, options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS)
    return {
      status: 'ok',
      ok: true,
      statusCode: 200,
      contentType: 'image/jpeg',
      jpeg,
    }
  } catch (error) {
    return {
      status: 'error',
      ok: false,
      statusCode: error?.statusCode || 502,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    controlSession?.destroy()
  }
}

export async function sendDogzillaCameraSnapshot(response, options = {}) {
  const result = await getDogzillaCameraSnapshot(options)

  if (!result.ok) {
    return sendCameraError(response, result.statusCode || 502, result.error || 'Camera snapshot failed.')
  }

  response.writeHead(200, {
    'content-type': result.contentType || 'image/jpeg',
    'cache-control': 'no-store, no-transform',
  })
  response.end(result.jpeg)
}

export async function proxyDogzillaCameraStream(response, options = {}) {
  const config = options.config || await loadDogzillaConnectionConfig()
  const camera = config?.camera || {}
  const streamUrl = normalizeUrl(camera.streamUrl)

  if (!streamUrl) {
    return sendCameraError(response, 404, 'Camera stream URL is not configured.')
  }

  let controlSession = null
  if (cameraControlConfigured(camera)) {
    try {
      controlSession = await openDogzillaCameraControlSession(camera, options)
    } catch (error) {
      return sendCameraError(
        response,
        502,
        `Camera control wake failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (!controlSession) {
      return sendCameraError(response, 502, 'Camera control wake failed: control session was not opened.')
    }
  }

  return proxyHttpStream(streamUrl, response, {
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_STREAM_CONNECT_TIMEOUT_MS,
    onClose() {
      controlSession?.destroy()
    },
  })
}

export async function openDogzillaCameraControlSession(camera = {}, options = {}) {
  const streamUrl = normalizeUrl(camera.streamUrl)
  const baseUrl = normalizeUrl(camera.baseUrl)
  const sourceUrl = streamUrl || baseUrl
  const controlPort = normalizePort(camera.controlPort, 6000)
  const wakeCommand = normalizeControlCommand(camera.wakeCommand || DEFAULT_STANDARD_MODE_COMMAND)

  if (!sourceUrl || !controlPort || !wakeCommand) {
    return null
  }

  const url = new URL(sourceUrl)
  const socket = net.createConnection({
    host: url.hostname,
    port: controlPort,
  })
  socket.setNoDelay(true)
  socket.on('data', () => {})

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      socket.destroy()
      reject(new Error(`Camera control TCP timed out after ${options.controlConnectTimeoutMs ?? DEFAULT_CONTROL_CONNECT_TIMEOUT_MS}ms.`))
    }, options.controlConnectTimeoutMs ?? DEFAULT_CONTROL_CONNECT_TIMEOUT_MS)

    function cleanup() {
      clearTimeout(timeout)
      socket.off('connect', handleConnect)
      socket.off('error', handleError)
    }

    function handleConnect() {
      cleanup()
      socket.write(wakeCommand)
      resolve()
    }

    function handleError(error) {
      cleanup()
      reject(error)
    }

    socket.once('connect', handleConnect)
    socket.once('error', handleError)
  })

  return socket
}

async function probeTcp(targetUrl, timeoutMs) {
  let url
  try {
    url = new URL(targetUrl)
  } catch {
    return {
      status: 'error',
      error: 'Invalid camera URL.',
    }
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    })
    const timeout = setTimeout(() => {
      socket.destroy()
      resolve({
        status: 'timeout',
        error: `TCP connection timed out after ${timeoutMs}ms.`,
      })
    }, timeoutMs)

    socket.once('connect', () => {
      clearTimeout(timeout)
      socket.destroy()
      resolve({
        status: 'ok',
        host: url.hostname,
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      })
    })

    socket.once('error', (error) => {
      clearTimeout(timeout)
      resolve({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    })
  })
}

function sendCameraError(response, statusCode, message) {
  if (response.headersSent || response.destroyed) {
    return
  }

  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(message)
}

function proxyHttpStream(targetUrl, response, { connectTimeoutMs, onClose }) {
  let request

  try {
    const url = new URL(targetUrl)
    request = getHttpClient(url).request(url, {
      method: 'GET',
      headers: {
        accept: 'multipart/x-mixed-replace,image/jpeg,*/*',
      },
    }, (upstream) => {
      const statusCode = upstream.statusCode || 0

      if (statusCode < 200 || statusCode >= 300) {
        upstream.destroy()
        onClose?.()
        return sendCameraError(response, 502, `Camera stream returned HTTP ${statusCode || 'unknown'}.`)
      }

      response.writeHead(200, {
        'content-type': upstream.headers['content-type'] || DEFAULT_STREAM_CONTENT_TYPE,
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })

      upstream.on('error', () => {
        if (!response.destroyed) {
          response.destroy()
        }
      })
      response.on('close', () => {
        upstream.destroy()
        request.destroy()
        onClose?.()
      })
      upstream.pipe(response)
    })
  } catch (error) {
    onClose?.()
    return sendCameraError(response, 502, error instanceof Error ? error.message : 'Invalid camera stream URL.')
  }

  request.setTimeout(connectTimeoutMs, () => {
    request.destroy(new Error('Camera stream did not respond before timeout.'))
  })

  request.on('error', (error) => {
    onClose?.()
    sendCameraError(response, 504, error instanceof Error ? error.message : 'Camera stream request failed.')
  })

  response.on('close', () => {
    request.destroy()
    onClose?.()
  })

  request.end()
}

async function readJpegFrameFromMjpeg(targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    let request
    let upstream = null
    let buffer = Buffer.alloc(0)

    const timeout = setTimeout(() => {
      const error = new Error(`Camera snapshot timed out after ${timeoutMs}ms.`)
      error.statusCode = 504
      finish(reject, error)
    }, timeoutMs)

    try {
      const url = new URL(targetUrl)
      request = getHttpClient(url).request(url, {
        method: 'GET',
        headers: {
          accept: 'multipart/x-mixed-replace,image/jpeg,*/*',
        },
      }, (response) => {
        upstream = response
        const statusCode = response.statusCode || 0

        if (statusCode < 200 || statusCode >= 300) {
          const error = new Error(`Camera stream returned HTTP ${statusCode || 'unknown'}.`)
          error.statusCode = 502
          finish(reject, error)
          return
        }

        response.on('data', (chunk) => {
          if (settled) {
            return
          }

          buffer = Buffer.concat([buffer, chunk])
          const start = buffer.indexOf(Buffer.from([0xff, 0xd8]))
          const end = start >= 0 ? buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2) : -1

          if (start >= 0 && end >= 0) {
            finish(resolve, buffer.subarray(start, end + 2))
            return
          }

          if (buffer.length > 5_000_000) {
            buffer = buffer.subarray(buffer.length - 1_000_000)
          }
        })
        response.on('error', (error) => {
          error.statusCode = 502
          finish(reject, error)
        })
      })
    } catch (error) {
      finish(reject, error)
      return
    }

    request.on('error', (error) => {
      if (!error.statusCode) {
        error.statusCode = 502
      }
      finish(reject, error)
    })
    request.end()

    function finish(settle, value) {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      upstream?.destroy()
      request?.destroy()
      settle(value)
    }
  })
}

function getHttpClient(url) {
  return url.protocol === 'https:' ? https : http
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return ''
  }

  try {
    return new URL(value).toString()
  } catch {
    return ''
  }
}

function normalizePort(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 65535 ? numeric : fallback
}

function normalizeControlCommand(value) {
  const command = typeof value === 'string' ? value.trim() : ''
  return command.startsWith('$') && command.endsWith('#') ? command : ''
}

function cameraControlConfigured(camera) {
  return !!(camera && (camera.controlPort !== undefined || camera.wakeCommand !== undefined))
}
