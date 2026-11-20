import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TelegramClient, TelegramError, telegramFailure } from '../telegram-client.js';
import { BOT_TOKEN } from './telegram-helpers.js';

test('Telegram transport uses HTTPS POST JSON and forwards cancellation', async () => {
  const calls = [];
  const controller = new AbortController();
  const client = new TelegramClient(BOT_TOKEN, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'ClimateTestBot' } }) };
  } });
  assert.deepEqual(await client.call('getMe', {}, { signal: controller.signal }), { username: 'ClimateTestBot' });
  const { url, options } = calls[0];
  assert.equal(url, `https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), {});
  controller.abort();
  assert.equal(options.signal.aborted, true);
  await assert.rejects(client.call('deleteWebhook'), /Unsupported Telegram method/);
  assert.equal(calls.length, 1);
  assert.throws(() => new TelegramClient('bad secret'), /invalid format/);
});

test('Telegram transport preserves rate-limit metadata but discards raw descriptions and tokens', async () => {
  const client = new TelegramClient(BOT_TOKEN, { fetchImpl: async () => ({ ok: false, status: 429,
    json: async () => ({ ok: false, error_code: 429, description: `private description ${BOT_TOKEN}`,
      parameters: { retry_after: 7 } }),
  }) });
  await assert.rejects(client.call('sendMessage'), (error) => {
    assert.ok(error instanceof TelegramError);
    assert.equal(error.code, 429);
    assert.equal(error.retryAfter, 7);
    assert.match(telegramFailure(error), /rate limit/);
    assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /private description/);
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(BOT_TOKEN));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('Telegram transport sanitizes network errors and invalid JSON, including token URLs', async () => {
  for (const fetchImpl of [
    async () => { throw new Error(`failed https://api.telegram.org/bot${BOT_TOKEN}/getMe`); },
    async () => ({ ok: false, status: 502, json: async () => { throw new Error(`private ${BOT_TOKEN}`); } }),
    async () => ({ ok: true, status: 200, json: async () => null }),
  ]) {
    const client = new TelegramClient(BOT_TOKEN, { fetchImpl });
    await assert.rejects(client.call('getMe'), (error) => {
      assert.ok(error instanceof TelegramError);
      assert.ok(!`${error.stack} ${JSON.stringify(error)} ${telegramFailure(error)}`.includes(BOT_TOKEN));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('Telegram transport rejects invalid retry_after and gives actionable permanent-error messages', async () => {
  for (const retry of [-1, 1.5, '10', Number.MAX_VALUE]) {
    const client = new TelegramClient(BOT_TOKEN, { fetchImpl: async () => ({ ok: false, status: 429,
      json: async () => ({ ok: false, parameters: { retry_after: retry } }),
    }) });
    await assert.rejects(client.call('sendMessage'), (error) => error.retryAfter === 0);
  }
  assert.match(telegramFailure(new TelegramError({ code: 401 })), /token/);
  assert.match(telegramFailure(new TelegramError({ code: 403 })), /permission/);
  assert.match(telegramFailure(new TelegramError({ code: 409 })), /one consumer/);
  assert.equal(telegramFailure(new Error(BOT_TOKEN)), 'Unexpected Telegram error.');
});
