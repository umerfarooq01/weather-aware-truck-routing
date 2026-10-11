import requests
from django.conf import settings

_session = requests.Session()
_session.headers.update({"User-Agent": settings.HTTP_USER_AGENT})


class UpstreamError(Exception):
    """A third-party API (routing, geocoding, weather) failed or returned unusable data."""


def get_json(url: str, params=None, timeout: float = 15.0):
    try:
        resp = _session.get(url, params=params, timeout=timeout)
    except requests.RequestException as exc:
        raise UpstreamError(f"Could not reach {url.split('/')[2]}") from exc
    if resp.status_code >= 400:
        raise UpstreamError(f"{url.split('/')[2]} responded {resp.status_code}")
    try:
        return resp.json()
    except ValueError as exc:
        raise UpstreamError(f"{url.split('/')[2]} returned invalid JSON") from exc
