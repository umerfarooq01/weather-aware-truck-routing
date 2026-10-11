"""Trip planning: checkpoints, ETAs, weather sampling, risk scoring and recommendation."""
import bisect
import math
from datetime import datetime, timedelta

from . import risk
from .geo import interpolate, simplify
from .routes import Route, get_routes
from .weather import fetch_hourly

# FMCSA hours-of-service (property carriers), simplified: 30-min break after 8h of driving,
# 10h off-duty after 11h of driving.
HOS_DRIVE_LIMIT_S = 11 * 3600
HOS_BREAK_AFTER_S = 8 * 3600
HOS_BREAK_S = 30 * 60
HOS_REST_S = 10 * 3600

ROUTE_NAMES = ["A", "B", "C", "D", "E"]


def elapsed_with_hos(driving_s: float, hos: bool) -> float:
    """Wall-clock seconds from departure after `driving_s` seconds of driving."""
    if not hos or driving_s <= 0:
        return driving_s
    periods = math.ceil(driving_s / HOS_DRIVE_LIMIT_S) - 1  # completed 11h shifts before this point
    remainder = driving_s - periods * HOS_DRIVE_LIMIT_S
    stops = periods * (HOS_REST_S + HOS_BREAK_S)
    if remainder > HOS_BREAK_AFTER_S:
        stops += HOS_BREAK_S
    return driving_s + stops


def checkpoint_miles(total_mi: float, interval_mi: float) -> list[float]:
    marks = [0.0]
    m = interval_mi
    while m < total_mi - interval_mi * 0.25:  # avoid a sliver checkpoint right before the destination
        marks.append(m)
        m += interval_mi
    marks.append(total_mi)
    return marks


def locate(route: Route, mile: float) -> tuple[tuple[float, float], float]:
    """Position and cumulative driving seconds at a given mile along the route."""
    i = bisect.bisect_right(route.cum_mi, mile) - 1
    i = min(max(i, 0), len(route.seg_mi) - 1)
    seg = route.seg_mi[i]
    t = 0.0 if seg <= 0 else min(max((mile - route.cum_mi[i]) / seg, 0.0), 1.0)
    point = interpolate(route.coords[i], route.coords[i + 1], t)
    return point, route.cum_s[i] + route.seg_s[i] * t


def _boundaries(marks: list[float]) -> list[float]:
    """Mile boundaries between neighbouring checkpoints; checkpoint k represents [b[k], b[k+1]]."""
    return [0.0] + [(a + b) / 2 for a, b in zip(marks, marks[1:])] + [marks[-1]]


def _colored_segments(route: Route, bounds: list[float], levels: list[int]) -> list[dict]:
    keep = simplify(route.coords, max(0.15, route.distance_mi / 2500))
    pieces: list[dict] = []
    for idx in keep:
        mile = route.cum_mi[idx]
        k = min(max(bisect.bisect_right(bounds, mile) - 1, 0), len(levels) - 1)
        pt = [round(route.coords[idx][0], 5), round(route.coords[idx][1], 5)]
        if pieces and pieces[-1]["level"] == levels[k]:
            pieces[-1]["coords"].append(pt)
        else:
            if pieces:
                pieces[-1]["coords"].append(pt)  # close the gap so the line is continuous
            pieces.append({"level": levels[k], "coords": [pt]})
    return [p for p in pieces if len(p["coords"]) >= 2]


def _explain(best: dict, other: dict) -> str:
    b, o = best["summary"]["miles_by_level"], other["summary"]["miles_by_level"]
    name = f"Route {other['name']}"
    for level in ("No Travel", "Severe", "High"):
        diff = o[level] - b[level]
        if round(diff, 1) > 0:
            return f"{diff:.0f} fewer {level} miles than {name}"
    da = other["summary"]["average_risk"] - best["summary"]["average_risk"]
    if round(da, 3) > 0:
        return f"Lower average risk than {name}"
    dt = round((other["trip_hours"] - best["trip_hours"]) * 60)
    if dt >= 1:
        h, m = divmod(dt, 60)
        faster = f"{h}h {m}m" if h else f"{m} min"
        return f"Same weather exposure as {name}, {faster} faster"
    return f"Equivalent to {name}"


