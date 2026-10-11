"""0–48h weather risk grid along the trip corridor.

The grid is uniform in Web Mercator so the client can stretch it over the map as a single
image overlay with smooth (bilinear) interpolation and no distortion.
"""
import math
from datetime import datetime, timedelta

from . import risk
from .geo import haversine_mi, inverse_mercator_y, mercator_y, simplify
from .weather import fetch_hourly, floor_hour

MAX_CELLS = 360
HOURS = 48


def build_heatmap(paths: list[list[tuple[float, float]]], departure: datetime, load_lb: int) -> dict:
    pts = [p for path in paths for p in path]
    south, north = min(p[0] for p in pts), max(p[0] for p in pts)
    west, east = min(p[1] for p in pts), max(p[1] for p in pts)

    span_mi = max(haversine_mi((south, west), (north, east)), 20.0)
    corridor_mi = max(15.0, min(60.0, span_mi * 0.08))

    # Pad the box by the corridor width so the edge of the corridor is covered.
    pad_lat = corridor_mi / 69.0
    pad_lon = corridor_mi / (69.0 * max(0.2, math.cos(math.radians((south + north) / 2))))
    south, north, west, east = south - pad_lat, north + pad_lat, west - pad_lon, east + pad_lon

    y_top, y_bot = mercator_y(north), mercator_y(south)
    x_span = math.radians(east - west)
    y_span = y_top - y_bot

    anchors = [p for path in paths for p in (path[i] for i in simplify(path, corridor_mi / 3))]

    # Shrink the cell size until the corridor holds at most MAX_CELLS cells.
    cols = 40
    while True:
        cell = x_span / cols
        rows = max(2, round(y_span / cell))
        cells = []
        for j in range(rows):
            lat = inverse_mercator_y(y_top - (j + 0.5) * y_span / rows)
            for i in range(cols):
                lon = west + (i + 0.5) * (east - west) / cols
                if min(haversine_mi((lat, lon), a) for a in anchors) <= corridor_mi:
                    cells.append((j * cols + i, (lat, lon)))
        if len(cells) <= MAX_CELLS or cols <= 8:
            break
        cols = int(cols * math.sqrt(MAX_CELLS / len(cells)) * 0.95)

    start = floor_hour(departure)
    series = fetch_hourly([p for _, p in cells], start, start + timedelta(hours=HOURS))
    hours = min(len(s) for s in series) if series else 0

    levels, wind, precip = [], [], []
    for h in range(hours):
        lv, wd, pr = [], [], []
        for s in series:
            a = risk.assess(s.wind[h], s.rain[h], s.snow[h], load_lb)
            lv.append(a.level)
            wd.append(round(s.wind[h]))
            # Liquid-equivalent precipitation in hundredths of an inch (snow ~10:1).
            pr.append(round((s.rain[h] + s.snow[h] / 10) * 100))
        levels.append(lv)
        wind.append(wd)
        precip.append(pr)

    return {
        "bounds": {"south": south, "north": north, "west": west, "east": east},
        "cols": cols,
        "rows": rows,
        "cells": [idx for idx, _ in cells],
        "start": start.isoformat(),
        "hours": hours,
        "risk": levels,
        "wind_mph": wind,
        "precip_hundredths": precip,
    }
