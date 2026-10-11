# Headwind — Weather-Aware Truck Routing

**Live demo:** https://weather-aware-truck-routing-mu.vercel.app

A React + Django web app that helps a truck driver pick the safest route given the weather, the load weight and the travel time.

Enter an origin, destination, departure time and load. Headwind:

1. Generates **3 route options**.
2. Places **weather checkpoints every 10, 25 or 50 miles**, then works out when the truck reaches each one.
3. Pulls the **hourly forecast for that arrival hour** at each checkpoint and classifies it with the risk and load rules.
4. **Recommends a route**: fewest Severe miles, then fewest High miles, then lowest average risk, then shortest time.
5. Shows routes, risk-colored segments, checkpoints, ETAs and route summaries on a map, with a **0–48 h corridor weather heatmap** driven by a time slider. The slider also moves a truck marker along the selected route.

Recent plans are stored in Supabase and shown in the sidebar.

---

## Architecture

```
frontend/  React 19 + TypeScript + Vite + Leaflet   (static, served by Vercel CDN)
backend/   Django 5.2 JSON API                       (Vercel Python serverless function via api/index.py)
           ├── routing/services/routes.py    OSRM route options + truck travel times
           ├── routing/services/weather.py   Open-Meteo batched hourly forecasts
           ├── routing/services/risk.py      Risk thresholds, load rules, ranking
           ├── routing/services/planner.py   Checkpoints, ETAs (incl. HOS), scoring, recommendation
           ├── routing/services/heatmap.py   Corridor grid forecast for 0–48 h
           └── routing/services/history.py   Supabase trip history (PostgREST)
```

| Concern   | Provider                                   | Key needed |
|-----------|--------------------------------------------|------------|
| Routing   | OSRM public API (`router.project-osrm.org`) | No |
| Geocoding | Photon (Komoot, OpenStreetMap data)         | No |
| Weather   | Open-Meteo forecast API                     | No |
| Basemap   | Esri World Light Gray Canvas                | No |
| History   | Supabase (Postgres + RLS)                   | Publishable key |

### API

| Method | Path           | Purpose |
|--------|----------------|---------|
| GET    | `/api/health`  | Liveness check |
| GET    | `/api/geocode?q=` | Place autocomplete |
| POST   | `/api/plan`    | `{origin, destination, departure, load_lb, interval_mi, hos}` → routes, checkpoints, risk, recommendation |
| POST   | `/api/heatmap` | `{paths, departure, load_lb}` → corridor risk/wind/precip grid for 49 hourly frames |
| GET    | `/api/trips`   | Recent plans |

`origin` and `destination` can be a `{label, lat, lon}` object from autocomplete or free text, which is geocoded on the server.

---

## How the logic works

### Route options
OSRM is asked for up to 3 alternatives. OSRM often returns fewer. When it does, extra corridors are forced by routing through a waypoint offset perpendicular to the straight line (±15% and ±30% of trip length). A candidate is dropped if:
- it overlaps an existing route by more than 85%,
- it is more than 1.6× slower than the fastest route, or
- it backtracks on itself to reach the waypoint.

### Truck ETAs
OSRM's per-segment car durations are converted to truck times by capping speed at **65 mph**. By default the planner also applies simplified **FMCSA hours-of-service** rules: a 30-min break after 8 h of driving and a 10 h rest after 11 h. A checkpoint's ETA is departure + elapsed time, rests included. HOS can be switched off in the form.

### Checkpoint weather
Checkpoints sit at mile 0, every *N* miles, and at the destination. A final checkpoint that would land within N/4 miles of the destination is merged into it. All checkpoints for all routes are fetched in a few batched Open-Meteo requests: up to 100 locations per request, run in parallel. Each checkpoint uses the forecast hour nearest its ETA.

- **Wind**: sustained 10 m wind speed, in mph. Gusts are shown but not scored.
- **Rain**: `rain + showers`, in in/hr.
- **Snow**: `snowfall`, in in/hr.

