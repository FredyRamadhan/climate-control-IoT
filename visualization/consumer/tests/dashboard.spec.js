import { test, expect } from '@playwright/test';

function dashboard() {
  const now = new Date().toISOString();
  const metadata = Object.fromEntries(['transmit', 'receive', 'transmit_status', 'receive_status', 'weather', 'command']
    .map((key) => [key, { received_at: now, schema_valid: true, retained: false }]));
  return {
    health: { status: 'ok', mqtt: true, subscriptions_ready: true },
    transmit: {
      temp: 26.4, hum: 58, motion: true, timestamp: Math.floor(Date.now() / 1000),
      target_temp: 24, fan_speed: 'medium', relay_on: true, light_on: true, sensor_ok: true,
      ir_sent: true, uptime_ms: 7200000, override: false,
    },
    receive: { temp: 24, fan_speed: 'medium', ac_power_state: true, timestamp: 1, state_valid: true },
    weather: { name: 'Surakarta', main: { temp: 301.15, humidity: 75 }, weather: [{ main: 'Rain' }] },
    transmit_status: { online: true }, receive_status: { online: true }, command: null,
    metadata, stale_after_seconds: 30, server_time: now,
  };
}

async function mockDashboard(page, getSnapshot) {
  await page.route('**/api/dashboard', (route) => route.fulfill({ json: getSnapshot() }));
}

