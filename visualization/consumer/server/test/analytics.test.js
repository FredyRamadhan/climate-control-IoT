import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';
import { TelemetryStore } from '../store.js';

async function fixture(t, handler) {
  const upstream = createServer(handler).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const config = readConfig({ ANALYTICS_URL: `http://127.0.0.1:${upstream.address().port}` });
  const app = createApp({ config, store: new TelemetryStore(), mqttService: { connected: false, ready: false } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const listener of [server, upstream]) {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
  });
  return { base: `http://127.0.0.1:${server.address().port}`, upstream };
}

test('analytics summary is proxied with its period on the same dashboard origin', async (t) => {
  const { base } = await fixture(t, (req, res) => {
    assert.equal(req.url, '/summary?days=1');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ dataset: { rows: 1440 } }));
  });
  const response = await fetch(`${base}/api/analytics/summary?days=1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).dataset.rows, 1440);
});

test('analytics JSON prediction and upstream validation errors are preserved', async (t) => {
  const { base } = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/predict');
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { target_temp_c: 100 });
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Invalid target' }));
  });
  const response = await fetch(`${base}/api/analytics/predict`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target_temp_c: 100 }),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).detail, 'Invalid target');
});

test('CSV uploads larger than the command JSON limit reach analytics unchanged', async (t) => {
  const contents = `indoor_temp_c,target_temp_c\n${'28,24\n'.repeat(5000)}`;
  const { base } = await fixture(t, async (req, res) => {
    assert.equal(req.headers['content-type'], 'text/csv');
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(body, contents);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ row_count: 5000 }));
  });
  const response = await fetch(`${base}/api/analytics/batch`, {
    method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: contents,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).row_count, 5000);
});

test('analytics template remains a CSV download and arbitrary routes do not reach upstream', async (t) => {
  let requests = 0;
  const { base } = await fixture(t, (_req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Type': 'text/csv' });
    res.end('indoor_temp_c\n28\n');
  });
  const template = await fetch(`${base}/api/analytics/template.csv`);
  assert.match(template.headers.get('content-type'), /text\/csv/);
  assert.match(template.headers.get('content-disposition'), /attachment/);
  assert.equal(await template.text(), 'indoor_temp_c\n28\n');
  assert.equal((await fetch(`${base}/api/analytics/arbitrary`)).status, 404);
  assert.equal((await fetch(`${base}/api/analytics/summary?days=invalid`)).status, 422);
  assert.equal(requests, 1);
});

test('an unavailable analytics service does not break the climate API', async (t) => {
  const { base, upstream } = await fixture(t, () => {});
  await new Promise((resolve) => upstream.close(resolve));
  const response = await fetch(`${base}/api/analytics/summary`);
  assert.equal(response.status, 503);
  assert.equal(typeof (await response.json()).detail, 'string');
  assert.equal((await fetch(`${base}/health`)).status, 200);
});
