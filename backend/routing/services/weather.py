"""Hourly forecasts from Open-Meteo. Many locations are fetched per request.

The free tier is limited to roughly 600 location-lookups per minute, so callers keep the
number of unique locations bounded (see `cluster`) and results are cached briefly in-process.
Set OPEN_METEO_API_KEY to use the commercial endpoint and its higher limits.
"""
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from django.conf import settings

from .http import UpstreamError, get_json

BATCH = 100
CACHE_TTL_S = 20 * 60
CACHE_MAX = 4000
VARIABLES = ["wind_speed_10m", "wind_gusts_10m", "rain", "showers", "snowfall", "temperature_2m", "weather_code"]

_cache: dict[tuple, tuple[float, "HourlySeries"]] = {}
_cache_lock = threading.Lock()


def floor_hour(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


class HourlySeries:
    """Forecast for one location over a fixed window of whole UTC hours."""

    def __init__(self, start: datetime, hourly: dict):
        self.start = start
        self.wind = _clean(hourly.get("wind_speed_10m"))
        self.gust = _clean(hourly.get("wind_gusts_10m"), len(self.wind))
        rain = _clean(hourly.get("rain"), len(self.wind))
        showers = _clean(hourly.get("showers"), len(rain))
        self.rain = [r + s for r, s in zip(rain, showers)]  # liquid precipitation, in/hr
        self.snow = _clean(hourly.get("snowfall"), len(self.wind))  # in/hr (precipitation_unit=inch)
        self.temp = _clean(hourly.get("temperature_2m"), len(self.wind))
        self.code = _clean(hourly.get("weather_code"), len(self.wind))
        if not self.wind:
            raise UpstreamError("Weather service returned an empty forecast")

    def __len__(self):
        return len(self.wind)

    def at(self, when: datetime) -> dict:
        idx = round((when - self.start).total_seconds() / 3600.0)
        idx = min(max(idx, 0), len(self) - 1)
        return {
            "time": (self.start + timedelta(hours=idx)).isoformat(),
            "wind_mph": round(self.wind[idx], 1),
            "gust_mph": round(self.gust[idx], 1),
            "rain_in_hr": round(self.rain[idx], 3),
            "snow_in_hr": round(self.snow[idx], 3),
            "temp_f": round(self.temp[idx], 1),
            "weather_code": int(self.code[idx]),
        }


def _clean(values, n=None) -> list[float]:
    if values is None:
        return [0.0] * (n or 0)
    return [float(v) if v is not None else 0.0 for v in values]


def cluster(points: list[tuple[float, float]], max_unique: int) -> tuple[list[tuple[float, float]], list[int]]:
    """Group nearby points so at most `max_unique` forecast lookups are needed.

    Returns (representative points, index into them for every input point). Points are kept
    exact when the budget allows; otherwise they're merged on a progressively coarser grid
    (0.1° ≈ 7 mi up to 0.5°), which is comparable to the forecast models' own resolution.
    """
    for cell in (0.0, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1.0):
        reps: list[tuple[float, float]] = []
        index: list[int] = []
        seen: dict[tuple, int] = {}
        for lat, lon in points:
            key = (round(lat, 4), round(lon, 4)) if cell == 0 else (math.floor(lat / cell), math.floor(lon / cell))
            if key not in seen:
                seen[key] = len(reps)
                reps.append((lat, lon))
            index.append(seen[key])
        if len(reps) <= max_unique:
            break
    return reps, index


def _endpoint() -> tuple[str, dict]:
    key = getattr(settings, "OPEN_METEO_API_KEY", "")
    if key:
        return "https://customer-api.open-meteo.com/v1/forecast", {"apikey": key}
    return "https://api.open-meteo.com/v1/forecast", {}


def _fetch_batch(points: list[tuple[float, float]], start: datetime, end: datetime) -> list[HourlySeries]:
    url, extra = _endpoint()
    params = {
        "latitude": ",".join(f"{lat:.4f}" for lat, _ in points),
        "longitude": ",".join(f"{lon:.4f}" for _, lon in points),
        "hourly": ",".join(VARIABLES),
        "wind_speed_unit": "mph",
        "precipitation_unit": "inch",
        "temperature_unit": "fahrenheit",
        "timezone": "GMT",
        "start_hour": start.strftime("%Y-%m-%dT%H:%M"),
        "end_hour": end.strftime("%Y-%m-%dT%H:%M"),
        **extra,
    }
    try:
        data = get_json(url, params=params, timeout=20)
    except UpstreamError as exc:
        if exc.status != 429:
            raise
        time.sleep(2.0)  # brief back-off for burst limits, then one retry
        data = get_json(url, params=params, timeout=20)
    items = data if isinstance(data, list) else [data]
    if len(items) != len(points):
        raise UpstreamError("Weather service returned an unexpected number of locations")
    out = []
    for item in items:
        if item.get("error"):
            raise UpstreamError(item.get("reason", "Weather service error"))
        out.append(HourlySeries(start, item.get("hourly", {})))
    return out


def fetch_hourly(points: list[tuple[float, float]], start: datetime, end: datetime) -> list[HourlySeries]:
    """Hourly series for each point from floor(start) through floor(end), inclusive."""
    if not points:
        return []
    start, end = floor_hour(start), floor_hour(end)
    now = time.monotonic()
    keys = [(round(lat, 4), round(lon, 4), start, end) for lat, lon in points]

    result: dict[tuple, HourlySeries] = {}
    with _cache_lock:
        for k in keys:
            hit = _cache.get(k)
            if hit and hit[0] > now:
                result[k] = hit[1]
    missing = list(dict.fromkeys(k for k in keys if k not in result))

    if missing:
        pts = [(k[0], k[1]) for k in missing]
        batches = [pts[i : i + BATCH] for i in range(0, len(pts), BATCH)]
        with ThreadPoolExecutor(max_workers=min(4, len(batches))) as pool:
            fetched = [s for batch in pool.map(lambda b: _fetch_batch(b, start, end), batches) for s in batch]
        with _cache_lock:
            if len(_cache) + len(missing) > CACHE_MAX:
                _cache.clear()
            for k, series in zip(missing, fetched):
                _cache[k] = (now + CACHE_TTL_S, series)
                result[k] = series

    return [result[k] for k in keys]
