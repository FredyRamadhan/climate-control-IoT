import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { readConfig } from './config.js';
import { isTelegramToken, TelegramClient, TelegramError, telegramFailure } from './telegram-client.js';
import { discoverTelegramGroups } from './telegram-setup.js';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) dotenv.config({ path: envPath, quiet: true });
const controller = new AbortController();
const cancel = () => controller.abort();
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);

try {
  const config = readConfig();
  if (config.TELEGRAM_ENABLED) throw new Error('Set TELEGRAM_ENABLED=false and stop running consumers before using telegram:setup.');
  if (!isTelegramToken(config.TELEGRAM_BOT_TOKEN)) throw new Error('Set a valid TELEGRAM_BOT_TOKEN in the consumer .env first.');
  const result = await discoverTelegramGroups({ client: new TelegramClient(config.TELEGRAM_BOT_TOKEN),
    token: config.TELEGRAM_BOT_TOKEN, signal: controller.signal });
  if (result.blocked || result.groups.length === 0) process.exitCode = 1;
} catch (error) {
  // Only controlled config/setup messages are printed. Raw network errors contain token URLs.
  const message = controller.signal.aborted ? 'Telegram setup cancelled.'
    : error instanceof TelegramError ? telegramFailure(error)
      : error.message.startsWith('Invalid environment:') || error.message.startsWith('Set ')
        ? error.message : 'Telegram setup failed. Check the bot configuration and connection.';
  console.error(message);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
