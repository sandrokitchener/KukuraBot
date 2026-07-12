import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDogzillaActionPlan,
  ensureDogzillaRobotIdentity,
  normalizeDogzillaConnectionConfig,
  runDogzillaConnectionAction,
  saveDogzillaRobotName,
} from '../lib/dogzilla-connection-center.mjs'

test('normalizeDogzillaConnectionConfig fills stock DOGZILLA SSH defaults', () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
    },
  })

  assert.equal(config.ssh.host, '192.168.8.88')
  assert.equal(config.ssh.user, 'pi')
  assert.equal(config.ssh.port, 22)
  assert.equal(config.ssh.alias, 'dogzilla')
  assert.equal(config.bridges.direct.baseUrl, 'http://192.168.8.88:8893')
  assert.equal(config.bridges.ros2.baseUrl, 'http://192.168.8.88:8892')
  assert.equal(config.camera.streamUrl, 'http://192.168.8.88:6500/video_feed')
  assert.equal(config.camera.proxyStreamPath, '/api/dogzilla/camera/stream')
  assert.equal(config.camera.proxySnapshotPath, '/api/dogzilla/camera/snapshot')
  assert.equal(config.camera.proxyStatusPath, '/api/dogzilla/camera/status')
  assert.equal(config.camera.controlPort, 6000)
  assert.equal(config.camera.wakeCommand, '$010F040115#')
  assert.equal(config.vision.enabled, false)
  assert.equal(config.vision.detectionEnabled, false)
  assert.equal(config.vision.streamUrl, 'http://192.168.8.88:8894/stream.mjpg')
  assert.equal(config.audio.enabled, false)
  assert.equal(config.audio.cueUrl, 'http://192.168.8.88:8895/cue')
  assert.equal(config.audio.volumeUrl, 'http://192.168.8.88:8895/volume')
  assert.equal(config.audio.healthUrl, 'http://192.168.8.88:8895/healthz')
  assert.equal(config.lidar.enabled, false)
  assert.equal(config.lidar.serialPort, '/dev/ttyAMA1')
  assert.equal(config.lidar.transport, 'rosbridge')
  assert.equal(config.lidar.rosbridgeUrl, 'ws://192.168.8.88:9090')
  assert.equal(config.lidar.proxyScanPath, '/api/dogzilla/lidar/scan')
  assert.equal(config.lidar.proxyPosePath, '/api/dogzilla/pose')
})

test('normalizeDogzillaConnectionConfig routes camera view through YOLO when vision is enabled', () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
    },
    vision: {
      enabled: true,
    },
  })

  assert.equal(config.vision.enabled, true)
  assert.equal(config.vision.statusUrl, 'http://192.168.8.88:8894/healthz')
  assert.equal(config.vision.streamUrl, 'http://192.168.8.88:8894/stream.mjpg')
  assert.equal(config.vision.sourceStreamUrl, 'http://192.168.8.88:6500/video_feed')
  assert.equal(config.camera.processed, true)
  assert.equal(config.camera.streamUrl, 'http://192.168.8.88:8894/stream.mjpg')
  assert.equal(config.camera.sourceStreamUrl, 'http://192.168.8.88:6500/video_feed')
  assert.equal(config.camera.statusUrl, 'http://192.168.8.88:8894/healthz')
  assert.equal(config.camera.proxySnapshotPath, '/api/dogzilla/camera/snapshot')
  assert.equal(config.camera.controlPort, undefined)
  assert.equal(config.camera.wakeCommand, undefined)
})

test('buildDogzillaActionPlan allowlists start-direct background bridge script', () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
      user: 'pi',
      alias: 'dogzilla',
    },
    remoteRoot: '/home/pi/robodoge',
  })
  const plan = buildDogzillaActionPlan('start-direct', config)

  assert.equal(plan.action, 'start-direct')
  assert.equal(plan.background, false)
  assert.ok(plan.args.includes('start-dogzilla-bridge-ssh.ps1') || plan.args.some((arg) => arg.endsWith('start-dogzilla-bridge-ssh.ps1')))
  assert.ok(plan.args.includes('-Background'))
  assert.ok(plan.args.includes('-Bridge'))
  assert.ok(plan.args.includes('direct'))
  assert.equal(plan.timeoutMs, 150_000)
})

