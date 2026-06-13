#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MAP_ORIGIN_FILE,
  saveDogzillaMapOriginFromPose,
} from '../lib/dogzilla-map-frame.mjs'
import { normalizeDogzillaMapMetadata } from '../lib/dogzilla-map-metadata.mjs'

const SCRIPT_FILE = fileURLToPath(import.meta.url)
const DEFAULT_POSE_URL = process.env.DOGZILLA_POSE_URL || 'http://10.0.4.32:8896/pose'
const DEFAULT_BRIDGE_HEALTH_URL = process.env.DOGZILLA_BRIDGE_HEALTH_URL || 'http://10.0.4.32:8893/healthz'

export async function setDogzillaMapOrigin({
  poseUrl = DEFAULT_POSE_URL,
  originFile = DEFAULT_MAP_ORIGIN_FILE,
  bridgeHealthUrl = DEFAULT_BRIDGE_HEALTH_URL,
  label = 'home_origin',
  allowMissingMapIdentity = false,
} = {}) {
  const response = await fetch(poseUrl)
  const posePayload = await response.json()
  if (!response.ok || posePayload.ok === false) {
    throw new Error(posePayload.error || posePayload.message || `pose request failed: ${response.status}`)
  }

  const mapMetadata = await loadActiveMapMetadata(bridgeHealthUrl)
  if (!allowMissingMapIdentity && (!mapMetadata?.available || !mapMetadata.id || !mapMetadata.fingerprint)) {
    throw new Error('refusing to save map origin without active DOGZILLA map identity; start DOGZILLA Direct Bridge or rerun with --allow-missing-map-identity')
  }

  const origin = await saveDogzillaMapOriginFromPose(posePayload, {
    originFile,
    label,
    mapMetadata: mapMetadata?.available ? mapMetadata : null,
    requireMapIdentity: !allowMissingMapIdentity,
  })
  return { origin, originFile, map: mapMetadata }
}

async function loadActiveMapMetadata(bridgeHealthUrl) {
  if (!bridgeHealthUrl) {
    return null
  }

  const response = await fetch(bridgeHealthUrl)
  const body = await response.json()
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || body.message || `bridge health failed: ${response.status}`)
  }

  return normalizeDogzillaMapMetadata(body.runtime?.map)
}

function parseArgs(argv) {
  const args = {
    poseUrl: DEFAULT_POSE_URL,
    originFile: DEFAULT_MAP_ORIGIN_FILE,
    bridgeHealthUrl: DEFAULT_BRIDGE_HEALTH_URL,
    label: 'home_origin',
    allowMissingMapIdentity: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--pose-url') args.poseUrl = argv[++index]
    else if (token === '--file') args.originFile = path.resolve(argv[++index])
    else if (token === '--bridge-health-url') args.bridgeHealthUrl = argv[++index]
    else if (token === '--label') args.label = argv[++index]
    else if (token === '--allow-missing-map-identity') args.allowMissingMapIdentity = true
    else throw new Error(`unknown argument: ${token}`)
  }

  return args
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  setDogzillaMapOrigin(parseArgs(process.argv.slice(2)))
    .then(({ origin, originFile, map }) => {
      console.log(JSON.stringify({ ok: true, origin, originFile, map }, null, 2))
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
