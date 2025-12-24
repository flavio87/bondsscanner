import datetime as dt
import json
from pathlib import Path
from typing import Any, Optional

import httpx

from .spread import parse_number

TENORS = "1J,2J,3J,4J,5J,6J,7J,8J,9J,10J,20J,30J"


def _build_urls() -> list[str]:
    today = dt.date.today()
    from_date = dt.date(today.year - 2, today.month, 1)
    to_date = dt.date(today.year, today.month, 1)
    base = "https://data.snb.ch/api/cube/rendeiduebm/data/json/en"
    params = (
        f"dimSel=D0(CHF),D1({TENORS})"
        f"&fromDate={from_date.strftime('%Y-%m')}"
        f"&toDate={to_date.strftime('%Y-%m')}"
    )
    return [
        f"{base}?{params}",
        f"{base}?dimSel=D0(CHF),D1({TENORS})",
    ]

CACHE_TTL_SECONDS = 24 * 60 * 60
CACHE_FILE = Path(__file__).resolve().parent / "data" / "snb_rendeiduebm.json"


class SnbClientError(RuntimeError):
    pass


def _load_cache(ignore_ttl: bool = False) -> Optional[dict[str, Any]]:
    if not CACHE_FILE.exists():
        return None
    try:
        payload = json.loads(CACHE_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    fetched_at = payload.get("fetched_at")
    if not fetched_at:
        return None
    try:
        fetched_ts = dt.datetime.fromisoformat(fetched_at).timestamp()
    except ValueError:
        return None
    if not ignore_ttl and (dt.datetime.utcnow().timestamp() - fetched_ts) > CACHE_TTL_SECONDS:
        return None
    return payload


def _save_cache(payload: dict[str, Any]) -> None:
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(json.dumps(payload, indent=2, sort_keys=True))


def _fetch_json(url: str) -> dict[str, Any]:
    with httpx.Client(timeout=20) as client:
        response = client.get(url)
    if response.status_code != 200:
        raise SnbClientError(f"SNB request failed: {response.status_code}")
    return response.json()


def _parse_date(value: object) -> Optional[dt.date]:
    if value is None:
        return None
    text = str(value)
    for fmt in ("%Y-%m-%d", "%Y-%m", "%Y%m%d"):
        try:
            parsed = dt.datetime.strptime(text, fmt).date()
            if fmt == "%Y-%m":
                return parsed.replace(day=1)
            return parsed
        except ValueError:
            continue
    return None


def _tenor_to_years(value: object) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    lowered = text.lower()
    for unit in ("year", "years", "yr", "yrs"):
        if unit in lowered:
            number = parse_number("".join(ch for ch in lowered if ch.isdigit() or ch == "."))
            return number
    for unit in ("month", "months", "mo", "mth"):
        if unit in lowered:
            number = parse_number("".join(ch for ch in lowered if ch.isdigit() or ch == "."))
            return number / 12 if number is not None else None
    for unit in ("day", "days", "d"):
        if unit in lowered:
            number = parse_number("".join(ch for ch in lowered if ch.isdigit() or ch == "."))
            return number / 365 if number is not None else None

    if lowered.endswith("y"):
        number = parse_number(lowered[:-1])
        return number
    if lowered.endswith("m"):
        number = parse_number(lowered[:-1])
        return number / 12 if number is not None else None
    if lowered.endswith("d"):
        number = parse_number(lowered[:-1])
        return number / 365 if number is not None else None

    if parse_number(lowered) is not None:
        return parse_number(lowered)
    return None


def _collect_dimensions(entry: dict[str, Any]) -> dict[str, Any]:
    dims: dict[str, Any] = {}
    for key in ("dimensions", "dimension", "dim"):
        payload = entry.get(key)
        if isinstance(payload, dict):
            dims.update(payload)
        elif isinstance(payload, list):
            for item in payload:
                if isinstance(item, dict):
                    code = item.get("code") or item.get("name") or item.get("id")
                    value = item.get("value") or item.get("label") or item.get("name")
                    if code and value is not None:
                        dims[str(code)] = value
    for key, value in entry.items():
        if key in ("dimensions", "dimension", "dim", "measures", "measure", "value"):
            continue
        dims.setdefault(key, value)
    return dims


def _extract_value(entry: dict[str, Any]) -> Optional[float]:
    for key in ("value", "Value", "obsValue", "ObservationValue"):
        if key in entry and parse_number(entry[key]) is not None:
            return parse_number(entry[key])
    for key in ("measures", "measure"):
        measures = entry.get(key)
        if isinstance(measures, dict):
            for val in measures.values():
                if parse_number(val) is not None:
                    return parse_number(val)
    return None


def _extract_tenor_and_date(entry: dict[str, Any]) -> tuple[Optional[float], Optional[dt.date]]:
    dims = _collect_dimensions(entry)
    tenor = None
    date = None
    for key, value in dims.items():
        key_lower = str(key).lower()
        if tenor is None and any(token in key_lower for token in ("tenor", "term", "maturity")):
            tenor = _tenor_to_years(value)
        if date is None and any(token in key_lower for token in ("date", "time", "period")):
            date = _parse_date(value)
    if date is None:
        for value in dims.values():
            candidate = _parse_date(value)
            if candidate:
                date = candidate
                break
    if tenor is None:
        for value in dims.values():
            candidate = _tenor_to_years(value)
            if candidate is not None:
                tenor = candidate
                break
    return tenor, date


def _parse_curve_points(payload: dict[str, Any]) -> Optional[dict[str, Any]]:
    if isinstance(payload, dict) and isinstance(payload.get("timeseries"), list):
        points: dict[float, tuple[dt.date, float]] = {}
        for entry in payload.get("timeseries", []):
            if not isinstance(entry, dict):
                continue
            header = entry.get("header", [])
            tenor = None
            for item in header:
                if not isinstance(item, dict):
                    continue
                if str(item.get("dim", "")).lower() == "maturity":
                    tenor = _tenor_to_years(item.get("dimItem"))
                    break
            if tenor is None:
                continue
            values = entry.get("values", [])
            latest_date = None
            latest_value = None
            for value_item in values:
                if not isinstance(value_item, dict):
                    continue
                candidate_date = _parse_date(value_item.get("date"))
                candidate_value = parse_number(value_item.get("value"))
                if candidate_date is None or candidate_value is None:
                    continue
                if latest_date is None or candidate_date > latest_date:
                    latest_date = candidate_date
                    latest_value = candidate_value
            if latest_date is None or latest_value is None:
                continue
            points[tenor] = (latest_date, latest_value)
        if not points:
            return None
        latest_date = max(date for date, _ in points.values())
        curve_points = [
            {"years": years, "yield": value}
            for years, (date, value) in points.items()
            if date == latest_date
        ]
        curve_points.sort(key=lambda item: item["years"])
        if not curve_points:
            return None
        return {"latest_date": latest_date.isoformat(), "points": curve_points}

    entries = payload.get("data")
    if isinstance(payload, list):
        entries = payload
    if isinstance(entries, dict):
        entries = entries.get("data") or entries.get("values")
    if not isinstance(entries, list):
        return None
    by_date: dict[dt.date, dict[float, float]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        value = _extract_value(entry)
        if value is None:
            continue
        tenor, date = _extract_tenor_and_date(entry)
        if tenor is None or date is None:
            continue
        by_date.setdefault(date, {})[tenor] = value
    if not by_date:
        return None
    latest_date = max(by_date.keys())
    points = [
        {"years": years, "yield": yield_value}
        for years, yield_value in by_date[latest_date].items()
    ]
    points.sort(key=lambda item: item["years"])
    return {"latest_date": latest_date.isoformat(), "points": points}


def fetch_snb_curve() -> dict[str, Any]:
    cached = _load_cache()
    if cached:
        return cached

    last_error: Optional[Exception] = None
    for url in _build_urls():
        try:
            payload = _fetch_json(url)
            parsed = _parse_curve_points(payload)
            if parsed and parsed.get("points"):
                result = {
                    "fetched_at": dt.datetime.utcnow().isoformat(),
                    "source_url": url,
                    **parsed,
                }
                _save_cache(result)
                return result
        except (SnbClientError, json.JSONDecodeError) as exc:
            last_error = exc
            continue
    cached_stale = _load_cache(ignore_ttl=True)
    if cached_stale:
        return cached_stale
    if last_error:
        raise SnbClientError(str(last_error)) from last_error
    raise SnbClientError("No SNB data available")
