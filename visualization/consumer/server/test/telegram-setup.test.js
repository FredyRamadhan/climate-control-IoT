import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverTelegramGroups } from '../telegram-setup.js';
import { BOT_TOKEN, GROUP_ID, FakeClock, FakeTelegram, statusUpdate } from './telegram-helpers.js';

test('setup lists unique groups, ignores private chats and never sends or acknowledges updates', async () => {
  const client = new FakeTelegram(new FakeClock());
  const logs = [];
  client.push([
    statusUpdate(1, { chat: { id: Number(GROUP_ID), type: 'supergroup', title: 'Climate\nRoom' } }),
    statusUpdate(2, { chat: { id: Number(GROUP_ID), type: 'supergroup', title: 'Climate\nRoom' } }),
    statusUpdate(3, { chat: { id: -44, type: 'group', title: `${'x'.repeat(100)}${BOT_TOKEN}` } }),
    statusUpdate(4, { chat: { id: 1, type: 'private', title: 'private' } }),
    statusUpdate(5, { chat: { id: -11, type: 'channel', title: 'channel' } }),
  ]);
  const result = await discoverTelegramGroups({ client, token: BOT_TOKEN, log: (text) => logs.push(text) });
  assert.equal(result.blocked, false);
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0].id, GROUP_ID);
  assert.equal(result.groups[0].title, 'Climate Room');
  assert.match(logs.join('\n'), /Bot: @ClimateTestBot/);
  assert.match(logs.join('\n'), /plain \/status can be received/);
  assert.ok(!logs.join('\n').includes(BOT_TOKEN));
  assert.ok(!logs.join('\n').includes(BOT_TOKEN.slice(0, 20)));
  assert.deepEqual(client.calls.map((call) => call.method), ['getMe', 'getWebhookInfo', 'getUpdates']);
  assert.equal(Object.hasOwn(client.requests('getUpdates')[0].body, 'offset'), false);
});

test('setup explains group privacy and provides a retry when no group update exists', async () => {
  const client = new FakeTelegram(new FakeClock());
  client.behavior.getMe = () => ({ username: 'ClimateTestBot', can_read_all_group_messages: false });
  client.push([]);
  const logs = [];
  const result = await discoverTelegramGroups({ client, log: (text) => logs.push(text) });
  assert.deepEqual(result, { groups: [], blocked: false });
  assert.match(logs.join('\n'), /BotFather \/setprivacy/);
  assert.match(logs.join('\n'), /remove and re-add/);
  assert.match(logs.join('\n'), /No group found/);
  assert.equal(client.requests('sendMessage').length, 0);
});

test('setup refuses an existing webhook without printing its URL or removing it', async () => {
  const client = new FakeTelegram(new FakeClock());
  client.behavior.getWebhookInfo = () => ({ url: 'https://private.example/webhook-secret' });
  const logs = [];
  assert.deepEqual(await discoverTelegramGroups({ client, log: (text) => logs.push(text) }), { groups: [], blocked: true });
  assert.deepEqual(client.calls.map((call) => call.method), ['getMe', 'getWebhookInfo']);
  assert.match(logs.join('\n'), /remove the webhook manually/);
  assert.doesNotMatch(logs.join('\n'), /private.example|webhook-secret/);
});
