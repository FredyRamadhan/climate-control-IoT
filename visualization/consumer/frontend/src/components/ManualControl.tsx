import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, Clock3, Fan, LoaderCircle, Minus, Plus, Power, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { fanLabels, isNumber } from '../lib/format'
import type { CommandResult, FanSpeed, Telemetry } from '../types'

interface Settings {
  temp: number
  fan: FanSpeed
  power: boolean
}

interface Feedback {
  kind: 'success' | 'warning' | 'danger'
  message: string
}

interface Draft {
  settings: Settings
  confirmedAt: string | null
}

const fans: FanSpeed[] = ['off', 'low', 'medium', 'high']

function fromTelemetry(telemetry: Telemetry | null): Settings {
  return {
    temp: isNumber(telemetry?.target_temp) ? Math.min(30, Math.max(16, telemetry.target_temp)) : 24,
    fan: fans.includes(telemetry?.fan_speed as FanSpeed) ? telemetry?.fan_speed as FanSpeed : 'medium',
    power: typeof telemetry?.relay_on === 'boolean' ? telemetry.relay_on : true,
  }
}

export function ManualControl({ telemetry, receivedAt, canCommand, overrideActive, onCommand }: {
  telemetry: Telemetry | null
  receivedAt: string | null
  canCommand: boolean
  overrideActive: boolean
  onCommand: () => void
}) {
  // A draft takes precedence over polling until the device confirms a command.
  const [draft, setDraft] = useState<Draft | null>(null)
  const [seconds, setSeconds] = useState(60)
  const [busy, setBusy] = useState<'override' | 'release' | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const sending = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const draftActive = draft && (draft.confirmedAt === null || receivedAt === draft.confirmedAt)
  const settings = draftActive ? draft.settings : fromTelemetry(telemetry)

  useEffect(() => () => controller.current?.abort(), [])

  function edit(patch: Partial<Settings>) {
    setDraft({ settings: { ...settings, ...patch }, confirmedAt: null })
    setFeedback(null)
  }

  async function send(action: 'override' | 'release') {
    if (!canCommand || sending.current) return
    sending.current = true
    setBusy(action)
    setFeedback(null)
    controller.current = new AbortController()
    // The server permits a 120 s ACK timeout plus a 30 s publish timeout.
    const timeout = setTimeout(() => controller.current?.abort(), 155000)
    try {
      const response = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        signal: controller.current.signal,
        body: JSON.stringify({
          action,
          // randomUUID is unavailable on HTTP LAN addresses; uniqueness is also
          // supplied by time and randomness for those local installations.
          request_id: `dash-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
          ...(action === 'override' ? {
            relay_on: settings.power,
            target_temp: settings.temp,
            fan_speed: settings.fan,
            duration_s: seconds,
          } : {}),
        }),
      })
      const result: CommandResult & { detail?: string } = await response.json()
      if (!response.ok) {
        // Technical API errors stay in the API; the dashboard explains what to do.
        setFeedback({ kind: 'danger', message: response.status === 503
          ? 'Koneksi perangkat terputus. Periksa koneksi lalu coba lagi.'
          : 'Perintah gagal dikirim. Periksa koneksi perangkat lalu coba lagi.' })
      } else if (!result.ack) {
        setFeedback({ kind: 'warning', message: 'Perintah terkirim, tetapi perangkat belum mengonfirmasi. Periksa kondisi unit sebelum mencoba lagi.' })
      } else if (result.ack.ok !== true) {
        setFeedback({ kind: 'danger', message: `Perangkat menolak perintah${result.ack.error ? `: ${result.ack.error}` : '.'}` })
      } else {
        // Keep the selected values until fresh telemetry arrives, without changing
        // the live device readout based on an unconfirmed local selection.
        if (action === 'release') setDraft(null)
        else setDraft({ settings, confirmedAt: receivedAt })
        setFeedback({ kind: 'success', message: action === 'release'
          ? 'Kontrol otomatis diaktifkan. Perangkat telah mengonfirmasi.'
          : 'Pengaturan diterapkan. Perangkat telah mengonfirmasi.' })
      }
      onCommand()
    } catch {
      setFeedback({ kind: 'danger', message: 'Konfirmasi tidak diterima. Periksa koneksi dan kondisi unit sebelum mengirim ulang.' })
    } finally {
      clearTimeout(timeout)
      sending.current = false
      setBusy(null)
    }
  }

  return <section className="manual-panel panel" id="kontrol" aria-labelledby="control-title">
    <div className="panel-heading">
      <span className="heading-icon"><SlidersHorizontal size={19} /></span>
      <div><h2 id="control-title">Kontrol manual</h2><p>Atur kenyamanan sesuai kebutuhan.</p></div>
    </div>
    <fieldset disabled={Boolean(busy)} className="control-fieldset">
      <legend className="sr-only">Pengaturan AC</legend>
      <div className="power-row">
        <div className="control-label"><Power size={18} /><label htmlFor="ac-power">Daya AC</label></div>
        <button type="button" id="ac-power" className="switch" role="switch"
          aria-checked={settings.power} aria-label="Daya AC"
          onClick={() => edit({ power: !settings.power })}>
          <span className="switch-thumb" />
        </button>
      </div>
      <div className={`temperature-control${settings.power ? '' : ' temperature-control--off'}`}>
        <label htmlFor="target-temp">Temperatur target</label>
        <div className="stepper">
          <button type="button" className="stepper-button" aria-label="Turunkan temperatur"
            disabled={settings.temp <= 16} onClick={() => edit({ temp: settings.temp - 1 })}><Minus size={20} /></button>
          <output htmlFor="target-temp" className="target-value">{settings.temp}<span>°C</span></output>
          <button type="button" className="stepper-button" aria-label="Naikkan temperatur"
            disabled={settings.temp >= 30} onClick={() => edit({ temp: settings.temp + 1 })}><Plus size={20} /></button>
        </div>
        <input id="target-temp" type="range" min="16" max="30" step="1" value={settings.temp}
          aria-label="Temperatur target" aria-valuetext={`${settings.temp} derajat Celsius`}
          onChange={(event) => edit({ temp: Number(event.target.value) })} />
        <div className="range-labels"><span>16°C</span><span>30°C</span></div>
      </div>
      <div className="fan-control">
        <div className="control-label" id="fan-label"><Fan size={18} /><span>Kecepatan kipas</span></div>
        <div className="segmented-control" role="group" aria-labelledby="fan-label">
          {fans.map((fan) => <button key={fan} type="button" aria-pressed={settings.fan === fan}
            onClick={() => edit({ fan })}>{fanLabels[fan]}</button>)}
        </div>
      </div>
      <div className="duration-control">
        <label htmlFor="override-duration" className="control-label"><Clock3 size={18} />Durasi override</label>
        <select id="override-duration" value={seconds} onChange={(event) => setSeconds(Number(event.target.value))}>
          <option value="5">5 detik</option><option value="30">30 detik</option>
          <option value="60">1 menit</option><option value="300">5 menit</option>
          <option value="900">15 menit</option><option value="3600">1 jam</option>
          <option value="0">Sampai dilepas</option>
        </select>
      </div>
      <button type="button" className="button button--primary apply-button"
        disabled={!canCommand} onClick={() => void send('override')}>
        {busy === 'override' ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />}
        {busy === 'override' ? 'Menunggu konfirmasi…' : 'Terapkan pengaturan'}
      </button>
      <button type="button" className="button button--secondary release-button"
        disabled={!canCommand || (!overrideActive && !feedback)} onClick={() => void send('release')}>
        {busy === 'release' ? <LoaderCircle size={16} className="spin" /> : <RotateCcw size={16} />}
        {busy === 'release' ? 'Mengaktifkan otomatis…' : 'Kembali ke otomatis'}
      </button>
    </fieldset>
    <div className="control-feedback" role="status" aria-live="polite" aria-atomic="true">
      {feedback ? <p className={`feedback feedback--${feedback.kind}`}>
        {feedback.kind === 'success' ? <Check size={17} /> : <CircleAlert size={17} />}
        <span>{feedback.message}</span>
      </p> : <p className="control-hint">{!canCommand
        ? 'Kontrol tersedia setelah koneksi perangkat siap.'
        : draftActive && draft.confirmedAt === null ? 'Pengaturan berubah. Terapkan untuk mengirim ke perangkat.'
          : 'Setelah durasi berakhir, kontrol otomatis kembali aktif.'}</p>}
    </div>
  </section>
}
