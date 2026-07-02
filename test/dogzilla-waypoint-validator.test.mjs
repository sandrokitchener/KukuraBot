import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  validateDogzillaWaypoints,
  validateDogzillaWaypointsFromFiles,
} from '../scripts/validate-dogzilla-waypoints.mjs'
import { mapWaypoint, waypointConfig } from '../test-support/robot-compiler-fixtures.mjs'
import { nav2HealthBody } from '../test-support/robot-http-fixtures.mjs'

test('validateDogzillaWaypoints reports ready map waypoint inside active map', () => {
  const health = nav2HealthBody()
  const report = validateDogzillaWaypoints({
    waypointConfig: waypointConfig({
      kitchen: mapWaypoint({
        x: 1.2,
        y: -0.4,
        yaw: 0.75,
      }),
      current_position: {
        kind: 'special',
        mode: 'stay_put',
        verified: true,
      },
    }),
    mapMetadata: health.runtime.map,
    mapOrigin: {
      frame: 'app_map',
      sourceFrame: 'map',
      label: 'charger_origin',
      x: 0,
      y: 0,
      yaw: 0,
      map: health.runtime.map,
    },
    bridgeHealth: health,
  })

  assert.equal(report.ok, true)
  assert.equal(report.readyForMapWaypoints, true)
  assert.deepEqual(report.blockers, [])
  assert.equal(report.navigation.ready, true)
  assert.equal(report.mapOrigin.status, 'ready')
  assert.equal(report.summary.ready, 1)
  assert.equal(report.summary.semantic, 1)
  assert.equal(report.results.find((result) => result.name === 'kitchen').status, 'ready')
  assert.match(report.writePolicy, /read-only/)
})

test('validateDogzillaWaypoints reports operator blocker when Nav2 readiness is missing', () => {
  const health = nav2HealthBody({
    nav2: {
      available: false,
      waypointReady: false,
      odom: {
        available: false,
        publisherCount: 0,
      },
    },
  })
  const report = validateDogzillaWaypoints({
    waypointConfig: waypointConfig({
      kitchen: mapWaypoint({
        x: 1.2,
        y: -0.4,
        yaw: 0.75,
      }),
    }),
    mapMetadata: health.runtime.map,
    bridgeHealth: health,
  })

  assert.equal(report.ok, true)
  assert.equal(report.readyForMapWaypoints, false)
  assert.equal(report.summary.ready, 1)
  assert.match(report.blockers.join('\n'), /navigation not ready/)
  assert.doesNotMatch(report.blockers.join('\n'), /map origin not ready/)
  assert.equal(report.navigation.ready, false)
  assert.equal(report.mapOrigin.status, 'missing')
})

test('validateDogzillaWaypoints trusts navigation nav2 sample when bridge health has stale top-level nav2', () => {
  const health = nav2HealthBody()
  health.runtime.nav2 = {
    available: false,
    waypointReady: false,
    blockers: [
      'Nav2 NavigateToPose action server is not running in the ROS graph for action navigate_to_pose',
    ],
    odom: {
      topic: '/odom',
      publisherCount: 1,
      available: true,
      messageAvailable: false,
      tfAvailable: false,
    },
  }
  health.runtime.navigation = {
    available: true,
    primary: 'nav2',
    actionServerAvailable: true,
    waypointReady: true,
    blockers: [],
    nav2: {
      available: true,
      waypointReady: true,
      blockers: [],
      odom: {
        topic: '/odom',
        publisherCount: 1,
        available: true,
        messageAvailable: true,
        tfAvailable: true,
      },
      lifecycle: {
        active: true,
        nodes: [{ name: 'controller_server', active: true, state: 'active' }],
      },
      scan: {
        topic: '/scan_nav2',
        publisherCount: 1,
        subscriptionCount: 2,
        available: true,
      },
    },
  }

  const report = validateDogzillaWaypoints({
    waypointConfig: waypointConfig({
      kitchen: mapWaypoint({
        x: 1.2,
        y: -0.4,
        yaw: 0.75,
      }),
    }),
    mapMetadata: health.runtime.map,
    mapOrigin: {
      frame: 'app_map',
      sourceFrame: 'map',
      label: 'charger_origin',
      x: 0,
      y: 0,
      yaw: 0,
      map: health.runtime.map,
    },
    bridgeHealth: health,
  })

  assert.equal(report.navigation.ready, true)
  assert.equal(report.readyForMapWaypoints, true)
})

