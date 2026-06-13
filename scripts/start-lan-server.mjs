process.env.APP_HOST ||= '0.0.0.0'

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { forceDogzillaDirectBridgeOnStartup } from '../lib/dogzilla-direct-bridge-launcher.mjs'
import { forceDogzillaRequiredServicesOnStartup } from '../lib/dogzilla-required-services-launcher.mjs'
import { forceDogzillaWaypointNavigationOnStartup } from '../lib/dogzilla-waypoint-navigation-launcher.mjs'
import {
  loadRobotRos2Config,
  loadRobotRuntimeConfig,
} from '../lib/robot-runtime-config.mjs'
import { resolveActiveSpeechProfile } from '../lib/speech-profile-config.mjs'
import { loadSpeechSidecarConfig } from '../lib/speech-sidecar-config.mjs'
import { startManagedSpeechSidecar } from '../lib/speech-sidecar-launcher.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const [robotRuntimeConfig, robotRos2Config, speechProfileConfig] = await Promise.all([
  loadRobotRuntimeConfig(),
  loadRobotRos2Config(),
  resolveActiveSpeechProfile(),
])
await startRobotNetworkDependencies()
const managedSpeechEnvironment = await startOptionalManagedSpeechSidecar()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void managedSpeechEnvironment.stop()
    process.exit(0)
  })
}

await import('../server.mjs')

async function startRobotNetworkDependencies() {
  const requiredServices = await forceDogzillaRequiredServicesOnStartup({
    logger: console,
  }).catch((error) => {
    console.warn(`DOGZILLA required service startup failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  })

  await forceDogzillaDirectBridgeOnStartup({
    runtimeConfig: robotRuntimeConfig,
    ros2Config: robotRos2Config,
    logger: console,
  }).catch((error) => {
    console.warn(`DOGZILLA direct bridge startup failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  await forceDogzillaWaypointNavigationOnStartup({
    runtimeConfig: robotRuntimeConfig,
    ros2Config: robotRos2Config,
    logger: console,
  }).catch((error) => {
    console.warn(`DOGZILLA waypoint navigator startup failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  return requiredServices
}

async function startOptionalManagedSpeechSidecar() {
  if (speechProfileConfig.activeProfile?.provider !== 'parakeet-sidecar') {
    return createNoopManagedEnvironment('speech')
  }

  try {
    return await startManagedSpeechSidecar({
      sidecarConfig: await loadSpeechSidecarConfig(),
      rootDir,
      logger: console,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Speech sidecar unavailable; continuing without managed speech sidecar. ${message}`)
    return createNoopManagedEnvironment('speech', message)
  }
}

function createNoopManagedEnvironment(label, error = '') {
  return {
    enabled: false,
    label,
    error,
    async stop() {},
  }
}
