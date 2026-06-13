#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_MAP_ORIGIN_FILE, loadDogzillaMapOrigin } from '../lib/dogzilla-map-frame.mjs'
import { normalizeRobotWaypointsConfig } from '../lib/isaacsim-config.mjs'
import { normalizeWaypointName } from './capture-dogzilla-map-pose.mjs'
import { validateDogzillaWaypoints } from './validate-dogzilla-waypoints.mjs'

const SCRIPT_FILE = fileURLToPath(import.meta.url)
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_FILE), '..')
const DEFAULT_WAYPOINT_FILE = path.join(ROOT_DIR, 'config', 'robot-waypoints.json')
const DEFAULT_BRIDGE_HEALTH_URL = process.env.DOGZILLA_BRIDGE_HEALTH_URL || 'http://10.0.4.32:8893/healthz'

export async function reviewDogzillaWaypointProposal({
  proposalFile,
  waypointFile = '',
  originFile = DEFAULT_MAP_ORIGIN_FILE,
  bridgeHealthUrl = DEFAULT_BRIDGE_HEALTH_URL,
  fetchBridgeHealth = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!proposalFile) {
    throw new Error('proposal file is required')
  }

  const proposalPath = path.resolve(proposalFile)
  const proposal = JSON.parse(await readFile(proposalPath, 'utf-8'))
  const waypointName = normalizeWaypointName(proposal.waypointName || proposal.name)
  const waypoint = proposal.waypoint && typeof proposal.waypoint === 'object' ? proposal.waypoint : null
  if (!waypointName || !waypoint) {
    throw new Error('proposal must include waypointName and waypoint object')
  }

  const sourceOfTruthFile = path.resolve(waypointFile || proposal.sourceOfTruthFile || DEFAULT_WAYPOINT_FILE)
  const sourceText = await readFile(sourceOfTruthFile, 'utf-8')
  const sourceSha256 = createHash('sha256').update(sourceText).digest('hex')
  const sourceConfig = normalizeRobotWaypointsConfig(JSON.parse(sourceText))
  const mapOrigin = await loadDogzillaMapOrigin(originFile)
  const activeMap = fetchBridgeHealth
    ? (await loadActiveMapMetadata(bridgeHealthUrl, fetchImpl)).map
    : null

  const proposalConfig = buildSingleWaypointConfig(sourceConfig, waypointName, waypoint)
  const proposalReport = validateDogzillaWaypoints({
    waypointConfig: proposalConfig,
    waypointFile: sourceOfTruthFile,
    mapOrigin,
    mapMetadata: activeMap,
    bridgeHealthUrl: fetchBridgeHealth ? bridgeHealthUrl : '',
  })
  const sourceReport = validateDogzillaWaypoints({
    waypointConfig: sourceConfig,
    waypointFile: sourceOfTruthFile,
    mapOrigin,
    mapMetadata: activeMap,
    bridgeHealthUrl: fetchBridgeHealth ? bridgeHealthUrl : '',
  })
  const proposalResult = proposalReport.results.find((result) => result.name === waypointName) || null
  const sourceResult = sourceReport.results.find((result) => result.name === waypointName) || null
  const activeSet = sourceConfig.activeSet || Object.keys(sourceConfig.sets || {})[0] || 'home'
  const sourceWaypoints = sourceConfig.sets?.[activeSet]?.waypoints || {}
  const waypointExists = Object.prototype.hasOwnProperty.call(sourceWaypoints, waypointName)

  const proposalAdvisories = Array.isArray(proposalResult?.advisoryProblems) ? proposalResult.advisoryProblems : []

  return {
    ok: proposalResult?.ok === true && proposalAdvisories.length === 0,
    proposalFile: proposalPath,
    sourceOfTruthFile,
    writePolicy: 'read-only review; robot-waypoints.json is not modified',
    waypointName,
    activeMap: proposalReport.map,
    source: {
      activeSet,
      sha256: sourceSha256,
      waypointExists,
      existingWaypointStatus: sourceResult?.status || 'missing',
    },
    proposalResult,
    sourceResult,
    jsonPatch: [
      {
        op: waypointExists ? 'replace' : 'add',
        path: `/sets/${escapeJsonPointer(activeSet)}/waypoints/${escapeJsonPointer(waypointName)}`,
        value: waypoint,
      },
    ],
    copyCandidate: {
      waypointName,
      waypoint,
    },
  }
}

function escapeJsonPointer(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1')
}

function buildSingleWaypointConfig(sourceConfig = {}, waypointName, waypoint) {
  const activeSet = sourceConfig.activeSet || Object.keys(sourceConfig.sets || {})[0] || 'home'
  return {
    activeSet,
    sets: {
      [activeSet]: {
        waypoints: {
          [waypointName]: waypoint,
        },
      },
    },
  }
}

async function loadActiveMapMetadata(bridgeHealthUrl, fetchImpl) {
  if (!bridgeHealthUrl) {
    return { map: null, error: 'bridge health URL is empty' }
  }

  if (typeof fetchImpl !== 'function') {
    return { map: null, error: 'fetch is unavailable' }
  }

  try {
    const response = await fetchImpl(bridgeHealthUrl)
    const body = await response.json()
    if (!response.ok || body.ok === false) {
      return { map: null, error: body.error || body.message || `bridge health failed: ${response.status}` }
    }
    return { map: body.runtime?.map || null, error: '' }
  } catch (error) {
    return { map: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function parseArgs(argv) {
  const args = {
    proposalFile: '',
    waypointFile: '',
    originFile: DEFAULT_MAP_ORIGIN_FILE,
    bridgeHealthUrl: DEFAULT_BRIDGE_HEALTH_URL,
    fetchBridgeHealth: true,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--file') args.waypointFile = path.resolve(argv[++index])
    else if (token === '--origin-file') args.originFile = path.resolve(argv[++index])
    else if (token === '--bridge-health-url') args.bridgeHealthUrl = argv[++index]
    else if (token === '--no-bridge') args.fetchBridgeHealth = false
    else if (!args.proposalFile) args.proposalFile = path.resolve(token)
    else throw new Error(`unknown argument: ${token}`)
  }

  return args
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  reviewDogzillaWaypointProposal(parseArgs(process.argv.slice(2)))
    .then((report) => {
      console.log(JSON.stringify(report, null, 2))
      if (!report.ok) {
        process.exitCode = 1
      }
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
