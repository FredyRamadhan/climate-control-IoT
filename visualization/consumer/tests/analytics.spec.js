import { test, expect } from '@playwright/test';

function summary(days = 'all') {
  return {
    dataset: { source: 'synthetic', rows: days === '1' ? 1440 : 10000, total_rows: 10000,
      start: '2026-01-01T00:00:00', end: '2026-01-07T22:39:00', sample_interval_seconds: 60 },
    metrics: { average_power_w: 642.5, active_percent: 72.4, energy_kwh: days === '1' ? 15 : 107.08, average_indoor_c: 26.5, average_outdoor_c: 30.2 },
    hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, power_w: 400 + Math.sin(hour / 24 * Math.PI) * 500,
      indoor_temp_c: 25 + Math.sin(hour / 24 * Math.PI) * 3, outdoor_temp_c: 27 + Math.sin(hour / 24 * Math.PI) * 8, active_percent: 72, count: 400 })),
    occupancy: [{ label: 'Tanpa penghuni', records: 2000, power_w: 102.5 }, { label: '1–3 orang', records: 5000, power_w: 580 }, { label: '4+ orang', records: 3000, power_w: 980.1 }],
    model_ready: true,
    evaluation: { name: 'hist_gradient_boosting', trained_at: '2026-11-11 08:24:38', training_samples: 8000, test_samples: 2000,
      metrics: { r2_score: 0.999, rmse: 14.98, mae: 9.63, mape_percent: 5.67 },
      benchmarks: [{ name: 'linear', r2_score: 0.939, rmse: 118.59, mae: 95.17 }, { name: 'hist_gradient_boosting', r2_score: 0.999, rmse: 14.98, mae: 9.63 }] },
  };
}

function dashboard() {
  const now = new Date().toISOString();
  return {
    health: { status: 'ok', mqtt: true, subscriptions_ready: true },
    transmit: { temp: 27.2, hum: 58, target_temp: 24, fan_speed: 'medium', relay_on: true,
      sensor_ok: true, motion: true, override: false, uptime_ms: 7200000 },
    receive: null, transmit_status: { online: true }, receive_status: null, command: null,
    weather: { name: 'Surakarta', main: { temp: 302.15, humidity: 75 }, weather: [{ main: 'Rain' }] },
    metadata: { transmit: { received_at: now, schema_valid: true, retained: false }, weather: { received_at: now, schema_valid: true, retained: false } },
    server_time: now, stale_after_seconds: 30,
  };
}

async function setup(page) {
  await page.route('**/api/dashboard', (route) => route.fulfill({ json: dashboard() }));
  await page.route('**/api/analytics/summary*', (route) => route.fulfill({ json: summary(new URL(route.request().url()).searchParams.get('days') || 'all') }));
}

