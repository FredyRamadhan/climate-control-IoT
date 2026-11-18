import { useEffect, useRef, useState } from 'react'
import { BarChart3, ChevronDown, CircleAlert, Download, FileSpreadsheet, LoaderCircle, RefreshCw, Upload, Users, Zap } from 'lucide-react'
import type { Dashboard } from '../types'
import { Badge } from '../components/Badge'
import { number } from '../lib/format'
import { Simulator } from './Simulator'
import { TrendChart } from './TrendChart'
import { analyticsRequest, modelNames, money } from './types'
import type { AnalyticsSummary, BatchResult } from './types'
import './analytics.css'

function date(value: string) {
  return new Date(value).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })
}

function BatchAnalysis({ ready }: { ready: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<BatchResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const lock = useRef(false)
  useEffect(() => () => controller.current?.abort(), [])

  async function analyze() {
    if (!file || !ready || lock.current) return
    setError(''); setResult(null)
    if (file.size > 5 * 1024 * 1024) { setError('Ukuran CSV maksimal 5 MB.'); return }
    lock.current = true; setBusy(true)
    controller.current = new AbortController()
    const timeout = setTimeout(() => controller.current?.abort(), 30000)
    try {
      setResult(await analyticsRequest<BatchResult>('batch', {
        method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: await file.text(), signal: controller.current.signal,
      }))
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'CSV gagal dianalisis.') }
    finally { clearTimeout(timeout); lock.current = false; setBusy(false) }
  }

  function download() {
    if (!result) return
    const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = 'prediksi-daya.csv'; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <section className="analytics-batch panel" aria-labelledby="batch-title">
    <div className="analytics-panel-title"><div><span className="analytics-title-icon"><FileSpreadsheet size={19} /></span><h2 id="batch-title">Analisis CSV</h2></div>
      <a href="/api/analytics/template.csv" download className="analytics-text-link"><Download size={14} />Unduh contoh CSV</a></div>
    <p className="analytics-description">Prediksi daya untuk beberapa kondisi sekaligus. Maksimal 10.000 baris dan 5 MB.</p>
    <form className="batch-upload-row" onSubmit={(event) => { event.preventDefault(); void analyze() }}>
      <label className="csv-file-input"><Upload size={18} /><span>{file ? file.name : 'Pilih file CSV'}<small>{file ? `${number(file.size / 1024, 0)} KB` : 'Gunakan format kolom pada file contoh.'}</small></span>
        <input type="file" accept=".csv,text/csv" aria-label="Pilih file CSV" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setResult(null); setError('') }} /></label>
      <button type="submit" className="button button--secondary" disabled={!ready || !file || busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <BarChart3 size={16} />}{busy ? 'Menganalisis…' : 'Analisis file'}</button>
    </form>
    <div role="status" aria-live="polite">
      {error && <p className="feedback feedback--danger"><CircleAlert size={16} /><span>{error}</span></p>}
      {result && <div className="batch-results">
        <div className="batch-result-heading"><p><strong>{number(result.row_count, 0)} baris selesai.</strong> Daya rata-rata {number(result.average_power_w)} W.</p><button type="button" className="analytics-text-link" onClick={download}><Download size={14} />Unduh hasil</button></div>
        <div className="analytics-table-wrap"><table><thead><tr><th>Baris</th><th>Dalam ruangan</th><th>Target AC</th><th>Prediksi daya</th></tr></thead><tbody>
          {result.preview.map((row, index) => <tr key={index}><td>{index + 1}</td><td>{number(row.indoor_temp_c)}°C</td><td>{number(row.target_temp_c, 0)}°C</td><td>{number(row.predicted_power_w)} W</td></tr>)}
        </tbody></table></div><p className="analytics-hint">Pratinjau {result.preview.length} baris pertama. Unduh hasil untuk seluruh data.</p>
      </div>}
    </div>
  </section>
}

