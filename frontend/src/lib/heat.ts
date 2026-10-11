import type { Heatmap } from '../types'
import { RISK_RGB } from './risk'

export type HeatMetric = 'risk' | 'wind' | 'precip'

type Stop = [value: number, rgb: [number, number, number], alpha: number]

// Ramps are anchored on the risk thresholds so colors mean the same thing across metrics.
const WIND: Stop[] = [
  [0, [158, 202, 225], 0],
  [15, [158, 202, 225], 90],
  [25, RISK_RGB[1], 150],
  [35, RISK_RGB[2], 180],
  [45, RISK_RGB[3], 200],
  [55, RISK_RGB[4], 215],
]
const PRECIP: Stop[] = [
  [0, [120, 170, 214], 0],
  [2, [120, 170, 214], 80],
  [10, [74, 144, 194], 150],
  [25, [43, 92, 158], 185],
  [50, [194, 54, 43], 200],
  [100, RISK_RGB[4], 215],
]
const RISK_ALPHA = [42, 165, 185, 205, 220]

function ramp(stops: Stop[], v: number): [number, number, number, number] {
  if (v <= stops[0][0]) return [...stops[0][1], stops[0][2]]
  for (let i = 1; i < stops.length; i++) {
    const [v1, c1, a1] = stops[i]
    if (v <= v1) {
      const [v0, c0, a0] = stops[i - 1]
      const t = (v - v0) / (v1 - v0)
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t, a0 + (a1 - a0) * t]
    }
  }
  const last = stops[stops.length - 1]
  return [...last[1], last[2]]
}

/** Paint one forecast hour into a cols×rows canvas (one pixel per cell). */
export function paintHeat(ctx: CanvasRenderingContext2D, heat: Heatmap, hour: number, metric: HeatMetric) {
  const img = ctx.createImageData(heat.cols, heat.rows)
  const h = Math.max(0, Math.min(heat.hours - 1, hour))
  const values = metric === 'risk' ? heat.risk[h] : metric === 'wind' ? heat.wind_mph[h] : heat.precip_hundredths[h]
  heat.cells.forEach((cell, k) => {
    const v = values[k]
    let rgba: [number, number, number, number]
    if (metric === 'risk') rgba = [...RISK_RGB[v], RISK_ALPHA[v]]
    else rgba = ramp(metric === 'wind' ? WIND : PRECIP, v)
    const o = cell * 4
    img.data[o] = rgba[0]
    img.data[o + 1] = rgba[1]
    img.data[o + 2] = rgba[2]
    img.data[o + 3] = rgba[3]
  })
  ctx.putImageData(img, 0, 0)
}

export const LEGENDS: Record<HeatMetric, { title: string; stops: { label: string; color: string }[] }> = {
  risk: {
    title: 'Weather risk (load-adjusted)',
    stops: ['Low', 'Moderate', 'High', 'Severe', 'No Travel'].map((label, i) => ({
      label,
      color: `rgb(${RISK_RGB[i].join(',')})`,
    })),
  },
  wind: {
    title: 'Sustained wind, mph',
    stops: WIND.slice(1).map(([v, c]) => ({ label: String(v), color: `rgb(${c.join(',')})` })),
  },
  precip: {
    title: 'Precipitation, in/hr (liquid eq.)',
    stops: PRECIP.slice(1).map(([v, c]) => ({ label: (v / 100).toFixed(2), color: `rgb(${c.join(',')})` })),
  },
}
