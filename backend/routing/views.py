import json
import logging
from datetime import datetime, timedelta, timezone

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from .services import geocode, history
from .services.heatmap import build_heatmap
from .services.http import UpstreamError
from .services.planner import plan_trip

log = logging.getLogger(__name__)

MAX_LOAD_LB = 120_000
INTERVALS = (10, 25, 50)


class BadRequest(Exception):
    pass


def _error(message: str, status: int) -> JsonResponse:
    return JsonResponse({"error": message}, status=status)


def _body(request) -> dict:
    try:
        data = json.loads(request.body or b"{}")
    except (ValueError, UnicodeDecodeError):
        raise BadRequest("Request body must be JSON")
    if not isinstance(data, dict):
        raise BadRequest("Request body must be a JSON object")
    return data


def _place(value, field: str) -> dict:
    """Accept either {label, lat, lon} from autocomplete or a free-text string to geocode."""
    if isinstance(value, dict):
        try:
            lat, lon = float(value["lat"]), float(value["lon"])
        except (KeyError, TypeError, ValueError):
            raise BadRequest(f"{field} has invalid coordinates")
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise BadRequest(f"{field} coordinates are out of range")
        label = str(value.get("label") or f"{lat:.4f}, {lon:.4f}")[:200]
        return {"label": label, "lat": lat, "lon": lon}
    if isinstance(value, str) and value.strip():
        return geocode.resolve(value.strip()[:200])
    raise BadRequest(f"{field} is required")


def _departure(value, max_past_hours: int = 1) -> datetime:
    if not isinstance(value, str):
        raise BadRequest("departure is required")
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise BadRequest("departure must be an ISO 8601 date/time")
    if dt.tzinfo is None:
        raise BadRequest("departure must include a timezone offset")
    dt = dt.astimezone(timezone.utc).replace(microsecond=0)
    now = datetime.now(timezone.utc)
    if dt < now - timedelta(hours=max_past_hours):
        raise BadRequest("Departure can't be in the past")
    if dt > now + timedelta(days=7):
        raise BadRequest("Departure must be within the next 7 days (forecast range)")
    return dt


def _load(value) -> int:
    try:
        load = int(float(value))
    except (TypeError, ValueError):
        raise BadRequest("load_lb must be a number")
    if not 0 <= load <= MAX_LOAD_LB:
        raise BadRequest(f"Load must be between 0 and {MAX_LOAD_LB:,} lb")
    return load


def _handle(fn):
    def wrapper(request, *args, **kwargs):
        try:
            return fn(request, *args, **kwargs)
        except BadRequest as exc:
            return _error(str(exc), 400)
        except UpstreamError as exc:
            return _error(str(exc), 502)
        except Exception:
            log.exception("Unhandled error")
            return _error("Something went wrong while planning. Please try again.", 500)

    wrapper.__name__ = fn.__name__
    return wrapper


@require_GET
def health(request):
    return JsonResponse({"ok": True, "history": history.enabled()})


@require_GET
@_handle
def geocode_view(request):
    q = request.GET.get("q", "").strip()
    if len(q) < 2:
        return JsonResponse({"results": []})
    return JsonResponse({"results": geocode.search(q[:200])})


@csrf_exempt
@require_POST
@_handle
def plan_view(request):
    data = _body(request)
    origin = _place(data.get("origin"), "origin")
    dest = _place(data.get("destination"), "destination")
    departure = _departure(data.get("departure"))
    load = _load(data.get("load_lb"))
    try:
        interval = int(data.get("interval_mi", 25))
    except (TypeError, ValueError):
        raise BadRequest("interval_mi must be 10, 25 or 50")
    if interval not in INTERVALS:
        raise BadRequest("interval_mi must be 10, 25 or 50")
    hos = bool(data.get("hos", True))

    plan = plan_trip(origin, dest, departure, load, interval, hos)
    history.save(plan)
    return JsonResponse(plan)


@csrf_exempt
@require_POST
@_handle
def heatmap_view(request):
    data = _body(request)
    paths = data.get("paths")
    if not isinstance(paths, list) or not paths or len(paths) > 5:
        raise BadRequest("paths must be a list of 1–5 coordinate lists")
    clean = []
    for path in paths:
        if not isinstance(path, list) or not 2 <= len(path) <= 2000:
            raise BadRequest("each path needs 2–2000 points")
        try:
            pts = [(float(p[0]), float(p[1])) for p in path]
        except (TypeError, ValueError, IndexError):
            raise BadRequest("path points must be [lat, lon]")
        if any(not (-90 <= a <= 90 and -180 <= b <= 180) for a, b in pts):
            raise BadRequest("path coordinates are out of range")
        clean.append(pts)
    # The heatmap is requested right after planning, but may be retried later from an open page.
    departure = _departure(data.get("departure"), max_past_hours=12)
    load = _load(data.get("load_lb"))
    return JsonResponse(build_heatmap(clean, departure, load))


@require_GET
@_handle
def trips_view(request):
    return JsonResponse({"trips": history.recent()})
