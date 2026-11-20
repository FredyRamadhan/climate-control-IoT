import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { TelegramError } from '../telegram-client.js';
import { TelegramService } from '../telegram-service.js';
import { quiet, serviceFixture } from './helpers.js';
import { BOT_TOKEN, GROUP_ID, EPOCH, settle, statusUpdate, telegramFixture } from './telegram-helpers.js';

test('disabled Telegram creates no worker, timer or network traffic', async (t) => {
  const f = telegramFixture(t, { TELEGRAM_ENABLED: 'false' });
  f.service.start();
  await f.clock.advance(7200000);
  assert.deepEqual(f.client.calls, []);
  assert.equal(f.clock.events.size, 0);
  assert.deepEqual(f.logs, []);
});

test('reports start after 30 minutes, repeat without changes, and never follow individual telemetry updates', async (t) => {
  const f = telegramFixture(t);
  f.service.start();
  f.service.start();
  await settle();
  assert.equal(f.client.requests('getMe').length, 1);
  assert.equal(f.client.requests('sendMessage').length, 0);
  await f.clock.advance(1799999);
  f.record({ temp: 28.3 });
  await settle();
  assert.equal(f.client.requests('sendMessage').length, 0);
  await f.clock.advance(1);
  assert.equal(f.client.requests('sendMessage').length, 1);
  assert.match(f.client.requests('sendMessage')[0].body.text, /28,3°C/);
  assert.equal(f.client.requests('sendMessage')[0].body.chat_id, GROUP_ID);
  assert.equal(f.client.requests('sendMessage')[0].body.reply_parameters, undefined);
  assert.equal(f.client.requests('sendMessage')[0].at, EPOCH + 1800000);
  await f.clock.advance(1800000);
  assert.equal(f.client.requests('sendMessage').length, 2);
  assert.match(f.client.requests('sendMessage')[1].body.text, /28,3°C/);
  assert.match(f.client.requests('sendMessage')[1].body.text, /data lama/);
});

test('any group member can request an immediate status with a plain or matching mentioned command', async (t) => {
  const f = telegramFixture(t);
  f.service.start();
  await settle();
  f.client.push([statusUpdate(1), statusUpdate(2, { text: '/status@climatetestbot' }),
    statusUpdate(3, { text: '/status@ClimateTestBot\n', from: { id: 99, is_bot: false } })]);
  await settle();
  const sends = f.client.requests('sendMessage');
  assert.equal(sends.length, 3);
  assert.deepEqual(sends.map((send) => send.body.reply_parameters), [101, 102, 103]
    .map((message_id) => ({ message_id, allow_sending_without_reply: true })));
  for (const send of sends) {
    assert.equal(send.at, EPOCH);
    assert.equal(send.body.chat_id, GROUP_ID);
    assert.equal(send.body.link_preview_options.is_disabled, true);
    assert.equal(send.body.parse_mode, undefined);
    assert.match(send.body.text, /Suhu ruangan: 26,4°C/);
  }
  assert.equal(f.clock.events.size, 1, 'manual replies do not reset the reporting interval');
});

test('worker ignores other chats, bots, edited or stale messages and unrelated commands, advancing every offset', async (t) => {
  const f = telegramFixture(t);
  f.service.start();
  await settle();
  const changes = [
    { chat: { id: -44, type: 'group' } },
    { chat: { id: Number(GROUP_ID), type: 'private' } },
    { text: 'private ordinary conversation' }, { text: '/help' }, { text: '/status@OtherBot' },
    { text: '/status later' }, { from: { is_bot: true } },
    { date: Math.floor(EPOCH / 1000) - 1 }, { date: undefined }, { message_id: undefined },
  ];
  const updates = changes.map((message, index) => statusUpdate(index + 1, message));
  const edited = statusUpdate(11);
  updates.push({ update_id: edited.update_id, edited_message: edited.message });
  f.client.push(updates);
  await settle();
  assert.equal(f.client.requests('sendMessage').length, 0);
  assert.equal(f.client.requests('getUpdates').at(-1).body.offset, 12);
  assert.doesNotMatch(f.logs.join('\n'), /private ordinary conversation/);
});

