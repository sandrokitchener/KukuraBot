import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import test from 'node:test'

import {
  openDogzillaCameraControlSession,
  probeDogzillaCameraStream,
  readDogzillaCameraSnapshot,
} from '../lib/dogzilla-camera-proxy.mjs'

test('probeDogzillaCameraStream reports reachable camera TCP without opening the stream', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=frame',
    })
    response.write('--frame\r\nContent-Type: image/jpeg\r\n\r\n')
  })

  await listen(server)

  try {
    const streamUrl = `http://127.0.0.1:${server.address().port}/video_feed`
    const status = await probeDogzillaCameraStream(
      {
        camera: {
          label: 'Test camera',
          streamUrl,
        },
      },
      {
        tcpTimeoutMs: 500,
        httpTimeoutMs: 500,
      },
    )

    assert.equal(status.status, 'ok')
    assert.equal(status.ok, true)
    assert.equal(status.tcp.status, 'ok')
    assert.equal(status.http.status, 'skipped')
    assert.match(status.detail, /Stream not opened/)
  } finally {
    await close(server)
  }
})

test('readDogzillaCameraSnapshot extracts one JPEG while the control session is active', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9])
  let controlActive = false
  const controlServer = net.createServer((socket) => {
    controlActive = true
    socket.on('data', () => {})
    socket.on('close', () => {
      controlActive = false
    })
  })
  const streamServer = createServer((request, response) => {
    if (!controlActive) {
      return
    }

    response.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=frame',
    })
    response.write(Buffer.concat([
      Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n', 'utf-8'),
      jpeg,
      Buffer.from('\r\n', 'utf-8'),
    ]))
  })

  await listen(controlServer)
  await listen(streamServer)

  try {
    const snapshot = await readDogzillaCameraSnapshot(
      {
        camera: {
          streamUrl: `http://127.0.0.1:${streamServer.address().port}/video_feed`,
          controlPort: controlServer.address().port,
          wakeCommand: '$010F040115#',
        },
      },
      {
        controlConnectTimeoutMs: 500,
        snapshotTimeoutMs: 500,
      },
    )

    assert.equal(snapshot.status, 'ok')
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.contentType, 'image/jpeg')
    assert.deepEqual(snapshot.jpeg, jpeg)
  } finally {
    await close(streamServer)
    await close(controlServer)
  }
})

test('probeDogzillaCameraStream does not open HTTP while checking camera availability', async () => {
  let receivedData = false
  const server = net.createServer((socket) => {
    socket.on('data', () => {
      receivedData = true
    })
  })

  await listen(server)

  try {
    const streamUrl = `http://127.0.0.1:${server.address().port}/video_feed`
    const status = await probeDogzillaCameraStream(
      {
        camera: {
          streamUrl,
        },
      },
      {
        tcpTimeoutMs: 500,
        httpTimeoutMs: 100,
      },
    )

    assert.equal(status.status, 'ok')
    assert.equal(status.ok, true)
    assert.equal(status.tcp.status, 'ok')
    assert.equal(status.http.status, 'skipped')
    assert.equal(receivedData, false)
    assert.match(status.detail, /Stream not opened/)
  } finally {
    await close(server)
  }
})

test('readDogzillaCameraSnapshot fails loudly when configured control wake fails', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=frame',
    })
    response.write('--frame\r\nContent-Type: image/jpeg\r\n\r\n')
  })
  const unusedControlPort = await getUnusedPort()

  await listen(server)

  try {
    const streamUrl = `http://127.0.0.1:${server.address().port}/video_feed`
    const status = await readDogzillaCameraSnapshot(
      {
        camera: {
          streamUrl,
          controlPort: unusedControlPort,
          wakeCommand: '$010F040115#',
        },
      },
      {
        tcpTimeoutMs: 500,
        controlConnectTimeoutMs: 100,
        httpTimeoutMs: 500,
      },
    )

    assert.equal(status.status, 'error')
    assert.equal(status.ok, false)
    assert.equal(status.statusCode, 502)
    assert.match(status.error, /Camera control TCP|ECONNREFUSED|connect/)
  } finally {
    await close(server)
  }
})

test('openDogzillaCameraControlSession sends the Standard-mode wake command', async () => {
  let received = ''
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      received += chunk.toString('utf-8')
    })
  })

  await listen(server)

  try {
    const session = await openDogzillaCameraControlSession(
      {
        streamUrl: 'http://127.0.0.1:6500/video_feed',
        controlPort: server.address().port,
      },
      {
        controlConnectTimeoutMs: 500,
      },
    )

    await new Promise((resolve) => setTimeout(resolve, 25))
    session.destroy()

    assert.equal(received, '$010F040115#')
  } finally {
    await close(server)
  }
})

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
}

async function close(server) {
  server.close()
  await once(server, 'close')
}

async function getUnusedPort() {
  const server = net.createServer()
  await listen(server)
  const port = server.address().port
  await close(server)
  return port
}
