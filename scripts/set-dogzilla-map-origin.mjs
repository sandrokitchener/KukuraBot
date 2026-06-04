#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MAP_ORIGIN_FILE,
  saveDogzillaMapOriginFromPose,
} from '../lib/dogzilla-map-frame.mjs'

const SCRIPT_FILE = fileURLToPath(import.meta.url)
const DEFAULT_POSE_URL = process.env.DOGZILLA_POSE_URL || 'http://10.0.4.32:8896/pose'

export async function setDogzillaMapOrigin({
  poseUrl = DEFAULT_POSE_URL,
  originFile = DEFAULT_MAP_ORIGIN_FILE,
  label = 'home_origin',
} = {}) {
  const response = await fetch(poseUrl)
  const posePayload = await response.json()
  if (!response.ok || posePayload.ok === false) {
    throw new Error(posePayload.error || posePayload.message || `pose request failed: ${response.status}`)
  }

  const origin = await saveDogzillaMapOriginFromPose(posePayload, { originFile, label })
  return { origin, originFile }
}

function parseArgs(argv) {
  const args = {
    poseUrl: DEFAULT_POSE_URL,
    originFile: DEFAULT_MAP_ORIGIN_FILE,
    label: 'home_origin',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--pose-url') args.poseUrl = argv[++index]
    else if (token === '--file') args.originFile = path.resolve(argv[++index])
    else if (token === '--label') args.label = argv[++index]
    else throw new Error(`unknown argument: ${token}`)
  }

  return args
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  setDogzillaMapOrigin(parseArgs(process.argv.slice(2)))
    .then(({ origin, originFile }) => {
      console.log(JSON.stringify({ ok: true, origin, originFile }, null, 2))
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
