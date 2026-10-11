import type { RiskLevel } from '../types'

export const LEVELS = ['Low', 'Moderate', 'High', 'Severe', 'No Travel'] as const

// Kept in sync with the --risk-* tokens in index.css; Leaflet needs literal colors.
export const RISK_COLORS = ['#2f8f5b', '#c9a227', '#e07a1f', '#c2362b', '#5b1a47'] as const
export const RISK_RGB: [number, number, number][] = [
  [47, 143, 91],
  [201, 162, 39],
  [224, 122, 31],
  [194, 54, 43],
  [91, 26, 71],
]

export const riskColor = (level: RiskLevel | number) => RISK_COLORS[Math.max(0, Math.min(4, level))]
export const riskLabel = (level: RiskLevel | number) => LEVELS[Math.max(0, Math.min(4, level))]
