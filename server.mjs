import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAppConfig } from './lib/app-config.mjs'
import { buildIsaacSimPreview } from './lib/isaacsim-command-compiler.mjs'
import { dispatchIsaacSimCommand, getIsaacSidecarHealth } from './lib/isaacsim-sidecar-client.mjs'
import { loadPublicConfig, processUserInput } from './lib/app-service.mjs'
import { resolveActiveModelProfile, setActiveModelProfile } from './lib/model-profile-config.mjs'

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

createServer(async (request, response) => {
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

    if (request.method === 'GET' && requestUrl.pathname === '/api/isaac/health') {
      return sendJson(response, 200, await getIsaacSidecarHealth())
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

    if (request.method === 'GET') {
      return serveStaticRequest(requestUrl.pathname, response)
    }

    sendJson(response, 405, { error: 'Method not allowed.' })
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Unexpected server error.',
    })
  }
}).listen(PORT, HOST, async () => {
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
