import { z } from 'zod';

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
});

export function readConfig(environment = process.env) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Invalid environment: ${result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return result.data;
}