test('validateDogzillaWaypoints reports operator blocker when filtered Nav2 scan is missing', () => {
  const health = nav2HealthBody({
    nav2: {
      scan: {
        topic: '/scan_nav2',
        publisherCount: 1,
        subscriptionCount: 0,
        available: false,
        error: 'No Nav2 costmap subscribers visible on /scan_nav2',
      },
    },
  })
  const report = validateDogzillaWaypoints({
    waypointConfig: waypointConfig({
      kitchen: mapWaypoint({
        x: 1.2,
        y: -0.4,
        yaw: 0.75,
      }),
    }),
    mapMetadata: health.runtime.map,
    bridgeHealth: health,
  })

  assert.equal(report.readyForMapWaypoints, false)
  assert.equal(report.navigation.scanReady, false)
  assert.match(report.blockers.join('\n'), /No Nav2 costmap subscribers visible on \/scan_nav2/)
})

test('validateDogzillaWaypoints treats off-map trusted config as advisory only', () => {
  const report = validateDogzillaWaypoints({
    waypointConfig: waypointConfig({
      kitchen: mapWaypoint({
        x: 11,
        y: 6.29,
        yaw: 2.66,
        notes: ['Captured map pose: x=5.18, y=0.38, yaw=2.66.'],
      }),
      pantry: mapWaypoint({
        x: 11,
        y: 0,
        yaw: 0,
      }),
    }),
    mapMetadata: nav2HealthBody().runtime.map,
    bridgeHealth: nav2HealthBody(),
  })

  const kitchen = report.results.find((result) => result.name === 'kitchen')
  const pantry = report.results.find((result) => result.name === 'pantry')

  assert.equal(report.ok, true)
  assert.equal(report.readyForMapWaypoints, true)
  assert.equal(report.summary.ready, 2)
  assert.equal(report.summary.invalid, 0)
  assert.equal(kitchen.status, 'ready')
  assert.equal(kitchen.enabled, true)
  assert.doesNotMatch(kitchen.problems.join('\n'), /does not match/)
  assert.match(kitchen.advisoryProblems.join('\n'), /outside active map bounds/)
  assert.equal(pantry.status, 'ready')
  assert.equal(pantry.enabled, true)
  assert.match(pantry.advisoryProblems.join('\n'), /outside active map bounds/)
})

test('validateDogzillaWaypoints disables trusted config when map identity is missing or mismatched', () => {
  const report = validateDogzillaWaypoints({
    waypointConfig: waypointConfig({
      kitchen: mapWaypoint({
        mapId: '',
        mapFingerprint: '',
      }),
      pantry: mapWaypoint({
        mapId: 'old_map',
        mapFingerprint: 'old-fingerprint',
      }),
    }),
    mapMetadata: nav2HealthBody().runtime.map,
  })

  const kitchen = report.results.find((result) => result.name === 'kitchen')
  const pantry = report.results.find((result) => result.name === 'pantry')

  assert.equal(report.ok, false)
  assert.equal(report.readyForMapWaypoints, false)
  assert.equal(report.summary.ready, 0)
  assert.equal(report.summary.invalid, 2)
  assert.equal(kitchen.status, 'missing-map-identity')
  assert.equal(kitchen.enabled, false)
  assert.match(kitchen.problems.join('\n'), /no map identity/)
  assert.equal(pantry.status, 'map-id-mismatch')
  assert.equal(pantry.enabled, false)
  assert.match(pantry.problems.join('\n'), /belongs to map "old_map"/)
})

