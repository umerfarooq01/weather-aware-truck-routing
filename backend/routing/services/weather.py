"""Hourly forecasts from Open-Meteo (no API key). Many locations are fetched per request."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from .http import UpstreamError, get_json

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
BATCH = 100
VARIABLES = ["wind_speed_10m", "wind_gusts_10m", "rain", "showers", "snowfall", "temperature_2m", "weather_code"]


def floor_hour(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


class HourlySeries:
    """Forecast for one location over a fixed window of whole UTC hours."""

    def __init__(self, start: datetime, hourly: dict):
        self.start = start
        self.wind = _clean(hourly.get("wind_speed_10m"))
        self.gust = _clean(hourly.get("wind_gusts_10m"))
        rain = _clean(hourly.get("rain"))
        showers = _clean(hourly.get("showers"), len(rain))
        self.rain = [r + s for r, s in zip(rain, showers)]  # liquid precipitation, in/hr
        self.snow = _clean(hourly.get("snowfall"))  # in/hr (precipitation_unit=inch)
        self.temp = _clean(hourly.get("temperature_2m"))
        self.code = _clean(hourly.get("weather_code"))

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


def _fetch_batch(points: list[tuple[float, float]], start: datetime, end: datetime) -> list[HourlySeries]:
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
    }
    data = get_json(OPEN_METEO_URL, params=params, timeout=20)
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
    batches = [points[i : i + BATCH] for i in range(0, len(points), BATCH)]
    with ThreadPoolExecutor(max_workers=min(6, len(batches))) as pool:
        results = list(pool.map(lambda b: _fetch_batch(b, start, end), batches))
    return [series for batch in results for series in batch]
