import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDogzillaActionPlan,
  ensureDogzillaRobotIdentity,
  normalizeDogzillaConnectionConfig,
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
  assert.equal(config.vision.streamUrl, 'http://192.168.8.88:8894/stream.mjpg')
  assert.equal(config.audio.enabled, false)
  assert.equal(config.audio.cueUrl, 'http://192.168.8.88:8895/cue')
  assert.equal(config.lidar.enabled, false)
  assert.equal(config.lidar.serialPort, '/dev/ttyAMA1')
  assert.equal(config.lidar.scanUrl, 'http://192.168.8.88:8896/scan')
  assert.equal(config.lidar.poseUrl, 'http://192.168.8.88:8896/pose')
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
      port: 8896,
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
  assert.ok(yoloPlan.args.some((arg) => arg.endsWith('start-dogzilla-yolo-vision-ssh.ps1')))
  assert.ok(yoloPlan.args.includes('-SshPort'))
  assert.equal(yoloPlan.args[yoloPlan.args.indexOf('-SshPort') + 1], '22')
  assert.ok(yoloPlan.args.includes('-Port'))
  assert.equal(yoloPlan.args[yoloPlan.args.indexOf('-Port') + 1], '8894')
  assert.ok(yoloPlan.args.includes('-CameraUrl'))
  assert.equal(yoloPlan.args[yoloPlan.args.indexOf('-CameraUrl') + 1], '/dev/video0')
  assert.ok(yoloPlan.args.includes('-Background'))
  assert.equal(yoloPlan.args.includes('-ModelPath'), false)
  assert.ok(lidarPlan.args.some((arg) => arg.endsWith('start-dogzilla-lidar-ssh.ps1')))
  assert.ok(lidarPlan.args.includes('-SshPort'))
  assert.equal(lidarPlan.args[lidarPlan.args.indexOf('-SshPort') + 1], '22')
  assert.ok(lidarPlan.args.includes('-Port'))
  assert.ok(lidarPlan.args.includes('8896'))
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
      port: 8896,
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
  assert.equal(plan.args[plan.args.indexOf('-PosePort') + 1], '8896')
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
  assert.deepEqual(savedIdentity, {
    robotId: '11111111-1111-4111-8111-111111111111',
    robotName: 'Questing Beast',
  })
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
