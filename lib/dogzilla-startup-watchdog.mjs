import { forceDogzillaDirectBridgeOnStartup } from './dogzilla-direct-bridge-launcher.mjs'
import { forceDogzillaRequiredServicesOnStartup } from './dogzilla-required-services-launcher.mjs'
import { forceDogzillaWaypointNavigationOnStartup } from './dogzilla-waypoint-navigation-launcher.mjs'
import {
  loadRobotRos2Config,
  loadRobotRuntimeConfig,
} from './robot-runtime-config.mjs'

const OFF_VALUES = new Set(['0', 'false', 'no', 'off'])

export function shouldRunDogzillaStartupWatchdog(runtimeConfig = {}, env = process.env) {
  const override = String(env.APP_DOGZILLA_STARTUP_WATCHDOG ?? env.DOGZILLA_STARTUP_WATCHDOG ?? '').trim().toLowerCase()

  if (OFF_VALUES.has(override)) {
    return false
  }

  return runtimeConfig.enabled !== false && runtimeConfig.activeTarget?.kind === 'dogzilla-direct'
}

export function shouldBlockDogzillaAppLaunchForNavigation(startupResult = {}, env = process.env) {
  const override = String(env.APP_DOGZILLA_STARTUP_REQUIRE_NAV ?? env.DOGZILLA_STARTUP_REQUIRE_NAV ?? '').trim().toLowerCase()

  if (OFF_VALUES.has(override)) {
    return false
  }

  if (!startupResult || startupResult.status === 'skipped') {
    return false
  }

  const waypointNavigation = startupResult.waypointNavigation || {}
  return waypointNavigation.enabled !== false
    && waypointNavigation.status !== 'ok'
    && waypointNavigation.status !== 'skipped'
}

export async function runDogzillaStartupWatchdog({
  env = process.env,
  logger = console,
  loadRobotRuntimeConfigImpl = loadRobotRuntimeConfig,
  loadRobotRos2ConfigImpl = loadRobotRos2Config,
  forceDogzillaRequiredServicesOnStartupImpl = forceDogzillaRequiredServicesOnStartup,
  forceDogzillaDirectBridgeOnStartupImpl = forceDogzillaDirectBridgeOnStartup,
  forceDogzillaWaypointNavigationOnStartupImpl = forceDogzillaWaypointNavigationOnStartup,
} = {}) {
  const [runtimeConfig, ros2Config] = await Promise.all([
    loadRobotRuntimeConfigImpl({ env }),
    loadRobotRos2ConfigImpl(),
  ])

  if (!shouldRunDogzillaStartupWatchdog(runtimeConfig, env)) {
    return {
      status: 'skipped',
      reason: 'active target is not DOGZILLA Direct Bridge',
      target: runtimeConfig.activeTarget?.id || '',
    }
  }

  logger.log?.('DOGZILLA startup watchdog checking support services.')
  const requiredServices = await forceDogzillaRequiredServicesOnStartupImpl({
    env,
    logger,
  }).catch((error) => ({
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
  }))

  logger.log?.('DOGZILLA startup watchdog checking direct bridge.')
  const directBridge = await forceDogzillaDirectBridgeOnStartupImpl({
    runtimeConfig,
    ros2Config,
    logger,
  }).catch((error) => ({
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
  }))

  logger.log?.('DOGZILLA startup watchdog checking Nav2 waypoint navigation.')
  const waypointNavigation = await forceDogzillaWaypointNavigationOnStartupImpl({
    runtimeConfig,
    ros2Config,
    logger,
  }).catch((error) => ({
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
  }))

  const status = [requiredServices, directBridge, waypointNavigation]
    .every((result) => result?.status === 'ok' || result?.status === 'skipped')
    ? 'ok'
    : 'degraded'

  if (status === 'ok') {
    logger.log?.('DOGZILLA startup watchdog ready.')
  } else {
    logger.warn?.('DOGZILLA startup watchdog completed with degraded services.')
  }

  return {
    status,
    requiredServices,
    directBridge,
    waypointNavigation,
  }
}