### Risk rules
| Condition | Low | Moderate | High | Severe | No Travel |
|-----------|-----|----------|------|--------|-----------|
| Wind (mph) | <25 | 25–34 | 35–44 | 45–54 | ≥55 |
| Rain (in/hr) | <0.10 | 0.10–0.25 | 0.25–0.50 | 0.50–1.00 | >1.00 |
| Snow (in/hr) | <0.5 | 0.5–1.0 | 1.0–2.0 | 2.0–3.0 | >3.0 |

Where two bands share a boundary value (for example rain 0.25), the value goes in the higher band. 1.00 in/hr rain and 3.0 in/hr snow are still Severe, because the spec says No Travel starts *above* them.

Load rules, applied to wind:
- ≥55 mph → No Travel for any load
- 45–54 mph and load >30,000 lb → No Travel
- 35–44 mph and load >40,000 lb → Severe

A checkpoint's level is the worst of its wind, rain and snow levels.

### Miles and ranking
Each checkpoint stands for the stretch of road halfway back to the previous checkpoint and halfway on to the next one. Summing those stretches gives each route's miles per risk level. Average risk is the mileage-weighted mean of the level index (Low = 0 … No Travel = 4).

Routes are sorted by:
1. No Travel miles. These are strictly worse than Severe, so they are checked before the spec's first criterion.
2. Severe miles.
3. High miles.
4. Average risk.
5. Total trip time.

The UI explains why the winner beat each other route. If even the best route crosses No Travel conditions, it warns the driver not to depart as planned.

### Heatmap
The backend builds a grid that is uniform in **Web Mercator**, keeps only cells within the trip corridor, and fetches 49 hourly frames (+0 h to +48 h from departure). The client paints one pixel per cell into a small `<canvas>`. A custom Leaflet `ImageOverlay` shows that canvas live, and the browser's bilinear scaling makes it a smooth heatmap. Moving the slider repaints a few hundred pixels and makes no network calls, so playback is instant. The grid can be shown as load-adjusted **risk**, **wind** or **precipitation**.

---

## Running locally

Requirements: Python 3.12+ and Node 20+.

```bash
pip install -r requirements.txt
cd frontend && npm install && cd ..

# API on :8000 (trip history is optional; omit the SUPABASE_* vars to disable it)
DJANGO_DEBUG=1 SUPABASE_URL=... SUPABASE_KEY=... python backend/manage.py runserver 8000

# Web on :5173 (proxies /api to :8000)
npm run dev --prefix frontend
```

Tests (risk thresholds, load rules, ranking, HOS, request validation):

```bash
cd backend && python manage.py test
```

### Supabase
Trip history uses a single table with row-level security:

```sql
create table public.trip_plans (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  origin text not null, destination text not null,
  departure timestamptz not null, load_lb integer not null,
  interval_mi integer not null check (interval_mi in (10, 25, 50)),
  recommended_label text, summary jsonb not null default '{}'
);
alter table public.trip_plans enable row level security;
-- anon may read and insert; nothing may update or delete
```

## Deployment (Vercel)
`vercel.json` builds the Vite app into `frontend/dist`, deploys `api/index.py` as a Python function that serves the Django WSGI app, and rewrites `/api/*` to it. Set these environment variables: `DJANGO_SECRET_KEY`, `SUPABASE_URL` and `SUPABASE_KEY`.

## Known limitations
- OSRM's public server uses a car profile, so it doesn't know truck-only restrictions such as low bridges or weight limits. In production you'd swap it for a truck-aware router such as HERE, TomTom or Valhalla with a truck costing profile.
- Forecasts are hourly. A checkpoint uses the hour nearest its ETA.
- The public OSRM, Photon and Open-Meteo endpoints are rate-limited and best effort. A production deployment should use paid keys and caching.