export function AnalyticsPage({ active, refreshKey, dashboard }: { active: boolean; refreshKey: number; dashboard: Dashboard | null }) {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
  const [period, setPeriod] = useState('all')
  const [mode, setMode] = useState<'power' | 'temperature'>('power')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [currency, setCurrency] = useState<'IDR' | 'USD'>('IDR')
  const [tariff, setTariff] = useState(1444)

  useEffect(() => {
    if (!active) return
    let disposed = false
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)
    setLoading(true); setError('')
    analyticsRequest<AnalyticsSummary>(`summary${period === 'all' ? '' : `?days=${period}`}`, { signal: controller.signal })
      .then((value) => {
        if (!value.dataset || !value.metrics || !Array.isArray(value.hourly) || !Array.isArray(value.occupancy)) throw new Error('Data analitik belum valid. Coba muat ulang.')
        if (!disposed) setSummary(value)
      })
      .catch((failure) => {
        if (!disposed) { setSummary(null); setError(failure instanceof Error ? failure.message : 'Analitik belum dapat dimuat.') }
      })
      .finally(() => { clearTimeout(timeout); if (!disposed) setLoading(false) })
    return () => { disposed = true; clearTimeout(timeout); controller.abort() }
  }, [active, period, refreshKey, retry])

  const evaluation = summary?.evaluation
  return <div className="analytics-page" id="analitik" aria-busy={loading}>
    <div className="page-heading analytics-heading"><div><div className="page-context"><span className="context-dot" />Ruang utama</div><h1>Analitik energi</h1><p>Pahami pola pemakaian dan perkirakan daya AC.</p></div>
      <Badge tone="blue"><FileSpreadsheet size={12} />Data simulasi</Badge></div>
    <div className="analytics-toolbar">
      <div className="analytics-period"><label htmlFor="analytics-period">Periode data</label><select id="analytics-period" value={period} onChange={(event) => setPeriod(event.target.value)}><option value="all">Seluruh data</option><option value="7">7 hari terakhir</option><option value="1">24 jam terakhir</option></select></div>
      <div className="tariff-controls"><label htmlFor="analytics-currency" className="sr-only">Mata uang</label><select id="analytics-currency" value={currency} onChange={(event) => { const value = event.target.value as 'IDR' | 'USD'; setCurrency(value); setTariff(value === 'IDR' ? 1444 : 0.15) }}><option value="IDR">Rp</option><option value="USD">USD</option></select>
        <label htmlFor="analytics-tariff">Tarif / kWh</label><input id="analytics-tariff" type="number" min="0" max="1000000" step="any" value={tariff} onChange={(event) => setTariff(Math.max(0, Math.min(1000000, Number(event.target.value))))} /></div>
    </div>
    {loading && <div className="analytics-loading" role="status"><LoaderCircle size={17} className="spin" /><span>Memuat analitik…</span></div>}
    {error && <div className="analytics-error panel" role="status"><span className="analytics-error-icon"><BarChart3 size={28} /></span><h2>Analitik belum tersedia</h2><p>{error}</p><button type="button" className="button button--secondary" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={16} />Coba lagi</button></div>}
    {summary && <>
      <section className="analytics-statistics panel" aria-label="Ringkasan energi">
        <div><span>Daya rata-rata</span><strong>{number(summary.metrics.average_power_w)}<small> W</small></strong><p>Seluruh kondisi AC</p></div>
        <div><span>AC aktif</span><strong>{number(summary.metrics.active_percent)}<small>%</small></strong><p>Dari {number(summary.dataset.rows, 0)} observasi</p></div>
        <div><span>Energi periode ini</span><strong>{number(summary.metrics.energy_kwh)}<small> kWh</small></strong><p>Interval {number(summary.dataset.sample_interval_seconds, 0)} detik</p></div>
        <div><span>Perkiraan biaya</span><strong className="analytics-cost">{money(summary.metrics.energy_kwh * tariff, currency)}</strong><p>Mengikuti tarif yang Anda isi</p></div>
      </section>
      <div className="analytics-data-caption"><span>{date(summary.dataset.start)} – {date(summary.dataset.end)}</span><span><span className="status-dot" />Data simulasi, bukan meter listrik</span></div>
      <div className="analytics-content-grid"><div className="analytics-main-column">
        <section className="analytics-trend panel" aria-labelledby="trend-title"><div className="analytics-panel-title"><div><span className="analytics-title-icon"><BarChart3 size={19} /></span><h2 id="trend-title">Pola harian</h2></div><div className="analytics-chart-modes" role="group" aria-label="Jenis grafik"><button type="button" aria-pressed={mode === 'power'} onClick={() => setMode('power')}>Daya AC</button><button type="button" aria-pressed={mode === 'temperature'} onClick={() => setMode('temperature')}>Temperatur</button></div></div>
          <p className="analytics-description">Rata-rata setiap jam dari periode yang dipilih.</p><TrendChart readings={summary.hourly} mode={mode} />
        </section>
        <section className="analytics-occupancy panel" aria-labelledby="occupancy-title"><div className="analytics-panel-title"><div><span className="analytics-title-icon"><Users size={18} /></span><h2 id="occupancy-title">Aktivitas & beban AC</h2></div></div>
          <div className="occupancy-metrics">{summary.occupancy.map((item) => <div key={item.label}><span>{item.label}</span><strong>{number(item.power_w)}<small>{item.power_w === null ? '' : ' W'}</small></strong><p>{number(item.records, 0)} observasi</p></div>)}</div>
        </section>
        {evaluation && <section className="analytics-model panel" aria-labelledby="model-title"><div className="analytics-panel-title"><div><span className="analytics-title-icon"><Zap size={18} /></span><h2 id="model-title">Kinerja model</h2></div><Badge tone={summary.model_ready ? 'success' : 'warning'} dot>{summary.model_ready ? 'Model siap' : 'Model belum siap'}</Badge></div>
          <p className="analytics-description">{modelNames[evaluation.name] || evaluation.name}, diuji pada {number(evaluation.test_samples, 0)} sampel terpisah.</p>
          <div className="model-metrics"><div><span>Skor R²</span><strong>{number(evaluation.metrics.r2_score, 4)}</strong></div><div><span>Galat rata-rata (MAE)</span><strong>{number(evaluation.metrics.mae)}<small> W</small></strong></div><div><span>Galat RMSE</span><strong>{number(evaluation.metrics.rmse)}<small> W</small></strong></div></div>
          <details className="model-details"><summary>Bandingkan model<ChevronDown size={15} /></summary><div className="analytics-table-wrap"><table><thead><tr><th>Model</th><th>R²</th><th>MAE</th><th>RMSE</th></tr></thead><tbody>{evaluation.benchmarks.map((model) => <tr key={model.name}><td>{modelNames[model.name] || model.name}{model.name === evaluation.name && <span className="selected-model-label">Terpilih</span>}</td><td>{number(model.r2_score, 4)}</td><td>{number(model.mae)} W</td><td>{number(model.rmse)} W</td></tr>)}</tbody></table></div>
            <p className="analytics-hint">Dilatih pada {number(evaluation.training_samples, 0)} sampel. Evaluasi ini menggunakan data simulasi dan tidak menyatakan akurasi pengukuran listrik di ruangan.</p></details>
        </section>}
      </div><Simulator ready={summary.model_ready} dashboard={dashboard} tariff={tariff} currency={currency} /></div>
      <BatchAnalysis ready={summary.model_ready} />
    </>}
  </div>
}
