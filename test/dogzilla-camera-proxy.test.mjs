import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import test from 'node:test'

import {
  openDogzillaCameraControlSession,
  probeDogzillaCameraStream,
} from '../lib/dogzilla-camera-proxy.mjs'

test('probeDogzillaCameraStream reports responding MJPEG headers', async () => {
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
    assert.equal(status.http.status, 'ok')
    assert.match(status.http.contentType, /multipart\/x-mixed-replace/)
  } finally {
    await close(server)
  }
})

test('probeDogzillaCameraStream distinguishes reachable TCP from stuck HTTP', async () => {
  const server = net.createServer((socket) => {
    socket.on('data', () => {})
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

    assert.equal(status.status, 'warn')
    assert.equal(status.ok, false)
    assert.equal(status.tcp.status, 'ok')
    assert.equal(status.http.status, 'timeout')
    assert.match(status.detail, /TCP port is reachable/)
  } finally {
    await close(server)
  }
})

test('probeDogzillaCameraStream fails loudly when configured control wake fails', async () => {
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
    const status = await probeDogzillaCameraStream(
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
    assert.equal(status.tcp.status, 'ok')
    assert.equal(status.control.status, 'error')
    assert.equal(status.http.status, 'skipped')
    assert.match(status.detail, /Camera control wake failed/)
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
