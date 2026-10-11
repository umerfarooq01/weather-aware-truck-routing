"""Geocoding via Photon (OpenStreetMap data, no API key)."""
from .http import UpstreamError, get_json

PHOTON_URL = "https://photon.komoot.io/api/"


def _label(props: dict) -> str:
    parts = []
    name = props.get("name")
    if name:
        parts.append(name)
    for key in ("city", "county", "state", "country"):
        val = props.get(key)
        if val and val not in parts:
            parts.append(val)
    return ", ".join(parts[:4])


def search(query: str, limit: int = 6) -> list[dict]:
    data = get_json(PHOTON_URL, params={"q": query, "limit": limit, "lang": "en"}, timeout=8)
    results, seen = [], set()
    for feat in data.get("features", []):
        lon, lat = feat["geometry"]["coordinates"]
        label = _label(feat.get("properties", {}))
        if not label or label in seen:
            continue
        seen.add(label)
        results.append({"label": label, "lat": lat, "lon": lon})
    return results


def resolve(query: str) -> dict:
    results = search(query, limit=1)
    if not results:
        raise UpstreamError(f'No location found for "{query}"')
    return results[0]
