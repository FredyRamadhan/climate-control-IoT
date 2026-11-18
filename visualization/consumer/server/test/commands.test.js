import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCommand } from '../schemas.js';
import { readConfig } from '../config.js';

test('override preserves false, zero-duration, and all supported fields', () => {
  assert.deepEqual(buildCommand({
    action: 'override', request_id: 'test-override', relay_on: false,
    light_on: true, target_temp: 16, fan_speed: 'off', duration_s: 0,
  }), {
    action: 'override', request_id: 'test-override', relay_on: false,
    light_on: true, target_temp: 16, fan_speed: 'off', duration_s: 0,
  });
});

test('lighting relay can be overridden on its own', () => {
  assert.deepEqual(buildCommand({ action: 'override', request_id: 'light', light_on: false }), {
    action: 'override', request_id: 'light', light_on: false, duration_s: 60,
  });
});

test('partial overrides default to sixty seconds and receive a unique request ID', () => {
  const first = buildCommand({ action: 'override', target_temp: 30 });
  const second = buildCommand({ action: 'override', fan_speed: 'high' });
  assert.equal(first.duration_s, 60);
  assert.equal(first.target_temp, 30);
  assert.notEqual(first.request_id, second.request_id);
  assert.equal(Object.hasOwn(first, 'relay_on'), false);
});

test('release strips duration from the transmitted payload', () => {
  assert.deepEqual(buildCommand({ action: 'release', request_id: 'release', duration_s: 30 }), {
    action: 'release', request_id: 'release',
  });
});

test('raw frames are normalized to eight uppercase hexadecimal digits', () => {
  assert.equal(buildCommand({ action: 'raw', ir_code: ' 0xab12 ' }).ir_code, '0x0000AB12');
  assert.equal(buildCommand({ action: 'raw', ir_code: 'ffffffff' }).ir_code, '0xFFFFFFFF');
});

const invalid = [
  null, [], {}, { action: 'unknown' }, { action: 'override' },
  { action: 'override', target_temp: 15 }, { action: 'override', target_temp: 31 },
  { action: 'override', target_temp: 24.5 }, { action: 'override', target_temp: '24' },
  { action: 'override', relay_on: 'false' }, { action: 'override', light_on: 'true' },
  { action: 'override', fan_speed: 'auto' },
  { action: 'override', relay_on: true, duration_s: -1 },
  { action: 'override', relay_on: true, duration_s: 86401 },
  { action: 'override', relay_on: true, unexpected: true },
  { action: 'override', relay_on: true, ir_code: 'a' },
  { action: 'release', relay_on: false }, { action: 'release', ir_code: 'a' },
  { action: 'raw' }, { action: 'raw', ir_code: 'xyz' },
  { action: 'raw', ir_code: '100000000' }, { action: 'raw', ir_code: '-1' },
  { action: 'raw', ir_code: '1', target_temp: 24 },
  { action: 'release', request_id: ' ' }, { action: 'release', request_id: 'x'.repeat(129) },
];
for (const body of invalid) {
  test(`rejects invalid command ${JSON.stringify(body)}`, () => {
    assert.throws(() => buildCommand(body), (error) => error.status === 422);
  });
}

test('configuration rejects invalid ports and timeouts', () => {
  assert.throws(() => readConfig({ PORT: 'nope' }), /PORT/);
  assert.throws(() => readConfig({ MQTT_PORT: '65536' }), /MQTT_PORT/);
  assert.throws(() => readConfig({ COMMAND_ACK_TIMEOUT: '-1' }), /COMMAND_ACK_TIMEOUT/);
  assert.equal(readConfig({ COMMAND_ACK_TIMEOUT: '0.5', MQTT_USER: '' }).COMMAND_ACK_TIMEOUT, 0.5);
  assert.equal(readConfig({ MQTT_USER: '' }).MQTT_USER, '');
  assert.equal(readConfig({ MQTT_CLIENT_ID: '' }).MQTT_CLIENT_ID, undefined);
});
