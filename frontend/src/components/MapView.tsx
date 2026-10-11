import { useEffect, useMemo, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Checkpoint, Heatmap, Plan, Route } from '../types'
import { riskColor } from '../lib/risk'
import { fmtDayTime, fmtDuration, fmtMiles } from '../lib/format'
import { paintHeat, type HeatMetric } from '../lib/heat'

/** ImageOverlay that displays a live <canvas>, so redraws need no image encoding. */
const CanvasOverlay = L.ImageOverlay.extend({
  _initImage(this: L.ImageOverlay & { _image: HTMLCanvasElement; _url: unknown; _zoomAnimated: boolean }) {
    const el = (this._image = this._url as HTMLCanvasElement)
    L.DomUtil.addClass(el, 'leaflet-image-layer')
    if (this._zoomAnimated) L.DomUtil.addClass(el, 'leaflet-zoom-animated')
    if (this.options.className) L.DomUtil.addClass(el, this.options.className)
  },
}) as unknown as new (canvas: HTMLCanvasElement, bounds: L.LatLngBoundsExpression, opts?: L.ImageOverlayOptions) => L.ImageOverlay

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function popupHtml(route: Route, cp: Checkpoint) {
  const w = cp.weather
  const driver =
    cp.risk.driver === 'none' ? 'All factors within Low limits' : `Driven by ${cp.risk.driver}${cp.risk.driver === 'wind' ? ' (load-adjusted)' : ''}`
  return `
    <div class="pop">
      <div class="pop-head">
        <span>Route ${esc(route.name)} · mile ${Math.round(cp.mile)}</span>
        <span class="pill risk-${cp.risk.level}"><i style="background:${riskColor(cp.risk.level)}"></i>${esc(cp.risk.label)}</span>
      </div>
      <div class="pop-eta">${esc(fmtDayTime(cp.eta))} <span>+${fmtDuration(cp.hours_from_departure)}</span></div>
      <dl>
        <dt>Wind</dt><dd>${Math.round(w.wind_mph)} mph <span>gust ${Math.round(w.gust_mph)}</span></dd>
        <dt>Rain</dt><dd>${w.rain_in_hr.toFixed(2)} in/hr</dd>
        <dt>Snow</dt><dd>${w.snow_in_hr.toFixed(2)} in/hr</dd>
        <dt>Temp</dt><dd>${Math.round(w.temp_f)}°F</dd>
      </dl>
      <div class="pop-foot">${esc(driver)}</div>
    </div>`
}

function endpointIcon(kind: 'origin' | 'destination') {
  return L.divIcon({ className: `endpoint ${kind}`, iconSize: [16, 16], iconAnchor: [8, 8] })
}

const truckIcon = L.divIcon({
  className: 'truck-marker',
  html: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M3 6h11v9H3zM14 9h4l3 3v3h-7z" fill="currentColor"/><circle cx="7" cy="17" r="2" fill="currentColor"/><circle cx="17" cy="17" r="2" fill="currentColor"/></svg>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
})

type Track = { pts: L.LatLng[]; cum: number[] }

function buildTrack(route: Route): Track {
  const pts: L.LatLng[] = []
  for (const seg of route.segments) {
    for (const [lat, lon] of seg.coords) {
      const p = L.latLng(lat, lon)
      if (!pts.length || !pts[pts.length - 1].equals(p)) pts.push(p)
    }
  }
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i - 1].distanceTo(pts[i]))
  // Scale geometric length to the route's mileage so checkpoint miles line up.
  const scale = cum[cum.length - 1] ? route.distance_mi / cum[cum.length - 1] : 0
  return { pts, cum: cum.map((d) => d * scale) }
}

function positionAt(route: Route, track: Track, hours: number): L.LatLng | null {
  const cps = route.checkpoints
  if (hours < 0 || !track.pts.length) return null
  let mile = route.distance_mi
  for (let i = 1; i < cps.length; i++) {
    if (hours <= cps[i].hours_from_departure) {
      const a = cps[i - 1]
      const b = cps[i]
      const span = b.hours_from_departure - a.hours_from_departure
      mile = a.mile + (span > 0 ? ((hours - a.hours_from_departure) / span) * (b.mile - a.mile) : 0)
      break
    }
  }
  let lo = 0
  let hi = track.cum.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (track.cum[mid] <= mile) lo = mid
    else hi = mid
  }
  const seg = track.cum[hi] - track.cum[lo]
  const t = seg > 0 ? Math.min(1, Math.max(0, (mile - track.cum[lo]) / seg)) : 0
  const a = track.pts[lo]
  const b = track.pts[hi]
  return L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t)
}

