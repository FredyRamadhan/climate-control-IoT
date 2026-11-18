import type { Dashboard, Metadata } from '../types'

export const fanLabels: Record<string, string> = {
  off: 'Mati', low: 'Rendah', medium: 'Sedang', high: 'Tinggi',
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function number(value: unknown, digits = 1): string {
  return isNumber(value) ? value.toLocaleString('id-ID', { maximumFractionDigits: digits }) : '—'
}

export function duration(seconds: unknown): string {
  if (!isNumber(seconds) || seconds <= 0) return 'Menunggu pembaruan'
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)} jam`
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} menit`
  return `${Math.ceil(seconds)} detik`
}

export function time(value: string | number | null | undefined): string {
  if (value == null) return 'Belum ada data'
  const date = new Date(typeof value === 'number' ? value * 1000 : value)
  if (Number.isNaN(date.getTime())) return 'Belum ada data'
  return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function isStale(metadata: Metadata | null | undefined, dashboard: Dashboard | null): boolean {
  if (!metadata || !dashboard) return true
  // Retained telemetry has no reliable receipt age after a new connection.
  // Wait for the next live frame before treating the device as current.
  if (metadata.retained) return true
  // Compare server timestamps, so a browser's clock cannot make old data appear current.
  const received = Date.parse(metadata.received_at)
  const serverTime = Date.parse(dashboard.server_time)
  return !Number.isFinite(received) || !Number.isFinite(serverTime)
    || serverTime - received > dashboard.stale_after_seconds * 1000
}

const weatherLabels: Record<string, string> = {
  clear: 'Cerah', clouds: 'Berawan', rain: 'Hujan', drizzle: 'Gerimis',
  thunderstorm: 'Badai petir', snow: 'Salju', mist: 'Berkabut', fog: 'Berkabut',
  haze: 'Berkabut', smoke: 'Berasap', dust: 'Berdebu', sand: 'Berdebu',
  ash: 'Abu vulkanik', squall: 'Angin kencang', tornado: 'Puting beliung',
}

export function weatherLabel(condition: unknown): string {
  if (typeof condition !== 'string' || !condition.trim()) return 'Menunggu data cuaca'
  const text = condition.trim().toLowerCase()
  if (weatherLabels[text]) return weatherLabels[text]
  if (/thunder|storm|petir|badai/i.test(text)) return 'Badai petir'
  if (/drizzle|gerimis/i.test(text)) return 'Gerimis'
  if (/rain|hujan/i.test(text)) return 'Hujan'
  if (/cloud|awan|mendung/i.test(text)) return 'Berawan'
  if (/clear|cerah|sun/i.test(text)) return 'Cerah'
  if (/snow|salju/i.test(text)) return 'Salju'
  if (/mist|fog|haze|kabut/i.test(text)) return 'Berkabut'
  return condition
}

export function celsius(value: unknown): number | undefined {
  if (!isNumber(value)) return undefined
  return value > 120 ? value - 273.15 : value
}
