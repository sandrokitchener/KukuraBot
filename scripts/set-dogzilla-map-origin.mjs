#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MAP_ORIGIN_FILE,
  saveDogzillaMapOriginFromPose,
} from '../lib/dogzilla-map-frame.mjs'
import {
  getDogzillaRobotPose,
  startDogzillaLidarClient,
} from '../lib/dogzilla-lidar-client.mjs'

const SCRIPT_FILE = fileURLToPath(import.meta.url)

export async function setDogzillaMapOrigin({
  originFile = DEFAULT_MAP_ORIGIN_FILE,
  label = 'home_origin',
  poseTimeoutMs = 10_000,
} = {}) {
  await startDogzillaLidarClient()
  const posePayload = await waitForMapPose(poseTimeoutMs)
  if (!posePayload.ok) {
    throw new Error(posePayload.error || 'pose not available')
  }

  const origin = await saveDogzillaMapOriginFromPose(posePayload, {
    originFile,
    label,
    requireMapIdentity: false,
  })
  return { origin, originFile }
}

async function waitForMapPose(timeoutMs) {
  const startedAt = Date.now()
  do {
    const pose = await getDogzillaRobotPose()
    if (pose.ok && pose.waypointSafe) {
      return pose
    }
    await sleep(250)
  } while (Date.now() - startedAt < timeoutMs)

  const last = await getDogzillaRobotPose()
  return last
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function parseArgs(argv) {
  const args = {
    originFile: DEFAULT_MAP_ORIGIN_FILE,
    label: 'home_origin',
    poseTimeoutMs: 10_000,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--file') args.originFile = path.resolve(argv[++index])
    else if (token === '--label') args.label = argv[++index]
    else if (token === '--pose-timeout') args.poseTimeoutMs = Number(argv[++index])
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
