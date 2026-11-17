import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { TOPICS } from '../topics.js';
import { quiet, serviceFixture, telemetry } from './helpers.js';

async function fixture(t, options = {}) {
  const setup = serviceFixture(options.config);
  const app = createApp({
    ...setup, mqttService: setup.service, logger: quiet,
    clientDirectory: options.clientDirectory ?? join(tmpdir(), 'auto-climate-nonexistent-client'),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await setup.service.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { ...setup, base: `http://127.0.0.1:${server.address().port}` };
}

test('legacy and /api routes return identical telemetry for every topic alias', async (t) => {
  const { client, base } = await fixture(t);
  client.message(TOPICS.transmit, telemetry);
  client.message(TOPICS.receive, { ac_power_state: true, temp: 24, fan_speed: 'medium', timestamp: 1, state_valid: true });
  client.message(TOPICS.weather, { main: { temp: 301.15 } });
  client.message(TOPICS.transmit_status, { online: true });
  client.message(TOPICS.receive_status, { online: false });
  client.acknowledge('previous');
  for (const prefix of ['', '/api']) {
    for (const [alias, topic] of [
      ['transmit', TOPICS.transmit], ['transmit/data', TOPICS.transmit],
      ['receive', TOPICS.receive], ['receive/ack', TOPICS.receive], ['receive/state', TOPICS.receive],
      ['command', TOPICS.command], ['command/ack', TOPICS.command], ['transmit/command/ack', TOPICS.command],
      ['weather', TOPICS.weather], ['api/weather', TOPICS.weather],
      ['transmit/status', TOPICS.transmit_status], ['receive/status', TOPICS.receive_status],
    ]) {
      const latest = await fetch(`${base}${prefix}/${alias}/latest`);
      assert.equal(latest.status, 200, `${prefix}/${alias}/latest`);
      const history = await fetch(`${base}${prefix}/history/${alias}`);
      assert.equal(history.status, 200);
      assert.deepEqual(await history.json(), [await latest.json()], topic);
    }
  }
});

test('snapshot exposes receipt metadata, health, and null before data arrives', async (t) => {
  const { base, client } = await fixture(t);
  const health = await fetch(`${base}/health`);
  assert.deepEqual(await health.json(), { status: 'ok', mqtt: true, subscriptions_ready: true });
  const response = await fetch(`${base}/api/dashboard`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-powered-by'), null);
  const snapshot = await response.json();
  assert.equal(snapshot.transmit, null);
  assert.equal(snapshot.metadata.transmit, null);
  assert.equal(snapshot.stale_after_seconds, 30);
  client.message(TOPICS.transmit, telemetry);
  const populated = await (await fetch(`${base}/api/dashboard`)).json();
  assert.equal(populated.transmit.temp, 26.4);
  assert.equal(populated.metadata.transmit.schema_valid, true);
  assert.ok(Number.isFinite(Date.parse(populated.metadata.transmit.received_at)));
});

test('missing latest data, unknown topics, and unknown API paths return JSON 404', async (t) => {
  const { base } = await fixture(t);
  for (const path of ['/transmit/latest', '/history/unknown', '/unknown/latest', '/api/missing']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.equal(typeof (await response.json()).detail, 'string');
  }
  assert.deepEqual(await (await fetch(`${base}/history/transmit`)).json(), []);
});

test('commands validate at HTTP boundary and wait for matching ACKs', async (t) => {
  const { base, client } = await fixture(t);
  client.onPublish = (payload, callback) => { callback(); client.acknowledge(payload.request_id); };
  const response = await fetch(`${base}/api/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'override', target_temp: 25 }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ack.ok, true);
  const invalid = await fetch(`${base}/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'override', target_temp: 50 }),
  });
  assert.equal(invalid.status, 422);
  assert.equal(client.publications.length, 1);
});

test('malformed and oversized HTTP bodies return consistent JSON errors', async (t) => {
  const { base } = await fixture(t);
  const malformed = await fetch(`${base}/api/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).detail, /valid JSON/);
  const oversized = await fetch(`${base}/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ large: 'x'.repeat(17000) }),
  });
  assert.equal(oversized.status, 413);
});

test('CORS is same-origin by default and supports explicitly allowed external clients', async (t) => {
  const { base } = await fixture(t, { config: { CORS_ORIGIN: 'https://control.example.com' } });
  const allowed = await fetch(`${base}/health`, { headers: { Origin: 'https://control.example.com' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://control.example.com');
  const denied = await fetch(`${base}/health`, { headers: { Origin: 'https://unlisted.example.com' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('production serves HTML and immutable fingerprinted assets without masking API errors', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-climate-client-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><div id="root"></div>');
  await writeFile(join(directory, 'assets', 'app-hash.js'), 'console.log("loaded")');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { base } = await fixture(t, { clientDirectory: directory });
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('cache-control'), 'no-cache');
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
  const asset = await fetch(`${base}/assets/app-hash.js`);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  const missing = await fetch(`${base}/api/nonexistent`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);
});
