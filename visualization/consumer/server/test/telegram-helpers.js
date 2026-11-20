import { readConfig } from '../config.js';
import { TelegramError } from '../telegram-client.js';
import { TelegramService } from '../telegram-service.js';
import { TelemetryStore } from '../store.js';
import { TOPICS } from '../topics.js';
import { telemetry } from './helpers.js';

// Deliberately fictional: tests never contact Telegram or load the user's .env.
export const BOT_TOKEN = '123456:abcdefghijklmnopqrstuvwxyz_test';
export const GROUP_ID = '-1001234567890';
export const EPOCH = Date.parse('2026-11-18T05:00:00Z');
export const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

export class FakeClock {
  time = EPOCH;
  events = new Map();
  nextId = 0;
  now = () => this.time;
  timers = {
    setTimeout: (callback, delay) => this.add(callback, delay, false),
    clearTimeout: (id) => this.events.delete(id),
    setInterval: (callback, delay) => this.add(callback, delay, true),
    clearInterval: (id) => this.events.delete(id),
  };

  add(callback, delay, repeat) {
    const id = ++this.nextId;
    this.events.set(id, { callback, delay, repeat, at: this.time + delay });
    return id;
  }

  async advance(milliseconds) {
    const target = this.time + milliseconds;
    await settle();
    for (;;) {
      const next = [...this.events.entries()].filter(([, event]) => event.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, event] = next;
      this.time = event.at;
      if (event.repeat) event.at += event.delay;
      else this.events.delete(id);
      event.callback();
      await settle();
    }
    this.time = target;
    await settle();
  }
}

export class FakeTelegram {
  calls = [];
  behavior = {};
  batches = [];
  pending = null;

  constructor(clock) { this.clock = clock; }
  requests(method) { return this.calls.filter((call) => call.method === method); }

  async call(method, body = {}, { signal } = {}) {
    this.calls.push({ method, body, signal, at: this.clock.now() });
    if (signal?.aborted) throw new TelegramError();
    if (this.behavior[method]) return this.behavior[method](body, signal);
    if (method === 'getMe') return { username: 'ClimateTestBot', can_read_all_group_messages: true };
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'sendMessage') return { message_id: 900 };
    if (method === 'getUpdates') {
      if (this.batches.length) return this.batches.shift();
      return new Promise((resolve, reject) => {
        const abort = () => { this.pending = null; reject(new TelegramError()); };
        const finish = (updates) => {
          signal?.removeEventListener('abort', abort);
          this.pending = null;
          resolve(updates);
        };
        this.pending = finish;
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    throw new Error('Unexpected mock method.');
  }

  push(updates) {
    if (this.pending) this.pending(updates);
    else this.batches.push(updates);
  }
}

export function statusUpdate(id, changes = {}) {
  return { update_id: id, message: {
    message_id: id + 100, date: Math.floor(EPOCH / 1000), text: '/status',
    chat: { id: Number(GROUP_ID), type: 'supergroup' }, from: { id: 1, is_bot: false },
    ...changes,
  } };
}

export function telegramFixture(t, environment = {}) {
  const clock = new FakeClock();
  const client = new FakeTelegram(clock);
  const store = new TelemetryStore();
  const mqttService = { connected: true, ready: true };
  const logs = [];
  const config = readConfig({ TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_CHAT_ID: GROUP_ID, ...environment });
  const service = new TelegramService({ config, store, mqttService, client,
    now: clock.now, timers: clock.timers,
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
  });
  t.after(() => service.stop());
  const record = (changes = {}, options = {}) => store.record(TOPICS.transmit, { ...telemetry, ...changes }, clock.now(), options);
  record();
  return { service, config, clock, client, store, mqttService, logs, record };
}
