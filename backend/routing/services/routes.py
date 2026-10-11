"""Route generation via the public OSRM API.

OSRM returns car routes; we convert segment travel times to truck travel times by capping
speed at TRUCK_MAX_MPH. When OSRM offers fewer than three alternatives we force distinct
corridors by routing through a waypoint offset to either side of the straight line.
"""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from .geo import haversine_mi, simplify
from .http import UpstreamError, get_json

OSRM_URL = "https://router.project-osrm.org/route/v1/driving/"
TRUCK_MAX_MPH = 65.0
MAX_DETOUR_RATIO = 1.6  # discard forced alternatives that are much slower than the fastest route


@dataclass
class Route:
    coords: list[tuple[float, float]]  # (lat, lon)
    seg_mi: list[float]
    seg_s: list[float]  # truck driving seconds per segment
    distance_mi: float = 0.0
    driving_s: float = 0.0
    source: str = "osrm"
    cum_mi: list[float] = field(default_factory=list)
    cum_s: list[float] = field(default_factory=list)

    def __post_init__(self):
        self.cum_mi, self.cum_s = [0.0], [0.0]
        for mi, s in zip(self.seg_mi, self.seg_s):
            self.cum_mi.append(self.cum_mi[-1] + mi)
            self.cum_s.append(self.cum_s[-1] + s)
        self.distance_mi = self.cum_mi[-1]
        self.driving_s = self.cum_s[-1]


def _fetch(points: list[tuple[float, float]], alternatives: int) -> list[dict]:
    path = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in points)
    params = {
        "overview": "full",
        "geometries": "geojson",
        "annotations": "duration",
        "steps": "false",
    }
    if alternatives:
        params["alternatives"] = str(alternatives)
    data = get_json(OSRM_URL + path, params=params, timeout=20)
    if data.get("code") != "Ok" or not data.get("routes"):
        if data.get("code") == "NoRoute":
            raise UpstreamError("No drivable route exists between these locations")
        raise UpstreamError(data.get("message") or "Routing service returned no routes")
    return data["routes"]


def _to_route(raw: dict, source: str) -> Route:
    coords = [(lat, lon) for lon, lat in raw["geometry"]["coordinates"]]
    seg_mi = [haversine_mi(coords[i], coords[i + 1]) for i in range(len(coords) - 1)]
    durations = [d for leg in raw.get("legs", []) for d in leg.get("annotation", {}).get("duration", [])]
    if len(durations) != len(seg_mi):
        # Fall back to the route's average speed if annotations don't line up with the geometry.
        total_mi = sum(seg_mi) or 1.0
        durations = [raw["duration"] * mi / total_mi for mi in seg_mi]
    seg_s = [max(d, mi / TRUCK_MAX_MPH * 3600.0) for d, mi in zip(durations, seg_mi)]
    return Route(coords=coords, seg_mi=seg_mi, seg_s=seg_s, source=source)


def _sample(route: Route, n: int = 24) -> list[tuple[float, float]]:
    step = max(1, len(route.coords) // n)
    return route.coords[::step]


def _overlap(a: Route, b: Route, tol_mi: float) -> float:
    """Fraction of a's sample points that lie within tol_mi of b's geometry."""
    b_pts = [b.coords[i] for i in simplify(b.coords, 1.0)]
    pts = _sample(a)
    near = sum(1 for p in pts if min(haversine_mi(p, q) for q in b_pts) <= tol_mi)
    return near / len(pts)


def _is_distinct(candidate: Route, chosen: list[Route]) -> bool:
    tol = max(2.0, candidate.distance_mi * 0.01)
    return all(_overlap(candidate, r, tol) < 0.85 for r in chosen)


def _detour_waypoints(origin, dest) -> list[tuple[float, float]]:
    (lat1, lon1), (lat2, lon2) = origin, dest
    mid_lat, mid_lon = (lat1 + lat2) / 2, (lon1 + lon2) / 2
    d_lat, d_lon = lat2 - lat1, lon2 - lon1
    waypoints = []
    for frac in (0.15, -0.15, 0.3, -0.3):
        # Perpendicular offset, proportional to trip length.
        waypoints.append((mid_lat - d_lon * frac, mid_lon + d_lat * frac))
    return waypoints


def get_routes(origin: tuple[float, float], dest: tuple[float, float], want: int = 3) -> list[Route]:
    if haversine_mi(origin, dest) < 1.0:
        raise UpstreamError("Origin and destination are too close together")

    chosen: list[Route] = []
    for raw in _fetch([origin, dest], alternatives=want):
        route = _to_route(raw, "osrm")
        if not chosen or _is_distinct(route, chosen):
            chosen.append(route)
        if len(chosen) == want:
            return chosen

    fastest = min(r.driving_s for r in chosen)

    def try_detour(wp):
        try:
            return _to_route(_fetch([origin, wp, dest], alternatives=0)[0], "detour")
        except UpstreamError:
            return None

    with ThreadPoolExecutor(max_workers=4) as pool:
        detours = [r for r in pool.map(try_detour, _detour_waypoints(origin, dest)) if r]

    for route in sorted(detours, key=lambda r: r.driving_s):
        if route.driving_s > fastest * MAX_DETOUR_RATIO:
            continue
        if _is_distinct(route, chosen) and not _has_backtrack(route):
            chosen.append(route)
        if len(chosen) == want:
            break
    return chosen


def _has_backtrack(route: Route) -> bool:
    """Reject forced routes that leave the highway to tag the waypoint and come back on the same road."""
    n = len(route.coords)
    if n < 20:
        return False
    first, second = route.coords[: n // 2], route.coords[n // 2 :]
    step = max(1, len(second) // 30)
    probe = second[::step]
    tol = 0.05
    first_pts = [first[i] for i in simplify(first, 0.25)]
    reused = sum(1 for p in probe if min(haversine_mi(p, q) for q in first_pts) <= tol)
    return reused / len(probe) > 0.25
