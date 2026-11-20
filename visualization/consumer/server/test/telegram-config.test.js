import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readConfig } from '../config.js';
import { BOT_TOKEN, GROUP_ID } from './telegram-helpers.js';

const enabled = { TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_CHAT_ID: GROUP_ID };

test('Telegram is disabled by default, with a 30-minute schedule and Jakarta timezone', () => {
  const config = readConfig({});
  assert.equal(config.TELEGRAM_ENABLED, false);
  assert.equal(config.TELEGRAM_INTERVAL_MINUTES, 30);
  assert.equal(config.TELEGRAM_TIMEZONE, 'Asia/Jakarta');
  assert.equal(config.TELEGRAM_BOT_TOKEN, '');
  assert.equal(config.TELEGRAM_CHAT_ID, '');
  assert.equal(readConfig({ TELEGRAM_ENABLED: 'false', TELEGRAM_BOT_TOKEN: BOT_TOKEN }).TELEGRAM_ENABLED, false);
  assert.equal(readConfig(enabled).TELEGRAM_ENABLED, true);
});

test('Telegram enable flag accepts only explicit true/false strings', () => {
  for (const flag of ['yes', '1', 'TRUE', '', true, false]) {
    assert.throws(() => readConfig({ ...enabled, TELEGRAM_ENABLED: flag }), /TELEGRAM_ENABLED/);
  }
});

test('enabled Telegram requires a token and a safe numeric group ID without logging secrets', () => {
  assert.throws(() => readConfig({ TELEGRAM_ENABLED: 'true' }), /TELEGRAM_BOT_TOKEN.*TELEGRAM_CHAT_ID/);
  for (const chat of ['123', '0', '@a_group', '-0', '-01', '-1.5', '-9007199254740992', '']) {
    assert.throws(() => readConfig({ ...enabled, TELEGRAM_CHAT_ID: chat }), /TELEGRAM_CHAT_ID/);
  }
  for (const token of ['', 'secret-that-must-not-appear', '123:short', `${BOT_TOKEN}\n${BOT_TOKEN}`]) {
    assert.throws(() => readConfig({ ...enabled, TELEGRAM_BOT_TOKEN: token }), (error) => {
      assert.match(error.message, /TELEGRAM_BOT_TOKEN/);
      if (token) assert.ok(!error.message.includes(token));
      return true;
    });
  }
  assert.equal(readConfig({ ...enabled, TELEGRAM_CHAT_ID: '-42' }).TELEGRAM_CHAT_ID, '-42');
});

test('Telegram interval and timezone are validated even while disabled', () => {
  for (const interval of ['0', '-1', '1.5', '1441', '', 'nope']) {
    assert.throws(() => readConfig({ TELEGRAM_INTERVAL_MINUTES: interval }), /TELEGRAM_INTERVAL_MINUTES/);
  }
  for (const zone of ['', 'Not/A_Zone']) {
    assert.throws(() => readConfig({ TELEGRAM_TIMEZONE: zone }), /TELEGRAM_TIMEZONE/);
  }
  assert.equal(readConfig({ TELEGRAM_INTERVAL_MINUTES: '60', TELEGRAM_TIMEZONE: 'UTC' }).TELEGRAM_INTERVAL_MINUTES, 60);
});

test('setup CLI exits before networking if the token is missing or the worker is enabled', () => {
  const script = fileURLToPath(new URL('../setup-telegram.js', import.meta.url));
  for (const [environment, expected] of [
    [{ TELEGRAM_ENABLED: 'false', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' }, /Set a valid TELEGRAM_BOT_TOKEN/],
    [enabled, /Set TELEGRAM_ENABLED=false/],
  ]) {
    const result = spawnSync(process.execPath, [script], { windowsHide: true, timeout: 5000,
      encoding: 'utf8', env: { ...process.env, ...environment,
        TELEGRAM_INTERVAL_MINUTES: '30', TELEGRAM_TIMEZONE: 'Asia/Jakarta' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.ok(!result.stderr.includes(BOT_TOKEN));
    assert.equal(result.stdout, '');
  }
});