type Props = {
  plan: Plan | null
  selected: number
  onSelect: (id: number) => void
  activeCheckpoint: number | null
  onCheckpoint: (index: number | null) => void
  heat: Heatmap | null
  heatVisible: boolean
  heatHour: number
  heatMetric: HeatMetric
}

export function MapView({ plan, selected, onSelect, activeCheckpoint, onCheckpoint, heat, heatVisible, heatHour, heatMetric }: Props) {
  const divRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const routeLayer = useRef<L.LayerGroup | null>(null)
  const markers = useRef<Map<number, L.CircleMarker>>(new Map())
  const heatLayer = useRef<{ overlay: L.ImageOverlay; ctx: CanvasRenderingContext2D } | null>(null)
  const truck = useRef<L.Marker | null>(null)
  const truckWest = useRef(false)
  const callbacks = useRef({ onSelect, onCheckpoint })
  useEffect(() => {
    callbacks.current = { onSelect, onCheckpoint }
  })

  // Map setup (once).
  useEffect(() => {
    if (!divRef.current) return
    const map = L.map(divRef.current, { zoomControl: false, preferCanvas: true, worldCopyJump: true, zoomSnap: 0.25 }).setView([39.5, -98.35], 4)
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas'
    L.tileLayer(`${esri}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
      attribution: 'Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors · Weather <a href="https://open-meteo.com/">Open-Meteo</a>',
      maxZoom: 16,
    }).addTo(map)
    // Labels sit above the weather layer so place names stay readable.
    map.createPane('labels').style.zIndex = '380'
    map.getPane('labels')!.style.pointerEvents = 'none'
    L.tileLayer(`${esri}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { pane: 'labels', maxZoom: 16 }).addTo(map)
    map.createPane('heat').style.zIndex = '350'
    map.createPane('routes-bg').style.zIndex = '390'
    routeLayer.current = L.layerGroup().addTo(map)
    mapRef.current = map
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(divRef.current)
    return () => {
      ro.disconnect()
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Fit to a new plan.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !plan) return
    const [s, w, n, e] = plan.bbox
    map.fitBounds(
      [
        [s, w],
        [n, e],
      ],
      { padding: [48, 48], animate: true },
    )
  }, [plan])

  const tracks = useMemo(() => new Map(plan?.routes.map((r) => [r.id, buildTrack(r)]) ?? []), [plan])

  // Routes, checkpoints and labels.
  useEffect(() => {
    const layer = routeLayer.current
    if (!layer) return
    layer.clearLayers()
    markers.current.clear()
    if (!plan) return

    for (const route of plan.routes) {
      if (route.id === selected) continue
      const track = tracks.get(route.id)!
      L.polyline(track.pts, { pane: 'routes-bg', color: '#ffffff', weight: 9, opacity: 0.9 }).addTo(layer)
      const line = L.polyline(track.pts, { pane: 'routes-bg', color: '#8796a8', weight: 4.5, opacity: 0.85 }).addTo(layer)
      line.on('click', () => callbacks.current.onSelect(route.id))
      line.on('mouseover', () => line.setStyle({ color: '#3a4a60' }))
      line.on('mouseout', () => line.setStyle({ color: '#8796a8' }))
      line.bindTooltip(`Route ${route.name} · ${fmtDuration(route.trip_hours)} · click to inspect`, { sticky: true, className: 'map-tip' })
    }

    const route = plan.routes.find((r) => r.id === selected)
    if (!route) return
    const track = tracks.get(route.id)!
    L.polyline(track.pts, { color: '#0f1b2d', weight: 10, opacity: 0.85 }).addTo(layer)
    for (const seg of route.segments) {
      L.polyline(seg.coords, { color: riskColor(seg.level), weight: 6, opacity: 1, interactive: false }).addTo(layer)
    }
    for (const cp of route.checkpoints) {
      const m = L.circleMarker([cp.lat, cp.lon], {
        radius: cp.risk.level >= 2 ? 6.5 : 5,
        color: '#ffffff',
        weight: 2,
        fillColor: riskColor(cp.risk.level),
        fillOpacity: 1,
      })
        .bindPopup(popupHtml(route, cp), { className: 'cp-popup', maxWidth: 260, autoPanPadding: [40, 40] })
        .bindTooltip(`Mile ${Math.round(cp.mile)} · ${fmtDayTime(cp.eta)} · ${cp.risk.label}`, { className: 'map-tip', direction: 'top', offset: [0, -6] })
        .addTo(layer)
      m.on('popupopen', () => callbacks.current.onCheckpoint(cp.index))
      m.on('popupclose', () => callbacks.current.onCheckpoint(null))
      markers.current.set(cp.index, m)
    }

    // Route summary labels, staggered along each line so they don't stack.
    plan.routes.forEach((r, i) => {
      const t = tracks.get(r.id)!
      const at = t.pts[Math.floor(t.pts.length * (0.3 + 0.2 * i))] ?? t.pts[0]
      const sel = r.id === selected
      const label = L.marker(at, {
        icon: L.divIcon({
          className: '',
          html: `<div class="route-label${sel ? ' sel' : ''}${r.id === plan.recommended ? ' rec' : ''}"><b>${esc(r.name)}</b>${fmtDuration(r.trip_hours)} · ${fmtMiles(r.distance_mi)}</div>`,
          iconSize: undefined,
          iconAnchor: [0, 0],
        }),
        zIndexOffset: sel ? 900 : 800,
        keyboard: false,
      }).addTo(layer)
      label.on('click', () => callbacks.current.onSelect(r.id))
    })

    L.marker([plan.origin.lat, plan.origin.lon], { icon: endpointIcon('origin'), zIndexOffset: 1000 })
      .bindTooltip(esc(plan.origin.label), { className: 'map-tip' })
      .addTo(layer)
    L.marker([plan.destination.lat, plan.destination.lon], { icon: endpointIcon('destination'), zIndexOffset: 1000 })
      .bindTooltip(esc(plan.destination.label), { className: 'map-tip' })
      .addTo(layer)
  }, [plan, selected, tracks])

  // Focus a checkpoint chosen from the list.
  useEffect(() => {
    const map = mapRef.current
    if (!map || activeCheckpoint === null) return
    const m = markers.current.get(activeCheckpoint)
    if (m && !m.isPopupOpen()) {
      map.panTo(m.getLatLng(), { animate: true })
      m.openPopup()
    }
  }, [activeCheckpoint, selected])

  // Heatmap overlay lifecycle.
  useEffect(() => {
    const map = mapRef.current
    heatLayer.current?.overlay.remove()
    heatLayer.current = null
    if (!map || !heat) return
    const canvas = document.createElement('canvas')
    canvas.width = heat.cols
    canvas.height = heat.rows
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const b = heat.bounds
    const overlay = new CanvasOverlay(
      canvas,
      [
        [b.south, b.west],
        [b.north, b.east],
      ],
      { pane: 'heat', opacity: 0.62, interactive: false, className: 'heat-layer' },
    )
    heatLayer.current = { overlay, ctx }
  }, [heat])

  useEffect(() => {
    const map = mapRef.current
    const h = heatLayer.current
    if (!map || !h || !heat) return
    if (!heatVisible) {
      h.overlay.remove()
      return
    }
    paintHeat(h.ctx, heat, heatHour, heatMetric)
    if (!map.hasLayer(h.overlay)) h.overlay.addTo(map)
  }, [heat, heatVisible, heatHour, heatMetric])

  // Truck position for the forecast hour on the slider.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const route = plan?.routes.find((r) => r.id === selected)
    const track = route ? tracks.get(route.id) : undefined
    let pos: L.LatLng | null = null
    let westbound = truckWest.current
    if (plan && route && track && heat && heatVisible) {
      const t = heatHour - (new Date(plan.departure).getTime() - new Date(heat.start).getTime()) / 3_600_000
      pos = positionAt(route, track, t)
      // Face the direction of travel: compare with where the truck is a little later
      // (or a little earlier at the destination). Keep the last heading while stopped.
      const ahead = positionAt(route, track, t + 0.5)
      const behind = positionAt(route, track, Math.max(0, t - 0.5))
      const from = pos && ahead && !ahead.equals(pos) ? pos : behind
      const to = pos && ahead && !ahead.equals(pos) ? ahead : pos
      if (from && to && Math.abs(to.lng - from.lng) > 1e-4) westbound = to.lng < from.lng
    }
    if (!pos) {
      truck.current?.remove()
      truck.current = null
      return
    }
    truckWest.current = westbound
    if (!truck.current) truck.current = L.marker(pos, { icon: truckIcon, zIndexOffset: 1100, interactive: false }).addTo(map)
    else truck.current.setLatLng(pos)
    truck.current.getElement()?.classList.toggle('west', westbound)
  }, [plan, selected, tracks, heat, heatVisible, heatHour])

  return <div ref={divRef} className="map" role="application" aria-label="Route map" />
}
