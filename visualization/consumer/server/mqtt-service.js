import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';
import { COMMAND_TOPIC, SUBSCRIPTIONS, TOPICS } from './topics.js';
import { ackSchema, buildCommand, HttpError } from './schemas.js';

export class MqttService {
  #client = null;
  #pending = new Map();
  #ready = false;
  #stopping = false;

  constructor({ config, store, logger = console, connect = mqtt.connect }) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.connect = connect;
  }

  get connected() {
    return Boolean(this.#client?.connected && !this.#stopping);
  }

  get ready() {
    return this.connected && this.#ready;
  }

  start() {
    if (this.#client) return;
    this.#stopping = false;
    const config = this.config;
    this.#client = this.connect({
      protocol: config.MQTT_PROTOCOL,
      host: config.MQTT_HOST,
      port: config.MQTT_PORT,
      clientId: config.MQTT_CLIENT_ID || `consumer-express-${randomUUID().slice(0, 12)}`,
      ...(config.MQTT_USER ? { username: config.MQTT_USER, password: config.MQTT_PASS } : {}),
      clean: true,
      keepalive: 60,
      connectTimeout: 10000,
      reconnectPeriod: 3000,
      // Re-subscribe explicitly on every connection, including reconnects.
      resubscribe: false,
      queueQoSZero: false,
    });

    this.#client.on('connect', () => {
      this.#ready = false;
      this.#client.subscribe(SUBSCRIPTIONS, { qos: 1 }, (error, granted) => {
        if (error || granted?.length !== SUBSCRIPTIONS.length
          || granted.some((subscription) => subscription.qos > 2)) {
          this.logger.error('MQTT subscription failed; reconnecting.');
          if (!this.#stopping) this.#client.reconnect();
          return;
        }
        this.#ready = true;
        this.logger.info('MQTT connected; telemetry subscriptions ready.');
      });
    });

    this.#client.on('message', (topic, bytes, packet) => {
      let payload;
      try {
        payload = JSON.parse(bytes.toString('utf8'));
      } catch {
        this.logger.warn(`Ignoring malformed JSON on ${topic}.`);
        return;
      }
      const normalized = this.store.record(topic, payload, Date.now(), { retained: Boolean(packet?.retain) });
      if (normalized && !normalized.valid) {
        this.logger.warn(`Schema mismatch on ${topic}; preserving payload for diagnostics.`);
      }
      // Never resolve a new command using a broker-retained ACK or an invalid payload.
      if (topic === TOPICS.command && !packet?.retain && ackSchema.safeParse(payload).success) {
        this.#pending.get(payload.request_id)?.acknowledge(payload);
      }
    });

    this.#client.on('close', () => {
      this.#ready = false;
      for (const pending of this.#pending.values()) {
        pending.fail(new HttpError(503, 'MQTT disconnected while waiting; command delivery is unconfirmed'));
      }
    });
    this.#client.on('error', (error) => {
      this.logger.warn(`MQTT connection error (${error.code || 'connection failed'}); retrying automatically.`);
    });
  }

  async sendCommand(body) {
    const payload = buildCommand(body);
    if (!this.ready) {
      throw new HttpError(503, 'MQTT broker is not connected or subscriptions are not ready; the command was not sent');
    }
    if (this.#pending.has(payload.request_id)) {
      throw new HttpError(409, 'A command with this request_id is already pending');
    }
    if (this.#pending.size >= 100) throw new HttpError(429, 'Too many pending commands; try again shortly');

    return new Promise((resolve, reject) => {
      let timer;
      let published = false;
      let earlyAck = null;
      let messageId = null;
      const finish = (error, ack = null) => {
        if (!this.#pending.has(payload.request_id)) return;
        clearTimeout(timer);
        this.#pending.delete(payload.request_id);
        // Do not replay an unconfirmed QoS 1 packet unexpectedly after reconnect.
        if (error && !published && messageId != null) this.#client?.removeOutgoingMessage(messageId);
        if (error) return reject(error);
        resolve({
          request_id: payload.request_id,
          sent: payload,
          ack,
          ...(!ack ? { detail: `No ACK received within ${this.config.COMMAND_ACK_TIMEOUT} s; the transmitter may be offline.` } : {}),
        });
      };
      // Install the listener before publishing: firmware can ACK before PUBACK arrives.
      this.#pending.set(payload.request_id, {
        acknowledge: (ack) => {
          if (published) finish(null, ack);
          else earlyAck = ack;
        },
        fail: (error) => finish(error),
      });
      timer = setTimeout(() => finish(new HttpError(502,
        'MQTT publish was not confirmed; command delivery is unknown')),
      this.config.COMMAND_PUBLISH_TIMEOUT * 1000);
      try {
        this.#client.publish(COMMAND_TOPIC, JSON.stringify(payload), { qos: 1, retain: false }, (error) => {
          if (!this.#pending.has(payload.request_id)) return;
          if (error) return finish(new HttpError(502, 'Failed to publish the command'));
          published = true;
          clearTimeout(timer);
          if (earlyAck) return finish(null, earlyAck);
          timer = setTimeout(() => finish(null), this.config.COMMAND_ACK_TIMEOUT * 1000);
        });
        messageId = this.#client.getLastMessageId?.() ?? null;
      } catch {
        finish(new HttpError(502, 'Failed to publish the command'));
      }
    });
  }

  async stop() {
    this.#stopping = true;
    this.#ready = false;
    for (const pending of this.#pending.values()) {
      pending.fail(new HttpError(503, 'Service is shutting down; command delivery is unconfirmed'));
    }
    if (this.#client) {
      await new Promise((resolve) => this.#client.end(true, {}, resolve));
      this.#client = null;
    }
  }
}
