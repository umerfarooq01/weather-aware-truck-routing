import type { Heatmap, Place, Plan, PlanRequest, TripRecord } from './types'

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(`/api/${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new ApiError('Network error — check your connection and try again.')
  }
  let body: unknown = null
  try {
    body = await resp.json()
  } catch {
    /* non-JSON error page */
  }
  if (!resp.ok) {
    const message = (body as { error?: string } | null)?.error
    if (message) throw new ApiError(message)
    if (resp.status === 504) throw new ApiError('The planner took too long. Try a larger checkpoint interval or a shorter trip.')
    throw new ApiError(`Request failed (${resp.status}). Please try again.`)
  }
  return body as T
}

export const api = {
  geocode: (q: string, signal?: AbortSignal) =>
    request<{ results: Place[] }>(`geocode?q=${encodeURIComponent(q)}`, { signal }).then((r) => r.results),
  plan: (body: PlanRequest) => request<Plan>('plan', { method: 'POST', body: JSON.stringify(body) }),
  heatmap: (body: { paths: [number, number][][]; departure: string; load_lb: number }) =>
    request<Heatmap>('heatmap', { method: 'POST', body: JSON.stringify(body) }),
  trips: () => request<{ trips: TripRecord[] }>('trips').then((r) => r.trips),
}
