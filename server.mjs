import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAppConfig } from './lib/app-config.mjs'
import { buildIsaacSimPreview } from './lib/isaacsim-command-compiler.mjs'
import {
  dispatchIsaacSimCommand,
  getIsaacRuntimeFeedback,
  getIsaacSidecarHealth,
} from './lib/isaacsim-sidecar-client.mjs'
import { loadPublicConfig, processUserInput } from './lib/app-service.mjs'
import { resolveActiveModelProfile, setActiveModelProfile } from './lib/model-profile-config.mjs'
import { buildRobotRuntimePreview } from './lib/robot-command-compiler.mjs'
import {
  dispatchRobotCommand,
  getRobotRuntimeFeedback,
  getRobotSidecarHealth,
} from './lib/robot-sidecar-client.mjs'
import {
  loadRobotRuntimeConfig,
  setActiveRobotTarget,
} from './lib/robot-runtime-config.mjs'
import {
  getRobotStateSnapshot,
  handleRobotStateStreamUpgrade,
  ROBOT_STATE_STREAM_PATH,
} from './lib/robot-state-stream.mjs'
import {
  resolveActiveSpeechProfile,
  saveSpeechRuntimeConfig,
} from './lib/speech-profile-config.mjs'
import {
  getSpeechSidecarHealth,
  transcribeSpeechInput,
} from './lib/speech-sidecar-client.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')
const MOONSHINE_DIST_DIR = path.join(__dirname, 'node_modules', '@moonshine-ai', 'moonshine-js', 'dist')
const ONNX_RUNTIME_DIST_DIR = path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist')
const VAD_DIST_DIR = path.join(__dirname, 'node_modules', '@ricky0123', 'vad-web', 'dist')
const TRANSFORMERS_DIST_DIR = path.join(__dirname, 'node_modules', '@huggingface', 'transformers', 'dist')
const TRANSFORMERS_ORT_DIST_DIR = path.join(
  __dirname,
  'node_modules',
  '@huggingface',
  'transformers',
  'node_modules',
  'onnxruntime-web',
  'dist',
)
const HOST = process.env.APP_HOST || process.env.KUKURA_HOST || '127.0.0.1'
const PORT = Number(process.env.APP_PORT || process.env.KUKURA_PORT || 3037)
const appConfig = await loadAppConfig()

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