test('renders real sensor values, converts Kelvin weather, and prefills device controls', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await mockDashboard(page, dashboard);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ringkasan ruangan' })).toBeVisible();
  await expect(page.locator('.temperature-value')).toContainText('26,4');
  await expect(page.locator('.sensor-card--weather .reading')).toHaveText('28°C');
  await expect(page.getByText('Hujan', { exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Temperatur target' })).toHaveValue('24');
  await expect(page.getByRole('button', { name: 'Sedang', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('switch', { name: 'Daya AC' })).toBeChecked();
  await expect(page.getByRole('switch', { name: 'Lampu ruangan' })).toBeChecked();
  await expect(page.locator('.device-detail').last()).toContainText('Nyala');
  await expect(page.getByRole('button', { name: 'Terapkan pengaturan' })).toBeEnabled();
  await expect(page.getByRole('img', { name: 'Unit air conditioner di ruang utama' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.locator('.ac-photo').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('keeps unsent edits through refresh, publishes chosen values, and releases override', async ({ page }) => {
  let snapshot = dashboard();
  const commands = [];
  await mockDashboard(page, () => snapshot);
  await page.route('**/api/command', async (route) => {
    const body = route.request().postDataJSON();
    commands.push(body);
    if (body.action === 'override') {
      snapshot = { ...dashboard(), transmit: { ...snapshot.transmit, target_temp: body.target_temp,
        fan_speed: body.fan_speed, relay_on: body.relay_on, light_on: body.light_on,
        override: true, override_indefinite: body.duration_s === 0 } };
    } else snapshot = { ...dashboard(), transmit: { ...snapshot.transmit, override: false } };
    await route.fulfill({ json: { request_id: body.request_id, sent: body, ack: { ok: true, override: body.action === 'override' } } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Terapkan pengaturan' })).toBeEnabled();
  await expect(page.getByLabel('Durasi override', { exact: true })).toHaveValue('0');
  await page.getByRole('button', { name: 'Naikkan temperatur' }).click();
  await page.getByRole('button', { name: 'Tinggi', exact: true }).click();
  await page.getByRole('switch', { name: 'Daya AC' }).click();
  await page.getByRole('switch', { name: 'Lampu ruangan' }).click();
  await page.getByLabel('Durasi override', { exact: true }).selectOption('0');
  await page.getByRole('button', { name: 'Muat ulang data' }).click();
  await expect(page.getByRole('slider', { name: 'Temperatur target' })).toHaveValue('25');
  await page.getByRole('button', { name: 'Terapkan pengaturan' }).click();
  await expect(page.getByText('Pengaturan diterapkan. Perangkat telah mengonfirmasi.')).toBeVisible();
  expect(commands[0]).toMatchObject({ action: 'override', target_temp: 25, fan_speed: 'high', relay_on: false, light_on: false, duration_s: 0 });
  expect(commands[0].request_id).toMatch(/^dash-/);
  await expect(page.getByText('Override aktif', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Kembali ke otomatis' }).click();
  await expect(page.getByText('Kontrol otomatis diaktifkan. Perangkat telah mengonfirmasi.')).toBeVisible();
  expect(Object.keys(commands[1]).sort()).toEqual(['action', 'request_id']);
  expect(commands[1].action).toBe('release');
});

test('an ACK timeout never claims the device applied the selection', async ({ page }) => {
  await mockDashboard(page, dashboard);
  await page.route('**/api/command', (route) => route.fulfill({ json: { ack: null, sent: {}, request_id: 'timeout' } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Terapkan pengaturan' })).toBeEnabled();
  await page.getByRole('button', { name: 'Naikkan temperatur' }).click();
  await page.getByRole('button', { name: 'Terapkan pengaturan' }).click();
  await expect(page.getByText(/Perintah terkirim, tetapi perangkat belum mengonfirmasi/)).toBeVisible();
  await expect(page.locator('.device-detail').first()).toContainText('24°C');
  await expect(page.getByText('Pengaturan diterapkan. Perangkat telah mengonfirmasi.')).toHaveCount(0);
});

test('confirmed controls follow later telemetry, including automatic changes', async ({ page }) => {
  let snapshot = dashboard();
  await mockDashboard(page, () => snapshot);
  await page.route('**/api/command', (route) => route.fulfill({ json: { ack: { ok: true } } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Terapkan pengaturan' })).toBeEnabled();
  await page.getByRole('button', { name: 'Naikkan temperatur' }).click();
  await page.getByRole('button', { name: 'Terapkan pengaturan' }).click();
  await expect(page.getByText('Pengaturan diterapkan. Perangkat telah mengonfirmasi.')).toBeVisible();
  snapshot = dashboard();
  snapshot.transmit.target_temp = 23;
  snapshot.transmit.fan_speed = 'low';
  await page.getByRole('button', { name: 'Muat ulang data' }).click();
  await expect(page.getByRole('slider', { name: 'Temperatur target' })).toHaveValue('23');
  await expect(page.getByRole('button', { name: 'Rendah', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('manual commands work without the secure-context randomUUID API on HTTP LANs', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window.crypto, 'randomUUID', { value: undefined }));
  await mockDashboard(page, dashboard);
  let sent = null;
  await page.route('**/api/command', (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ json: { ack: { ok: true } } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Terapkan pengaturan' })).toBeEnabled();
  await page.getByRole('button', { name: 'Terapkan pengaturan' }).click();
  await expect(page.getByText('Pengaturan diterapkan. Perangkat telah mengonfirmasi.')).toBeVisible();
  expect(sent.request_id).toMatch(/^dash-/);
});

test('device rejections remain visible and preserve the live state', async ({ page }) => {
  await mockDashboard(page, dashboard);
  await page.route('**/api/command', (route) => route.fulfill({ json: { ack: { ok: false, error: 'IR unavailable' } } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Terapkan pengaturan' })).toBeEnabled();
  await page.getByRole('button', { name: 'Terapkan pengaturan' }).click();
  await expect(page.getByText('Perangkat menolak perintah: IR unavailable')).toBeVisible();
});

test('unreachable API retains last readings and disables sending', async ({ page }) => {
  let fail = false;
  await page.route('**/api/dashboard', (route) => fail ? route.abort() : route.fulfill({ json: dashboard() }));
  await page.goto('/');
  await expect(page.locator('.temperature-value')).toContainText('26,4');
  fail = true;
  await page.getByRole('button', { name: 'Muat ulang data' }).click();
  await expect(page.getByText('Layanan terputus', { exact: true })).toBeVisible();
  await expect(page.locator('.temperature-value')).toContainText('26,4');
  await expect(page.getByRole('button', { name: 'Terapkan pengaturan' })).toBeDisabled();
});

test('stale, warming-up, and invalid sensor payloads are handled explicitly', async ({ page }) => {
  let snapshot = dashboard();
  snapshot.metadata.transmit.received_at = new Date(Date.now() - 90000).toISOString();
  await mockDashboard(page, () => snapshot);
  await page.goto('/');
  await expect(page.getByText(/Data ruangan belum diperbarui/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Terapkan pengaturan' })).toBeDisabled();
  snapshot = dashboard();
  snapshot.transmit.warmup = true;
  await page.getByRole('button', { name: 'Muat ulang data' }).click();
  await expect(page.getByText(/Sensor sedang melakukan pemanasan/)).toBeVisible();
  await expect(page.locator('.temperature-value')).toHaveText('—°C');
  snapshot = dashboard();
  snapshot.transmit = 'invalid firmware payload';
  snapshot.weather = [];
  await page.getByRole('button', { name: 'Muat ulang data' }).click();
  await expect(page.getByText('Menunggu pembacaan sensor', { exact: true })).toBeVisible();
});

test('temperature bounds, keyboard controls, navigation, and persisted themes work', async ({ page }) => {
  await mockDashboard(page, dashboard);
  await page.goto('/');
  const slider = page.getByRole('slider', { name: 'Temperatur target' });
  await expect(slider).toHaveValue('24');
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveValue('16');
  await expect(page.getByRole('button', { name: 'Turunkan temperatur' })).toBeDisabled();
  await page.keyboard.press('End');
  await expect(slider).toHaveValue('30');
  await expect(page.getByRole('button', { name: 'Naikkan temperatur' })).toBeDisabled();
  await page.getByRole('button', { name: 'Gunakan tema gelap' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('link', { name: 'Status perangkat', exact: true }).click();
  await expect(page).toHaveURL(/#sistem$/);
});

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`dashboard fits ${width}px without horizontal overflow`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await mockDashboard(page, dashboard);
    await page.goto('/');
    await expect(page.locator('.temperature-value')).toContainText('26,4');
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    if (width === 390 || width === 1440) await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true });
  });
}
