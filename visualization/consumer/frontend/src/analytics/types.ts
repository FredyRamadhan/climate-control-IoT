export interface HourlyReading {
  hour: number
  power_w: number
  indoor_temp_c: number
  outdoor_temp_c: number
  active_percent: number
  count: number
}

export interface ModelMetrics {
  r2_score: number
  rmse: number
  mae: number
  mape_percent: number
}

export interface AnalyticsSummary {
  dataset: { source: 'synthetic'; rows: number; total_rows: number; start: string; end: string; sample_interval_seconds: number }
  metrics: { average_power_w: number; active_percent: number; energy_kwh: number; average_indoor_c: number; average_outdoor_c: number }
  hourly: HourlyReading[]
  occupancy: Array<{ label: string; records: number; power_w: number | null }>
  model_ready: boolean
  evaluation: {
    name: string
    trained_at: string
    training_samples: number
    test_samples: number
    metrics: ModelMetrics
    benchmarks: Array<ModelMetrics & { name: string }>
  } | null
}

export interface SimulationInput {
  indoor_temp_c: number
  indoor_humidity: number
  outdoor_temp_c: number
  outdoor_humidity: number
  occupancy_count: number
  target_temp_c: number
  hour_of_day: number
  motion_detected: 0 | 1
  ac_power_state: 0 | 1
  weather_condition: 'Clear' | 'Clouds' | 'Rain' | 'Thunderstorm'
  fan_speed: 'Low' | 'Medium' | 'High' | 'Auto' | 'Off'
}

export interface Prediction {
  power_w: number
  features: SimulationInput & { temp_delta: number }
}

export interface BatchResult {
  row_count: number
  average_power_w: number
  preview: Array<Record<string, string | number | null>>
  csv: string
}

export async function analyticsRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/analytics/${path}`, {
    ...options, signal: options.signal ?? AbortSignal.timeout(30000), cache: 'no-store',
  })
  const body = await response.json()
  if (!response.ok) {
    throw new Error(typeof body.detail === 'string' ? body.detail
      : response.status === 422 ? 'Nilai simulasi tidak valid. Periksa semua isian lalu coba lagi.'
        : 'Analitik belum dapat dimuat. Coba lagi beberapa saat lagi.')
  }
  return body as T
}

export function money(value: number, currency: 'IDR' | 'USD'): string {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency, maximumFractionDigits: currency === 'IDR' ? 0 : 2 }).format(value)
}

export const modelNames: Record<string, string> = {
  hist_gradient_boosting: 'Gradient boosting', random_forest: 'Random forest',
  linear: 'Regresi linear', ridge: 'Regresi ridge',
}
