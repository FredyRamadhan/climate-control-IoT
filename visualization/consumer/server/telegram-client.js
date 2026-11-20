const METHODS = new Set(['getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage']);

export function isTelegramToken(value) {
  return typeof value === 'string' && /^\d+:[A-Za-z0-9_-]{20,}$/.test(value);
}

export class TelegramError extends Error {
  constructor({ status = 0, code = 0, retryAfter = 0 } = {}) {
    // Never retain the original fetch error, response description, or token URL.
    super(code ? `Telegram request failed (code ${code}).` : 'Telegram request could not be completed.');
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function telegramFailure(error) {
  if (!(error instanceof TelegramError)) return 'Unexpected Telegram error.';
  if (error.code === 401) return 'Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN and restart the consumer.';
  if (error.code === 403) return 'Telegram access denied. Check group membership and permission to send messages, then restart the consumer.';
  if (error.code === 409) return 'Telegram polling conflict. Run one consumer per bot token and check for an existing webhook.';
  if (error.code === 429) return 'Telegram rate limit reached; waiting for the requested retry delay.';
  return error.code ? `Telegram API error ${error.code}.` : 'Telegram network request failed.';
}

export class TelegramClient {
  #token;
  #fetch;

  constructor(token, { fetchImpl = fetch } = {}) {
    if (!isTelegramToken(token)) throw new Error('TELEGRAM_BOT_TOKEN has an invalid format.');
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async call(method, body = {}, { signal } = {}) {
    if (!METHODS.has(method)) throw new Error('Unsupported Telegram method.');
    const timeout = AbortSignal.timeout(method === 'getUpdates' ? 35000 : 10000);
    let response;
    let payload;
    try {
      response = await this.#fetch(`https://api.telegram.org/bot${this.#token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      payload = await response.json();
    } catch {
      throw new TelegramError({ status: response?.status || 0, code: response?.status || 0 });
    }
    if (!response.ok || payload?.ok !== true) {
      const retry = payload?.parameters?.retry_after;
      throw new TelegramError({
        status: response.status,
        code: Number.isInteger(payload?.error_code) ? payload.error_code : response.status,
        retryAfter: Number.isSafeInteger(retry) && retry > 0 ? retry : 0,
      });
    }
    return payload.result;
  }
}
