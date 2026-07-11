import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'robot-obstacle-avoidance.json')

const DEFAULTS = {
  nav2RobotRadius: 0.22,
  nav2FootprintPadding: 0.03,
  nav2InflationRadius: 0.4,
  nav2CostScalingFactor: 5.0,
  nav2ObstacleMinRange: 0.05,
  nav2ObstacleMaxRange: 3.0,
  nav2RaytraceMaxRange: 3.5,
  nav2ScanFilterEnabled: true,
  nav2ScanFilterMaskStartDeg: 120,
  nav2ScanFilterMaskEndDeg: 260,
  nav2ScanFilterMaskRangeM: 0.45,
  yawGoalTolerance: 6.283185307179586,
  nav2ControllerFrequency: 5.0,
  nav2BtLoopDurationMs: 200,
  nav2BtServerTimeoutMs: 10000,
  nav2BtWaitForServiceTimeoutMs: 5000,
  nav2PlannerFrequency: 1.0,
  nav2SmootherFrequency: 5.0,
  nav2RequiredMovementRadius: 0.05,
  nav2MovementTimeAllowance: 20.0,
  nav2FailureTolerance: 5.0,
  nav2MinSpeedXy: 0.03,
  nav2TransStoppedVelocity: 0.05,
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
