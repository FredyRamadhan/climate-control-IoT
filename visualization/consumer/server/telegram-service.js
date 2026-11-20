import { TelegramClient, TelegramError, telegramFailure } from './telegram-client.js';
import { formatTelegramStatus } from './telegram-status.js';

const systemTimers = { setTimeout, clearTimeout, setInterval, clearInterval };

export class TelegramService {
  #running = false;
  #ready = false;
  #controller;
  #interval;
  #task;
  #sendTail = Promise.resolve();
  #scheduledBusy = false;
  #sendNotBefore = 0;
  #offset;
  #username;
  #startedAt;

  constructor({ config, store, mqttService, logger = console, client, now = Date.now, timers = systemTimers }) {
    this.config = config;
    this.store = store;
    this.mqttService = mqttService;
    this.logger = logger;
    // Disabled mode creates no client, timers, or outgoing network requests.
    this.client = client ?? (config.TELEGRAM_ENABLED ? new TelegramClient(config.TELEGRAM_BOT_TOKEN) : null);
    this.now = now;
    this.timers = timers;
  }

  start() {
    if (!this.config.TELEGRAM_ENABLED || this.#running) return;
    this.#running = true;
    this.#ready = false;
    this.#offset = undefined;
    this.#sendNotBefore = 0;
    this.#startedAt = Math.floor(this.now() / 1000);
    this.#controller = new AbortController();
    this.#interval = this.timers.setInterval(() => {
      if (!this.#running || !this.#ready || this.#scheduledBusy) return;
      this.#scheduledBusy = true;
      void this.#enqueueReport().finally(() => { this.#scheduledBusy = false; });
    }, this.config.TELEGRAM_INTERVAL_MINUTES * 60000);
    this.#interval?.unref?.();
    this.#task = this.#run().catch(() => {
      if (this.#running) {
        this.logger.warn('Telegram worker stopped after an unexpected error. Restart the consumer to retry.');
        this.#halt();
      }
    });
  }

  #halt() {
    this.#running = false;
    this.#ready = false;
    this.timers.clearInterval(this.#interval);
    this.#controller?.abort();
  }

  async stop() {
    this.#halt();
    await Promise.allSettled([this.#task, this.#sendTail]);
  }

  async #wait(milliseconds) {
    const signal = this.#controller.signal;
    const deadline = this.now() + milliseconds;
    while (!signal.aborted && this.now() < deadline) {
      await new Promise((resolve) => {
        const finish = () => {
          this.timers.clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = this.timers.setTimeout(finish, Math.min(60000, deadline - this.now()));
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
      });
    }
  }

  #failure(context, error) {
    this.logger.warn(`Telegram ${context}: ${telegramFailure(error)}`);
    if (error instanceof TelegramError && [401, 403, 409].includes(error.code)) this.#halt();
  }

  async #run() {
    let backoff = 1000;
    while (this.#running) {
      try {
        if (!this.#ready) {
          const me = await this.client.call('getMe', {}, { signal: this.#controller.signal });
          const webhook = await this.client.call('getWebhookInfo', {}, { signal: this.#controller.signal });
          if (!this.#running) return;
          if (webhook?.url) {
            this.logger.warn('Telegram worker disabled: an existing webhook is configured. Remove it manually or use a dedicated bot.');
            this.#halt();
            return;
          }
          if (typeof me?.username !== 'string' || !/^[A-Za-z0-9_]+$/.test(me.username)) throw new TelegramError();
          this.#username = me.username.toLowerCase();
          this.#ready = true;
          this.logger.info(`Telegram status bot ready; scheduled reports every ${this.config.TELEGRAM_INTERVAL_MINUTES} minutes.`);
        }
        if (!this.#running) return;
        const updates = await this.client.call('getUpdates', {
          ...(this.#offset === undefined ? {} : { offset: this.#offset }),
          timeout: 25, limit: 100, allowed_updates: ['message'],
        }, { signal: this.#controller.signal });
        if (!this.#running) return;
        if (!Array.isArray(updates)) throw new TelegramError();
        backoff = 1000;
        for (const update of updates) {
          if (!this.#running) return;
          if (!Number.isSafeInteger(update?.update_id) || (this.#offset !== undefined && update.update_id < this.#offset)) continue;
          // Advance even for ignored chats/commands, but never retain their content.
          this.#offset = update.update_id + 1;
          const message = update.message;
          if (!message || !['group', 'supergroup'].includes(message.chat?.type)
            || String(message.chat.id) !== this.config.TELEGRAM_CHAT_ID
            || message.from?.is_bot === true || !Number.isFinite(message.date) || message.date < this.#startedAt
            || !Number.isSafeInteger(message.message_id) || typeof message.text !== 'string') continue;
          const command = /^\/status(?:@([A-Za-z0-9_]+))?\s*$/i.exec(message.text);
          if (!command || (command[1] && command[1].toLowerCase() !== this.#username)) continue;
          await this.#enqueueReport(message.message_id);
        }
      } catch (error) {
        if (!this.#running) return;
        this.#failure('polling', error);
        if (!this.#running) return;
        await this.#wait(error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : backoff);
        backoff = Math.min(60000, backoff * 2);
      }
    }
  }

  #enqueueReport(replyTo) {
    const operation = this.#sendTail.then(() => this.#sendReport(replyTo));
    this.#sendTail = operation.catch((error) => {
      if (this.#running) this.#failure('report', error);
    });
    return this.#sendTail;
  }

  async #sendReport(replyTo) {
    while (this.#running && this.#ready) {
      await this.#wait(Math.max(0, this.#sendNotBefore - this.now()));
      if (!this.#running) return;
      // Read the store at delivery time, never in response to MQTT message events.
      const text = formatTelegramStatus({
        snapshot: this.store.snapshot(), mqttConnected: this.mqttService.connected,
        subscriptionsReady: this.mqttService.ready, staleAfterSeconds: this.config.STALE_AFTER_SECONDS,
        timezone: this.config.TELEGRAM_TIMEZONE, now: this.now(),
      });
      try {
        await this.client.call('sendMessage', {
          chat_id: this.config.TELEGRAM_CHAT_ID, text,
          link_preview_options: { is_disabled: true },
          ...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
        }, { signal: this.#controller.signal });
        return;
      } catch (error) {
        if (!this.#running) return;
        this.#failure('delivery', error);
        if (this.#running && error instanceof TelegramError && error.code === 429 && error.retryAfter) {
          this.#sendNotBefore = this.now() + error.retryAfter * 1000;
          continue; // A 429 explicitly rejects delivery; retry once permitted, with a fresh snapshot.
        }
        // A timeout or network error may follow successful delivery. Do not replay
        // that report; the next scheduled report or /status uses current data.
        return;
      }
    }
  }
}
