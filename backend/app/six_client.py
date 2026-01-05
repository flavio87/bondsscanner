import datetime as dt
from typing import Any, Iterable, Optional
from urllib.parse import quote

import httpx

from .cache import TTLCache

BASE_FQS = "https://www.six-group.com/fqs"
BASE_SHELDON = "https://www.six-group.com/sheldon"

LIST_FIELDS = [
    "ShortName",
    "ValorId",
    "TradingBaseCurrency",
    "CouponRate",
    "MaturityDate",
    "ClosingPrice",
    "BidPrice",
    "AskPrice",
    "MarketDate",
    "MarketTime",
    "TotalVolume",
    "IssuerNameFull",
    "ProductLine",
    "IndustrySectorCode",
    "IndustrySectorDesc",
    "SecTypeCode",
    "ISIN",
    "AmountInIssue",
    "YieldToWorst",
]

DETAIL_MARKET_FIELDS = [
    "ClosingPrice",
    "ClosingDelta",
    "ClosingPerformance",
    "LatestTradeDate",
    "LatestTradeTime",
    "AskPrice",
    "AskVolume",
    "BidPrice",
    "BidVolume",
    "DailyHighPrice",
    "DailyHighTime",
    "DailyLowPrice",
    "DailyLowTime",
    "PreviousClosingPrice",
    "AccruedInterestCalcDesc",
    "MidSpread",
    "OpeningPrice",
    "YearAgoPerformance",
    "YearToDatePerformance",
    "YieldToWorst",
    "TotalVolume",
    "LatestTradeVolume",
    "MarketDate",
    "MarketTime",
    "OnMarketVolume",
    "OffBookVolume",
    "OnMarketTrades",
    "OffBookTrades",
    "OnMarketTurnover",
    "OffBookTurnover",
]

LIST_CACHE = TTLCache(ttl_seconds=300)
DETAIL_CACHE = TTLCache(ttl_seconds=600)
IUP_CACHE = TTLCache(ttl_seconds=24 * 60 * 60)

GOVERNMENT_ISSUER_NAMES = [
    "SWISS CONFEDERATION",
    "Swiss Confederation",
    "SCHWEIZERISCHE EIDGENOSSENSCHAFT",
    "Schweizerische Eidgenossenschaft",
    "Schweiz. Eidgenossenschaft",
]


class SixClientError(RuntimeError):
    pass


class IctaxClientError(RuntimeError):
    pass


def _add_years(date: dt.date, years: int) -> dt.date:
    try:
        return date.replace(year=date.year + years)
    except ValueError:
        # Handle leap day
        return date.replace(month=2, day=28, year=date.year + years)


def _date_to_int(date: dt.date) -> int:
    return int(date.strftime("%Y%m%d"))


def maturity_bucket_to_range(bucket: str) -> tuple[Optional[int], Optional[int]]:
    today = dt.date.today()
    if bucket == "lt1":
        return _date_to_int(today), _date_to_int(_add_years(today, 1))
    if bucket == "1-2":
        return _date_to_int(_add_years(today, 1)), _date_to_int(_add_years(today, 2))
    if bucket == "2-3":
        return _date_to_int(_add_years(today, 2)), _date_to_int(_add_years(today, 3))
    if bucket == "3-5":
        return _date_to_int(_add_years(today, 3)), _date_to_int(_add_years(today, 5))
    if bucket == "5-10":
        return _date_to_int(_add_years(today, 5)), _date_to_int(_add_years(today, 10))
    if bucket == "10+":
        return _date_to_int(_add_years(today, 10)), None
    return None, None


def _build_where(
    *,
    country: Optional[str],
    currency: Optional[str],
    maturity_from: Optional[int],
    maturity_to: Optional[int],
    industry_sector: Optional[str] = None,
    issuer_name: Optional[str] = None,
) -> str:
    parts = ["PortalSegment=BO"]
    if country:
        parts.append(f"GeographicalAreaCode={country}")
    if currency:
        parts.append(f"TradingBaseCurrency={currency}")
    if industry_sector:
        parts.append(f"IndustrySectorCode={industry_sector}")
    if maturity_from:
        parts.append(f"MaturityDate>{maturity_from}")
    if maturity_to:
        parts.append(f"MaturityDate<{maturity_to}")
    if issuer_name:
        safe_name = quote(issuer_name, safe="")
        parts.append(f"IssuerNameFull={safe_name}")
    return "*".join(parts)


def _build_fqs_url(
    *,
    select: Iterable[str],
    where: str,
    order_by: str,
    page: int,
    page_size: int,
) -> str:
    select_str = ",".join(select)
    return (
        f"{BASE_FQS}/ref.json?select={select_str}"
        f"&where={where}"
        f"&orderby={order_by}"
        f"&page={page}"
        f"&pagesize={page_size}"
    )


def _build_fqs_command_url(
    *,
    command: str,
    format_: str,
    params: list[dict[str, Any]],
    properties: Iterable[str],
) -> str:
    select_str = ",".join(properties).rstrip(",")
    param_str = ""
    for param in params:
        key_values = param.get("keyValues") or []
        key_parts: list[str] = []
        for key_value in key_values:
            key = key_value.get("key")
            operator = key_value.get("operator")
            value = key_value.get("value")
            multi_operator = key_value.get("multiParamOperator")
            if operator and value is not None:
                if multi_operator:
                    key_parts.append(
                        f"{multi_operator}{key}{operator}{value}"
                    )
                else:
                    key_parts.append(f"{key}{operator}{value}")
            else:
                key_parts.append(str(key))
        param_str += f"&{param['name']}{param.get('operator', '')}{''.join(key_parts)}"
    return f"{BASE_FQS}/{command}.{format_}?select={select_str}{param_str}"


