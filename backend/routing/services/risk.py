"""Weather risk classification and route ranking.

Levels are ordinal so they can be compared and averaged:
0 Low, 1 Moderate, 2 High, 3 Severe, 4 No Travel.
"""
from dataclasses import dataclass

LOW, MODERATE, HIGH, SEVERE, NO_TRAVEL = range(5)
LEVEL_NAMES = ["Low", "Moderate", "High", "Severe", "No Travel"]


def wind_level(mph: float) -> int:
    if mph < 25:
        return LOW
    if mph < 35:
        return MODERATE
    if mph < 45:
        return HIGH
    if mph < 55:
        return SEVERE
    return NO_TRAVEL


def rain_level(in_per_hr: float) -> int:
    # Shared boundaries (0.25, 0.50) belong to the higher band; 1.00 is still Severe (">1.00" is No Travel).
    if in_per_hr < 0.10:
        return LOW
    if in_per_hr < 0.25:
        return MODERATE
    if in_per_hr < 0.50:
        return HIGH
    if in_per_hr <= 1.00:
        return SEVERE
    return NO_TRAVEL


def snow_level(in_per_hr: float) -> int:
    if in_per_hr < 0.5:
        return LOW
    if in_per_hr < 1.0:
        return MODERATE
    if in_per_hr < 2.0:
        return HIGH
    if in_per_hr <= 3.0:
        return SEVERE
    return NO_TRAVEL


def load_adjusted_wind_level(mph: float, load_lb: float) -> int:
    level = wind_level(mph)
    if mph >= 55:
        return NO_TRAVEL
    if 45 <= mph < 55 and load_lb > 30_000:
        return NO_TRAVEL
    if 35 <= mph < 45 and load_lb > 40_000:
        return max(level, SEVERE)
    return level


@dataclass(frozen=True)
class Assessment:
    level: int
    wind: int
    rain: int
    snow: int
    driver: str  # which factor set the overall level

    def as_dict(self) -> dict:
        return {
            "level": self.level,
            "label": LEVEL_NAMES[self.level],
            "factors": {"wind": self.wind, "rain": self.rain, "snow": self.snow},
            "driver": self.driver,
        }


def assess(wind_mph: float, rain_in_hr: float, snow_in_hr: float, load_lb: float) -> Assessment:
    w = load_adjusted_wind_level(wind_mph, load_lb)
    r = rain_level(rain_in_hr)
    s = snow_level(snow_in_hr)
    level = max(w, r, s)
    if level == LOW:
        driver = "none"
    else:
        driver = max((("wind", w), ("rain", r), ("snow", s)), key=lambda kv: kv[1])[0]
    return Assessment(level, w, r, s, driver)


def summarize(segment_miles: list[tuple[int, float]]) -> dict:
    """Aggregate (level, miles) pairs into per-level miles and a mileage-weighted average."""
    miles = [0.0] * 5
    for level, mi in segment_miles:
        miles[level] += mi
    total = sum(miles)
    avg = sum(i * m for i, m in enumerate(miles)) / total if total else 0.0
    return {
        "miles_by_level": {LEVEL_NAMES[i]: round(m, 1) for i, m in enumerate(miles)},
        "average_risk": round(avg, 3),
        "max_level": max((lvl for lvl, mi in segment_miles if mi > 0), default=LOW),
    }


def ranking_key(summary: dict, duration_s: float) -> tuple:
    """Lower is better. No Travel miles are counted ahead of Severe miles (they are strictly worse),
    then the spec order: Severe miles, High miles, average risk, travel time.
    Miles are rounded to 0.1 so floating noise never overrides a real difference later in the key."""
    m = summary["miles_by_level"]
    return (
        round(m["No Travel"], 1),
        round(m["Severe"], 1),
        round(m["High"], 1),
        round(summary["average_risk"], 3),
        duration_s,
    )
