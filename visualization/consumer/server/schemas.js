import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TOPICS } from './topics.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const optionalString = z.string().nullable().optional();
const optionalBoolean = z.boolean().nullable().optional();
const optionalInteger = z.number().int().nullable().optional();

const telemetrySchema = z.object({
  motion: z.boolean(),
  temp: z.number(),
  hum: z.number(),
  timestamp: z.number().int(),
  fan_speed: z.string(),
  relay_on: z.boolean(),
  target_temp: z.number().int(),
  sensor_ok: z.boolean(),
  ir_sent: z.boolean(),
  uptime_ms: z.number().int(),
  override: z.boolean(),
  ir_code: optionalString,
  warmup: optionalBoolean,
  override_source: optionalString,
  override_indefinite: optionalBoolean,
  override_remaining_s: optionalInteger,
}).passthrough();

const receiveSchema = z.object({
  ac_power_state: z.boolean(),
  temp: z.number(),
  fan_speed: z.string(),
  timestamp: z.number().int(),
  state_valid: z.boolean(),
  source: optionalString,
}).passthrough();

export const ackSchema = z.object({
  ok: z.boolean(),
  override: z.boolean(),
  raw_only: z.boolean(),
  timestamp: z.number().int(),
  request_id: optionalString,
  action: optionalString,
  override_source: optionalString,
  override_indefinite: optionalBoolean,
  override_remaining_s: optionalInteger,
  applied: z.object({
    relay_on: z.boolean(),
    target_temp: z.number().int(),
    fan_speed: z.string(),
  }).passthrough().nullable().optional(),
  ir_code: optionalString,
  error: optionalString,
}).passthrough();

const statusSchema = z.object({ online: z.boolean() }).strip();

const schemas = new Map([
  [TOPICS.transmit, telemetrySchema],
  [TOPICS.receive, receiveSchema],
  [TOPICS.command, ackSchema],
  [TOPICS.transmit_status, statusSchema],
  [TOPICS.receive_status, statusSchema],
]);

export function normalizePayload(topic, payload) {
  const schema = schemas.get(topic);
  if (!schema) return { data: payload, valid: true };
  const result = schema.safeParse(payload);
  if (!result.success) return { data: payload, valid: false };
  return {
    data: Object.fromEntries(Object.entries(result.data).filter(([, value]) => value != null)),
    valid: true,
  };
}

const commandSchema = z.object({
  action: z.enum(['override', 'release', 'raw']),
  request_id: z.string().trim().min(1).max(128).nullable().optional(),
  relay_on: optionalBoolean,
  target_temp: optionalInteger,
  fan_speed: optionalString,
  ir_code: optionalString,
  duration_s: z.number().int().min(0).max(86400).default(60),
}).strict();

export function buildCommand(body) {
  const result = commandSchema.safeParse(body);
  if (!result.success) {
    throw new HttpError(422, result.error.issues
      .map((issue) => `${issue.path.join('.') || 'command'}: ${issue.message}`).join('; '));
  }
  const req = result.data;
  const requestId = req.request_id || `dash-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const hasControl = ['relay_on', 'target_temp', 'fan_speed'].some((field) => req[field] != null);

  if (req.action === 'release') {
    if (hasControl || req.ir_code != null) {
      throw new HttpError(422, 'release does not accept relay/temp/fan/ir_code fields');
    }
    return { action: 'release', request_id: requestId };
  }

  if (req.action === 'raw') {
    if (hasControl) throw new HttpError(422, 'relay/temp/fan cannot be combined with a raw frame');
    const code = (req.ir_code ?? '').trim().replace(/^0x/i, '');
    if (!/^[0-9a-f]{1,8}$/i.test(code)) {
      throw new HttpError(422, 'ir_code must contain 1-8 hexadecimal digits');
    }
    return {
      action: 'raw',
      ir_code: `0x${code.toUpperCase().padStart(8, '0')}`,
      duration_s: req.duration_s,
      request_id: requestId,
    };
  }

  if (req.ir_code != null) throw new HttpError(422, 'ir_code only applies to the raw action');
  if (!hasControl) throw new HttpError(422, 'override requires at least one of relay_on, target_temp, fan_speed');
  if (req.target_temp != null && (req.target_temp < 16 || req.target_temp > 30)) {
    throw new HttpError(422, 'target_temp must be between 16 and 30 Celsius');
  }
  if (req.fan_speed != null && !['off', 'low', 'medium', 'high'].includes(req.fan_speed)) {
    throw new HttpError(422, 'fan_speed must be one of: off, low, medium, high');
  }

  return {
    action: 'override',
    duration_s: req.duration_s,
    request_id: requestId,
    ...Object.fromEntries(['relay_on', 'target_temp', 'fan_speed']
      .filter((field) => req[field] != null).map((field) => [field, req[field]])),
  };
}