def _fetch_json(url: str, cache: Optional[TTLCache] = None) -> Any:
    if cache:
        cached = cache.get(url)
        if cached is not None:
            return cached
    with httpx.Client(timeout=15) as client:
        response = client.get(url)
    if response.status_code != 200:
        raise SixClientError(f"SIX request failed: {response.status_code}")
    data = response.json()
    if cache:
        cache.set(url, data)
    return data


def fetch_ictax_security(isin: str, maturity: Optional[str]) -> dict[str, Any]:
    if not isin:
        raise IctaxClientError("ISIN required")
    isin = isin.strip().upper()
    maturity_key = (maturity or "").strip()
    cache_key = f"{isin}:{maturity_key}"
    cached = IUP_CACHE.get(cache_key)
    if cached is not None:
        return cached
    encoded_isin = quote(isin, safe="")
    encoded_maturity = quote(maturity_key, safe="") if maturity_key else ""
    url = (
        "https://www.ictax.admin.ch/extern/en.html"
        f"?isin={encoded_isin}&maturity={encoded_maturity}&format=json"
    )
    with httpx.Client(timeout=15) as client:
        response = client.get(url)
    if response.status_code != 200:
        raise IctaxClientError(f"ICTax request failed: {response.status_code}")
    data = response.json()
    IUP_CACHE.set(cache_key, data)
    return data


def extract_iup_flag(payload: Any) -> Optional[bool]:
    if isinstance(payload, dict):
        for key, value in payload.items():
            key_lower = str(key).lower()
            if "iup" in key_lower:
                if isinstance(value, bool):
                    return value
                if isinstance(value, (int, float)):
                    return bool(value)
                if isinstance(value, str):
                    normalized = value.strip().lower()
                    if normalized in {"true", "yes", "y", "1"}:
                        return True
                    if normalized in {"false", "no", "n", "0"}:
                        return False
            nested = extract_iup_flag(value)
            if nested is not None:
                return nested
    if isinstance(payload, list):
        for item in payload:
            nested = extract_iup_flag(item)
            if nested is not None:
                return nested
    return None


def _rows_to_dicts(data: dict[str, Any]) -> list[dict[str, Any]]:
    cols = data.get("colNames", [])
    rows = data.get("rowData", [])
    return [dict(zip(cols, row)) for row in rows]


def fetch_bonds(
    *,
    country: Optional[str],
    currency: Optional[str],
    maturity_from: Optional[int],
    maturity_to: Optional[int],
    page: int,
    page_size: int,
    order_by: str,
    industry_sector: Optional[str] = None,
    issuer_name: Optional[str] = None,
) -> dict[str, Any]:
    where = _build_where(
        country=country,
        currency=currency,
        maturity_from=maturity_from,
        maturity_to=maturity_to,
        industry_sector=industry_sector,
        issuer_name=issuer_name,
    )
    url = _build_fqs_url(
        select=LIST_FIELDS,
        where=where,
        order_by=order_by,
        page=page,
        page_size=page_size,
    )
    data = _fetch_json(url, cache=LIST_CACHE)
    return {
        "total": data.get("totalRows", 0),
        "page": data.get("pageNumber", page),
        "page_size": data.get("pageSize", page_size),
        "items": _rows_to_dicts(data),
    }


def fetch_government_bonds(
    *,
    currency: Optional[str] = "CHF",
    country: Optional[str] = "CH",
    page_size: int = 200,
) -> list[dict[str, Any]]:
    # IndustrySectorCode=016 corresponds to "Countries" on SIX.
    response = fetch_bonds(
        country=country,
        currency=currency,
        maturity_from=None,
        maturity_to=None,
        page=1,
        page_size=page_size,
        order_by="MaturityDate",
        industry_sector="016",
    )
    return response.get("items", [])


def fetch_bond_market_data(valor_id: str) -> dict[str, Any]:
    params = [
        {
            "name": "where",
            "operator": "=",
            "keyValues": [
                {
                    "key": "ValorId",
                    "operator": "=",
                    "value": valor_id,
                }
            ],
        }
    ]
    url = _build_fqs_command_url(
        command="movie",
        format_="json",
        params=params,
        properties=DETAIL_MARKET_FIELDS,
    )
    data = _fetch_json(url, cache=DETAIL_CACHE)
    items = _rows_to_dicts(data)
    return items[0] if items else {}


def fetch_bond_overview(valor_id: str) -> dict[str, Any]:
    url = f"{BASE_SHELDON}/bond_details/v3/{valor_id}/overview/info.json"
    data = _fetch_json(url, cache=DETAIL_CACHE)
    return (data.get("itemList") or [{}])[0]


def fetch_bond_details(valor_id: str) -> dict[str, Any]:
    url = f"{BASE_SHELDON}/bond_details/v3/{valor_id}/details/info.json"
    data = _fetch_json(url, cache=DETAIL_CACHE)
    return (data.get("itemList") or [{}])[0]


def fetch_bond_liquidity(valor_id: str) -> list[dict[str, Any]]:
    url = f"{BASE_SHELDON}/bond_details/v3/{valor_id}/liquidity/measures.json"
    data = _fetch_json(url, cache=DETAIL_CACHE)
    return data.get("itemList") or []