def plan_trip(origin: dict, dest: dict, departure: datetime, load_lb: int, interval_mi: int, hos: bool = True) -> dict:
    routes = get_routes((origin["lat"], origin["lon"]), (dest["lat"], dest["lon"]))

    # Lay out checkpoints for every route, then fetch all weather in one batched pass.
    layouts = []
    all_points = []
    for route in routes:
        marks = checkpoint_miles(route.distance_mi, interval_mi)
        cps = []
        for mile in marks:
            point, drive_s = locate(route, mile)
            eta = departure + timedelta(seconds=elapsed_with_hos(drive_s, hos))
            cps.append({"mile": mile, "point": point, "drive_s": drive_s, "eta": eta})
            all_points.append(point)
        layouts.append(cps)

    last_eta = max(cps[-1]["eta"] for cps in layouts)
    series = fetch_hourly(all_points, departure, last_eta + timedelta(hours=1))

    results = []
    cursor = 0
    for n, (route, cps) in enumerate(zip(routes, layouts)):
        marks = [c["mile"] for c in cps]
        bounds = _boundaries(marks)
        checkpoints, levels, weighted = [], [], []
        for k, cp in enumerate(cps):
            wx = series[cursor].at(cp["eta"])
            cursor += 1
            a = risk.assess(wx["wind_mph"], wx["rain_in_hr"], wx["snow_in_hr"], load_lb)
            miles_covered = bounds[k + 1] - bounds[k]
            levels.append(a.level)
            weighted.append((a.level, miles_covered))
            checkpoints.append({
                "index": k,
                "mile": round(cp["mile"], 1),
                "lat": round(cp["point"][0], 5),
                "lon": round(cp["point"][1], 5),
                "eta": cp["eta"].isoformat(),
                "hours_from_departure": round((cp["eta"] - departure).total_seconds() / 3600, 2),
                "weather": wx,
                "risk": a.as_dict(),
            })
        summary = risk.summarize(weighted)
        trip_s = (cps[-1]["eta"] - departure).total_seconds()
        results.append({
            "id": n,
            "name": ROUTE_NAMES[n],
            "source": route.source,
            "distance_mi": round(route.distance_mi, 1),
            "driving_hours": round(route.driving_s / 3600, 2),
            "trip_hours": round(trip_s / 3600, 2),
            "arrival": cps[-1]["eta"].isoformat(),
            "summary": summary,
            "checkpoints": checkpoints,
            "segments": _colored_segments(route, bounds, levels),
            "_key": risk.ranking_key(summary, trip_s),
        })

    ranked = sorted(results, key=lambda r: r["_key"])
    for rank, r in enumerate(ranked, start=1):
        r["rank"] = rank
    best = ranked[0]
    reasons = [_explain(best, other) for other in ranked[1:]]

    fastest = min(results, key=lambda r: r["trip_hours"])
    shortest = min(results, key=lambda r: r["distance_mi"])
    for r in results:
        r["tags"] = [t for t, cond in (
            ("Recommended", r is best),
            ("Fastest", r is fastest),
            ("Shortest", r is shortest),
        ) if cond]
        del r["_key"]

    lats = [p[0] for route in routes for p in route.coords]
    lons = [p[1] for route in routes for p in route.coords]
    return {
        "origin": origin,
        "destination": dest,
        "departure": departure.isoformat(),
        "load_lb": load_lb,
        "interval_mi": interval_mi,
        "hos": hos,
        "bbox": [min(lats), min(lons), max(lats), max(lons)],
        "recommended": best["id"],
        "recommendation_reasons": reasons,
        "no_travel_warning": best["summary"]["miles_by_level"]["No Travel"] > 0,
        "routes": results,
    }
