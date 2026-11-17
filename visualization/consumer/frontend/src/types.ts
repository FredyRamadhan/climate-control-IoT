export type FanSpeed = 'off' | 'low' | 'medium' | 'high'

export interface Telemetry {
  temp?: number
  hum?: number
  motion?: boolean
  timestamp?: number
  fan_speed?: string
  relay_on?: boolean
  target_temp?: number
  sensor_ok?: boolean
  warmup?: boolean
  ir_sent?: boolean
  uptime_ms?: number
  override?: boolean
  override_indefinite?: boolean
  override_remaining_s?: number
}

export interface ReceiveState {
  ac_power_state?: boolean
  temp?: number
  fan_speed?: string
  timestamp?: number
  state_valid?: boolean
}

export interface Weather {
  name?: string
  dt?: number
  main?: { temp?: number; humidity?: number }
  weather?: Array<{ main?: string; description?: string }>
}

export interface CommandAck {
  ok: boolean
  request_id?: string
  action?: string
  override?: boolean
  error?: string
  applied?: { relay_on: boolean; target_temp: number; fan_speed: FanSpeed }
}

export interface Metadata {
  received_at: string
  schema_valid: boolean
  retained: boolean
}

export interface Dashboard {
  health: { status: string; mqtt: boolean; subscriptions_ready: boolean }
  transmit: Telemetry | null
  receive: ReceiveState | null
  transmit_status: { online?: boolean } | null
  receive_status: { online?: boolean } | null
  command: CommandAck | null
  weather: Weather | null
  metadata: Partial<Record<'transmit' | 'receive' | 'transmit_status' | 'receive_status' | 'weather' | 'command', Metadata | null>>
  stale_after_seconds: number
  server_time: string
}

export interface CommandResult {
  request_id: string
  sent: Record<string, unknown>
  ack: CommandAck | null
  detail?: string
}

export type Connection = 'loading' | 'online' | 'offline'