test('validateDogzillaWaypoints separates missing map identity from config-disabled waypoints', () => {
  const report = validateDogzillaWaypoints({
    waypointConfig: waypointConfig({
      trusted_placeholder: mapWaypoint({
        x: 0,
        y: 0,
        yaw: 0,
        mapId: '',
        mapFingerprint: '',
        verified: true,
      }),
      draft: mapWaypoint({
        x: 2,
        y: 2,
        yaw: 0,
        verified: false,
      }),
    }),
    mapMetadata: nav2HealthBody().runtime.map,
    bridgeHealth: nav2HealthBody(),
  })

  const trusted = report.results.find((result) => result.name === 'trusted_placeholder')
  const draft = report.results.find((result) => result.name === 'draft')

  assert.equal(report.ok, false)
  assert.equal(report.readyForMapWaypoints, false)
  assert.equal(report.summary.ready, 0)
  assert.equal(report.summary.disabled, 2)
  assert.equal(report.summary.invalid, 1)
  assert.equal(trusted.status, 'missing-map-identity')
  assert.equal(trusted.enabled, false)
  assert.equal(draft.status, 'disabled-by-config')
  assert.equal(draft.enabled, false)
  assert.match(draft.problems.join('\n'), /not verified by config/)
})

test('validateDogzillaWaypointsFromFiles does not modify robot-waypoints source', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-validate-'))
  const waypointFile = path.join(tempDir, 'robot-waypoints.json')
  const originFile = path.join(tempDir, 'missing-origin.json')
  const originalConfig = `${JSON.stringify(waypointConfig({
    kitchen: mapWaypoint({
      x: 1.2,
      y: -0.4,
      yaw: 0.75,
    }),
  }), null, 2)}\n`
  await writeFile(waypointFile, originalConfig, 'utf-8')

  const report = await validateDogzillaWaypointsFromFiles({
    waypointFile,
    originFile,
    fetchImpl: async () => ({
      ok: true,
      json: async () => nav2HealthBody(),
    }),
  })

  assert.equal(report.ok, true)
  assert.equal(report.readyForMapWaypoints, true)
  assert.deepEqual(report.blockers, [])
  assert.equal(await readFile(waypointFile, 'utf-8'), originalConfig)
})

test('validateDogzillaWaypointsFromFiles trusts healthz-lite waypoint readiness over stale full lifecycle probes', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-validate-'))
  const waypointFile = path.join(tempDir, 'robot-waypoints.json')
  const originFile = path.join(tempDir, 'origin.json')
  const health = nav2HealthBody()
  health.runtime.nav2.lifecycle = {
    active: false,
    nodes: [{ name: 'controller_server', active: false, error: 'timeout' }],
  }
  health.runtime.nav2.scan = {
    topic: '/scan_nav2',
    publisherCount: 1,
    subscriptionCount: 0,
    available: false,
  }
  health.runtime.navigation = {
    nav2: health.runtime.nav2,
  }

  await writeFile(waypointFile, `${JSON.stringify(waypointConfig({
    kitchen: mapWaypoint({ x: 1.2, y: -0.4, yaw: 0.75 }),
  }), null, 2)}\n`, 'utf-8')
  await writeFile(originFile, `${JSON.stringify({
    frame: 'app_map',
    sourceFrame: 'map',
    label: 'charger_origin',
    x: 0,
    y: 0,
    yaw: 0,
    map: health.runtime.map,
  }, null, 2)}\n`, 'utf-8')

  const report = await validateDogzillaWaypointsFromFiles({
    waypointFile,
    originFile,
    bridgeHealthUrl: 'http://dog.test/healthz',
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => String(url).endsWith('/healthz-lite')
        ? { ok: true, waypointReady: true, nav2Ready: true, canSendGoal: true, nav2Backend: 'docker-rclpy' }
        : health,
    }),
  })

  assert.equal(report.readyForMapWaypoints, true)
  assert.equal(report.navigation.ready, true)
  assert.equal(report.navigation.lifecycleActive, false)
  assert.deepEqual(report.blockers, [])
})
