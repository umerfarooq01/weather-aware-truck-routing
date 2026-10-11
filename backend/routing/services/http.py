import requests
from django.conf import settings

_session = requests.Session()
_session.headers.update({"User-Agent": settings.HTTP_USER_AGENT})


class UpstreamError(Exception):
    """A third-party API (routing, geocoding, weather) failed or returned unusable data."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def get_json(url: str, params=None, timeout: float = 15.0):
    host = url.split("/")[2]
    try:
        resp = _session.get(url, params=params, timeout=timeout)
    except requests.Timeout as exc:
        raise UpstreamError(f"{host} took too long to respond") from exc
    except requests.RequestException as exc:
        raise UpstreamError(f"Could not reach {host}") from exc
    if resp.status_code == 429:
        raise UpstreamError(f"{host} is rate-limiting requests. Please wait a minute and try again.", 429)
    if resp.status_code >= 400:
        raise UpstreamError(f"{host} responded {resp.status_code}", resp.status_code)
    try:
        return resp.json()
    except ValueError as exc:
        raise UpstreamError(f"{host} returned invalid JSON") from exc
