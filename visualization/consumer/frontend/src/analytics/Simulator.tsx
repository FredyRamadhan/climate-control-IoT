import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, CircleAlert, FlaskConical, LoaderCircle, Radio, Zap } from 'lucide-react'
import type { Dashboard } from '../types'
import { celsius, isNumber, isStale, number } from '../lib/format'
import { analyticsRequest, money } from './types'
import type { Prediction, SimulationInput } from './types'

const presets: Record<string, { label: string; values: SimulationInput }> = {
  comfort: { label: 'Nyaman', values: { indoor_temp_c: 28.5, indoor_humidity: 65, outdoor_temp_c: 33, outdoor_humidity: 75, occupancy_count: 3, target_temp_c: 24, hour_of_day: 14, motion_detected: 1, ac_power_state: 1, weather_condition: 'Clouds', fan_speed: 'Medium' } },
  eco: { label: 'Hemat', values: { indoor_temp_c: 24.5, indoor_humidity: 55, outdoor_temp_c: 28, outdoor_humidity: 70, occupancy_count: 2, target_temp_c: 24, hour_of_day: 16, motion_detected: 1, ac_power_state: 1, weather_condition: 'Clouds', fan_speed: 'Medium' } },
  hot: { label: 'Siang panas', values: { indoor_temp_c: 30.5, indoor_humidity: 68, outdoor_temp_c: 36.5, outdoor_humidity: 60, occupancy_count: 8, target_temp_c: 18, hour_of_day: 14, motion_detected: 1, ac_power_state: 1, weather_condition: 'Clear', fan_speed: 'High' } },
  vacant: { label: 'Ruangan kosong', values: { indoor_temp_c: 23.5, indoor_humidity: 50, outdoor_temp_c: 24, outdoor_humidity: 85, occupancy_count: 0, target_temp_c: 24, hour_of_day: 22, motion_detected: 0, ac_power_state: 1, weather_condition: 'Rain', fan_speed: 'Low' } },
  off: { label: 'AC mati', values: { indoor_temp_c: 26, indoor_humidity: 65, outdoor_temp_c: 23, outdoor_humidity: 90, occupancy_count: 0, target_temp_c: 24, hour_of_day: 3, motion_detected: 0, ac_power_state: 0, weather_condition: 'Clouds', fan_speed: 'Off' } },
}

