import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const project = `auto-climate-smoke-${randomUUID().slice(0, 8)}`;
const overrideFile = join(root, '.cache', `${project}.json`);
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  PORT: String(port), MQTT_HOST: '127.0.0.1', MQTT_PORT: '1883',
  MQTT_PROTOCOL: 'mqtt', MQTT_USER: '', MQTT_PASS: '', MQTT_CLIENT_ID: project,
  COMMAND_ACK_TIMEOUT: '0.2', COMMAND_PUBLISH_TIMEOUT: '2',
  STALE_AFTER_SECONDS: '30', CORS_ORIGIN: '',
};
const composeArgs = ['compose', '--project-name', project, '--file', join(root, 'compose.yaml'), '--file', overrideFile];
let started = false;
let container = null;
let broker = null;
let brokerOutput = '';

function docker(args) {
  return execFileSync('docker', args, {
    cwd: root, env: environment, windowsHide: true, encoding: 'utf8',
    timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function waitFor(check, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
}

async function json(path) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, path);
  return response.json();
}

async function command(body, expectedStatus = 200) {
  const response = await fetch(`${origin}/api/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, expectedStatus);
  return response.json();
}

try {
  await mkdir(join(root, '.cache'), { recursive: true });
  // Only speed up health-check scheduling; the image's actual check is preserved.
  await writeFile(overrideFile, JSON.stringify({ services: {
    consumer: { healthcheck: { interval: '1s', start_period: '1s' } },
    analytics: { healthcheck: { interval: '1s', start_period: '1s' } },
  } }));
  started = true;
  docker([...composeArgs, 'up', '--no-build', '--detach', '--wait', '--wait-timeout', '30']);
  container = docker([...composeArgs, 'ps', '--quiet', 'consumer']);
  assert.ok(container, 'Compose did not start the consumer');
  const inspection = JSON.parse(docker(['inspect', container]))[0];
  assert.equal(inspection.Config.User, 'node');
  assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
  assert.ok(inspection.HostConfig.CapDrop.includes('ALL'));
  assert.ok(inspection.HostConfig.SecurityOpt.some((option) => option.startsWith('no-new-privileges')));
  assert.equal(inspection.State.Health.Status, 'healthy');
  console.log('PASS: Compose starts a healthy, unprivileged container with a read-only filesystem.');

  assert.equal((await json('/health')).mqtt, false);
  await command({ action: 'release' }, 503);
  await command({ action: 'override', target_temp: 50 }, 422);
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  const html = await page.text();
  assert.match(html, /AutoClimate/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((match) => match[1]);
  assert.ok(assets.some((asset) => asset.endsWith('.js')));
  assert.ok(assets.some((asset) => asset.endsWith('.css')));
  for (const path of [...assets, '/theme.js', '/images/ac-photo.png', '/fonts/source-sans-3-400.woff2']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    if (path.startsWith('/assets/')) assert.match(response.headers.get('cache-control'), /immutable/);
  }
  docker(['exec', container, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { existsSync, writeFileSync } from 'node:fs';
    assert.notEqual(process.getuid(), 0);
    for (const path of ['/app/.env', '/app/frontend/src', '/app/server/test', '/app/node_modules/vite']) {
      assert.equal(existsSync(path), false, path);
    }
    assert.throws(() => writeFileSync('/app/smoke-write-check', 'blocked'),
      error => ['EROFS', 'EACCES'].includes(error.code));
  `]);
  console.log('PASS: API offline behavior, React assets, production-only dependencies, and excluded secrets.');

  const analyticsContainer = docker([...composeArgs, 'ps', '--quiet', 'analytics']);
  const analyticsInspection = JSON.parse(docker(['inspect', analyticsContainer]))[0];
  assert.equal(analyticsInspection.Config.User, 'analytics');
  assert.equal(analyticsInspection.HostConfig.ReadonlyRootfs, true);
  assert.equal(analyticsInspection.State.Health.Status, 'healthy');
  assert.equal(Object.keys(analyticsInspection.HostConfig.PortBindings || {}).length, 0);
  const analytics = await json('/api/analytics/summary');
  assert.equal(analytics.dataset.rows, 10000);
  assert.equal(analytics.dataset.source, 'synthetic');
  assert.equal(analytics.model_ready, true);
  assert.equal(analytics.hourly.length, 24);
  assert.equal((await json('/api/analytics/summary?days=1')).dataset.rows, 1440);
  const simulation = {
    indoor_temp_c: 28.5, indoor_humidity: 65, outdoor_temp_c: 33, outdoor_humidity: 75,
    occupancy_count: 3, target_temp_c: 24, hour_of_day: 14, motion_detected: 1,
    ac_power_state: 1, weather_condition: 'Clouds', fan_speed: 'Medium',
  };
  const predictionResponse = await fetch(`${origin}/api/analytics/predict`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(simulation),
  });
  assert.equal(predictionResponse.status, 200);
  const prediction = await predictionResponse.json();
  assert.ok(Number.isFinite(prediction.power_w) && prediction.power_w >= 0);
  assert.equal(prediction.features.temp_delta, 4.5);
  const template = await (await fetch(`${origin}/api/analytics/template.csv`)).text();
  const batchResponse = await fetch(`${origin}/api/analytics/batch`, {
    method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: template,
  });
  assert.equal(batchResponse.status, 200);
  const batch = await batchResponse.json();
  assert.equal(batch.row_count, 1);
  assert.match(batch.csv, /predicted_power_w/);
  assert.equal(batch.preview[0].predicted_power_w, prediction.power_w);
  const invalid = await fetch(`${origin}/api/analytics/predict`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...simulation, target_temp_c: 100 }),
  });
  assert.equal(invalid.status, 422);
  const nonfinite = await fetch(`${origin}/api/analytics/predict`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(simulation).replace('28.5', 'NaN'),
  });
  // NaN is not valid JSON, so Express rejects it before it reaches Python.
  assert.equal(nonfinite.status, 400);
  console.log('PASS: Python model, summary, period filtering, prediction, CSV inference, and validation work through Express.');
  docker([...composeArgs, 'stop', '--timeout', '12', 'analytics']);
  assert.equal((await fetch(`${origin}/api/analytics/summary`)).status, 503);
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  docker([...composeArgs, 'start', 'analytics']);
  await waitFor(async () => (await json('/api/analytics/summary')).model_ready, 'analytics recovery');
  console.log('PASS: Analytics can stop and recover without disrupting climate control.');

  // Stream a fixture into a second Node process in this container, with no mounted
  // secrets or network path to real devices. The fixture is excluded from the image.
  broker = spawn('docker', ['exec', '--interactive', container, 'node', '--input-type=commonjs'], {
    cwd: root, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  broker.on('error', (error) => { brokerOutput += error.message; });
  broker.stdout.on('data', (bytes) => { brokerOutput += bytes; });
  broker.stderr.on('data', (bytes) => { brokerOutput += bytes; });
  broker.stdin.on('error', () => {});
  broker.stdin.end(await readFile(new URL('./fixtures/mqtt-broker.cjs', import.meta.url)));
  await waitFor(() => {
    if (broker.exitCode !== null) throw new Error(brokerOutput);
    return brokerOutput.includes('MQTT test broker ready');
  }, 'MQTT fixture startup');
  await waitFor(async () => {
    const snapshot = await json('/api/dashboard');
    return snapshot.health.subscriptions_ready && snapshot.transmit?.sequence >= 104;
  }, 'MQTT reconnection and topic subscriptions');
  const snapshot = await json('/api/dashboard');
  assert.equal(snapshot.transmit.temp, 26.4);
  assert.equal(snapshot.receive.temp, 24);
  assert.equal(snapshot.transmit_status.online, true);
  assert.equal(snapshot.receive_status.online, true);
  assert.equal(snapshot.weather.main.temp, 301.15);
  assert.equal(snapshot.metadata.transmit.schema_valid, true);
  const history = await json('/history/transmit/data');
  assert.equal(history.length, 100);
  assert.ok(history[0].sequence > 0);
  // The fixture keeps publishing; stable fields must agree across API aliases
  // even if the two requests straddle a new timestamp or sequence number.
  for (const path of ['/transmit/latest', '/api/transmit/latest']) {
    const latest = await json(path);
    assert.equal(latest.temp, 26.4);
    assert.equal(latest.target_temp, 24);
    assert.equal(latest.fan_speed, 'medium');
  }
  console.log('PASS: MQTT reconnects, subscribes, validates telemetry, and bounds history to 100 messages.');

  const applied = await command({ action: 'override', request_id: 'docker-override',
    relay_on: false, target_temp: 23, fan_speed: 'high', duration_s: 0 });
  assert.equal(applied.ack.ok, true);
  assert.equal(applied.ack.request_id, 'docker-override');
  assert.deepEqual(applied.ack.applied, { relay_on: false, target_temp: 23, fan_speed: 'high' });
  const released = await command({ action: 'release', request_id: 'docker-release' });
  assert.equal(released.ack.ok, true);
  assert.equal(released.ack.override, false);
  const raw = await command({ action: 'raw', request_id: 'docker-raw', ir_code: 'ab12' });
  assert.equal(raw.ack.ir_code, '0x0000AB12');
  assert.equal(raw.ack.raw_only, true);
  const rejected = await command({ action: 'release', request_id: 'docker-rejected' });
  assert.equal(rejected.ack.ok, false);
  const timeout = await command({ action: 'release', request_id: 'docker-noack' });
  assert.equal(timeout.ack, null);
  assert.match(timeout.detail, /No ACK/);
  console.log('PASS: Overrides, release, raw frames, device rejection, and ACK timeout work in Docker.');

  docker([...composeArgs, 'stop', '--timeout', '12', 'consumer']);
  const stopped = JSON.parse(docker(['inspect', container]))[0];
  assert.equal(stopped.State.ExitCode, 0);
  assert.match(docker(['logs', container]), /Shutting down Auto-Climate Control/);
  console.log('PASS: SIGTERM stops the production service cleanly with exit code 0.');
} catch (error) {
  if (container) {
    try { console.error(docker(['logs', '--tail', '30', container])); } catch { /* Preserve the original failure. */ }
  }
  if (brokerOutput && !brokerOutput.includes('MQTT test broker ready')) console.error(brokerOutput);
  throw error;
} finally {
  if (started) docker([...composeArgs, 'down', '--timeout', '12']);
  if (broker && broker.exitCode === null) broker.kill();
  await unlink(overrideFile).catch(() => {});
}
console.log('Docker smoke tests passed; temporary containers and network removed.');