const STATIC_ROOTS = [
  { prefix: '/vendor/transformers/', rootDir: TRANSFORMERS_DIST_DIR },
  { prefix: '/vendor/transformers-ort/', rootDir: TRANSFORMERS_ORT_DIST_DIR },
  { prefix: '/vendor/moonshine/', rootDir: MOONSHINE_DIST_DIR },
  { prefix: '/vendor/onnxruntime/', rootDir: ONNX_RUNTIME_DIST_DIR },
  { prefix: '/vendor/vad/', rootDir: VAD_DIST_DIR },
]

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)

    if (request.method === 'GET' && requestUrl.pathname === '/api/config') {
      return sendJson(response, 200, await loadPublicConfig())
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/chat') {
      const body = await readJsonBody(request)
      return sendJson(response, 200, await processUserInput(body?.input))
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/settings/profile') {
      const body = await readJsonBody(request)
      const profileId = typeof body?.profileId === 'string' ? body.profileId.trim() : ''

      if (!profileId) {
        return sendJson(response, 400, { error: 'Select a profile first.' })
      }

      try {
        await setActiveModelProfile(profileId)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not update profile.'
        const statusCode = /locked/i.test(message) ? 409 : 400
        return sendJson(response, statusCode, { error: message })
      }

      return sendJson(response, 200, await loadPublicConfig())
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/settings/speech-profile') {
      const body = await readJsonBody(request)
      const profileId = typeof body?.profileId === 'string' ? body.profileId.trim() : ''

      if (!profileId) {
        return sendJson(response, 400, { error: 'Select a speech profile first.' })
      }

      try {
        const speechConfig = await resolveActiveSpeechProfile()
        const profileExists = speechConfig.availableProfiles.some((profile) => profile.id === profileId)

        if (!profileExists) {
          return sendJson(response, 400, { error: `Unknown speech profile "${profileId}".` })
        }

        if (speechConfig.selectionLocked) {
          return sendJson(response, 409, { error: 'Speech profile locked by APP_SPEECH_PROFILE.' })
        }

        await saveSpeechRuntimeConfig({ activeProfile: profileId })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not update speech profile.'
        const statusCode = /locked/i.test(message) ? 409 : 400
        return sendJson(response, statusCode, { error: message })
      }

      return sendJson(response, 200, await loadPublicConfig())
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/settings/robot-target') {
      const body = await readJsonBody(request)
      const targetId = typeof body?.targetId === 'string' ? body.targetId.trim() : ''

      if (!targetId) {
        return sendJson(response, 400, { error: 'Select a robot target first.' })
      }

      try {
        const runtimeConfig = await loadRobotRuntimeConfig()

        if (runtimeConfig.selectionLocked) {
          return sendJson(response, 409, { error: 'Robot target locked by ROBOT_RUNTIME_TARGET.' })
        }

        await setActiveRobotTarget(targetId)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not update robot target.'
        return sendJson(response, 400, { error: message })
      }

      return sendJson(response, 200, await loadPublicConfig())
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/isaac/health') {
      return sendJson(response, 200, await getIsaacSidecarHealth())
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/isaac/feedback') {
      return sendJson(response, 200, await getIsaacRuntimeFeedback())
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/robot/health') {
      return sendJson(response, 200, await getRobotSidecarHealth())
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/robot/feedback') {
      return sendJson(response, 200, await getRobotRuntimeFeedback())
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/robot/state') {
      const robotRuntimeConfig = await loadRobotRuntimeConfig()
      return sendJson(response, 200, {
        ...getRobotStateSnapshot(),
        streamPath: ROBOT_STATE_STREAM_PATH,
        activeTarget: robotRuntimeConfig.activeTarget,
      })
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/speech/health') {
      return sendJson(response, 200, await getSpeechSidecarHealth())
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/speech/transcribe') {
      const body = await readJsonBody(request)
      const speechConfig = await resolveActiveSpeechProfile()
      const activeSpeechProfile = speechConfig.activeProfile

      if (activeSpeechProfile.provider !== 'parakeet-sidecar') {
        return sendJson(response, 400, {
          error: `Active speech profile "${activeSpeechProfile.label}" does not use server transcription.`,
        })
      }

      const result = await transcribeSpeechInput({
        audioBase64: typeof body?.audioBase64 === 'string' ? body.audioBase64.trim() : '',
        mimeType: typeof body?.mimeType === 'string' ? body.mimeType.trim() : 'audio/wav',
        sampleRate: Number.isFinite(body?.sampleRate) ? body.sampleRate : 16000,
        timestamps: activeSpeechProfile.timestamps ?? true,
        modelId: activeSpeechProfile.sidecarModelId || activeSpeechProfile.modelId,
        language: activeSpeechProfile.language,
        task: activeSpeechProfile.task,
        device: activeSpeechProfile.device,
      })

      const statusCode = result.status === 'ok' ? 200 : result.status === 'invalid-audio' ? 400 : 502
      return sendJson(response, statusCode, result)
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/isaac/dispatch') {
      const body = await readJsonBody(request)
      const preview =
        body?.preview && typeof body.preview === 'object'
          ? body.preview
          : await buildIsaacSimPreview({
            input: body?.input,
            rawResponse: body?.rawResponse,
            parsed: body?.parsed,
          })
      const dispatch = await dispatchIsaacSimCommand(preview)
      const statusCode = dispatch.status === 'error' ? 502 : 200
      return sendJson(response, statusCode, { preview, dispatch })
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/robot/dispatch') {
      const body = await readJsonBody(request)
      const preview =
        body?.preview && typeof body.preview === 'object'
          ? body.preview
          : await buildRobotRuntimePreview({
            input: body?.input,
            rawResponse: body?.rawResponse,
            parsed: body?.parsed,
          })
      const dispatch = await dispatchRobotCommand(preview)
      const statusCode = dispatch.status === 'error' ? 502 : 200
      return sendJson(response, statusCode, { preview, dispatch })
    }

    if (request.method === 'GET') {
      return serveStaticRequest(requestUrl.pathname, response)
    }

    sendJson(response, 405, { error: 'Method not allowed.' })
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Unexpected server error.',
    })
  }
})

server.on('upgrade', (request, socket, head) => {
  void handleRobotStateStreamUpgrade(request, socket, head, {
    async getRuntimeTargetKind() {
      const robotRuntimeConfig = await loadRobotRuntimeConfig()
      return robotRuntimeConfig.activeTarget?.kind || ''
    },
  }).catch((error) => {
    rejectFailedUpgrade(socket, error)
  })
})

server.listen(PORT, HOST, async () => {
  const profileConfig = await resolveActiveModelProfile()
  console.log(
    `${appConfig.serverReadyLabel} running at http://${HOST}:${PORT} using ${profileConfig.activeProfile.label} (${profileConfig.activeProfile.model})`,
  )
})

async function serveStaticRequest(pathname, response) {
  for (const { prefix, rootDir } of STATIC_ROOTS) {
    if (pathname.startsWith(prefix)) {
      const requestedPath = pathname.slice(prefix.length)
      return serveStaticFile(requestedPath, response, rootDir)
    }
  }

  return serveStaticFile(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''), response, PUBLIC_DIR)
}
async function serveStaticFile(requestedPath, response, rootDir) {
  const cleanedPath = requestedPath.replace(/^\/+/, '')
  const resolved = path.normalize(path.join(rootDir, cleanedPath))
  const normalizedRoot = path.normalize(rootDir)
  const rootPrefix = `${normalizedRoot}${path.sep}`

  if (resolved !== normalizedRoot && !resolved.startsWith(rootPrefix)) {
    return sendJson(response, 403, { error: 'Forbidden.' })
  }

  try {
    const file = await readFile(resolved)
    response.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(resolved)] || 'application/octet-stream',
    })
    response.end(file)
  } catch {
    sendJson(response, 404, { error: 'Not found.' })
  }
}

async function readJsonBody(request) {
  const chunks = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  if (chunks.length === 0) {
    return {}
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function rejectFailedUpgrade(socket, error) {
  const message = error instanceof Error ? error.message : 'Unexpected robot state stream error.'
  socket.write(
    'HTTP/1.1 500 Robot State Stream Error\r\n' +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(message)}\r\n` +
    '\r\n' +
    message,
  )
  socket.destroy()
}
