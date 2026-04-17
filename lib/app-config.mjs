import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const CONFIG_DIR = path.join(ROOT_DIR, 'config')

export async function loadAppConfig() {
  const rawConfig = JSON.parse(await readFile(path.join(CONFIG_DIR, 'app.json'), 'utf-8'))
  return normalizeAppConfig(rawConfig)
}

export function normalizeAppConfig(rawConfig = {}) {
  const assistantName = typeof rawConfig.assistantName === 'string' && rawConfig.assistantName.trim()
    ? rawConfig.assistantName.trim()
    : 'Assistant'

  return {
    assistantName,
    pageTitle: `${assistantName} Test App`,
    consoleTitle: `${assistantName} Console`,
    sendButtonLabel: `Ask ${assistantName}`,
    thinkingStatus: `${assistantName} is thinking...`,
    introEyebrow: 'Ollama robot-control test',
    introDescription:
      `Test a local ${assistantName} robot-control wrapper for robot-chat vs robot-command behavior. ` +
      'Edit prompt and response schema files directly whenever you want.',
    emptyChatMessage: 'Waiting for first message.',
    emptyChatMeta: 'Prompt ready.',
    waitingForJsonMessage: 'Waiting for valid JSON.',
    serverReadyLabel: `${assistantName} test app`,
  }
}

