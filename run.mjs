import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import path from 'node:path'
import { forceDogzillaDirectBridgeOnStartup } from './lib/dogzilla-direct-bridge-launcher.mjs'
import { forceDogzillaRequiredServicesOnStartup } from './lib/dogzilla-required-services-launcher.mjs'
import {
  getDogzillaLidarHealth,
  startDogzillaLidarClient,
} from './lib/dogzilla-lidar-client.mjs'
import { loadIsaacSidecarConfig } from './lib/isaacsim-config.mjs'
import { startManagedIsaacEnvironment } from './lib/isaacsim-launcher.mjs'
import { loadRobotRos2Config, loadRobotRuntimeConfig } from './lib/robot-runtime-config.mjs'
import {
  runExistingAppRobotStartupSequence,
  runRobotStartupSequence,
} from './lib/robot-startup-sequence.mjs'
import { stopManagedProcessOnPort } from './lib/managed-process-cleanup.mjs'
import { startManagedRobotEnvironment } from './lib/robot-sidecar-launcher.mjs'
import { resolveActiveSpeechProfile } from './lib/speech-profile-config.mjs'
import { loadSpeechSidecarConfig } from './lib/speech-sidecar-config.mjs'
import { startManagedSpeechSidecar } from './lib/speech-sidecar-launcher.mjs'
import { green, printStartupBanner } from './lib/startup-banner.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cliOptions = parseCliArgs(process.argv.slice(2))
const HOST = cliOptions.host || process.env.APP_HOST || process.env.KUKURA_HOST || '0.0.0.0'
const PORT = Number(cliOptions.port || process.env.APP_PORT || process.env.KUKURA_PORT || 3037)
const MODEL_PROFILE = cliOptions.profile || process.env.APP_MODEL_PROFILE || ''
const APP_URL = `http://${resolveProbeHost(HOST)}:${PORT}`
const startupStatus = createStartupStatus()
const startupBannerPrinted = printStartupBanner({
  mode: 'managed launch',
  url: APP_URL,
})

startupStatus.start(`Questing Beast startup at ${APP_URL}`)
let existingAppConfig = await fetchExistingAppConfig(HOST, PORT)
const reuseExistingApp = shouldReuseExistingApp(cliOptions, process.env)
const replaceManagedSidecars = shouldReplaceManagedSidecars(cliOptions, process.env)