test('buildDogzillaActionPlan starts YOLO, audio, and lidar support services independently', () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
      user: 'pi',
      alias: 'dogzilla',
    },
    remoteRoot: '/home/pi/robodoge',
    audio: {
      enabled: true,
      port: 8895,
    },
    lidar: {
      enabled: true,
      rosbridgePort: 9090,
    },
  })

  const audioPlan = buildDogzillaActionPlan('start-audio', config)
  const yoloPlan = buildDogzillaActionPlan('start-yolo', normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
      user: 'pi',
      alias: 'dogzilla',
    },
    remoteRoot: '/home/pi/robodoge',
    vision: {
      enabled: true,
      port: 8894,
      sourceStreamUrl: '/dev/video0',
    },
  }))
  const lidarPlan = buildDogzillaActionPlan('start-lidar', config)

  assert.ok(audioPlan.args.some((arg) => arg.endsWith('start-dogzilla-audio-cue-ssh.ps1')))
  assert.ok(audioPlan.args.includes('-SshPort'))
  assert.equal(audioPlan.args[audioPlan.args.indexOf('-SshPort') + 1], '22')
  assert.ok(audioPlan.args.includes('-Port'))
  assert.ok(audioPlan.args.includes('8895'))
  assert.ok(audioPlan.args.includes('-Background'))
  assert.ok(audioPlan.args.includes('-DefaultVolume'))
  assert.equal(audioPlan.args[audioPlan.args.indexOf('-DefaultVolume') + 1], '0.75')
  assert.ok(yoloPlan.args.some((arg) => arg.endsWith('start-dogzilla-yolo-vision-ssh.ps1')))
  assert.ok(yoloPlan.args.includes('-SshPort'))
  assert.equal(yoloPlan.args[yoloPlan.args.indexOf('-SshPort') + 1], '22')
  assert.ok(yoloPlan.args.includes('-Port'))
  assert.equal(yoloPlan.args[yoloPlan.args.indexOf('-Port') + 1], '8894')
  assert.ok(yoloPlan.args.includes('-CameraUrl'))
  assert.equal(yoloPlan.args[yoloPlan.args.indexOf('-CameraUrl') + 1], '/dev/video0')
  assert.ok(yoloPlan.args.includes('-Background'))
  assert.equal(yoloPlan.args.includes('-DetectionEnabled'), false)
  assert.equal(yoloPlan.args.includes('-ModelPath'), false)

  const yoloDetectionPlan = buildDogzillaActionPlan('start-yolo', normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
      user: 'pi',
      alias: 'dogzilla',
    },
    remoteRoot: '/home/pi/robodoge',
    vision: {
      enabled: true,
      detectionEnabled: true,
      port: 8894,
      sourceStreamUrl: '/dev/video0',
    },
  }))
  assert.ok(yoloDetectionPlan.args.includes('-DetectionEnabled'))
  assert.ok(lidarPlan.args.some((arg) => arg.endsWith('start-dogzilla-rosbridge-ssh.ps1')))
  assert.ok(lidarPlan.args.includes('-SshPort'))
  assert.equal(lidarPlan.args[lidarPlan.args.indexOf('-SshPort') + 1], '22')
  assert.ok(lidarPlan.args.includes('-Port'))
  assert.ok(lidarPlan.args.includes('9090'))
  assert.ok(lidarPlan.args.includes('-SerialPort'))
  assert.equal(lidarPlan.args[lidarPlan.args.indexOf('-SerialPort') + 1], '/dev/ttyAMA1')
  assert.ok(lidarPlan.args.includes('-Background'))
})

test('buildDogzillaActionPlan starts map pose localization through the lidar container', () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
      user: 'pi',
      alias: 'dogzilla',
    },
    remoteRoot: '/home/pi/robodoge',
    lidar: {
      enabled: true,
      rosbridgePort: 9090,
    },
  })
  const plan = buildDogzillaActionPlan('start-map-pose', config)

  assert.equal(plan.action, 'start-map-pose')
  assert.equal(plan.background, false)
  assert.ok(plan.args.some((arg) => arg.endsWith('start-dogzilla-map-pose-ssh.ps1')))
  assert.ok(plan.args.includes('-SshPort'))
  assert.equal(plan.args[plan.args.indexOf('-SshPort') + 1], '22')
  assert.ok(plan.args.includes('-RemoteRoot'))
  assert.equal(plan.args[plan.args.indexOf('-RemoteRoot') + 1], '/home/pi/robodoge')
  assert.ok(plan.args.includes('-PosePort'))
  assert.equal(plan.args[plan.args.indexOf('-PosePort') + 1], '9090')
  assert.ok(plan.args.includes('-Mode'))
  assert.equal(plan.args[plan.args.indexOf('-Mode') + 1], 'auto')
})

