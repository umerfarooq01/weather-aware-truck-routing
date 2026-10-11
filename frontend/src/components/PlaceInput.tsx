import { useEffect, useId, useRef, useState } from 'react'
import { api } from '../api'
import type { Place } from '../types'

type Props = {
  label: string
  value: Place | null
  text: string
  onText: (text: string) => void
  onSelect: (place: Place) => void
  placeholder?: string
  marker: 'origin' | 'destination'
}

export function PlaceInput({ label, value, text, onText, onSelect, placeholder, marker }: Props) {
  const id = useId()
  const [results, setResults] = useState<Place[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // Debounced lookup; skipped when the text is exactly the selected place.
  useEffect(() => {
    const q = text.trim()
    if (q.length < 3 || (value && value.label === text)) {
      setResults([])
      setLoading(false)
      return
    }
    const ctrl = new AbortController()
    setLoading(true)
    const t = setTimeout(() => {
      api
        .geocode(q, ctrl.signal)
        .then((r) => {
          setResults(r)
          setActive(0)
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setResults([])
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false)
        })
    }, 250)
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [text, value])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const choose = (p: Place) => {
    onSelect(p)
    setOpen(false)
    setResults([])
  }

  const showList = open && results.length > 0

  return (
    <div className="field place" ref={boxRef}>
      <label htmlFor={id}>{label}</label>
      <div className="place-input">
        <span className={`place-dot ${marker}`} aria-hidden />
        <input
          id={id}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={text}
          role="combobox"
          aria-expanded={showList}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          onChange={(e) => {
            onText(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (!showList) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => (a + 1) % results.length)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => (a - 1 + results.length) % results.length)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(results[active])
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
        />
        {loading && <span className="spinner small" aria-label="Searching" />}
      </div>
      {showList && (
        <ul className="suggestions" id={`${id}-list`} role="listbox">
          {results.map((r, i) => {
            const [head, ...rest] = r.label.split(', ')
            return (
              <li
                key={`${r.lat},${r.lon}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'active' : ''}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(r)
                }}
              >
                <span className="s-head">{head}</span>
                <span className="s-rest">{rest.join(', ')}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
