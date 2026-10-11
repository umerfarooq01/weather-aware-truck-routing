import type { Checkpoint, Plan, Route } from '../types'
import { LEVELS, riskColor } from '../lib/risk'
import { fmtDayTime, fmtDuration, fmtMiles, shortPlace } from '../lib/format'

export function RiskBar({ route, height = 6 }: { route: Route; height?: number }) {
  const total = route.distance_mi || 1
  return (
    <div className="risk-bar" style={{ height }} aria-hidden>
      {LEVELS.map((name, i) => {
        const mi = route.summary.miles_by_level[name]
        if (mi <= 0) return null
        return <span key={name} style={{ width: `${(mi / total) * 100}%`, background: riskColor(i) }} />
      })}
    </div>
  )
}

function RiskPill({ level }: { level: number }) {
  return (
    <span className={`pill risk-${level}`}>
      <i style={{ background: riskColor(level) }} />
      {LEVELS[level]}
    </span>
  )
}

function exposure(route: Route) {
  const m = route.summary.miles_by_level
  const parts = (['No Travel', 'Severe', 'High', 'Moderate'] as const)
    .filter((k) => m[k] > 0)
    .map((k) => `${Math.round(m[k])} mi ${k.toLowerCase()}`)
  return parts.length ? parts.join(' · ') : 'Low risk the whole way'
}

function RouteCard({ route, selected, onSelect }: { route: Route; selected: boolean; onSelect: () => void }) {
  const recommended = route.tags.includes('Recommended')
  return (
    <button
      type="button"
      className={`route-card${selected ? ' selected' : ''}${recommended ? ' recommended' : ''}`}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <div className="rc-top">
        <span className="rc-name">Route {route.name}</span>
        <span className="rc-tags">
          {route.tags.map((t) => (
            <span key={t} className={`tag ${t.toLowerCase()}`}>
              {t}
            </span>
          ))}
        </span>
      </div>
      <div className="rc-stats">
        <div>
          <strong>{fmtDuration(route.trip_hours)}</strong>
          <span>trip time</span>
        </div>
        <div>
          <strong>{fmtMiles(route.distance_mi)}</strong>
          <span>distance</span>
        </div>
        <div>
          <strong>{fmtDayTime(route.arrival)}</strong>
          <span>arrives</span>
        </div>
      </div>
      <RiskBar route={route} />
      <div className="rc-foot">
        <span>{exposure(route)}</span>
        <span className="mono">avg {route.summary.average_risk.toFixed(2)}</span>
      </div>
    </button>
  )
}

function factorText(cp: Checkpoint) {
  if (cp.risk.driver === 'none') return null
  const w = cp.weather
  if (cp.risk.driver === 'wind') return `Wind ${Math.round(w.wind_mph)} mph`
  if (cp.risk.driver === 'rain') return `Rain ${w.rain_in_hr.toFixed(2)} in/hr`
  return `Snow ${w.snow_in_hr.toFixed(2)} in/hr`
}

function CheckpointList({
  route,
  activeCheckpoint,
  onCheckpoint,
}: {
  route: Route
  activeCheckpoint: number | null
  onCheckpoint: (index: number) => void
}) {
  return (
    <div className="cp-table" role="table" aria-label={`Checkpoints for route ${route.name}`}>
      <div className="cp-row cp-head" role="row">
        <span role="columnheader">Mile</span>
        <span role="columnheader">ETA</span>
        <span role="columnheader">Wind</span>
        <span role="columnheader">Precip</span>
        <span role="columnheader">Risk</span>
      </div>
      {route.checkpoints.map((cp) => {
        const w = cp.weather
        const precip =
          w.snow_in_hr > 0.009 ? `${w.snow_in_hr.toFixed(2)}″ snow` : w.rain_in_hr > 0.004 ? `${w.rain_in_hr.toFixed(2)}″` : '—'
        return (
          <button
            type="button"
            role="row"
            key={cp.index}
            className={`cp-row${activeCheckpoint === cp.index ? ' active' : ''}`}
            onClick={() => onCheckpoint(cp.index)}
            title={factorText(cp) ?? undefined}
          >
            <span role="cell" className="mono">{Math.round(cp.mile)}</span>
            <span role="cell">{fmtDayTime(cp.eta)}</span>
            <span role="cell" className="mono">
              {Math.round(w.wind_mph)}
              <small> mph</small>
            </span>
            <span role="cell" className="mono">{precip}</span>
            <span role="cell">
              <RiskPill level={cp.risk.level} />
            </span>
          </button>
        )
      })}
    </div>
  )
}

type Props = {
  plan: Plan
  selected: number
  onSelect: (id: number) => void
  activeCheckpoint: number | null
  onCheckpoint: (index: number) => void
}

export function Results({ plan, selected, onSelect, activeCheckpoint, onCheckpoint }: Props) {
  const best = plan.routes.find((r) => r.id === plan.recommended)!
  const route = plan.routes.find((r) => r.id === selected) ?? best
  const ordered = [...plan.routes].sort((a, b) => a.rank - b.rank)

  return (
    <section className="results" aria-live="polite">
      <div className={`verdict${plan.no_travel_warning ? ' danger' : ''}`}>
        <div className="verdict-label">{plan.no_travel_warning ? 'Do not depart as planned' : 'Recommendation'}</div>
        <div className="verdict-main">
          Take <strong>Route {best.name}</strong> · {fmtDuration(best.trip_hours)}, {fmtMiles(best.distance_mi)}
        </div>
        {plan.no_travel_warning ? (
          <p>
            Every option crosses No Travel conditions for this load. Delay departure or reduce load; Route {best.name}{' '}
            has the least exposure.
          </p>
        ) : (
          plan.recommendation_reasons.length > 0 && (
            <ul>
              {plan.recommendation_reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )
        )}
        <div className="verdict-meta">
          {shortPlace(plan.origin.label)} → {shortPlace(plan.destination.label)} · {plan.load_lb.toLocaleString()} lb ·
          every {plan.interval_mi} mi
        </div>
      </div>

      <div className="route-list">
        {ordered.map((r) => (
          <RouteCard key={r.id} route={r} selected={r.id === route.id} onSelect={() => onSelect(r.id)} />
        ))}
      </div>

      <div className="section-head">
        <h2>Route {route.name} checkpoints</h2>
        <span className="muted">{route.checkpoints.length} samples</span>
      </div>
      <CheckpointList route={route} activeCheckpoint={activeCheckpoint} onCheckpoint={onCheckpoint} />
      <p className="footnote">
        ETAs use truck speeds capped at 65 mph{plan.hos ? ' and FMCSA hours-of-service breaks' : ''}. Each checkpoint uses the
        hourly forecast for the hour the truck is expected to arrive there.
      </p>
    </section>
  )
}
