import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import mqttPacket from 'mqtt-packet';
import { readConfig } from '../config.js';
import { TelemetryStore } from '../store.js';
import { MqttService } from '../mqtt-service.js';
import { COMMAND_TOPIC, SUBSCRIPTIONS, TOPICS } from '../topics.js';
import { ack, quiet, telemetry } from './helpers.js';
import { test } from 'node:test';

test('real MQTT socket consumes telemetry, publishes QoS 1 commands, and correlates device ACKs', async (t) => {
  const sockets = new Set();
  let subscribed = [];
  let published;
  let credentials;
  const broker = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const parser = mqttPacket.parser();
    const send = (packet) => socket.write(mqttPacket.generate(packet));
    socket.on('data', (bytes) => parser.parse(bytes));
    parser.on('packet', (packet) => {
      if (packet.cmd === 'connect') {
        credentials = { username: packet.username, password: packet.password.toString() };
        send({ cmd: 'connack', returnCode: 0, sessionPresent: false });
      } else if (packet.cmd === 'subscribe') {
        subscribed = packet.subscriptions;
        send({ cmd: 'suback', messageId: packet.messageId, granted: subscribed.map(() => 1) });
        send({ cmd: 'publish', topic: TOPICS.transmit, payload: JSON.stringify(telemetry), qos: 1, messageId: 41 });
      } else if (packet.cmd === 'publish') {
        published = packet;
        if (packet.qos === 1) send({ cmd: 'puback', messageId: packet.messageId });
        const command = JSON.parse(packet.payload.toString());
        send({ cmd: 'publish', topic: TOPICS.command, payload: JSON.stringify(ack('other-request')), qos: 0 });
        send({ cmd: 'publish', topic: TOPICS.command, payload: JSON.stringify(ack(command.request_id)), qos: 1, messageId: 42 });
      } else if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
      else if (packet.cmd === 'disconnect') socket.end();
    });
  });
  broker.listen(0, '127.0.0.1');
  await once(broker, 'listening');
  const config = readConfig({ MQTT_HOST: '127.0.0.1', MQTT_PORT: broker.address().port });
  const store = new TelemetryStore();
  const service = new MqttService({ config, store, logger: quiet });
  t.after(async () => {
    await service.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => broker.close(resolve));
  });
  service.start();
  const deadline = Date.now() + 3000;
  while ((!service.ready || !store.has(TOPICS.transmit)) && Date.now() < deadline) await delay(10);
  assert.equal(service.ready, true);
  assert.deepEqual(subscribed.map(({ topic }) => topic), SUBSCRIPTIONS);
  assert.ok(subscribed.every(({ qos }) => qos === 1));
  assert.deepEqual(credentials, { username: 'iot_user', password: 'iot_password' });
  assert.equal(store.latest(TOPICS.transmit).temp, 26.4);
  const result = await service.sendCommand({ action: 'override', target_temp: 23, request_id: 'wire-test' });
  assert.equal(published.topic, COMMAND_TOPIC);
  assert.equal(published.qos, 1);
  assert.equal(published.retain, false);
  assert.equal(result.ack.request_id, 'wire-test');
  assert.equal(result.ack.ok, true);
});