export function Simulator({ ready, dashboard, tariff, currency }: { ready: boolean; dashboard: Dashboard | null; tariff: number; currency: 'IDR' | 'USD' }) {
  const [input, setInput] = useState<SimulationInput>(presets.comfort.values)
  const [preset, setPreset] = useState('comfort')
  const [prediction, setPrediction] = useState<Prediction | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [hours, setHours] = useState(8)
  const [liveNote, setLiveNote] = useState('')
  const controller = useRef<AbortController | null>(null)
  const lock = useRef(false)
  const canUseLive = dashboard?.health.mqtt === true && dashboard.transmit?.sensor_ok === true
    && dashboard.transmit.warmup !== true && dashboard.metadata.transmit?.schema_valid !== false
    && dashboard.transmit_status?.online !== false && !isStale(dashboard.metadata.transmit, dashboard)

  useEffect(() => () => controller.current?.abort(), [])

  function edit(patch: Partial<SimulationInput>) {
    setInput((current) => ({ ...current, ...patch }))
    setPreset('custom'); setPrediction(null); setError(''); setLiveNote('')
  }

  function useLive() {
    if (!canUseLive || !dashboard) return
    const tx = dashboard.transmit!
    const weather = dashboard.weather
    const outside = celsius(weather?.main?.temp)
    const fanMap: Record<string, SimulationInput['fan_speed']> = { off: 'Off', low: 'Low', medium: 'Medium', high: 'High' }
    const condition = weather?.weather?.[0]?.main
    edit({
      ...(isNumber(tx.temp) ? { indoor_temp_c: tx.temp } : {}),
      ...(isNumber(tx.hum) ? { indoor_humidity: tx.hum } : {}),
      ...(isNumber(tx.target_temp) ? { target_temp_c: tx.target_temp } : {}),
      ...(tx.fan_speed && fanMap[tx.fan_speed] ? { fan_speed: fanMap[tx.fan_speed] } : {}),
      ...(typeof tx.relay_on === 'boolean' ? { ac_power_state: tx.relay_on ? 1 : 0 } : {}),
      ...(typeof tx.motion === 'boolean' ? { motion_detected: tx.motion ? 1 : 0 } : {}),
      ...(!isStale(dashboard.metadata.weather, dashboard) && isNumber(outside) ? { outdoor_temp_c: Math.round(outside * 100) / 100 } : {}),
      ...(!isStale(dashboard.metadata.weather, dashboard) && isNumber(weather?.main?.humidity) ? { outdoor_humidity: weather.main.humidity } : {}),
      ...(!isStale(dashboard.metadata.weather, dashboard) && condition && ['Clear', 'Clouds', 'Rain', 'Thunderstorm'].includes(condition)
        ? { weather_condition: condition as SimulationInput['weather_condition'] } : {}),
      hour_of_day: new Date().getHours() + new Date().getMinutes() / 60,
    })
    setLiveNote('Pembacaan terbaru disalin. Jumlah penghuni tetap berupa perkiraan; periksa isian sebelum menghitung.')
  }

  async function predict() {
    if (lock.current || !ready) return
    lock.current = true; setBusy(true); setError(''); setPrediction(null)
    controller.current = new AbortController()
    const timer = setTimeout(() => controller.current?.abort(), 30000)
    try {
      const result = await analyticsRequest<Prediction>('predict', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input), signal: controller.current.signal,
      })
      if (!isNumber(result.power_w) || result.power_w < 0) throw new Error('Hasil prediksi belum valid. Coba lagi.')
      setPrediction(result)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Prediksi gagal dimuat.') }
    finally { clearTimeout(timer); lock.current = false; setBusy(false) }
  }

  return <section className="simulator-panel panel" aria-labelledby="simulator-title">
    <div className="panel-heading"><span className="heading-icon"><FlaskConical size={20} /></span><div><h2 id="simulator-title">Simulasi daya</h2><p>Coba pengaturan sebelum diterapkan.</p></div></div>
    <form onSubmit={(event) => { event.preventDefault(); void predict() }}>
      <fieldset disabled={busy} className="analytics-fieldset">
        <legend className="sr-only">Pengaturan simulasi daya</legend>
        <div className="analytics-field"><label htmlFor="simulation-scenario">Skenario</label><select id="simulation-scenario" value={preset} onChange={(event) => {
          const value = event.target.value
          if (!presets[value]) return
          setInput(presets[value].values); setPreset(value); setPrediction(null); setError(''); setLiveNote('')
        }}>{preset === 'custom' && <option value="custom">Pengaturan sendiri</option>}{Object.entries(presets).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></div>
        <button type="button" className="live-input-button" disabled={!canUseLive} onClick={useLive}><Radio size={14} />Gunakan data ruangan</button>
        {liveNote && <p className="analytics-hint" role="status">{liveNote}</p>}
        <div className="simulation-input-grid">
          <label className="analytics-field">Temperatur dalam (°C)<input type="number" min="10" max="50" step="any" required value={input.indoor_temp_c} onChange={(event) => edit({ indoor_temp_c: Number(event.target.value) })} /></label>
          <label className="analytics-field">Temperatur luar (°C)<input type="number" min="-20" max="60" step="any" required value={input.outdoor_temp_c} onChange={(event) => edit({ outdoor_temp_c: Number(event.target.value) })} /></label>
          <label className="analytics-field">Target AC (°C)<input type="number" min="16" max="30" step="1" required value={input.target_temp_c} onChange={(event) => edit({ target_temp_c: Number(event.target.value) })} /></label>
          <label className="analytics-field">Kipas<select value={input.fan_speed} onChange={(event) => edit({ fan_speed: event.target.value as SimulationInput['fan_speed'] })}>
            <option value="Low">Rendah</option><option value="Medium">Sedang</option><option value="High">Tinggi</option><option value="Auto">Otomatis</option><option value="Off">Mati</option>
          </select></label>
        </div>
        <div className="simulation-power-row"><label htmlFor="simulation-power">Daya AC</label><button type="button" id="simulation-power" className="switch" role="switch" aria-label="Daya AC simulasi" aria-checked={input.ac_power_state === 1}
          onClick={() => edit({ ac_power_state: input.ac_power_state ? 0 : 1, ...(input.ac_power_state ? { fan_speed: 'Off' } : { fan_speed: 'Medium' }) })}><span className="switch-thumb" /></button></div>
        <details className="simulation-advanced"><summary>Kondisi lainnya</summary><div className="simulation-input-grid">
          <label className="analytics-field">Kelembapan dalam (%)<input type="number" min="0" max="100" step="any" required value={input.indoor_humidity} onChange={(event) => edit({ indoor_humidity: Number(event.target.value) })} /></label>
          <label className="analytics-field">Kelembapan luar (%)<input type="number" min="0" max="100" step="any" required value={input.outdoor_humidity} onChange={(event) => edit({ outdoor_humidity: Number(event.target.value) })} /></label>
          <label className="analytics-field">Perkiraan penghuni<input type="number" min="0" max="20" step="1" required value={input.occupancy_count} onChange={(event) => edit({ occupancy_count: Number(event.target.value) })} /></label>
          <label className="analytics-field">Jam (0–23,99)<input type="number" min="0" max="23.99" step="any" required value={input.hour_of_day} onChange={(event) => edit({ hour_of_day: Number(event.target.value) })} /></label>
          <label className="analytics-field">Cuaca<select value={input.weather_condition} onChange={(event) => edit({ weather_condition: event.target.value as SimulationInput['weather_condition'] })}><option value="Clear">Cerah</option><option value="Clouds">Berawan</option><option value="Rain">Hujan</option><option value="Thunderstorm">Badai petir</option></select></label>
          <label className="analytics-field">Gerakan<select value={input.motion_detected} onChange={(event) => edit({ motion_detected: Number(event.target.value) as 0 | 1 })}><option value="1">Terdeteksi</option><option value="0">Tidak ada</option></select></label>
        </div></details>
        <button type="submit" className="button button--primary" disabled={!ready}>{busy ? <LoaderCircle size={17} className="spin" /> : <Zap size={17} />}{busy ? 'Menghitung…' : 'Hitung perkiraan'}</button>
      </fieldset>
    </form>
    <div role="status" aria-live="polite" className="simulation-output">
      {error && <p className="feedback feedback--danger"><CircleAlert size={16} /><span>{error}</span></p>}
      {!ready && <p className="analytics-hint">Prediksi tersedia setelah model siap.</p>}
      {prediction && <div className="prediction-result"><span>Perkiraan daya AC</span><strong data-testid="predicted-power">{number(prediction.power_w)}<small> W</small></strong>
        <div className="prediction-cost"><label htmlFor="simulation-hours">Pemakaian per hari</label><div><input id="simulation-hours" type="number" min="0.5" max="24" step="0.5" value={hours} onChange={(event) => setHours(Math.min(24, Math.max(0.5, Number(event.target.value))))} /><span>jam</span></div></div>
        <div className="daily-estimate"><span>Perkiraan biaya / hari</span><b>{money(prediction.power_w / 1000 * hours * tariff, currency)}</b></div>
        <p>Estimasi model dari data simulasi, dengan daya tetap selama waktu pemakaian.</p>
      </div>}
    </div>
    <p className="simulation-footnote"><ArrowDownToLine size={13} />Simulasi tidak mengirim perintah ke AC.</p>
  </section>
}