test('buildDogzillaActionPlan starts waypoint navigation through the lidar container', () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
      user: 'pi',
      alias: 'dogzilla',
    },
    remoteRoot: '/home/pi/robodoge',
    lidar: {
      enabled: true,
      rosbridgePort: 9090,
    },
  })
  const plan = buildDogzillaActionPlan('start-navigation', config)

  assert.equal(plan.action, 'start-navigation')
  assert.equal(plan.background, false)
  assert.ok(plan.args.some((arg) => arg.endsWith('start-dogzilla-navigation-ssh.ps1')))
  assert.ok(plan.args.includes('-RemoteRoot'))
  assert.equal(plan.args[plan.args.indexOf('-RemoteRoot') + 1], '/home/pi/robodoge')
  assert.ok(plan.args.includes('-PosePort'))
  assert.equal(plan.args[plan.args.indexOf('-PosePort') + 1], '9090')
})

test('buildDogzillaActionPlan passes Nav2 yaw goal tolerance to navigation startup', () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
      user: 'pi',
      alias: 'dogzilla',
    },
    remoteRoot: '/home/pi/robodoge',
    lidar: {
      enabled: true,
      rosbridgePort: 9090,
    },
  })
  const plan = buildDogzillaActionPlan('start-navigation', config, {
    obstacleAvoidance: {
      nav2RobotRadius: 0.1,
      nav2FootprintPadding: 0.01,
      nav2InflationRadius: 0.16,
      nav2CostScalingFactor: 10,
      nav2ObstacleMinRange: 0.24,
      nav2ObstacleMaxRange: 2.5,
      nav2RaytraceMaxRange: 3.5,
      nav2ScanFilterEnabled: true,
      nav2ScanFilterMaskStartDeg: 120,
      nav2ScanFilterMaskEndDeg: 260,
      nav2ScanFilterMaskRangeM: 0.45,
      yawGoalTolerance: 6.283185307179586,
      nav2ControllerFrequency: 5,
      nav2BtLoopDurationMs: 200,
      nav2BtServerTimeoutMs: 10000,
      nav2BtWaitForServiceTimeoutMs: 5000,
      nav2PlannerFrequency: 1,
      nav2SmootherFrequency: 5,
      nav2RequiredMovementRadius: 0.08,
      nav2MovementTimeAllowance: 45,
      nav2FailureTolerance: 5,
      nav2MinSpeedXy: 0.03,
      nav2TransStoppedVelocity: 0.05,
    },
  })

  assert.ok(plan.args.includes('-YawGoalTolerance'))
  assert.equal(plan.args[plan.args.indexOf('-YawGoalTolerance') + 1], '6.283185307179586')
  assert.ok(plan.args.includes('-Nav2ObstacleMinRange'))
  assert.equal(plan.args[plan.args.indexOf('-Nav2ObstacleMinRange') + 1], '0.24')
  assert.ok(plan.args.includes('-Nav2ScanFilterEnabled'))
  assert.equal(plan.args[plan.args.indexOf('-Nav2ScanFilterEnabled') + 1], '1')
  assert.ok(plan.args.includes('-Nav2ScanFilterMaskRangeM'))
  assert.equal(plan.args[plan.args.indexOf('-Nav2ScanFilterMaskRangeM') + 1], '0.45')
  assert.ok(plan.args.includes('-Nav2BtServerTimeoutMs'))
  assert.equal(plan.args[plan.args.indexOf('-Nav2BtServerTimeoutMs') + 1], '10000')
  assert.ok(plan.args.includes('-Nav2RequiredMovementRadius'))
  assert.equal(plan.args[plan.args.indexOf('-Nav2RequiredMovementRadius') + 1], '0.08')
  assert.ok(plan.args.includes('-Nav2TransStoppedVelocity'))
  assert.equal(plan.args[plan.args.indexOf('-Nav2TransStoppedVelocity') + 1], '0.05')
})

test('buildDogzillaActionPlan exposes explicit map mapping and save actions', () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
      user: 'pi',
      alias: 'dogzilla',
    },
    remoteRoot: '/home/pi/robodoge',
    lidar: {
      enabled: true,
      rosbridgePort: 9090,
    },
  })
  const mappingPlan = buildDogzillaActionPlan('start-map-pose-mapping', config)
  const savePlan = buildDogzillaActionPlan('save-map-pose', config)

  assert.equal(mappingPlan.action, 'start-map-pose-mapping')
  assert.ok(mappingPlan.args.some((arg) => arg.endsWith('start-dogzilla-map-pose-ssh.ps1')))
  assert.equal(mappingPlan.args[mappingPlan.args.indexOf('-Mode') + 1], 'mapping')
  assert.ok(mappingPlan.args.includes('-ForceRestart'))
  assert.equal(savePlan.action, 'save-map-pose')
  assert.ok(savePlan.args.some((arg) => arg.endsWith('save-dogzilla-map-pose-ssh.ps1')))
})

