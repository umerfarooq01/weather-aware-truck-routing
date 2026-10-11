import { useEffect, useRef } from 'react'
import type { Heatmap } from '../types'
import { LEGENDS, type HeatMetric } from '../lib/heat'
import { fmtDayTime } from '../lib/format'

type Props = {
  heat: Heatmap | null
  loading: boolean
  error: string | null
  visible: boolean
  setVisible: (v: boolean) => void
  hour: number
  setHour: (h: number | ((h: number) => number)) => void
  metric: HeatMetric
  setMetric: (m: HeatMetric) => void
  playing: boolean
  setPlaying: (p: boolean | ((p: boolean) => boolean)) => void
  onRetry: () => void
}

const METRICS: { id: HeatMetric; label: string }[] = [
  { id: 'risk', label: 'Risk' },
  { id: 'wind', label: 'Wind' },
  { id: 'precip', label: 'Precip' },
]

export function HeatControls(p: Props) {
  const { heat, hour, setHour, playing, setPlaying } = p
  const max = heat ? heat.hours - 1 : 48
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (!playing || !heat) return
    timer.current = window.setInterval(() => {
      setHour((h) => (h >= heat.hours - 1 ? 0 : h + 1))
    }, 380)
    return () => {
      if (timer.current) window.clearInterval(timer.current)
    }
  }, [playing, heat, setHour])

  const when = heat ? new Date(new Date(heat.start).getTime() + hour * 3_600_000).toISOString() : null
  const legend = LEGENDS[p.metric]

  return (
    <div className="heat-panel">
      <div className="heat-top">
        <label className="toggle">
          <input type="checkbox" checked={p.visible} onChange={(e) => p.setVisible(e.target.checked)} />
          <span className="track" aria-hidden />
          <span>Weather layer</span>
        </label>
        <div className="segmented small" role="radiogroup" aria-label="Heatmap metric">
          {METRICS.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={p.metric === m.id}
              className={p.metric === m.id ? 'on' : ''}
              onClick={() => p.setMetric(m.id)}
              disabled={!p.visible}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {p.loading && (
        <div className="heat-status">
          <span className="spinner small" aria-hidden /> Loading 48-hour corridor forecast…
        </div>
      )}
      {p.error && !p.loading && (
        <div className="heat-status error">
          {p.error}{' '}
          <button type="button" className="link" onClick={p.onRetry}>
            Retry
          </button>
        </div>
      )}

      {heat && !p.loading && (
        <>
          <div className="slider-row">
            <button
              type="button"
              className="play"
              onClick={() => setPlaying((v) => !v)}
              disabled={!p.visible}
              aria-label={playing ? 'Pause' : 'Play forecast'}
            >
              {playing ? (
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
                  <path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
                  <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
                </svg>
              )}
            </button>
            <input
              type="range"
              min={0}
              max={max}
              step={1}
              value={hour}
              disabled={!p.visible}
              aria-label="Forecast hour"
              aria-valuetext={when ? `${fmtDayTime(when)}, plus ${hour} hours` : undefined}
              onChange={(e) => {
                setPlaying(false)
                setHour(Number(e.target.value))
              }}
              style={{ ['--pct' as string]: `${(hour / max) * 100}%` }}
            />
            <div className="slider-time">
              <strong>{when ? fmtDayTime(when) : '—'}</strong>
              <span className="mono">+{hour}h</span>
            </div>
          </div>
          <div className="legend">
            <span className="legend-title">{legend.title}</span>
            <div className="legend-scale">
              {legend.stops.map((s) => (
                <span key={s.label}>
                  <i style={{ background: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
