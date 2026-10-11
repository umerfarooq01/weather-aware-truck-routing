import math

EARTH_RADIUS_MI = 3958.8
METERS_PER_MILE = 1609.344


def haversine_mi(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distance in miles between two (lat, lon) points."""
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(min(1.0, math.sqrt(h)))


def interpolate(a: tuple[float, float], b: tuple[float, float], t: float) -> tuple[float, float]:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def mercator_y(lat: float) -> float:
    lat = max(min(lat, 85.0), -85.0)
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def inverse_mercator_y(y: float) -> float:
    return math.degrees(2 * math.atan(math.exp(y)) - math.pi / 2)


def simplify(points: list[tuple[float, float]], min_gap_mi: float) -> list[int]:
    """Indices of points kept so consecutive kept points are at least min_gap_mi apart (endpoints always kept)."""
    if len(points) <= 2:
        return list(range(len(points)))
    kept = [0]
    for i in range(1, len(points) - 1):
        if haversine_mi(points[kept[-1]], points[i]) >= min_gap_mi:
            kept.append(i)
    kept.append(len(points) - 1)
    return kept
