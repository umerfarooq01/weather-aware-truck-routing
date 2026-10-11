import { useState, type FormEvent } from 'react'
import type { Place, PlanRequest } from '../types'
import { nextHalfHour, toLocalInput } from '../lib/format'
import { PlaceInput } from './PlaceInput'

export type FormState = {
  origin: Place | null
  originText: string
  destination: Place | null
  destinationText: string
  departure: string
  load: string
  interval: 10 | 25 | 50
  hos: boolean
}

export const initialForm = (): FormState => ({
  origin: null,
  originText: '',
  destination: null,
  destinationText: '',
  departure: toLocalInput(nextHalfHour()),
  load: '38000',
  interval: 25,
  hos: true,
})

type Props = {
  form: FormState
  setForm: (updater: (f: FormState) => FormState) => void
  onSubmit: (req: PlanRequest) => void
  busy: boolean
}

const INTERVALS = [10, 25, 50] as const

export function TripForm({ form, setForm, onSubmit, busy }: Props) {
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))

  const min = toLocalInput(new Date(Date.now() - 30 * 60_000))
  const max = toLocalInput(new Date(Date.now() + 7 * 86_400_000 - 60_000))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const origin = form.origin && form.origin.label === form.originText ? form.origin : form.originText.trim()
    const destination =
      form.destination && form.destination.label === form.destinationText ? form.destination : form.destinationText.trim()
    const load = Number(form.load.replace(/[,\s]/g, ''))
    const dep = new Date(form.departure)

    if (!origin) return setError('Enter an origin.')
    if (!destination) return setError('Enter a destination.')
    if (!form.departure || Number.isNaN(dep.getTime())) return setError('Choose a departure date and time.')
    if (dep.getTime() < Date.now() - 60 * 60_000) return setError("Departure can't be in the past.")
    if (dep.getTime() > Date.now() + 7 * 86_400_000) return setError('Departure must be within the next 7 days.')
    if (!Number.isFinite(load) || load < 0 || load > 120_000) return setError('Load must be between 0 and 120,000 lb.')
    setError(null)
    onSubmit({
      origin,
      destination,
      departure: dep.toISOString(),
      load_lb: Math.round(load),
      interval_mi: form.interval,
      hos: form.hos,
    })
  }

  const swap = () =>
    setForm((f) => ({
      ...f,
      origin: f.destination,
      originText: f.destinationText,
      destination: f.origin,
      destinationText: f.originText,
    }))

  return (
    <form className="trip-form" onSubmit={submit} noValidate>
      <div className="places">
        <PlaceInput
          label="Origin"
          marker="origin"
          placeholder="City, address or terminal"
          value={form.origin}
          text={form.originText}
          onText={(t) => set('originText', t)}
          onSelect={(p) => setForm((f) => ({ ...f, origin: p, originText: p.label }))}
        />
        <button type="button" className="swap" onClick={swap} aria-label="Swap origin and destination" title="Swap">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path d="M5 2v11M5 13l-3-3M5 13l3-3M11 14V3M11 3L8 6M11 3l3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <PlaceInput
          label="Destination"
          marker="destination"
          placeholder="City, address or terminal"
          value={form.destination}
          text={form.destinationText}
          onText={(t) => set('destinationText', t)}
          onSelect={(p) => setForm((f) => ({ ...f, destination: p, destinationText: p.label }))}
        />
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="departure">Departure</label>
          <input
            id="departure"
            type="datetime-local"
            value={form.departure}
            min={min}
            max={max}
            onChange={(e) => set('departure', e.target.value)}
          />
        </div>
        <div className="field load">
          <label htmlFor="load">Load weight</label>
          <div className="suffix-input">
            <input
              id="load"
              inputMode="numeric"
              value={form.load}
              onChange={(e) => set('load', e.target.value.replace(/[^\d,]/g, ''))}
            />
            <span>lb</span>
          </div>
        </div>
      </div>

      <div className="row align-end">
        <div className="field">
          <span className="label" id="interval-label">Weather checkpoint every</span>
          <div className="segmented" role="radiogroup" aria-labelledby="interval-label">
            {INTERVALS.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={form.interval === n}
                className={form.interval === n ? 'on' : ''}
                onClick={() => set('interval', n)}
              >
                {n} mi
              </button>
            ))}
          </div>
        </div>
        <label className="check" title="Adds a 30-min break after 8h and a 10h rest after 11h of driving">
          <input type="checkbox" checked={form.hos} onChange={(e) => set('hos', e.target.checked)} />
          <span>HOS breaks</span>
        </label>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <button className="primary" type="submit" disabled={busy}>
        {busy ? (
          <>
            <span className="spinner" aria-hidden /> Planning routes…
          </>
        ) : (
          'Plan routes'
        )}
      </button>
    </form>
  )
}
