import assert from 'node:assert/strict'
import test from 'node:test'
import { RosbridgeClient } from '../lib/rosbridge-client.mjs'

test('RosbridgeClient defaults avoid streaming occupancy grids', () => {
  const client = new RosbridgeClient()
  const topics = client.topics.map((sub) => sub.topic)

  assert.deepEqual(topics, ['/scan', '/tf', '/tf_static', '/odom'])
  assert.equal(client.topics.find((sub) => sub.topic === '/scan')?.throttle_rate, 250)
  assert.equal(client.topics.find((sub) => sub.topic === '/scan')?.queue_length, 1)
})

test('RosbridgeClient forwards rosbridge throttle and queue options', () => {
  const client = new RosbridgeClient()
  const sent = []
  client.ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      sent.push(JSON.parse(payload))
    },
  }

  client.sendSubscribe({
    topic: '/scan',
    type: 'sensor_msgs/LaserScan',
    throttle_rate: 250,
    queue_length: 1,
  })

  assert.deepEqual(sent, [
    {
      op: 'subscribe',
      topic: '/scan',
      type: 'sensor_msgs/LaserScan',
      throttle_rate: 250,
      queue_length: 1,
    },
  ])
  assert.equal(client.subscriptions.get('/scan')?.throttle_rate, 250)
  assert.equal(client.subscriptions.get('/scan')?.queue_length, 1)
})
