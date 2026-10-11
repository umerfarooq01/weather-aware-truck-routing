import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { Heatmap, Plan, PlanRequest, TripRecord } from './types'
import { TripForm, initialForm, type FormState } from './components/TripForm'
import { Results } from './components/Results'
import { MapView } from './components/MapView'
import { HeatControls } from './components/HeatControls'
import { RecentTrips } from './components/RecentTrips'
import { LEVELS, RISK_COLORS } from './lib/risk'
import { nextHalfHour, toLocalInput } from './lib/format'
import type { HeatMetric } from './lib/heat'

const STEPS = ['Finding route options…', 'Projecting truck ETAs…', 'Sampling forecasts at checkpoints…', 'Scoring weather risk…']

function samplePath(coords: [number, number][], max = 300): [number, number][] {
  if (coords.length <= max) return coords
  const step = coords.length / max
  const out: [number, number][] = []
  for (let i = 0; i < max; i++) out.push(coords[Math.floor(i * step)])
  out.push(coords[coords.length - 1])
  return out
}

export default function App() {
  const [form, setForm] = useState<FormState>(initialForm)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const [activeCheckpoint, setActiveCheckpoint] = useState<number | null>(null)

  const [heat, setHeat] = useState<Heatmap | null>(null)
  const [heatLoading, setHeatLoading] = useState(false)
  const [heatError, setHeatError] = useState<string | null>(null)
  const [heatVisible, setHeatVisible] = useState(true)
  const [heatHour, setHeatHour] = useState(0)
  const [heatMetric, setHeatMetric] = useState<HeatMetric>('risk')
  const [playing, setPlaying] = useState(false)
  const [historyKey, setHistoryKey] = useState(0)
  const reqId = useRef(0)

  useEffect(() => {
    if (!busy) return
    const t = window.setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 1400)
    return () => window.clearInterval(t)
  }, [busy])

  const loadHeat = useCallback((p: Plan, id: number) => {
    setHeat(null)
    setHeatError(null)
    setHeatLoading(true)
    setPlaying(false)
    const paths = p.routes.map((r) => samplePath(r.segments.flatMap((s) => s.coords)))
    api
      .heatmap({ paths, departure: p.departure, load_lb: p.load_lb })
      .then((h) => {
        if (id !== reqId.current) return
        setHeat(h)
        setHeatHour(Math.max(0, Math.round((new Date(p.departure).getTime() - new Date(h.start).getTime()) / 3_600_000)))
      })
      .catch((e: Error) => id === reqId.current && setHeatError(e.message))
      .finally(() => id === reqId.current && setHeatLoading(false))
  }, [])

  const submit = async (req: PlanRequest) => {
    const id = ++reqId.current
    setStep(0)
    setBusy(true)
    setError(null)
    try {
      const p = await api.plan(req)
      if (id !== reqId.current) return
      setPlan(p)
      setSelected(p.recommended)
      setActiveCheckpoint(null)
      // Keep the inputs in sync with what the server resolved.
      setForm((f) => ({
        ...f,
        origin: p.origin,
        originText: p.origin.label,
        destination: p.destination,
        destinationText: p.destination.label,
      }))
      setHistoryKey((k) => k + 1)
      loadHeat(p, id)
    } catch (e) {
      if (id === reqId.current) setError((e as Error).message)
    } finally {
      if (id === reqId.current) setBusy(false)
    }
  }

  const pickTrip = (t: TripRecord) => {
    const o = t.summary.origin
    const d = t.summary.destination
    setForm((f) => ({
      ...f,
      origin: o ?? null,
      originText: o?.label ?? t.origin,
      destination: d ?? null,
      destinationText: d?.label ?? t.destination,
      load: String(t.load_lb),
      interval: t.interval_mi,
      departure: toLocalInput(nextHalfHour()),
    }))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const selectRoute = (id: number) => {
    setSelected(id)
    setActiveCheckpoint(null)
  }

  return (
    <div className="app">
      <aside className="panel">
        <header className="brand">
          <img src="/logo.png" alt="Headwind" width={124} height={34} />
          <span className="brand-tag">Weather-aware truck routing</span>
        </header>

        <TripForm form={form} setForm={setForm} onSubmit={submit} busy={busy} />

        {error && (
          <div className="alert" role="alert">
            <strong>Couldn't plan this trip.</strong> {error}
          </div>
        )}

        {busy && (
          <div className="loading-card" aria-live="polite">
            <div className="progress">
              <span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
            </div>
            <span>{STEPS[step]}</span>
          </div>
        )}

        {plan && !busy && (
          <Results
            plan={plan}
            selected={selected}
            onSelect={selectRoute}
            activeCheckpoint={activeCheckpoint}
            onCheckpoint={setActiveCheckpoint}
          />
        )}

        {!plan && !busy && (
          <section className="intro">
            <h2>How routes are scored</h2>
            <p>
              Three route options are generated, and the forecast is checked at each checkpoint for the hour your truck is
              expected to be there. Wind limits tighten with load weight.
            </p>
            <ol>
              <li>Fewest Severe (and No Travel) miles</li>
              <li>Fewest High miles</li>
              <li>Lowest average risk</li>
              <li>Shortest travel time</li>
            </ol>
            <div className="scale">
              {LEVELS.map((l, i) => (
                <span key={l}>
                  <i style={{ background: RISK_COLORS[i] }} />
                  {l}
                </span>
              ))}
            </div>
          </section>
        )}

        <RecentTrips refreshKey={historyKey} onPick={pickTrip} />

        <footer className="credits">
          Routing © OSRM / OpenStreetMap · Forecasts © Open-Meteo · Geocoding © Photon
        </footer>
      </aside>

      <main className="map-wrap">
        <MapView
          plan={plan}
          selected={selected}
          onSelect={selectRoute}
          activeCheckpoint={activeCheckpoint}
          onCheckpoint={setActiveCheckpoint}
          heat={heat}
          heatVisible={heatVisible}
          heatHour={heatHour}
          heatMetric={heatMetric}
        />
        {plan && (
          <HeatControls
            heat={heat}
            loading={heatLoading}
            error={heatError}
            visible={heatVisible}
            setVisible={setHeatVisible}
            hour={heatHour}
            setHour={setHeatHour}
            metric={heatMetric}
            setMetric={setHeatMetric}
            playing={playing}
            setPlaying={setPlaying}
            onRetry={() => plan && loadHeat(plan, reqId.current)}
          />
        )}
        {!plan && (
          <div className="map-hint">
            <strong>Plan a trip to see routes</strong>
            <span>Routes, checkpoint risk and a 48-hour weather layer will appear here.</span>
          </div>
        )}
      </main>
    </div>
  )
}
