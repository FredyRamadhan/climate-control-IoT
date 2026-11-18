import { useEffect, useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { AnalyticsPage } from './analytics/AnalyticsPage'
import { Activity, ArrowUpRight, CircleAlert, CloudRain, CloudSun, Droplets, Fan, House, LayoutDashboard, Lightbulb, MapPin, Moon, Power, Radio, RefreshCw, Settings2, ShieldCheck, SlidersHorizontal, Snowflake, Sun, Thermometer, Users, Wifi, WifiOff, Wind } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Badge } from './components/Badge'
import { ManualControl } from './components/ManualControl'
import { useDashboard } from './hooks/useDashboard'
import { useTheme } from './hooks/useTheme'
import { celsius, duration, fanLabels, isNumber, isStale, number, time, weatherLabel } from './lib/format'
import './App.css'

function Reading({ value, unit }: { value: unknown; unit?: string }) {
  return <span className="reading">{number(value)}{isNumber(value) && unit && <span className="reading-unit">{unit}</span>}</span>
}

function Detail({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return <div className="device-detail"><Icon size={18} /><span>{label}</span><strong>{value}</strong></div>
}

function SystemStatus({ icon: Icon, title, description, state }: {
  icon: LucideIcon; title: string; description: string; state: 'online' | 'offline' | 'unknown'
}) {
  return <div className="system-item">
    <span className={`system-icon system-icon--${state}`}><Icon size={21} /></span>
    <div className="system-copy"><h3>{title}</h3><p>{description}</p></div>
    <Badge tone={state === 'online' ? 'success' : state === 'offline' ? 'danger' : 'neutral'} dot>
      {state === 'online' ? 'Terhubung' : state === 'offline' ? 'Terputus' : 'Menunggu'}
    </Badge>
  </div>
}

function App() {
  const { data, connection, refreshing, refresh } = useDashboard()
  const { theme, toggleTheme } = useTheme()
  const [activeNav, setActiveNav] = useState(() => window.location.hash.slice(1) || 'ringkasan')
  const [analyticsRevision, setAnalyticsRevision] = useState(0)
  const analyticsActive = activeNav === 'analitik'
  useEffect(() => {
    const onHashChange = () => setActiveNav(window.location.hash.slice(1) || 'ringkasan')
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  useEffect(() => {
    document.title = analyticsActive ? 'Analitik energi — AutoClimate' : 'AutoClimate — Kontrol Iklim Ruangan'
    if (!window.location.hash) return
    const frame = requestAnimationFrame(() => document.getElementById(activeNav)?.scrollIntoView({ block: 'start' }))
    return () => cancelAnimationFrame(frame)
  }, [activeNav, analyticsActive])
  const tx = data?.transmit ?? null
  const rx = data?.receive ?? null
  const weather = data?.weather ?? null
  const apiOnline = connection === 'online'
  const brokerOnline = apiOnline && data?.health.mqtt === true
  const telemetryStale = isStale(data?.metadata.transmit, data)
  const sensorValid = tx?.sensor_ok !== false && tx?.warmup !== true && data?.metadata.transmit?.schema_valid !== false
  const transmitterOnline = brokerOnline && data?.transmit_status?.online !== false && Boolean(tx) && !telemetryStale
  const receiverOnline = brokerOnline && data?.receive_status?.online !== false && Boolean(rx) && !isStale(data?.metadata.receive, data)
  const canCommand = transmitterOnline && data?.health.subscriptions_ready === true
  const overridden = tx?.override === true
  const weatherCondition = typeof weather?.weather?.[0]?.main === 'string' ? weather.weather[0].main : ''
  const rainy = /rain|drizzle|thunder|shower|hujan/i.test(weatherCondition)
  const WeatherIcon = rainy ? CloudRain : CloudSun
  const weatherTemperature = celsius(weather?.main?.temp)
  const date = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
  const hasRoomTemperature = sensorValid && isNumber(tx?.temp)
  const status = connection === 'loading' ? { label: 'Menghubungkan', tone: 'neutral' as const }
    : !apiOnline ? { label: 'Layanan terputus', tone: 'danger' as const }
      : !brokerOnline ? { label: 'Koneksi terputus', tone: 'warning' as const }
        : transmitterOnline ? { label: 'Sistem terhubung', tone: 'success' as const }
          : { label: 'Menunggu perangkat', tone: 'warning' as const }

  let alert: string | null = null
  if (connection === 'offline') alert = 'Layanan tidak dapat dihubungi. Data terakhir tetap ditampilkan. Periksa koneksi lalu muat ulang.'
  else if (apiOnline && !brokerOnline) alert = 'Koneksi ke perangkat terputus. Sistem akan menyambung kembali secara otomatis.'
  else if (tx && telemetryStale) alert = 'Data ruangan belum diperbarui. Angka yang ditampilkan adalah data terakhir; kontrol tersedia setelah perangkat kembali terhubung.'
  else if (tx?.warmup) alert = 'Sensor sedang melakukan pemanasan. Pembacaan ruangan akan tersedia setelah sensor siap.'
  else if (tx && !sensorValid) alert = 'Pembacaan sensor belum valid. Periksa sensor pada perangkat pengendali.'

  return <div className="app-shell">
    <a className="skip-link" href="#main" onClick={(event) => {
      event.preventDefault()
      const content = document.getElementById('main')
      content?.focus({ preventScroll: true })
      content?.scrollIntoView({ block: 'start' })
    }}>Langsung ke konten</a>
    <aside className="sidebar" aria-label="Navigasi utama">
      <a className="brand" href="#ringkasan" onClick={() => setActiveNav('ringkasan')} aria-label="AutoClimate, ringkasan">
        <span className="brand-mark"><Wind size={25} strokeWidth={2.2} /></span>
        <span>Auto<span className="brand-light">Climate</span><small>Ruang nyaman, otomatis.</small></span>
      </a>
      <div className="workspace-label"><span className="workspace-icon"><House size={17} /></span><span>Ruang utama<small>Climate control</small></span></div>
      <nav className="navigation">
        {[
          { id: 'ringkasan', label: 'Ringkasan', icon: LayoutDashboard },
          { id: 'analitik', label: 'Analitik', icon: BarChart3 },
          { id: 'kontrol', label: 'Kontrol manual', icon: SlidersHorizontal },
          { id: 'sistem', label: 'Status perangkat', icon: Radio },
        ].map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} aria-label={label}
          className={activeNav === id ? 'nav-link nav-link--active' : 'nav-link'}
          aria-current={activeNav === id ? 'location' : undefined} onClick={() => setActiveNav(id)}>
          <Icon size={19} /><span>{label}</span>{activeNav === id && <span className="nav-indicator" />}
        </a>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="automation-note"><span className="automation-icon"><ShieldCheck size={21} /></span>
          <strong>Nyaman secara otomatis</strong><p>Kontrol iklim mengikuti kondisi dan aktivitas ruangan.</p>
        </div>
        <div className="sidebar-footer"><Wind size={17} /><span>Auto-Climate Control</span><span className="version">v2.0</span></div>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><House size={16} /><span className="breadcrumb-divider">/</span><span>{analyticsActive ? 'Analitik energi' : 'Ruang utama'}</span></div>
        <div className="topbar-actions">
          <Badge tone={status.tone} dot>{status.label}</Badge><span className="topbar-divider" />
          <button type="button" className="icon-button" aria-label="Muat ulang data" title="Muat ulang data"
            disabled={refreshing} onClick={() => { refresh(); setAnalyticsRevision((value) => value + 1) }}><RefreshCw size={18} className={refreshing ? 'spin' : ''} /></button>
          <button type="button" className="icon-button" aria-label={theme === 'light' ? 'Gunakan tema gelap' : 'Gunakan tema terang'}
            title={theme === 'light' ? 'Tema gelap' : 'Tema terang'} onClick={toggleTheme}>
            {theme === 'light' ? <Moon size={19} /> : <Sun size={19} />}
          </button>
        </div>
      </header>
      <main id="main" className="main-content" tabIndex={-1}>
        <div hidden={!analyticsActive}><AnalyticsPage active={analyticsActive} refreshKey={analyticsRevision} dashboard={data} /></div>
        <div hidden={analyticsActive}>
        <div className="page-heading" id="ringkasan">
          <div><div className="page-context"><span className="context-dot" />Ruang utama</div><h1>Ringkasan ruangan</h1>
            <p>Kenali kondisi ruangan. Atur kenyamanan Anda.</p></div>
          <div className="date-display"><span>{date}</span><small><RefreshCw size={12} />Pembaruan setiap 3 detik</small></div>
        </div>
        {alert && <div className="connection-alert" role="status"><CircleAlert size={19} /><p>{alert}</p>
          {connection === 'offline' && <button type="button" onClick={refresh}>Muat ulang</button>}</div>}
        <div className="dashboard-grid">
          <div className="overview-column">
            <section className="climate-panel" aria-labelledby="climate-title">
              <div className="climate-heading"><div className="climate-title"><span className="climate-icon"><Snowflake size={21} /></span>
                <div><h2 id="climate-title">Kondisi ruangan</h2><p>Air conditioner</p></div></div>
                <Badge tone={!tx ? 'neutral' : overridden ? 'blue' : 'success'} dot>
                  {!tx ? 'Menunggu data' : overridden ? 'Override aktif' : 'Otomatis'}
                </Badge>
              </div>
              <div className="climate-scene">
                <div className="room-temperature"><span className="temperature-caption">Temperatur saat ini</span>
                  <div className="temperature-value">{hasRoomTemperature ? number(tx?.temp) : '—'}<span>°C</span></div>
                  <span className="temperature-meta"><span className={`status-dot${transmitterOnline ? ' status-dot--live' : ''}`} />
                    {!tx ? 'Menunggu pembacaan sensor' : tx.warmup ? 'Sensor sedang disiapkan'
                      : !sensorValid ? 'Sensor perlu diperiksa' : !transmitterOnline ? 'Pembacaan terakhir' : 'Pembacaan langsung'}
                  </span>
                </div>
                <div className="appliance-visual"><img src="/images/ac-photo.png" width="1080" height="355"
                  alt="Unit air conditioner di ruang utama" className="ac-photo" />
                  <div className="airflow" aria-hidden="true"><span /><span /><span /><span /><span /></div>
                  <span className="appliance-label"><span className={`status-dot${tx?.relay_on === true ? ' status-dot--live' : ''}`} />
                    {typeof tx?.relay_on === 'boolean' ? tx.relay_on ? 'AC menyala' : 'AC mati' : 'Status belum tersedia'}</span>
                </div>
              </div>
              <div className="device-details">
                <Detail icon={Thermometer} label="Target" value={isNumber(tx?.target_temp) ? `${number(tx.target_temp, 0)}°C` : '—'} />
                <Detail icon={Fan} label="Kipas" value={typeof tx?.fan_speed === 'string' ? fanLabels[tx.fan_speed] || tx.fan_speed : '—'} />
                <Detail icon={Power} label="Daya AC" value={typeof tx?.relay_on === 'boolean' ? tx.relay_on ? 'Nyala' : 'Mati' : '—'} />
                <Detail icon={Lightbulb} label="Lampu" value="Belum tersedia" />
              </div>
              <div className="climate-footer"><span><RefreshCw size={12} />{data?.metadata.transmit ? `Diperbarui ${time(data.metadata.transmit.received_at)}` : 'Data akan muncul saat perangkat terhubung'}</span>
                {overridden && <span className="override-remaining">{tx?.override_indefinite ? 'Sampai dilepas' : `${duration(tx?.override_remaining_s)} tersisa`}</span>}
              </div>
            </section>
            <section className="sensor-section" aria-labelledby="sensor-title">
              <div className="section-heading"><h2 id="sensor-title">Di dalam & di luar</h2><span>Lingkungan Anda</span></div>
              <div className="sensor-grid">
                <article className="sensor-card panel">
                  <div className="sensor-heading"><span className="sensor-icon sensor-icon--water"><Droplets size={20} /></span><span>Kelembapan</span></div>
                  <Reading value={sensorValid ? tx?.hum : undefined} unit="%" /><p>Kelembapan ruangan</p>
                  <div className="humidity-track" aria-hidden="true"><span className="humidity-marker"
                    data-level={!sensorValid || !isNumber(tx?.hum) ? 'unknown' : tx.hum < 30 ? 'low' : tx.hum <= 60 ? 'normal' : 'high'} /></div>
                  <div className="sensor-footnote">{!sensorValid || !isNumber(tx?.hum) ? 'Menunggu sensor'
                    : tx.hum < 30 ? 'Udara cenderung kering' : tx.hum <= 60 ? 'Dalam rentang nyaman' : 'Udara cenderung lembap'}</div>
                </article>
                <article className="sensor-card panel">
                  <div className="sensor-heading"><span className="sensor-icon sensor-icon--people"><Users size={20} /></span><span>Aktivitas</span></div>
                  <div className="activity-value">{typeof tx?.motion === 'boolean' ? tx.motion ? 'Terdeteksi' : 'Tidak ada' : '—'}</div>
                  <p>{typeof tx?.motion === 'boolean' ? tx.motion ? 'Gerakan di dalam ruangan' : 'Tidak ada gerakan saat ini' : 'Menunggu sensor gerakan'}</p>
                  <div className="occupancy-visual" aria-hidden="true"><Users size={31} /><span /><span /><span /></div>
                  <div className="sensor-footnote"><span className={`status-dot${tx?.motion === true ? ' status-dot--live' : ''}`} />Sensor gerakan</div>
                </article>
                <article className="sensor-card sensor-card--weather panel">
                  <div className="sensor-heading"><span className="sensor-icon sensor-icon--weather"><WeatherIcon size={21} /></span><span>Cuaca luar</span></div>
                  <Reading value={weatherTemperature} unit="°C" /><p>{weatherLabel(weatherCondition)}</p>
                  <div className="weather-location"><MapPin size={13} /><span>{typeof weather?.name === 'string' ? weather.name : 'Surakarta'}</span></div>
                  <div className="sensor-footnote">{isNumber(weather?.main?.humidity) ? <><Droplets size={13} />{number(weather.main.humidity, 0)}% kelembapan</> : 'Menunggu data cuaca'}</div>
                </article>
              </div>
            </section>
            <div className="automation-strip"><span className="automation-strip-icon"><Settings2 size={21} /></span>
              <div><strong>{!tx ? 'Siap memantau ruangan Anda' : overridden ? 'Anda memegang kendali' : 'Biarkan ruangan menyesuaikan'}</strong>
                <p>{!tx ? 'Hubungkan perangkat untuk mulai menerima data kondisi ruangan.'
                  : overridden ? 'Pengaturan manual aktif. Kembali ke otomatis kapan saja.'
                    : 'Sistem mengatur iklim berdasarkan temperatur dan gerakan di ruangan.'}</p></div>
              <a href="#kontrol" aria-label="Buka kontrol manual" onClick={() => setActiveNav('kontrol')}><ArrowUpRight size={20} /></a>
            </div>
          </div>
          <ManualControl telemetry={tx} receivedAt={data?.metadata.transmit?.received_at ?? null}
            canCommand={canCommand} overrideActive={overridden} onCommand={refresh} />
        </div>
        <section className="system-section panel" id="sistem" aria-labelledby="system-title">
          <div className="system-heading"><h2 id="system-title">Status perangkat</h2><span><Activity size={14} />Pemantauan langsung</span></div>
          <div className="system-grid">
            <SystemStatus icon={brokerOnline ? Wifi : WifiOff} title="Koneksi layanan"
              description={connection === 'loading' ? 'Menyambungkan layanan' : brokerOnline ? 'Layanan siap menerima data' : 'Menunggu koneksi kembali'}
              state={connection === 'loading' ? 'unknown' : brokerOnline ? 'online' : 'offline'} />
            <SystemStatus icon={Radio} title="Pengendali ruangan"
              description={tx ? data?.transmit_status?.online === false ? 'Perangkat tidak terhubung' : telemetryStale ? 'Menunggu pembaruan data'
                : isNumber(tx.uptime_ms) ? `Aktif selama ${duration(tx.uptime_ms / 1000)}` : 'Pembacaan sensor diterima' : 'Belum ada data sensor'}
              state={transmitterOnline ? 'online' : data?.transmit_status?.online === false || (tx && !brokerOnline) ? 'offline' : 'unknown'} />
            <SystemStatus icon={Snowflake} title="Penerima AC"
              description={rx?.state_valid === true && receiverOnline ? `Target ${number(rx.temp, 0)}°C · ${rx.ac_power_state ? 'AC nyala' : 'AC mati'}`
                : rx?.state_valid === false ? 'Menunggu sinyal AC yang valid' : 'Belum ada konfirmasi unit'}
              state={receiverOnline ? 'online' : data?.receive_status?.online === false || (rx && !brokerOnline) ? 'offline' : 'unknown'} />
          </div>
        </section>
        </div>
        <footer className="page-footer"><span>Auto-Climate Control<span className="footer-separator">/</span>Ruang nyaman, otomatis.</span><span>{analyticsActive ? 'Analitik berdasarkan data simulasi' : 'Cuaca dari OpenWeatherMap'}</span></footer>
      </main>
    </div>
  </div>
}

export default App
