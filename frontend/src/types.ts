export type Place = { label: string; lat: number; lon: number }

export type RiskLevel = 0 | 1 | 2 | 3 | 4

export type Weather = {
  time: string
  wind_mph: number
  gust_mph: number
  rain_in_hr: number
  snow_in_hr: number
  temp_f: number
  weather_code: number
}

export type Checkpoint = {
  index: number
  mile: number
  lat: number
  lon: number
  eta: string
  hours_from_departure: number
  weather: Weather
  risk: {
    level: RiskLevel
    label: string
    factors: { wind: RiskLevel; rain: RiskLevel; snow: RiskLevel }
    driver: 'none' | 'wind' | 'rain' | 'snow'
  }
}

export type MilesByLevel = Record<'Low' | 'Moderate' | 'High' | 'Severe' | 'No Travel', number>

export type Route = {
  id: number
  name: string
  source: 'osrm' | 'detour'
  distance_mi: number
  driving_hours: number
  trip_hours: number
  arrival: string
  rank: number
  tags: string[]
  summary: { miles_by_level: MilesByLevel; average_risk: number; max_level: RiskLevel }
  checkpoints: Checkpoint[]
  segments: { level: RiskLevel; coords: [number, number][] }[]
}

export type Plan = {
  origin: Place
  destination: Place
  departure: string
  load_lb: number
  interval_mi: 10 | 25 | 50
  hos: boolean
  bbox: [number, number, number, number]
  recommended: number
  recommendation_reasons: string[]
  no_travel_warning: boolean
  routes: Route[]
}

export type Heatmap = {
  bounds: { south: number; north: number; west: number; east: number }
  cols: number
  rows: number
  cells: number[]
  start: string
  hours: number
  risk: number[][]
  wind_mph: number[][]
  precip_hundredths: number[][]
}

export type PlanRequest = {
  origin: Place | string
  destination: Place | string
  departure: string
  load_lb: number
  interval_mi: 10 | 25 | 50
  hos: boolean
}

export type TripRecord = {
  id: string
  created_at: string
  origin: string
  destination: string
  departure: string
  load_lb: number
  interval_mi: 10 | 25 | 50
  recommended_label: string | null
  summary: {
    origin?: Place
    destination?: Place
    distance_mi?: number
    trip_hours?: number
    max_level?: RiskLevel
  }
}
