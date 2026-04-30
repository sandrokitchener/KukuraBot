import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadIsaacSidecarConfig } from './lib/isaacsim-config.mjs'
import { startManagedIsaacEnvironment } from './lib/isaacsim-launcher.mjs'
import { loadRobotRos2Config, loadRobotRuntimeConfig } from './lib/robot-runtime-config.mjs'
import { startManagedRobotEnvironment } from './lib/robot-sidecar-launcher.mjs'
import { resolveActiveSpeechProfile } from './lib/speech-profile-config.mjs'
import { loadSpeechSidecarConfig } from './lib/speech-sidecar-config.mjs'
import { startManagedSpeechSidecar } from './lib/speech-sidecar-launcher.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cliOptions = parseCliArgs(process.argv.slice(2))
const HOST = cliOptions.host || process.env.APP_HOST || process.env.KUKURA_HOST || '127.0.0.1'
const PORT = Number(cliOptions.port || process.env.APP_PORT || process.env.KUKURA_PORT || 3037)
const MODEL_PROFILE = cliOptions.profile || process.env.APP_MODEL_PROFILE || ''
const APP_URL = `http://${HOST}:${PORT}`
const isaacSidecarConfig = await loadIsaacSidecarConfig()
const robotRuntimeConfig = await loadRobotRuntimeConfig({
  env: {
    ...process.env,
    ...(cliOptions.robotTarget ? { ROBOT_RUNTIME_TARGET: cliOptions.robotTarget } : {}),
  },
})
const robotRos2Config = await loadRobotRos2Config()
const speechProfileConfig = await resolveActiveSpeechProfile()
const speechSidecarConfig = await loadSpeechSidecarConfig()
const shouldManageIsaac = !robotRuntimeConfig.enabled || (robotRuntimeConfig.activeTarget?.kind || '') === 'isaacsim'
const shouldManageRobot = robotRuntimeConfig.enabled && (robotRuntimeConfig.activeTarget?.kind || '') === 'ros2-bridge'
const managedIsaacEnvironment = shouldManageIsaac
  ? await startManagedIsaacEnvironment({
    sidecarConfig: isaacSidecarConfig,
    rootDir: __dirname,
    logger: console,
  })
  : createNoopManagedEnvironment('isaacsim')
const managedRobotEnvironment = shouldManageRobot
  ? await startManagedRobotEnvironment({
    runtimeConfig: robotRuntimeConfig,
    ros2Config: robotRos2Config,
    rootDir: __dirname,
    logger: console,
  })
  : createNoopManagedEnvironment('ros2')
const managedSpeechEnvironment = await startOptionalManagedSpeechSidecar({
  sidecarConfig: shouldManageSpeechSidecar(speechProfileConfig)
    ? speechSidecarConfig
    : {
      ...speechSidecarConfig,
      launch: {
        ...speechSidecarConfig.launch,
        managedByApp: false,
      },
    },
  rootDir: __dirname,
  logger: console,
})

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: {
    ...process.env,
    APP_HOST: HOST,
    APP_PORT: String(PORT),
    APP_MODEL_PROFILE: MODEL_PROFILE,
    ROBOT_RUNTIME_TARGET: robotRuntimeConfig.activeTargetId,
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
  void managedSpeechEnvironment.stop()
  void managedIsaacEnvironment.stop()
  void managedRobotEnvironment.stop()

  if (signal) {
    process.exit(0)
    return
  }

  process.exit(code ?? 0)
})

server.on('error', (error) => {
  void managedSpeechEnvironment.stop()
  void managedIsaacEnvironment.stop()
  void managedRobotEnvironment.stop()
  console.error(`Launcher failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void managedSpeechEnvironment.stop()
    void managedIsaacEnvironment.stop()
    void managedRobotEnvironment.stop()

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

function shouldManageSpeechSidecar(speechProfileConfig) {
  return speechProfileConfig.activeProfile?.provider === 'parakeet-sidecar'
}

async function startOptionalManagedSpeechSidecar(options) {
  try {
    return await startManagedSpeechSidecar(options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.logger?.warn?.(`Speech sidecar unavailable; continuing without managed speech sidecar. ${message}`)
    return createNoopManagedEnvironment('speech', message)
  }
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
      continue
    }

    if (value === '--profile' && argv[index + 1]) {
      options.profile = argv[index + 1]
      index += 1
      continue
    }

    if (value === '--robot-target' && argv[index + 1]) {
      options.robotTarget = argv[index + 1]
      index += 1
    }
  }

  return options
}

function createNoopManagedEnvironment(label, error = '') {
  return {
    enabled: false,
    label,
    error,
    async stop() {},
  }
}
