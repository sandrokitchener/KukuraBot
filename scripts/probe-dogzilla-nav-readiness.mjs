#!/usr/bin/env node
import { loadDogzillaConnectionConfig } from '../lib/dogzilla-connection-center.mjs'
import { validatePoseInsideDogzillaMap } from '../lib/dogzilla-map-metadata.mjs'
import { getDogzillaWaypointNavigationReadiness } from '../lib/dogzilla-navigation-readiness.mjs'

const DEFAULT_TIMEOUT_MS = 12000

async function main() {
  const args = new Set(process.argv.slice(2))
  const failOnBlocked = args.has('--fail-on-blocked')
  const config = await loadDogzillaConnectionConfig()
  const bridgeHealthUrl = new URL('/healthz', config.bridges?.direct?.baseUrl || 'http://10.0.4.32:8893').toString()
  const [bridgeHealth, lidarHealth, lidarPose, lidarScan] = await Promise.all([
    fetchJson(bridgeHealthUrl),
    fetchJson(config.lidar?.healthUrl || ''),
    fetchJson(config.lidar?.poseUrl || ''),
    fetchJson(config.lidar?.scanUrl || ''),
  ])

  const runtime = bridgeHealth.body?.runtime && typeof bridgeHealth.body.runtime === 'object'
    ? bridgeHealth.body.runtime
    : {}
  const readiness = getDogzillaWaypointNavigationReadiness(runtime)
  const poseSummary = summarizePose(lidarPose)
  const poseBounds = validateLivePoseBounds(poseSummary, runtime.map)
  const blockers = [
    ...(Array.isArray(readiness.blockers) ? readiness.blockers : []),
    poseBounds.ok === false ? poseBounds.message : '',
  ].filter(Boolean)
  const payload = {
    ok: readiness.ready && poseBounds.ok !== false,
    checkedAt: new Date().toISOString(),
    bridge: {
      url: bridgeHealthUrl,
      status: bridgeHealth.status,
      error: bridgeHealth.error,
    },
    map: compactObject({
      id: runtime.map?.id,
      fingerprint: runtime.map?.fingerprint,
      available: runtime.map?.available,
      bounds: runtime.map?.bounds,
    }),
    navigation: compactObject({
      ready: readiness.ready,
      reason: blockers.join('; '),
      actionAvailable: readiness.actionAvailable,
      odomReady: readiness.odomReady,
      odomTopic: readiness.odomTopic,
      odomPublisherCount: readiness.odomPublisherCount,
      odomMessageAvailable: readiness.odomMessageAvailable,
      odomTfAvailable: readiness.odomTfAvailable,
      odomLiveProbeKnown: readiness.odomLiveProbeKnown,
      lifecycleActive: readiness.lifecycleActive,
      lifecycleKnown: readiness.lifecycleKnown,
      lifecycleNodes: readiness.lifecycleNodes,
      scanReady: readiness.scanReady,
      scanTopic: readiness.scanTopic,
      scanPublisherCount: readiness.scanPublisherCount,
      scanSubscriptionCount: readiness.scanSubscriptionCount,
      scanLiveProbeKnown: readiness.scanLiveProbeKnown,
      blockers,
      robotPoseInsideMap: poseBounds.ok,
      robotPoseMapCheck: poseBounds,
      nav2: runtime.nav2,
      nav2GaitAdapter: runtime.nav2GaitAdapter,
    }),
    lidar: {
      health: summarizeLidarHealth(lidarHealth),
      pose: poseSummary,
      scan: summarizeScan(lidarScan),
    },
  }

  console.log(JSON.stringify(payload, null, 2))
  if (failOnBlocked && !payload.ok) {
    process.exitCode = 2
  }
}

async function fetchJson(url) {
  if (!url) {
    return { status: 'skipped', error: 'url not configured', body: null }
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })
    const body = await response.json().catch(() => null)
    return {
      status: response.ok ? 'ok' : 'error',
      responseStatus: response.status,
      url,
      body,
      error: response.ok ? '' : `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      status: 'error',
      url,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function summarizeLidarHealth(result) {
  const body = result.body || {}
  return compactObject({
    status: result.status,
    url: result.url,
    ok: body.ok,
    topic: body.topic,
    driver: body.driver,
    serialPort: body.serialPort,
    latestScanAgeSec: body.latestScanAgeSec,
    error: result.error || body.error,
  })
}

function summarizePose(result) {
  const body = result.body || {}
  const pose = body.pose || {}
  return compactObject({
    status: result.status,
    url: result.url,
    ok: body.ok,
    waypointSafe: body.waypointSafe,
    frame: pose.frame || body.frame,
    source: pose.source || body.source,
    x: pose.x,
    y: pose.y,
    theta: pose.theta,
    ageSec: body.ageSec || body.latestPoseAgeSec,
    rosGraphOdomPublishers: body.rosGraph?.topics?.['/odom']?.publisherCount,
    error: result.error || body.error,
  })
}

function summarizeScan(result) {
  const body = result.body || {}
  return compactObject({
    status: result.status,
    url: result.url,
    ok: body.ok,
    frameId: body.frameId,
    ageSec: body.ageSec || body.latestScanAgeSec,
    validRanges: body.validRanges,
    nearFront: body.nearFront,
    nearLeft: body.nearLeft,
    nearRight: body.nearRight,
    minRange: body.minRange,
    error: result.error || body.error,
  })
}

function validateLivePoseBounds(pose = {}, activeMap = null) {
  if (pose.status !== 'ok' || pose.frame !== 'map') {
    return { ok: null, reason: 'pose-unchecked' }
  }

  const validation = validatePoseInsideDogzillaMap(pose, activeMap)
  if (validation.ok) {
    return { ok: true }
  }

  if (validation.reason !== 'off-map') {
    return { ok: null, reason: validation.reason, message: validation.message }
  }

  const bounds = validation.map?.bounds || {}
  return {
    ok: false,
    reason: validation.reason,
    message: `robot pose (${formatNumber(pose.x)}, ${formatNumber(pose.y)}) is outside active map bounds x ${formatNumber(bounds.minX)}..${formatNumber(bounds.maxX)}, y ${formatNumber(bounds.minY)}..${formatNumber(bounds.maxY)}`,
  }
}

function formatNumber(value) {
  return Number(value).toFixed(2)
}

function compactObject(source) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value !== null && value !== ''))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
