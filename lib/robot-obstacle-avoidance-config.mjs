import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'robot-obstacle-avoidance.json')

export async function loadDogzillaObstacleAvoidanceConfig() {
  const content = await readFile(CONFIG_PATH, 'utf-8')
  const parsed = JSON.parse(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid DOGZILLA obstacle avoidance config: ${CONFIG_PATH}`)
  }
  return parsed
}