if (existingAppConfig && reuseExistingApp) {
  startupStatus.update('Reusing existing app')
  const requiredServicesStartup = ensureExistingAppDogzillaRequiredServices(existingAppConfig)
  await requiredServicesStartup
  await ensureExistingAppDogzillaDirectBridge(APP_URL, existingAppConfig)
  startupStatus.update('Running robot startup sequence')
  await runExistingAppRobotStartupSequence(APP_URL, existingAppConfig, {
    logger: console,
  })
  startupStatus.stop(`App already ready at ${APP_URL}. Reusing existing process.`)
} else {
  if (existingAppConfig) {
    startupStatus.update('Stopping stale local app')
    await stopExistingAppServer(HOST, PORT, console)
    existingAppConfig = null
  }

  if (await isPortOccupied(HOST, PORT)) {
    startupStatus.stop()
    console.error(`Port ${HOST}:${PORT} is already in use by another process. Stop that process or start with --port <free-port>.`)
    process.exitCode = 1
  } else {
    startupStatus.update('Loading runtime config')
    const [isaacSidecarConfig, robotRuntimeConfig, robotRos2Config, speechProfileConfig, speechSidecarConfig] = await Promise.all([
      loadIsaacSidecarConfig(),
      loadRobotRuntimeConfig({
        env: {
          ...process.env,
          ...(cliOptions.robotTarget ? { ROBOT_RUNTIME_TARGET: cliOptions.robotTarget } : {}),
        },
      }),
      loadRobotRos2Config(),
      resolveActiveSpeechProfile(),
      loadSpeechSidecarConfig(),
    ])
    const shouldManageIsaac = !robotRuntimeConfig.enabled || (robotRuntimeConfig.activeTarget?.kind || '') === 'isaacsim'
    const shouldManageRobot = robotRuntimeConfig.enabled && (robotRuntimeConfig.activeTarget?.kind || '') === 'ros2-bridge'

    startupStatus.update('Starting services')
    const [
      ,
      directBridgeStartup,
      managedIsaacEnvironment,
      managedRobotEnvironment,
      managedSpeechEnvironment,
    ] = await Promise.all([
      forceDogzillaRequiredServicesOnStartup({
        logger: console,
        replaceExisting: replaceManagedSidecars,
      }).catch((error) => {
        console.warn(`DOGZILLA required service startup failed: ${error instanceof Error ? error.message : String(error)}`)
      }),
      forceDogzillaDirectBridgeOnStartup({
        runtimeConfig: robotRuntimeConfig,
        ros2Config: robotRos2Config,
        logger: console,
        replaceExisting: replaceManagedSidecars,
      }),
      shouldManageIsaac
        ? startManagedIsaacEnvironment({
          sidecarConfig: isaacSidecarConfig,
          rootDir: __dirname,
          logger: console,
          replaceExisting: replaceManagedSidecars,
        })
        : createNoopManagedEnvironment('isaacsim'),
      shouldManageRobot
        ? startManagedRobotEnvironment({
          runtimeConfig: robotRuntimeConfig,
          ros2Config: robotRos2Config,
          rootDir: __dirname,
          logger: console,
          replaceExisting: replaceManagedSidecars,
        })
        : createNoopManagedEnvironment('ros2'),
      startOptionalManagedSpeechSidecar({
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
        replaceExisting: replaceManagedSidecars,
      }),
    ])

    startupStatus.update('Checking DOGZILLA endpoints')
    const endpointCheck = await verifySimplifiedDogzillaEndpoints({
      robotRuntimeConfig,
      ros2Config: robotRos2Config,
      directBridgeStartup,
    })
    if (!endpointCheck.ok) {
      startupStatus.stop()
      console.error(`App launch blocked: ${endpointCheck.error}`)
      process.exit(1)
    }

    startupStatus.update('Running robot startup sequence')
    await runRobotStartupSequence({
      runtimeConfig: robotRuntimeConfig,
      ros2Config: robotRos2Config,
      logger: console,
      existingDirectBridgeHealth: pickFreshDirectBridgeHealth([
        directBridgeStartup?.health,
      ]),
    })

    startupStatus.stop('Starting Questing Beast server')
  const server = spawn(process.execPath, ['server.mjs'], {
      cwd: __dirname,
      stdio: 'inherit',
      env: {
        ...process.env,
        APP_HOST: HOST,
        APP_PORT: String(PORT),
        APP_MODEL_PROFILE: MODEL_PROFILE,
        APP_DOGZILLA_STARTUP_MONITOR: process.env.APP_DOGZILLA_STARTUP_MONITOR ?? '1',
        ROBOT_RUNTIME_TARGET: robotRuntimeConfig.activeTargetId,
        KUKURA_HOST: HOST,
        KUKURA_PORT: String(PORT),
        ...(startupBannerPrinted ? { QUESTING_BEAST_BANNER_PRINTED: '1' } : {}),
      },
    })

    server.once('spawn', () => {
      console.log(green(`Launcher ready. App URL: ${APP_URL}`))
      console.log()
      console.log(green(`     |\\_/|`))
      console.log(green(`     | @ @   Woof!`))
      console.log(green(`     |   <>              _`))
      console.log(green(`     |  _/\\------____ ((| |))`))
      console.log(green(`     |               \`--' |`))
      console.log(green(` ____|_       ___|   |___.'`))
      console.log(green(`/_/_____/____/_______|`))

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
  }
}

function createStartupStatus() {
  const enabled = process.stdout.isTTY && process.env.CI !== 'true'
  const frames = ['+', '/', '+', '\\']
  let frameIndex = 0
  let message = ''
  let timer = null

  const render = () => {
    if (!enabled) {
      return
    }

    const frame = frames[frameIndex % frames.length]
    frameIndex += 1
    process.stdout.write(`\r${frame} ${message}...`)
  }

  return {
    start(nextMessage) {
      message = nextMessage
      if (!enabled) {
        console.log(`${message}...`)
        return
      }
      render()
      timer = setInterval(render, 140)
    },
    update(nextMessage) {
      message = nextMessage
      if (!enabled) {
        console.log(`${message}...`)
        return
      }
      render()
    },
    stop(finalMessage = '') {
      if (timer) {
        clearInterval(timer)
        timer = null
      }

      if (!enabled) {
        if (finalMessage) {
          console.log(finalMessage)
        }
        return
      }

      process.stdout.clearLine(0)
      process.stdout.cursorTo(0)
      if (finalMessage) {
        console.log(finalMessage)
      }
    },
  }
}

function isLocalDesktopHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '::'
}

async function fetchExistingAppConfig(host, port) {
  try {
    const response = await fetch(`http://${resolveProbeHost(host)}:${port}/api/config`, {
      signal: AbortSignal.timeout(1000),
    })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

async function ensureExistingAppDogzillaDirectBridge(appUrl, appConfig) {
  if (appConfig?.robotRuntime?.activeTarget?.kind !== 'dogzilla-direct') {
    return
  }

  await runExistingAppDogzillaAction(appUrl, 'stop-vendor-app', 30_000)

  try {
    const healthResponse = await fetch(new URL('/api/robot/health', appUrl), {
      signal: AbortSignal.timeout(1500),
    })
    const health = await safeReadJson(healthResponse)

    if (healthResponse.ok && health?.status === 'ok') {
      console.log(green(`DOGZILLA direct bridge already ready at ${health.destination}.`))
      return
    }
  } catch {
    // Existing app is up, but direct bridge is not ready yet.
  }

  console.log('App is already open, but DOGZILLA direct bridge is not ready. Starting it now.')
  await runExistingAppDogzillaAction(appUrl, 'start-direct', 150_000, {
    live: shouldExistingAppDirectBridgeLive(appConfig),
  })
}

async function runExistingAppDogzillaAction(appUrl, action, timeoutMs, options = {}) {
  const response = await fetch(new URL('/api/dogzilla/connection/action', appUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      action,
      ...(options.live === true ? { live: true } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const result = await safeReadJson(response)

  if (!response.ok || result?.status === 'error') {
    console.warn(`DOGZILLA ${action} failed: ${result?.error || result?.stderr || `HTTP ${response.status}`}`)
  }

  return result || {
    status: response.ok ? 'ok' : 'error',
    action,
    responseStatus: response.status,
  }
}

function shouldExistingAppDirectBridgeLive(appConfig) {
  return appConfig?.robotRuntime?.dryRun === false
}

async function ensureExistingAppDogzillaRequiredServices(appConfig) {
  if (!appConfig?.dogzilla) {
    return
  }

  await forceDogzillaRequiredServicesOnStartup({
    config: appConfig.dogzilla,
    logger: console,
  })
}

async function isPortOccupied(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: resolveProbeHost(host),
      port,
    })
    const timeout = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 1000)

    socket.once('connect', () => {
      clearTimeout(timeout)
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      clearTimeout(timeout)
      resolve(false)
    })
  })
}

async function stopExistingAppServer(host, port, logger = console) {
  if (!isLocalDesktopHost(host)) {
    return {
      stopped: [],
      skipped: true,
      reason: `refusing to stop non-local app host ${host}`,
    }
  }

  const result = await stopManagedProcessOnPort({
    label: 'local app server',
    port,
    fragments: ['server.mjs'],
    logger,
  })
  await sleep(800)
  return result
}

function resolveProbeHost(host) {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
}

async function safeReadJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
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

function shouldReuseExistingApp(options = {}, env = process.env) {
  if (options.reuseExistingApp === true) {
    return true
  }

  return isTruthy(env.APP_REUSE_EXISTING_APP)
}

function shouldReplaceManagedSidecars(options = {}, env = process.env) {
  if (options.replaceManagedSidecars === true || isTruthy(env.APP_REPLACE_MANAGED_SIDECARS)) {
    return true
  }

  if (options.reuseManagedSidecars === true || isTruthy(env.APP_REUSE_MANAGED_SIDECARS)) {
    return false
  }

  return false
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
      continue
    }

    if (value === '--reuse-existing-app') {
      options.reuseExistingApp = true
      continue
    }

    if (value === '--reuse-managed-sidecars') {
      options.reuseManagedSidecars = true
      continue
    }

    if (value === '--replace-managed-sidecars') {
      options.replaceManagedSidecars = true
    }
  }

  return options
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function createNoopManagedEnvironment(label, error = '') {
  return {
    enabled: false,
    label,
    error,
    async stop() {},
  }
}

function pickFreshDirectBridgeHealth(candidates = []) {
  for (const candidate of candidates) {
    if (candidate && candidate.status === 'ok' && candidate.body?.runtime?.dryRun === false) {
      return candidate
    }
  }
  return null
}

async function verifySimplifiedDogzillaEndpoints({ robotRuntimeConfig, ros2Config, directBridgeStartup }) {
  const isDogzillaDirect = robotRuntimeConfig.activeTarget?.kind === 'dogzilla-direct'

  if (!isDogzillaDirect) {
    return { ok: true }
  }

  const lidarHealth = await startDogzillaLidarClient()
    .then(() => getDogzillaLidarHealth())
    .catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))

  if (!lidarHealth.ok) {
    console.warn(`DOGZILLA rosbridge not ready at app startup: ${lidarHealth.error || lidarHealth.status || 'unknown'}`)
  }

  const directHealth = directBridgeStartup?.health
  if (!directHealth || directHealth.status !== 'ok') {
    return {
      ok: false,
      error: 'DOGZILLA Direct Bridge (8893) is not healthy.',
    }
  }

  return { ok: true }
}
