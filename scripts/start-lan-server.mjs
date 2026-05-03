process.env.APP_HOST ||= '0.0.0.0'

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveActiveSpeechProfile } from '../lib/speech-profile-config.mjs'
import { loadSpeechSidecarConfig } from '../lib/speech-sidecar-config.mjs'
import { startManagedSpeechSidecar } from '../lib/speech-sidecar-launcher.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const speechProfileConfig = await resolveActiveSpeechProfile()
const managedSpeechEnvironment = await startOptionalManagedSpeechSidecar()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void managedSpeechEnvironment.stop()
    process.exit(0)
  })
}

await import('../server.mjs')

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