test('buildDogzillaActionPlan keeps autonomous mapping and candidate promotion explicit', () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: { host: '192.168.8.88', user: 'pi', alias: 'dogzilla' },
    remoteRoot: '/home/pi/robodoge',
    lidar: { enabled: true, rosbridgePort: 9090 },
  })
  const startPlan = buildDogzillaActionPlan('start-autonomous-mapping', config)
  const continuePlan = buildDogzillaActionPlan('continue-autonomous-mapping', config)
  const finishPlan = buildDogzillaActionPlan('finish-autonomous-mapping', config)
  const promotePlan = buildDogzillaActionPlan('promote-map-candidate', config)

  assert.ok(startPlan.args.some((arg) => arg.endsWith('start-dogzilla-autonomous-mapping-ssh.ps1')))
  assert.ok(continuePlan.args.some((arg) => arg.endsWith('start-dogzilla-autonomous-mapping-ssh.ps1')))
  assert.ok(continuePlan.args.includes('-ContinueCurrentMap'))
  assert.ok(finishPlan.args.some((arg) => arg.endsWith('finish-dogzilla-autonomous-mapping-ssh.ps1')))
  assert.ok(promotePlan.args.some((arg) => arg.endsWith('promote-dogzilla-map-candidate-ssh.ps1')))
  assert.equal(startPlan.timeoutMs, 240_000)
  assert.equal(finishPlan.timeoutMs, 240_000)
})

test('connection actions do not gate the requested script on a second identity SSH command', async () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: { host: '192.168.8.88', user: 'pi', alias: 'dogzilla' },
    remoteRoot: '/home/pi/robodoge',
    lidar: { enabled: true, rosbridgePort: 9090 },
  })
  const calls = []

  const result = await runDogzillaConnectionAction('start-autonomous-mapping', {
    config,
    noSync: true,
    obstacleAvoidance: {},
    execFilePromiseImpl: async (command, args) => {
      calls.push({ command, args })
      return { exitCode: 0, stdout: 'started', stderr: '' }
    },
  })

  assert.equal(result.status, 'ok')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].args.some((arg) => arg.endsWith('start-dogzilla-autonomous-mapping-ssh.ps1')))
  assert.ok(!calls[0].args.some((arg) => arg.endsWith('dogzilla-ssh.ps1')))
})

test('buildDogzillaActionPlan stops the vendor DOGZILLA app before direct control', () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
      user: 'pi',
      alias: 'dogzilla',
    },
    remoteRoot: '/home/pi/robodoge',
  })
  const plan = buildDogzillaActionPlan('stop-vendor-app', config)

  assert.equal(plan.action, 'stop-vendor-app')
  assert.equal(plan.background, false)
  assert.ok(plan.args.some((arg) => arg.endsWith('stop-dogzilla-vendor-app-ssh.ps1')))
  assert.ok(plan.args.includes('-SshPort'))
  assert.equal(plan.args[plan.args.indexOf('-SshPort') + 1], '22')
  assert.ok(plan.args.includes('-RemoteRoot'))
  assert.equal(plan.args[plan.args.indexOf('-RemoteRoot') + 1], '/home/pi/robodoge')
})

test('ensureDogzillaRobotIdentity creates missing Pi identity files and saves runtime identity', async () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
      user: 'pi',
      alias: 'dogzilla',
    },
    remoteRoot: '/home/pi/robodoge',
  })
  let remoteCommand = ''
  let savedIdentity = null

  const identity = await ensureDogzillaRobotIdentity({
    config,
    generatedRobotId: '11111111-1111-4111-8111-111111111111',
    robotName: 'Questing Beast',
    execFilePromiseImpl: async (_command, args) => {
      remoteCommand = args[args.indexOf('-Command') + 1]
      return {
        exitCode: 0,
        stdout:
          'robot_id=11111111-1111-4111-8111-111111111111\n' +
          'robot_name=Questing Beast\n' +
          'robot_id_created=1\n' +
          'robot_name_created=1',
        stderr: '',
      }
    },
    saveRobotRuntimeIdentityImpl: async (value) => {
      savedIdentity = value
    },
  })

  assert.equal(identity.status, 'ok')
  assert.equal(identity.robot_id, '11111111-1111-4111-8111-111111111111')
  assert.equal(identity.robot_name, 'Questing Beast')
  assert.equal(identity.created, true)
  assert.match(remoteCommand, /robot_id\.txt/)
  assert.match(remoteCommand, /robot_name\.txt/)
  assert.match(remoteCommand, /umask 077; mkdir -p/)
  assert.deepEqual(savedIdentity, {
    robotId: '11111111-1111-4111-8111-111111111111',
    robotName: 'Questing Beast',
  })
})