test('analytics is a SPA tab with deep links, back navigation, and preserved manual edits', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await expect(page.getByRole('slider', { name: 'Temperatur target' })).toHaveValue('24');
  await page.getByRole('button', { name: 'Naikkan temperatur' }).click();
  await page.evaluate(() => { window.spaMarker = 'preserved'; });
  await page.getByRole('link', { name: 'Analitik', exact: true }).click();
  await expect(page).toHaveURL(/#analitik$/);
  await expect(page.getByRole('heading', { name: 'Analitik energi', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Ringkasan energi' })).toContainText('10.000 observasi');
  expect(await page.evaluate(() => window.spaMarker)).toBe('preserved');
  await page.getByRole('link', { name: 'Langsung ke konten' }).focus();
  await page.getByRole('link', { name: 'Langsung ke konten' }).press('Enter');
  await expect(page).toHaveURL(/#analitik$/);
  await expect(page.locator('#main')).toBeFocused();
  await page.getByRole('link', { name: 'Ringkasan', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Temperatur target' })).toHaveValue('25');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Analitik energi', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Analitik energi', exact: true })).toBeVisible();
});

test('analytics loads on demand and supports periods, chart modes, and model comparison', async ({ page }) => {
  await setup(page);
  let requests = 0;
  page.on('request', (request) => { if (request.url().includes('/analytics/summary')) requests++; });
  await page.goto('/');
  await expect(page.locator('.temperature-value')).toContainText('27,2');
  expect(requests).toBe(0);
  await page.getByRole('link', { name: 'Analitik', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Ringkasan energi' })).toContainText('642,5');
  await page.getByLabel('Periode data', { exact: true }).selectOption('1');
  await expect(page.getByRole('region', { name: 'Ringkasan energi' })).toContainText('1.440 observasi');
  await page.getByRole('button', { name: 'Temperatur', exact: true }).click();
  await expect(page.getByRole('img', { name: /Rata-rata temperatur per jam/ })).toBeVisible();
  await page.locator('.chart-data > summary').click();
  await expect(page.locator('.chart-data table tbody tr')).toHaveCount(24);
  await page.getByText('Bandingkan model', { exact: true }).click();
  await expect(page.getByText('Regresi linear', { exact: true })).toBeVisible();
});

test('simulations calculate costs, use presets, and never send hardware commands', async ({ page }) => {
  await setup(page);
  const predictions = [];
  let commands = 0;
  await page.route('**/api/command', (route) => { commands++; return route.abort(); });
  await page.route('**/api/analytics/predict', (route) => {
    predictions.push(route.request().postDataJSON());
    return route.fulfill({ json: { power_w: 812.5, features: predictions.at(-1) } });
  });
  await page.goto('/#analitik');
  await expect(page.getByRole('button', { name: 'Hitung perkiraan' })).toBeEnabled();
  await page.getByLabel('Skenario', { exact: true }).selectOption('hot');
  await page.getByRole('button', { name: 'Hitung perkiraan' }).click();
  await expect(page.getByTestId('predicted-power')).toHaveText('812,5 W');
  expect(predictions[0]).toMatchObject({ indoor_temp_c: 30.5, target_temp_c: 18, fan_speed: 'High', occupancy_count: 8 });
  await page.getByLabel('Tarif / kWh').fill('2000');
  await expect(page.locator('.daily-estimate')).toContainText('13.000');
  await page.getByLabel('Target AC (°C)', { exact: true }).fill('25');
  await expect(page.getByTestId('predicted-power')).toHaveCount(0);
  expect(commands).toBe(0);
});

test('live inputs use fresh sensor data and leave occupancy as an estimate', async ({ page }) => {
  await setup(page);
  await page.route('**/api/dashboard', (route) => {
    const value = dashboard();
    value.transmit.hum = 58.4;
    return route.fulfill({ json: value });
  });
  await page.route('**/api/analytics/predict', (route) => route.fulfill({ json: { power_w: 500, features: route.request().postDataJSON() } }));
  await page.goto('/#analitik');
  await page.getByRole('button', { name: 'Gunakan data ruangan' }).click();
  await expect(page.getByLabel('Temperatur dalam (°C)', { exact: true })).toHaveValue('27.2');
  await expect(page.getByLabel('Temperatur luar (°C)', { exact: true })).toHaveValue('29');
  await expect(page.getByLabel('Perkiraan penghuni', { exact: true })).toHaveValue('3');
  await expect(page.getByText(/Jumlah penghuni tetap berupa perkiraan/)).toBeVisible();
  await page.getByRole('button', { name: 'Hitung perkiraan' }).click();
  await expect(page.getByTestId('predicted-power')).toHaveText('500 W');
});

test('CSV uploads produce previews and downloadable full results', async ({ page }) => {
  await setup(page);
  const csv = 'indoor_temp_c,target_temp_c\n28,24\n29,25\n';
  await page.route('**/api/analytics/batch', (route) => {
    expect(route.request().headers()['content-type']).toBe('text/csv');
    expect(route.request().postData()).toBe(csv);
    return route.fulfill({ json: { row_count: 2, average_power_w: 700,
      preview: [{ indoor_temp_c: 28, target_temp_c: 24, predicted_power_w: 650 }, { indoor_temp_c: 29, target_temp_c: 25, predicted_power_w: 750 }],
      csv: 'indoor_temp_c,target_temp_c,predicted_power_w\n28,24,650\n29,25,750\n' } });
  });
  await page.goto('/#analitik');
  await page.getByLabel('Pilih file CSV', { exact: true }).setInputFiles({ name: 'telemetri.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Analisis file' }).click();
  await expect(page.getByText('2 baris selesai.', { exact: true })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Unduh hasil' }).click()]);
  expect(download.suggestedFilename()).toBe('prediksi-daya.csv');
});

test('analytics failures can be retried while room controls remain available', async ({ page }) => {
  await setup(page);
  let unavailable = true;
  await page.route('**/api/analytics/summary*', (route) => unavailable
    ? route.fulfill({ status: 503, json: { detail: 'Layanan analitik belum dapat dihubungi.' } }) : route.fulfill({ json: summary() }));
  await page.goto('/#analitik');
  await expect(page.getByRole('heading', { name: 'Analitik belum tersedia' })).toBeVisible();
  await page.getByRole('link', { name: 'Ringkasan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ringkasan ruangan' })).toBeVisible();
  await page.getByRole('link', { name: 'Analitik', exact: true }).click();
  unavailable = false;
  await page.getByRole('button', { name: 'Coba lagi' }).click();
  await expect(page.getByRole('region', { name: 'Ringkasan energi' })).toBeVisible();
});

test('missing models disable prediction and invalid CSV errors remain visible', async ({ page }) => {
  await setup(page);
  let ready = false;
  await page.route('**/api/analytics/summary*', (route) => route.fulfill({ json: { ...summary(), model_ready: ready } }));
  await page.goto('/#analitik');
  await expect(page.getByRole('button', { name: 'Hitung perkiraan' })).toBeDisabled();
  await expect(page.getByText('Model belum siap', { exact: true })).toBeVisible();
  ready = true;
  await page.getByRole('button', { name: 'Muat ulang data' }).click();
  await expect(page.getByRole('button', { name: 'Hitung perkiraan' })).toBeEnabled();
  await page.route('**/api/analytics/batch', (route) => route.fulfill({ status: 422, json: { detail: 'Kolom CSV belum lengkap: indoor_temp_c' } }));
  await page.getByLabel('Pilih file CSV', { exact: true }).setInputFiles({ name: 'invalid.csv', mimeType: 'text/csv', buffer: Buffer.from('x\n1') });
  await page.getByRole('button', { name: 'Analisis file' }).click();
  await expect(page.getByText('Kolom CSV belum lengkap: indoor_temp_c', { exact: true })).toBeVisible();
});

for (const width of [320, 390, 768, 1440]) {
  test(`analytics fits ${width}px in light and dark themes`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page);
    await page.goto('/#analitik');
    await expect(page.getByRole('region', { name: 'Ringkasan energi' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    if (width === 390 || width === 1440) await page.screenshot({ path: testInfo.outputPath('analytics-light.png'), fullPage: true });
    await page.getByRole('button', { name: 'Gunakan tema gelap' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    if (width === 1440) await page.screenshot({ path: testInfo.outputPath('analytics-dark.png'), fullPage: true });
  });
}
