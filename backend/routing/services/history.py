"""Trip history persisted in Supabase (PostgREST). Failures never break planning."""
import logging

import requests
from django.conf import settings

log = logging.getLogger(__name__)


def _headers() -> dict:
    return {
        "apikey": settings.SUPABASE_KEY,
        "Authorization": f"Bearer {settings.SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def enabled() -> bool:
    return bool(settings.SUPABASE_URL and settings.SUPABASE_KEY)


def save(plan: dict) -> None:
    if not enabled():
        return
    best = next(r for r in plan["routes"] if r["id"] == plan["recommended"])
    row = {
        "origin": plan["origin"]["label"][:200],
        "destination": plan["destination"]["label"][:200],
        "departure": plan["departure"],
        "load_lb": plan["load_lb"],
        "interval_mi": plan["interval_mi"],
        "recommended_label": f"Route {best['name']}",
        "summary": {
            "origin": plan["origin"],
            "destination": plan["destination"],
            "routes": len(plan["routes"]),
            "distance_mi": best["distance_mi"],
            "trip_hours": best["trip_hours"],
            "max_level": best["summary"]["max_level"],
            "miles_by_level": best["summary"]["miles_by_level"],
        },
    }
    try:
        resp = requests.post(
            f"{settings.SUPABASE_URL}/rest/v1/trip_plans",
            json=row,
            headers={**_headers(), "Prefer": "return=minimal"},
            timeout=4,
        )
        if resp.status_code >= 300:
            log.warning("Supabase insert failed: %s %s", resp.status_code, resp.text[:200])
    except requests.RequestException as exc:
        log.warning("Supabase insert error: %s", exc)


def recent(limit: int = 8) -> list[dict]:
    if not enabled():
        return []
    try:
        resp = requests.get(
            f"{settings.SUPABASE_URL}/rest/v1/trip_plans",
            params={
                "select": "id,created_at,origin,destination,departure,load_lb,interval_mi,recommended_label,summary",
                "order": "created_at.desc",
                "limit": str(limit),
            },
            headers=_headers(),
            timeout=4,
        )
        resp.raise_for_status()
        return resp.json()
    except (requests.RequestException, ValueError) as exc:
        log.warning("Supabase read error: %s", exc)
        return []
