import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOPICS } from '../topics.js';
import { TelemetryStore } from '../store.js';
import { ack, assertSubscriptions, serviceFixture, telemetry } from './helpers.js';

test('subscribes to all six firmware topics at QoS 1 and resubscribes after reconnect', async () => {
  const { client, service } = serviceFixture();
  assert.equal(service.ready, true);
  assertSubscriptions(assert, client);
  client.connected = false;
  client.emit('close');
  assert.equal(service.connected, false);
  assert.equal(service.ready, false);
  client.connected = true;
  client.emit('connect');
  assert.equal(client.subscriptions.length, 2);
  assertSubscriptions(assert, client);
  assert.equal(service.ready, true);
  await service.stop();
});

test('telemetry preserves additional firmware fields; history keeps the newest 100 in order', () => {
  const { client, store } = serviceFixture();
  for (let index = 0; index < 105; index++) {
    client.message(TOPICS.transmit, { ...telemetry, timestamp: index, firmware_version: '2.0' });
  }
  const history = store.history(TOPICS.transmit);
  assert.equal(history.length, 100);
  assert.equal(history[0].timestamp, 5);
  assert.equal(history.at(-1).timestamp, 104);
  assert.equal(store.latest(TOPICS.transmit).firmware_version, '2.0');
  history.pop();
  assert.equal(store.history(TOPICS.transmit).length, 100);
  assert.equal(store.snapshot().metadata.transmit.schema_valid, true);
});

test('malformed JSON is discarded, while schema mismatches remain available and flagged', () => {
  const { client, store } = serviceFixture();
  client.emit('message', TOPICS.transmit, Buffer.from('{invalid'), {});
  assert.deepEqual(store.history(TOPICS.transmit), []);
  client.message(TOPICS.transmit, { temp: 25, future_field: true });
  assert.deepEqual(store.latest(TOPICS.transmit), { temp: 25, future_field: true });
  assert.equal(store.snapshot().metadata.transmit.schema_valid, false);
  client.message(TOPICS.weather, { main: { temp: 301.15 }, weather: [{ main: 'Rain' }] });
  assert.equal(store.snapshot().weather.main.temp, 301.15);
});

test('empty buffers differ from a buffered JSON null, including metadata', () => {
  const store = new TelemetryStore();
  assert.equal(store.has(TOPICS.weather), false);
  store.record(TOPICS.weather, null, 1000, { retained: true });
  assert.equal(store.has(TOPICS.weather), true);
  assert.deepEqual(store.history(TOPICS.weather), [null]);
  assert.deepEqual(store.snapshot().metadata.weather, {
    received_at: '1970-01-01T00:00:01.000Z', schema_valid: true, retained: true,
  });
});

test('an immediate device ACK arriving before PUBACK still confirms the correct command', async () => {
  const { client, service } = serviceFixture();
  client.onPublish = (payload, callback) => {
    client.acknowledge('unrelated');
    client.acknowledge(payload.request_id);
    callback();
  };
  const response = await service.sendCommand({ action: 'override', target_temp: 24, request_id: 'quick-ack' });
  assert.equal(response.ack.ok, true);
  assert.equal(response.ack.request_id, 'quick-ack');
  assert.deepEqual(client.publications[0].options, { qos: 1, retain: false });
  assert.equal(client.publications[0].topic, 'transmit/command');
  await service.stop();
});

test('old buffered, retained, mismatched, and malformed ACKs cannot confirm a command', async () => {
  const { client, service, store } = serviceFixture();
  store.record(TOPICS.command, ack('new-command'));
  client.onPublish = (payload, callback) => {
    callback();
    client.acknowledge(payload.request_id, {}, { retain: true });
    client.acknowledge('different-request');
    client.message(TOPICS.command, { request_id: payload.request_id, ok: true });
  };
  const result = await service.sendCommand({ action: 'release', request_id: 'new-command' });
  assert.equal(result.ack, null);
  assert.match(result.detail, /No ACK/);
  await service.stop();
});

test('parallel commands are correlated by request ID even when ACKs arrive out of order', async () => {
  const { client, service } = serviceFixture();
  const first = service.sendCommand({ action: 'release', request_id: 'first' });
  const second = service.sendCommand({ action: 'release', request_id: 'second' });
  client.acknowledge('second', { ok: false, error: 'rejected' });
  client.acknowledge('first');
  assert.equal((await second).ack.ok, false);
  assert.equal((await first).ack.request_id, 'first');
  await service.stop();
});

test('duplicate in-flight IDs are rejected without publishing a second command', async () => {
  const { client, service } = serviceFixture();
  const first = service.sendCommand({ action: 'release', request_id: 'duplicate' });
  await assert.rejects(service.sendCommand({ action: 'release', request_id: 'duplicate' }), { status: 409 });
  assert.equal(client.publications.length, 1);
  client.acknowledge('duplicate');
  await first;
  await service.stop();
});

test('a missing broker confirmation fails with 502 and cleans up the pending request', async () => {
  const { client, service } = serviceFixture();
  client.onPublish = () => {};
  await assert.rejects(service.sendCommand({ action: 'release', request_id: 'timeout' }), { status: 502 });
  assert.deepEqual(client.removedMessages, [1]);
  client.onPublish = (payload, callback) => { callback(); client.acknowledge(payload.request_id); };
  assert.equal((await service.sendCommand({ action: 'release', request_id: 'timeout' })).ack.ok, true);
  await service.stop();
});

test('publish callback errors return 502', async () => {
  const { client, service } = serviceFixture();
  client.onPublish = (_payload, callback) => callback(new Error('publish failed'));
  await assert.rejects(service.sendCommand({ action: 'release' }), { status: 502 });
  await service.stop();
});

test('disconnect and shutdown reject pending commands and stop accepting new commands', async () => {
  const { client, service } = serviceFixture();
  const waiting = service.sendCommand({ action: 'release', request_id: 'disconnect' });
  const disconnected = assert.rejects(waiting, { status: 503 });
  client.connected = false;
  client.emit('close');
  await disconnected;
  await assert.rejects(service.sendCommand({ action: 'release' }), { status: 503 });
  client.connected = true;
  client.emit('connect');
  const shutdown = assert.rejects(service.sendCommand({ action: 'release' }), { status: 503 });
  await service.stop();
  await shutdown;
  assert.equal(service.ready, false);
});
