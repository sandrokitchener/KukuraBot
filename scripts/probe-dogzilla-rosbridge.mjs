#!/usr/bin/env node
import { createRosbridgeClient } from '../lib/rosbridge-client.mjs'

const url = process.argv[2] || process.env.DOGZILLA_ROSBRIDGE_URL || 'ws://10.0.4.32:9090'
const client = createRosbridgeClient({ url })

function timeout(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
  })
}

async function main() {
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        client.once('connected', resolve)
        client.once('error', reject)
        client.connect()
      }),
      timeout(5000),
    ])

    await new Promise((resolve) => setTimeout(resolve, 1500))

    const health = client.getHealth()
    const pose = client.getPose()
    const map = client.getMap()

    const report = {
      url,
      connected: health.connected,
      scan: health.ok
        ? {
            frameId: health.frameId,
            rangeCount: client.latest.scan?.msg?.ranges?.length || 0,
            stats: client.getScan().stats,
          }
        : { ok: false, error: health.error },
      pose: pose.waypointSafe
        ? {
            frame: pose.pose.frame,
            x: pose.pose.x,
            y: pose.pose.y,
            theta: pose.pose.theta,
            ageSec: pose.pose.ageSec,
          }
        : { ok: false, status: pose.status, error: pose.error },
      map: map.ok
        ? {
            topic: map.topic,
            frameId: map.frameId,
            width: map.width,
            height: map.height,
            resolution: map.resolution,
            occupiedCount: map.occupiedCount,
            freeCount: map.freeCount,
            unknownCount: map.unknownCount,
            receivedAtAgeSec: map.receivedAtAgeSec,
          }
        : { ok: false, status: map.status, error: map.error },
    }

    console.log(JSON.stringify(report, null, 2))
    client.close()
    process.exit(report.connected && health.ok && pose.waypointSafe ? 0 : 1)
  } catch (error) {
    console.error(JSON.stringify({ url, ok: false, error: error.message }, null, 2))
    client.close()
    process.exit(1)
  }
}

main()
