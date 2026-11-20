import { z } from 'zod';
import { isTelegramToken } from './telegram-client.js';

const integer = (fallback, minimum, maximum) => z.coerce.number()
  .int().min(minimum).max(maximum).default(fallback);

const environmentSchema = z.object({
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: integer(8000, 1, 65535),
  MQTT_HOST: z.string().min(1).default('127.0.0.1'),
  MQTT_PORT: integer(1883, 1, 65535),
  MQTT_PROTOCOL: z.enum(['mqtt', 'mqtts']).default('mqtt'),
  MQTT_USER: z.string().default('iot_user'),
  MQTT_PASS: z.string().default('iot_password'),
  MQTT_CLIENT_ID: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  COMMAND_ACK_TIMEOUT: z.coerce.number().min(0.1).max(120).default(6),
  COMMAND_PUBLISH_TIMEOUT: z.coerce.number().min(0.1).max(30).default(2),
  STALE_AFTER_SECONDS: integer(30, 5, 3600),
  CORS_ORIGIN: z.string().default(''),
  TELEGRAM_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  TELEGRAM_BOT_TOKEN: z.string().trim().default(''),
  TELEGRAM_CHAT_ID: z.string().trim().default(''),
  TELEGRAM_INTERVAL_MINUTES: integer(30, 1, 1440),
  TELEGRAM_TIMEZONE: z.string().default('Asia/Jakarta').refine((value) => {
    try { new Intl.DateTimeFormat('id-ID', { timeZone: value }); return true; }
    catch { return false; }
  }, 'Use a valid IANA timezone'),
  ANALYTICS_URL: z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol),
    'Use an HTTP or HTTPS analytics URL').default('http://127.0.0.1:8001'),
}).superRefine((config, context) => {
  if (!config.TELEGRAM_ENABLED) return;
  if (!isTelegramToken(config.TELEGRAM_BOT_TOKEN)) {
    context.addIssue({ code: 'custom', path: ['TELEGRAM_BOT_TOKEN'], message: 'A valid BotFather token is required when Telegram is enabled' });
  }
  if (!/^-[1-9]\d*$/.test(config.TELEGRAM_CHAT_ID) || !Number.isSafeInteger(Number(config.TELEGRAM_CHAT_ID))) {
    context.addIssue({ code: 'custom', path: ['TELEGRAM_CHAT_ID'], message: 'A numeric Telegram group ID is required when Telegram is enabled' });
  }
});

export function readConfig(environment = process.env) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Invalid environment: ${result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return result.data;
}
