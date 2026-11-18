import { useEffect, useId, useState } from 'react'
import { number } from '../lib/format'
import type { HourlyReading } from './types'

export function TrendChart({ readings, mode }: { readings: HourlyReading[]; mode: 'power' | 'temperature' }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const id = useId().replace(/:/g, '')
  const [small, setSmall] = useState(() => window.matchMedia('(max-width: 600px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 600px)')
    const onChange = () => setSmall(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  if (!readings.length) return <p className="analytics-empty">Belum ada pembacaan untuk periode ini.</p>
  const width = small ? 360 : 680, height = small ? 220 : 260
  const padding = { top: 18, bottom: 35, left: small ? 42 : 49, right: 17 }
  const series = mode === 'power'
    ? [{ key: 'power_w' as const, label: 'Daya AC', className: 'chart-primary' }]
    : [{ key: 'indoor_temp_c' as const, label: 'Dalam ruangan', className: 'chart-primary' },
      { key: 'outdoor_temp_c' as const, label: 'Luar ruangan', className: 'chart-secondary' }]
  const values = readings.flatMap((reading) => series.map(({ key }) => reading[key]))
  const maximum = Math.max(...values)
  const minimum = mode === 'power' ? 0 : Math.floor(Math.min(...values) - 2)
  const top = mode === 'power' ? Math.max(100, Math.ceil(maximum / 250) * 250) : Math.ceil(maximum + 2)
  const x = (hour: number) => padding.left + hour / 23 * (width - padding.left - padding.right)
  const y = (value: number) => padding.top + (top - value) / Math.max(1, top - minimum) * (height - padding.top - padding.bottom)
  const active = hovered !== null ? readings[hovered] : null
  const tooltipX = active ? Math.min(width - 166, Math.max(padding.left, x(active.hour) - 70)) : 0

  return <>
    <div className="chart-legend">{series.map((item) => <span key={item.key}><i className={item.className} />{item.label}</span>)}<span className="chart-unit">{mode === 'power' ? 'Watt' : '°C'}</span></div>
    <svg className="trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-title ${id}-description`}
      onMouseLeave={() => setHovered(null)}>
      <title id={`${id}-title`}>{mode === 'power' ? 'Rata-rata daya AC per jam' : 'Rata-rata temperatur per jam'}</title>
      <desc id={`${id}-description`}>Pola berdasarkan jam dalam sehari. Arahkan ke titik atau gunakan tabel di bawah untuk melihat nilainya.</desc>
      <defs><linearGradient id={`${id}-fill`} className="chart-primary" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="currentColor" stopOpacity=".16" /><stop offset="100%" stopColor="currentColor" stopOpacity=".01" /></linearGradient></defs>
      {[0, 1, 2, 3, 4].map((index) => {
        const value = minimum + (top - minimum) * index / 4
        return <g key={index}><line x1={padding.left} x2={width - padding.right} y1={y(value)} y2={y(value)} className="chart-gridline" />
          <text x={padding.left - 12} y={y(value) + 4} textAnchor="end" className="chart-axis">{number(value, 0)}</text></g>
      })}
      {(small ? [0, 6, 12, 18, 23] : [0, 4, 8, 12, 16, 20, 23]).map((hour) => <text key={hour} x={x(hour)} y={height - 10} textAnchor="middle" className="chart-axis">{String(hour).padStart(2, '0')}.00</text>)}
      {mode === 'power' && <path d={`M${x(readings[0].hour)},${y(minimum)} ${readings.map((reading) => `L${x(reading.hour)},${y(reading.power_w)}`).join(' ')} L${x(readings.at(-1)!.hour)},${y(minimum)} Z`} fill={`url(#${id}-fill)`} className="chart-primary" />}
      {series.map(({ key, className }) => <polyline key={key} points={readings.map((reading) => `${x(reading.hour)},${y(reading[key])}`).join(' ')}
        className={`chart-line ${className}`} fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />)}
      {readings.map((reading, index) => <circle key={reading.hour} cx={x(reading.hour)} cy={y(reading[series[0].key])} r="7" className="chart-hit-point"
        tabIndex={0} role="button" aria-label={`${String(reading.hour).padStart(2, '0')}.00: ${number(reading[series[0].key])} ${mode === 'power' ? 'watt' : 'derajat Celsius'}`}
        onMouseEnter={() => setHovered(index)} onFocus={() => setHovered(index)} onBlur={() => setHovered(null)}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setHovered(index) } }} />)}
      {active && <g className="chart-tooltip" aria-hidden="true" pointerEvents="none">
        <line x1={x(active.hour)} x2={x(active.hour)} y1={padding.top} y2={height - padding.bottom} className="chart-cursor" />
        <rect x={tooltipX} y={24} width="150" height={mode === 'power' ? 57 : 77} rx="7" />
        <text x={tooltipX + 12} y={44} className="chart-tooltip-time">Pukul {String(active.hour).padStart(2, '0')}.00</text>
        {series.map(({ key, label }, index) => <text key={key} x={tooltipX + 12} y={64 + index * 19}>{label}: {number(active[key])}{mode === 'power' ? ' W' : '°C'}</text>)}
      </g>}
    </svg>
    <details className="chart-data"><summary>Lihat data per jam</summary><div className="analytics-table-wrap"><table>
      <thead><tr><th>Jam</th><th>Daya rata-rata</th><th>Temperatur dalam</th><th>Temperatur luar</th></tr></thead>
      <tbody>{readings.map((reading) => <tr key={reading.hour}><td>{String(reading.hour).padStart(2, '0')}.00</td><td>{number(reading.power_w)} W</td><td>{number(reading.indoor_temp_c)}°C</td><td>{number(reading.outdoor_temp_c)}°C</td></tr>)}</tbody>
    </table></div></details>
  </>
}