test('buildDogzillaSshCommandPlan passes shell fragments as one PowerShell argument', async () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
      user: 'pi',
      alias: 'dogzilla',
    },
    remoteRoot: '/home/pi/robodoge',
  })
  let capturedArgs = []

  await ensureDogzillaRobotIdentity({
    config,
    generatedRobotId: '11111111-1111-4111-8111-111111111111',
    robotName: 'Questing Beast',
    execFilePromiseImpl: async (_command, args) => {
      capturedArgs = args
      return {
        exitCode: 0,
        stdout:
          'robot_id=11111111-1111-4111-8111-111111111111\n' +
          'robot_name=Questing Beast\n' +
          'robot_id_created=0\n' +
          'robot_name_created=0',
        stderr: '',
      }
    },
    saveRobotRuntimeIdentityImpl: async () => {},
  })

  const commandIndex = capturedArgs.indexOf('-Command')
  assert.notEqual(commandIndex, -1)
  assert.equal(typeof capturedArgs[commandIndex + 1], 'string')
  assert.match(capturedArgs[commandIndex + 1], /robot_id_created=0; if \[ ! -s/)
  assert.equal(capturedArgs.filter((arg) => arg === ';').length, 0)
})

test('saveDogzillaRobotName writes robot_name.txt and preserves robot_id.txt as source of truth', async () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
      user: 'pi',
      alias: 'dogzilla',
    },
    remoteRoot: '/home/pi/robodoge',
  })
  let remoteCommand = ''
  let savedIdentity = null

  const identity = await saveDogzillaRobotName('Shop Scout', {
    config,
    generatedRobotId: '22222222-2222-4222-8222-222222222222',
    execFilePromiseImpl: async (_command, args) => {
      remoteCommand = args[args.indexOf('-Command') + 1]
      return {
        exitCode: 0,
        stdout: 'robot_id=pi-existing-id\nrobot_name=Shop Scout',
        stderr: '',
      }
    },
    saveRobotRuntimeIdentityImpl: async (value) => {
      savedIdentity = value
    },
  })

  assert.equal(identity.robot_id, 'pi-existing-id')
  assert.equal(identity.robot_name, 'Shop Scout')
  assert.match(remoteCommand, /printf '%s\\n' 'Shop Scout' > '\/home\/pi\/robodoge\/robot_name\.txt'/)
  assert.match(remoteCommand, /if \[ ! -s '\/home\/pi\/robodoge\/robot_id\.txt' \]/)
  assert.deepEqual(savedIdentity, {
    robotId: 'pi-existing-id',
    robotName: 'Shop Scout',
  })
})

test('start-direct succeeds only after health proof', async () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: { host: '192.168.8.88', user: 'pi', alias: 'dogzilla' },
    remoteRoot: '/home/pi/robodoge',
  })

  const result = await runDogzillaConnectionAction('start-direct', {
    config,
    noSync: true,
    obstacleAvoidance: {},
    execFilePromiseImpl: async () => ({ exitCode: 0, stdout: 'started', stderr: '' }),
    directHealthProbeImpl: async () => ({ status: 'ok', body: { ok: true } }),
    directHealthTimeoutMs: 0,
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.health.status, 'ok')
})

test('start-direct reports failure when health proof never arrives', async () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: { host: '192.168.8.88', user: 'pi', alias: 'dogzilla' },
    remoteRoot: '/home/pi/robodoge',
  })

  const result = await runDogzillaConnectionAction('start-direct', {
    config,
    noSync: true,
    obstacleAvoidance: {},
    execFilePromiseImpl: async () => ({ exitCode: 0, stdout: 'started', stderr: '' }),
    directHealthProbeImpl: async () => ({ status: 'error', error: 'ECONNREFUSED' }),
    directHealthTimeoutMs: 0,
  })

  assert.equal(result.status, 'error')
  assert.equal(result.health.status, 'error')
  assert.match(result.error, /ECONNREFUSED/)
})
