import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTelegramStatus } from '../telegram-status.js';
import { TelemetryStore } from '../store.js';
import { TOPICS } from '../topics.js';
import { telemetry } from './helpers.js';
import { EPOCH } from './telegram-helpers.js';

function fixture({ tx = {}, rx = {}, age = 0, retained = false } = {}) {
  const store = new TelemetryStore();
  const received = EPOCH - age * 1000;
  store.record(TOPICS.transmit, { ...telemetry, ...tx }, received, { retained });
  store.record(TOPICS.receive, { ac_power_state: true, temp: 24, fan_speed: 'medium',
    timestamp: 1, state_valid: true, ...rx }, received, { retained });
  store.record(TOPICS.weather, { main: { temp: 301.15, humidity: 76 }, weather: [{ main: 'Clouds' }] }, received);
  const format = (extra = {}) => formatTelegramStatus({ snapshot: store.snapshot(), mqttConnected: true,
    subscriptionsReady: true, timezone: 'Asia/Jakarta', now: EPOCH, ...extra });
  return { store, format };
}

test('status combines real room, receiver and weather readings in Indonesian with timezone and timestamps', () => {
  const text = fixture().format();
  for (const value of ['Status ruangan', '12.00.00', 'MQTT: Terhubung', 'Pengendali: Terhubung',
    'Penerima: Terhubung', 'Suhu ruangan: 26,4°C', 'Kelembapan: 58%', 'Gerakan: Terdeteksi',
    'AC target: Nyala / 24°C / Kipas Sedang', 'AC penerima: Nyala / 24°C / Kipas Sedang',
    'Mode: Otomatis', 'Cuaca luar: 28°C / Berawan', 'Kelembapan luar: 76%',
    'Pembaruan ruangan:', 'Pembaruan cuaca:']) assert.ok(text.includes(value), value);
  assert.doesNotMatch(text, /berbeda|undefined|NaN/);
  assert.ok(text.length < 4096);
  assert.ok(fixture().format({ timezone: 'UTC' }).includes('05.00.00'));
});

test('status clearly labels desired versus receiver state and only compares fresh confirmations', () => {
  const current = fixture({ rx: { ac_power_state: false, temp: 26, fan_speed: 'off' } }).format();
  assert.match(current, /AC target: Nyala/);
  assert.match(current, /AC penerima: Mati/);
  assert.match(current, /Konfirmasi AC berbeda dari target/);
  assert.doesNotMatch(fixture({ rx: { temp: 26 }, age: 31 }).format(), /berbeda dari target/);
  assert.match(fixture({ rx: { state_valid: false } }).format(), /Belum ada konfirmasi yang valid/);
});

test('missing or schema-invalid telemetry is unavailable rather than fabricated', () => {
  const store = new TelemetryStore();
  const empty = formatTelegramStatus({ snapshot: store.snapshot(), mqttConnected: false,
    timezone: 'Asia/Jakarta', now: EPOCH });
  assert.match(empty, /Suhu ruangan: Tidak tersedia/);
  assert.match(empty, /Mode: Tidak diketahui/);
  assert.match(empty, /Cuaca luar: belum ada data/);
  assert.doesNotMatch(empty, /undefined|NaN|null|kWh|prediksi/i);
  store.record(TOPICS.transmit, { ...telemetry, sensor_ok: 'true', temp: 99 }, EPOCH);
  const invalid = formatTelegramStatus({ snapshot: store.snapshot(), mqttConnected: true,
    timezone: 'Asia/Jakarta', now: EPOCH });
  assert.match(invalid, /format data tidak valid/);
  assert.match(invalid, /Suhu ruangan: Tidak tersedia/);
  assert.ok(!invalid.includes('99'));
});

test('sensor failures and warmup hide temperature and humidity but preserve motion', () => {
  for (const tx of [{ sensor_ok: false }, { warmup: true }]) {
    const text = fixture({ tx }).format();
    assert.match(text, /Suhu ruangan: Tidak tersedia/);
    assert.match(text, /Kelembapan: Tidak tersedia/);
    assert.match(text, /Gerakan: Terdeteksi/);
    assert.match(text, /sensor suhu tidak valid|sensor sedang disiapkan/);
  }
});

test('offline, stale, retained and unknown-age snapshots do not claim a live connection', () => {
  const stale = fixture({ age: 1800 });
  assert.match(stale.format(), /data lama, 30 menit lalu/);
  assert.match(stale.format(), /Status target: pembacaan terakhir/);
  assert.match(stale.format({ mqttConnected: false }), /Tidak terhubung \(MQTT terputus\)/);
  assert.match(fixture({ retained: true }).format(), /data tersimpan/);
  const offline = fixture();
  offline.store.record(TOPICS.transmit_status, { online: false }, EPOCH);
  assert.match(offline.format(), /Pengendali: Offline/);
  const snapshot = offline.store.snapshot();
  snapshot.metadata.transmit.received_at = 'not-a-date';
  assert.match(offline.format({ snapshot }), /waktu data tidak diketahui/);
  assert.match(offline.format({ subscriptionsReady: false }), /Menyiapkan koneksi topik/);
});

test('manual overrides report timed or indefinite duration as of the last telemetry update', () => {
  assert.match(fixture({ tx: { override: true, override_remaining_s: 125 } }).format(),
    /Mode: Manual \(2 menit tersisa pada pembaruan terakhir\)/);
  assert.match(fixture({ tx: { override: true, override_indefinite: true } }).format(), /Mode: Manual \(sampai dilepas\)/);
  assert.match(fixture({ tx: { override: true } }).format(), /Mode: Manual\n/);
  assert.match(fixture({ tx: { motion: false } }).format(), /Gerakan: Tidak ada/);
});

test('weather supports Celsius and zero humidity; arbitrary strings and analytics never enter the report', () => {
  const { store, format } = fixture({ tx: { fan_speed: 'constructor', secret: 'never-print-this' } });
  store.record(TOPICS.weather, { main: { temp: 0, humidity: 0 }, weather: [{ main: 'constructor' }],
    predictions: 'never-print-this', description: 'never-print-this' }, EPOCH);
  const text = format();
  assert.match(text, /Cuaca luar: 0°C \/ Kondisi tidak diketahui/);
  assert.match(text, /Kelembapan luar: 0%/);
  assert.match(text, /Kipas Tidak diketahui/);
  assert.doesNotMatch(text, /never-print-this|function|synthetic|predictions/);
  store.record(TOPICS.weather, { main: { temp: 'hot', humidity: null }, weather: null }, EPOCH);
  assert.match(format(), /Cuaca luar: Tidak tersedia/);
  assert.match(format(), /Kelembapan luar: Tidak tersedia/);
});
