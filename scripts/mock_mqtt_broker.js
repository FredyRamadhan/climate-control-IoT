#!/usr/bin/env node
/**
 * Lightweight in-memory MQTT 3.1.1 broker for integration testing and local dev.
 * Uses mqtt-packet from visualization/consumer/node_modules.
 */
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const currentDir = dirname(fileURLToPath(import.meta.url));
const consumerDir = resolve(currentDir, '../visualization/consumer');
const mqttPacket = await import(resolve(consumerDir, 'node_modules/mqtt-packet/mqtt.js')).then(m => m.default || m);

const PORT = parseInt(process.env.MQTT_PORT || process.argv[2] || '18883', 10);
const HOST = process.env.MQTT_HOST || '127.0.0.1';
const EXPECTED_USER = process.env.MQTT_USER || 'iot_user';
const EXPECTED_PASS = process.env.MQTT_PASS || 'iot_password';
const ENFORCE_AUTH = process.env.MQTT_ENFORCE_AUTH === '1';

const clients = new Set();
const subscriptions = new Map(); // socket -> Set of topics
const retainedMessages = new Map(); // topic -> { packet }
let messageCounter = 1;

function topicMatches(sub, topic) {
  if (sub === '#' || sub === topic) return true;
  const subParts = sub.split('/');
  const topicParts = topic.split('/');
  for (let i = 0; i < subParts.length; i++) {
    if (subParts[i] === '#') return true;
    if (subParts[i] === '+') {
      if (i >= topicParts.length) return false;
      continue;
    }
    if (subParts[i] !== topicParts[i]) return false;
  }
  return subParts.length === topicParts.length;
}

const server = createServer((socket) => {
  clients.add(socket);
  subscriptions.set(socket, new Set());

  const parser = mqttPacket.parser();
  const send = (packet) => {
    try {
      if (!socket.destroyed) socket.write(mqttPacket.generate(packet));
    } catch (err) {
      // client disconnected
    }
  };

  socket.on('data', (bytes) => {
    try {
      parser.parse(bytes);
    } catch (err) {
      socket.destroy();
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
    subscriptions.delete(socket);
  });

  socket.on('error', () => {
    clients.delete(socket);
    subscriptions.delete(socket);
  });

  parser.on('packet', (packet) => {
    switch (packet.cmd) {
      case 'connect': {
        if (ENFORCE_AUTH) {
          const u = packet.username;
          const p = packet.password ? packet.password.toString() : '';
          if (u !== EXPECTED_USER || p !== EXPECTED_PASS) {
            send({ cmd: 'connack', returnCode: 5, sessionPresent: false });
            socket.end();
            return;
          }
        }
        send({ cmd: 'connack', returnCode: 0, sessionPresent: false });
        break;
      }

      case 'subscribe': {
        const subs = subscriptions.get(socket);
        const granted = [];
        for (const sub of packet.subscriptions) {
          subs.add(sub.topic);
          granted.push(sub.qos || 1);
        }
        send({ cmd: 'suback', messageId: packet.messageId, granted });

        // Deliver retained messages that match new subscriptions
        for (const sub of packet.subscriptions) {
          for (const [topic, retained] of retainedMessages.entries()) {
            if (topicMatches(sub.topic, topic)) {
              send({
                cmd: 'publish',
                topic: retained.topic,
                payload: retained.payload,
                qos: 0,
                retain: true,
              });
            }
          }
        }
        break;
      }

      case 'publish': {
        if (packet.retain) {
          if (packet.payload.length === 0) {
            retainedMessages.delete(packet.topic);
          } else {
            retainedMessages.set(packet.topic, {
              topic: packet.topic,
              payload: packet.payload,
            });
          }
        }

        if (packet.qos === 1) {
          send({ cmd: 'puback', messageId: packet.messageId });
        }

        // Fan out to matching subscribers
        const msgId = ++messageCounter;
        for (const [otherSocket, subs] of subscriptions.entries()) {
          for (const sub of subs) {
            if (topicMatches(sub, packet.topic)) {
              try {
                if (!otherSocket.destroyed) {
                  otherSocket.write(mqttPacket.generate({
                    cmd: 'publish',
                    topic: packet.topic,
                    payload: packet.payload,
                    qos: 0,
                    retain: false,
                  }));
                }
              } catch (_) {}
              break;
            }
          }
        }
        break;
      }

      case 'pingreq':
        send({ cmd: 'pingresp' });
        break;

      case 'disconnect':
        socket.end();
        break;
    }
  });
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  console.log(`MOCK_BROKER_READY host=${addr.address} port=${addr.port}`);
});