test('update offsets prevent duplicate replies and accept only new update IDs', async (t) => {
  const f = telegramFixture(t);
  f.service.start();
  await settle();
  f.client.push([statusUpdate(1), statusUpdate(1), statusUpdate(0), statusUpdate(3)]);
  await settle();
  assert.equal(f.client.requests('sendMessage').length, 2);
  const poll = f.client.requests('getUpdates').at(-1).body;
  assert.equal(poll.offset, 4);
  assert.equal(poll.timeout, 25);
  assert.deepEqual(poll.allowed_updates, ['message']);
  f.client.push([statusUpdate(1), statusUpdate(4)]);
  await settle();
  assert.equal(f.client.requests('sendMessage').length, 3);
});

test('reports continue during MQTT outages and explicitly label cached and missing readings', async (t) => {
  const f = telegramFixture(t);
  f.mqttService.connected = false;
  f.mqttService.ready = false;
  f.service.start();
  await f.clock.advance(1800000);
  const text = f.client.requests('sendMessage')[0].body.text;
  assert.match(text, /MQTT: Terputus/);
  assert.match(text, /data lama, 30 menit lalu/);
  assert.match(text, /Cuaca luar: belum ada data/);
  assert.match(text, /Belum ada konfirmasi yang valid/);
});

test('an existing webhook disables only the bot and is never removed or printed', async (t) => {
  const f = telegramFixture(t);
  f.client.behavior.getWebhookInfo = () => ({ url: `https://private.example/${BOT_TOKEN}` });
  f.service.start();
  await f.clock.advance(3600000);
  assert.deepEqual(f.client.calls.map((call) => call.method), ['getMe', 'getWebhookInfo']);
  assert.equal(f.clock.events.size, 0);
  assert.match(f.logs.join('\n'), /existing webhook/);
  assert.ok(!f.logs.join('\n').includes(BOT_TOKEN));
});

test('401, 403 and 409 disable the bot without retries and use safe actionable logs', async (t) => {
  for (const code of [401, 403, 409]) {
    const f = telegramFixture(t);
    f.client.behavior.getMe = () => { throw new TelegramError({ code }); };
    f.service.start();
    await f.clock.advance(3600000);
    assert.equal(f.client.calls.length, 1);
    assert.equal(f.clock.events.size, 0);
    assert.match(f.logs.join('\n'), /token|permission|one consumer/);
    assert.ok(!f.logs.join('\n').includes(BOT_TOKEN));
  }
});

test('polling network/server failures back off from 1 second to a maximum of 60 seconds', async (t) => {
  const f = telegramFixture(t);
  f.client.behavior.getUpdates = () => { throw new TelegramError({ code: 503 }); };
  f.service.start();
  await settle();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    const before = f.client.requests('getUpdates').length;
    await f.clock.advance(delay - 1);
    assert.equal(f.client.requests('getUpdates').length, before);
    await f.clock.advance(1);
    assert.equal(f.client.requests('getUpdates').length, before + 1);
  }
  delete f.client.behavior.getUpdates;
  await f.clock.advance(60000);
  assert.ok(f.client.pending, 'polling resumes after recovery');
  assert.equal(f.client.requests('getMe').length, 1);
});

test('polling honors retry_after even when the delay exceeds normal backoff', async (t) => {
  const f = telegramFixture(t);
  f.client.behavior.getUpdates = () => {
    delete f.client.behavior.getUpdates;
    throw new TelegramError({ code: 429, retryAfter: 75 });
  };
  f.service.start();
  await f.clock.advance(74999);
  assert.equal(f.client.requests('getUpdates').length, 1);
  await f.clock.advance(1);
  assert.equal(f.client.requests('getUpdates').length, 2);
});

