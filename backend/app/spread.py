import datetime as dt
from typing import Any, Iterable, Optional


def parse_number(value: object) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None


def build_spread_price_meta(
    *,
    ask: object,
    bid: object,
    close: object,
) -> dict[str, Any]:
    ask_value = parse_number(ask)
    bid_value = parse_number(bid)
    close_value = parse_number(close)

    if ask_value is None and close_value is None:
        return {
            "price": None,
            "source": None,
            "ask": ask_value,
            "bid": bid_value,
            "close": close_value,
        }

    if bid_value is None or bid_value <= 0:
        if close_value is not None:
            return {
                "price": close_value,
                "source": "close",
                "ask": ask_value,
                "bid": bid_value,
                "close": close_value,
            }
        return {
            "price": ask_value,
            "source": "ask",
            "ask": ask_value,
            "bid": bid_value,
            "close": close_value,
        }

    mid = (ask_value + bid_value) / 2 if ask_value is not None else bid_value
    return {
        "price": mid,
        "source": "mid",
        "ask": ask_value,
        "bid": bid_value,
        "close": close_value,
    }


def interpolate_curve_yield(
    curve_points: list[dict[str, float]],
    target_years: Optional[float],
) -> Optional[float]:
    if target_years is None:
        return None
    selected = _select_curve_points(curve_points, target_years)
    if not selected:
        return None
    low, high = selected
    if high["years"] == low["years"]:
        return low["yield"]
    weight = (target_years - low["years"]) / (high["years"] - low["years"])
    return low["yield"] + weight * (high["yield"] - low["yield"])


def maturity_years_from_value(value: object) -> Optional[float]:
    if value is None:
        return None
    str_value = str(value)
    year = month = day = None
    if len(str_value) == 8 and str_value.isdigit():
        year = int(str_value[0:4])
        month = int(str_value[4:6])
        day = int(str_value[6:8])
    elif len(str_value) >= 10 and str_value[4] == "-" and str_value[7] == "-":
        year = int(str_value[0:4])
        month = int(str_value[5:7])
        day = int(str_value[8:10])
    if year is None or month is None or day is None:
        return None
    try:
        maturity_date = dt.date(year, month, day)
    except ValueError:
        return None
    today = dt.date.today()
    diff = (maturity_date - today).days
    if diff <= 0:
        return None
    return diff / 365.25


def estimate_periods(years: float, frequency: float) -> Optional[int]:
    if not years or years <= 0:
        return None
    freq = frequency if frequency and frequency > 0 else 1
    return max(1, round(years * freq))


def yield_to_maturity(
    *,
    price: float,
    coupon_rate: float,
    years: float,
    frequency: float,
    notional: float,
) -> Optional[float]:
    if price <= 0 or years <= 0 or notional <= 0:
        return None
    freq = frequency if frequency and frequency > 0 else 1
    periods = estimate_periods(years, freq)
    if not periods:
        return None
    coupon = (coupon_rate / 100.0) * notional / freq

    def pv(rate: float) -> float:
        per_rate = rate / freq
        total = 0.0
        for i in range(1, periods + 1):
            total += coupon / ((1 + per_rate) ** i)
        total += notional / ((1 + per_rate) ** periods)
        return total

    low = -0.99
    high = 2.0
    f_low = pv(low) - price
    f_high = pv(high) - price
    if f_low * f_high > 0:
        return None
    for _ in range(80):
        mid = (low + high) / 2
        f_mid = pv(mid) - price
        if abs(f_mid) < 1e-6:
            return mid * 100.0
        if f_low * f_mid <= 0:
            high = mid
            f_high = f_mid
        else:
            low = mid
            f_low = f_mid
    return ((low + high) / 2) * 100.0


def _extract_curve_points(bonds: Iterable[dict]) -> list[dict[str, float]]:
    points: list[dict[str, float]] = []
    for bond in bonds:
        years = maturity_years_from_value(bond.get("MaturityDate"))
        bond_yield = parse_number(bond.get("YieldToWorst"))
        if bond_yield is None:
            price = parse_number(bond.get("AskPrice"))
            coupon_rate = parse_number(bond.get("CouponRate")) or 0.0
            if years is not None and price is not None:
                bond_yield = yield_to_maturity(
                    price=(price / 100.0) * 100.0,
                    coupon_rate=coupon_rate,
                    years=years,
                    frequency=1,
                    notional=100.0,
                )
        if years is None or bond_yield is None:
            continue
        points.append({"years": years, "yield": bond_yield})
    points.sort(key=lambda item: item["years"])
    return points


def _select_curve_points(points: list[dict[str, float]], target_years: float) -> Optional[tuple]:
    if len(points) < 2 or target_years is None:
        return None
    if target_years <= points[0]["years"]:
        return points[0], points[1]
    if target_years >= points[-1]["years"]:
        return points[-2], points[-1]
    for idx in range(1, len(points)):
        if points[idx]["years"] >= target_years:
            return points[idx - 1], points[idx]
    return None


def compute_gov_spread_bps(
    *,
    price: object,
    coupon_rate: object,
    years: Optional[float],
    frequency: Optional[float],
    curve_points: Optional[list[dict[str, float]]] = None,
    gov_bonds: Iterable[dict] = (),
) -> Optional[float]:
    price_value = parse_number(price)
    if price_value is None or price_value <= 0 or years is None:
        return None
    freq = frequency if frequency and frequency > 0 else 1
    periods = estimate_periods(years, freq)
    if not periods:
        return None

    points = curve_points if curve_points is not None else _extract_curve_points(gov_bonds)
    curve_points = points
    selected = _select_curve_points(curve_points, years)
    if not selected:
        return None
    bond_low, bond_high = selected

    notional = 100.0
    trade_value = (price_value / 100.0) * notional
    coupon_per_period = ((parse_number(coupon_rate) or 0.0) / 100.0) * notional / freq
    cashflows = []
    for i in range(1, periods + 1):
        t = i / freq
        amount = coupon_per_period
        if i == periods:
            amount += notional
        cashflows.append((t, amount))

    def base_yield(time: float) -> float:
        if bond_high["years"] == bond_low["years"]:
            return bond_low["yield"]
        weight = (time - bond_low["years"]) / (bond_high["years"] - bond_low["years"])
        return bond_low["yield"] + weight * (bond_high["yield"] - bond_low["yield"])

    def pv_with_spread(spread: float) -> float:
        total = 0.0
        for t, amount in cashflows:
            rate = (base_yield(t) + spread) / 100.0
            total += amount / ((1 + rate) ** t)
        return total

    low = -5.0
    high = 10.0
    f_low = pv_with_spread(low) - trade_value
    f_high = pv_with_spread(high) - trade_value
    attempts = 0
    while f_low * f_high > 0 and attempts < 6:
        high += 10.0
        f_high = pv_with_spread(high) - trade_value
        attempts += 1
    if f_low * f_high > 0:
        return None

    for _ in range(80):
        mid = (low + high) / 2
        f_mid = pv_with_spread(mid) - trade_value
        if abs(f_mid) < 1e-6:
            return mid * 100.0
        if f_low * f_mid <= 0:
            high = mid
            f_high = f_mid
        else:
            low = mid
            f_low = f_mid

    return ((low + high) / 2) * 100.0
