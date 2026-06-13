import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'robot-obstacle-avoidance.json')

const DEFAULTS = {
  nav2RobotRadius: 0.16,
  nav2FootprintPadding: 0.02,
  nav2InflationRadius: 0.28,
  nav2CostScalingFactor: 8.0,
  nav2ObstacleMaxRange: 2.5,
  nav2RaytraceMaxRange: 3.5,
  mapNavigationObstacleDistance: 0.55,
  mapNavigationObstacleStopCount: 2,
  mapNavigationMaxXStep: 4,
  mapNavigationMaxYStep: 3,
  mapNavigationMaxTurnRate: 18,
  mapNavigationXGain: 14,
  mapNavigationYGain: 10,
  mapNavigationTurnGain: 28,
}

export async function loadDogzillaObstacleAvoidanceConfig() {
  try {
    const content = await readFile(CONFIG_PATH, 'utf-8')
    const parsed = JSON.parse(content)
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}
