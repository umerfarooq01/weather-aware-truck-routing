"""Geocoding via Photon (OpenStreetMap data, no API key)."""
from .http import get_json

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


class NotFound(Exception):
    """The query didn't match any location (a user input problem, not an upstream failure)."""


def _is_place(feat: dict) -> bool:
    return feat.get("properties", {}).get("osm_key") in ("place", "boundary")


def search(query: str, limit: int = 6) -> list[dict]:
    data = get_json(PHOTON_URL, params={"q": query, "limit": limit * 2, "lang": "en"}, timeout=8)
    # Prefer settlements and regions over businesses/POIs that merely share the name.
    features = sorted(data.get("features", []), key=lambda f: not _is_place(f))
    results, seen = [], set()
    for feat in features:
        lon, lat = feat["geometry"]["coordinates"]
        label = _label(feat.get("properties", {}))
        if not label or label in seen:
            continue
        seen.add(label)
        results.append({"label": label, "lat": lat, "lon": lon})
    return results[:limit]


def resolve(query: str) -> dict:
    results = search(query, limit=5)
    if not results:
        raise NotFound(f'No location found for "{query}"')
    return results[0]
