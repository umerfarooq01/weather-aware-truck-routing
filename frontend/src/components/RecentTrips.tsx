import { useEffect, useState } from 'react'
import { api } from '../api'
import type { TripRecord } from '../types'
import { fmtDuration, fmtRelative, shortPlace } from '../lib/format'
import { riskColor, riskLabel } from '../lib/risk'

export function RecentTrips({ refreshKey, onPick }: { refreshKey: number; onPick: (t: TripRecord) => void }) {
  const [trips, setTrips] = useState<TripRecord[] | null>(null)

  useEffect(() => {
    let live = true
    api
      .trips()
      .then((t) => live && setTrips(t))
      .catch(() => live && setTrips([]))
    return () => {
      live = false
    }
  }, [refreshKey])

  if (!trips || trips.length === 0) return null

  return (
    <section className="recent">
      <div className="section-head">
        <h2>Recent plans</h2>
      </div>
      <ul>
        {trips.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => onPick(t)}>
              <span className="r-route">
                {shortPlace(t.origin)} <span className="arrow">→</span> {shortPlace(t.destination)}
              </span>
              <span className="r-meta">
                {t.summary.max_level !== undefined && (
                  <i style={{ background: riskColor(t.summary.max_level) }} title={`Worst: ${riskLabel(t.summary.max_level)}`} />
                )}
                {t.summary.trip_hours !== undefined && fmtDuration(t.summary.trip_hours)} · {t.load_lb.toLocaleString()} lb ·{' '}
                {fmtRelative(t.created_at)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