test('ambiguous send failures are not replayed; a later command reads a fresh snapshot', async (t) => {
  const f = telegramFixture(t);
  f.client.behavior.sendMessage = () => {
    delete f.client.behavior.sendMessage;
    throw new Error(`failed https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
  };
  f.service.start();
  await settle();
  f.client.push([statusUpdate(1)]);
  await settle();
  await f.clock.advance(10000);
  assert.equal(f.client.requests('sendMessage').length, 1);
  f.record({ temp: 29.1 });
  f.client.push([statusUpdate(2)]);
  await settle();
  assert.equal(f.client.requests('sendMessage').length, 2);
  assert.match(f.client.requests('sendMessage')[1].body.text, /29,1°C/);
  assert.ok(!f.logs.join('\n').includes(BOT_TOKEN));
});

test('explicitly rejected sends honor retry_after, regenerate the report, and bound pending scheduled reports', async (t) => {
  const f = telegramFixture(t, { TELEGRAM_INTERVAL_MINUTES: '1' });
  f.client.behavior.sendMessage = () => {
    delete f.client.behavior.sendMessage;
    throw new TelegramError({ code: 429, retryAfter: 130 });
  };
  f.service.start();
  await settle();
  f.client.push([statusUpdate(1)]);
  await settle();
  await f.clock.advance(129999);
  assert.equal(f.client.requests('sendMessage').length, 1);
  f.record({ temp: 30.1 });
  await f.clock.advance(1);
  const sends = f.client.requests('sendMessage');
  assert.equal(sends.length, 3, 'one rejected attempt, one retry, and at most one queued scheduled report');
  assert.equal(sends[1].at, EPOCH + 130000);
  assert.match(sends[1].body.text, /30,1°C/);
  assert.match(sends[2].body.text, /30,1°C/);
  assert.equal(sends[1].body.reply_parameters.message_id, 101);
  assert.equal(sends[2].body.reply_parameters, undefined);
});

test('stop aborts long polling and retry delays, clears timers, and prevents later sends', async (t) => {
  for (const retrying of [false, true]) {
    const f = telegramFixture(t);
    if (retrying) f.client.behavior.sendMessage = () => { throw new TelegramError({ code: 429, retryAfter: 120 }); };
    f.service.start();
    await settle();
    if (retrying) { f.client.push([statusUpdate(1)]); await settle(); }
    const signal = f.client.calls[0].signal;
    await f.service.stop();
    assert.equal(signal.aborted, true);
    assert.equal(f.client.pending, null);
    assert.equal(f.clock.events.size, 0);
    const count = f.client.calls.length;
    await f.clock.advance(7200000);
    assert.equal(f.client.calls.length, count);
  }
});

test('restart starts a new interval without catch-up messages or old queued commands', async (t) => {
  const f = telegramFixture(t);
  f.service.start();
  await settle();
  await f.service.stop();
  await f.clock.advance(7200000);
  f.service.start();
  await settle();
  f.client.push([statusUpdate(1)]);
  await settle();
  assert.equal(f.client.requests('sendMessage').length, 0);
  await f.clock.advance(1799999);
  assert.equal(f.client.requests('sendMessage').length, 0);
  await f.clock.advance(1);
  assert.equal(f.client.requests('sendMessage').length, 1);
});

test('a Telegram delivery permission failure leaves Express health and MQTT commands working', async (t) => {
  const f = telegramFixture(t);
  const hardware = serviceFixture();
  t.after(() => hardware.service.stop());
  const bot = new TelegramService({ config: f.config, store: hardware.store,
    mqttService: hardware.service, client: f.client, now: f.clock.now, timers: f.clock.timers, logger: quiet });
  t.after(() => bot.stop());
  f.client.behavior.sendMessage = () => { throw new TelegramError({ code: 403 }); };
  bot.start();
  await settle();
  f.client.push([statusUpdate(1)]);
  await settle();
  assert.equal(f.clock.events.size, 0);
  assert.equal(hardware.service.connected, true);
  const server = createApp({ config: hardware.config, store: hardware.store,
    mqttService: hardware.service, logger: quiet }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  hardware.client.onPublish = (payload, callback) => { callback(); hardware.client.acknowledge(payload.request_id); };
  const response = await fetch(`${base}/api/command`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'override', target_temp: 25 }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ack.ok, true);
});
