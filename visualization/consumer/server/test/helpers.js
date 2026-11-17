import { EventEmitter } from 'node:events';
import { readConfig } from '../config.js';
import { TelemetryStore } from '../store.js';
import { MqttService } from '../mqtt-service.js';
import { SUBSCRIPTIONS, TOPICS } from '../topics.js';

export const telemetry = {
  motion: true, temp: 26.4, hum: 58, timestamp: 1794916800,
  fan_speed: 'medium', relay_on: true, target_temp: 24,
  sensor_ok: true, ir_sent: true, uptime_ms: 7200000, override: false,
};

export const quiet = { info() {}, warn() {}, error() {} };

export function ack(requestId, extra = {}) {
  return {
    ok: true, override: true, raw_only: false, timestamp: 1794916801,
    request_id: requestId, ...extra,
  };
}

export class TestClient extends EventEmitter {
  connected = true;
  publications = [];
  subscriptions = [];
  removedMessages = [];
  onPublish = (_payload, callback) => callback();

  subscribe(topics, options, callback) {
    this.subscriptions.push({ topics, options });
    callback(null, topics.map((topic) => ({ topic, qos: 1 })));
  }

  publish(topic, bytes, options, callback) {
    const payload = JSON.parse(bytes);
    this.publications.push({ topic, payload, options });
    this.onPublish(payload, callback);
  }

  end(_force, _options, callback) { callback(); }

  getLastMessageId() { return this.publications.length; }

  removeOutgoingMessage(messageId) { this.removedMessages.push(messageId); }

  message(topic, payload, { retain = false } = {}) {
    this.emit('message', topic, Buffer.from(JSON.stringify(payload)), { retain });
  }

  acknowledge(requestId, extra = {}, packet = {}) {
    this.message(TOPICS.command, ack(requestId, extra), packet);
  }
}

export function serviceFixture(overrides = {}) {
  const config = readConfig({ COMMAND_ACK_TIMEOUT: 0.1, COMMAND_PUBLISH_TIMEOUT: 0.1, ...overrides });
  const store = new TelemetryStore();
  const client = new TestClient();
  const service = new MqttService({ config, store, logger: quiet, connect: () => client });
  service.start();
  client.emit('connect');
  return { config, store, client, service };
}

export function assertSubscriptions(assert, client) {
  assert.deepEqual(client.subscriptions.at(-1), { topics: SUBSCRIPTIONS, options: { qos: 1 } });
}
