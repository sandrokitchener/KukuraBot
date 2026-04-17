import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cliOptions = parseCliArgs(process.argv.slice(2))
const HOST = cliOptions.host || process.env.APP_HOST || process.env.KUKURA_HOST || '127.0.0.1'
const PORT = Number(cliOptions.port || process.env.APP_PORT || process.env.KUKURA_PORT || 3037)
const APP_URL = `http://${HOST}:${PORT}`

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: {
    ...process.env,
    APP_HOST: HOST,
    APP_PORT: String(PORT),
    KUKURA_HOST: HOST,
    KUKURA_PORT: String(PORT),
  },
})

server.once('spawn', () => {
  console.log(`Launcher ready. App URL: ${APP_URL}`)

  if (isLocalDesktopHost(HOST)) {
    openBrowser(APP_URL)
  } else {
    console.log('Browser auto-open skipped for non-local host.')
  }
})

server.on('exit', (code, signal) => {
  if (signal) {
    process.exit(0)
    return
  }

  process.exit(code ?? 0)
})

server.on('error', (error) => {
  console.error(`Launcher failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!server.killed) {
      server.kill(signal)
    }
  })
}

function isLocalDesktopHost(host) {
  return host === '127.0.0.1' || host === 'localhost'
}

function openBrowser(url) {
  const platform = process.platform
  let command = null
  let args = []

  if (platform === 'win32') {
    command = 'cmd'
    args = ['/c', 'start', '', url]
  } else if (platform === 'darwin') {
    command = 'open'
    args = [url]
  } else {
    command = 'xdg-open'
    args = [url]
  }

  const child = spawn(command, args, {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
  })

  child.on('error', () => {
    console.log(`Open browser manually: ${url}`)
  })

  child.unref()
}

function parseCliArgs(argv) {
  const options = {}

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]

    if (value === '--host' && argv[index + 1]) {
      options.host = argv[index + 1]
      index += 1
      continue
    }

    if (value === '--port' && argv[index + 1]) {
      options.port = argv[index + 1]
      index += 1
    }
  }

  return options
}
