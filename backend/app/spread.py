import datetime as dt
import math
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
            price = (
                parse_number(bond.get("AskPrice"))
                or parse_number(bond.get("ClosingPrice"))
                or parse_number(bond.get("BidPrice"))
            )
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


def extract_curve_points(bonds: Iterable[dict]) -> list[dict[str, float]]:
    return _extract_curve_points(bonds)


def extract_curve_points_with_meta(bonds: Iterable[dict]) -> list[dict[str, float]]:
    points: list[dict[str, float]] = []
    for bond in bonds:
        years = maturity_years_from_value(bond.get("MaturityDate"))
        if years is None:
            continue
        bond_yield = parse_number(bond.get("YieldToWorst"))
        source = "YieldToWorst"
        if bond_yield is None:
            price = (
                parse_number(bond.get("AskPrice"))
                or parse_number(bond.get("ClosingPrice"))
                or parse_number(bond.get("BidPrice"))
            )
            coupon_rate = parse_number(bond.get("CouponRate")) or 0.0
            if price is not None:
                bond_yield = yield_to_maturity(
                    price=(price / 100.0) * 100.0,
                    coupon_rate=coupon_rate,
                    years=years,
                    frequency=1,
                    notional=100.0,
                )
                source = "Derived"
        if bond_yield is None:
            continue
        points.append(
            {
                "years": years,
                "yield": bond_yield,
                "valor_id": bond.get("ValorId"),
                "isin": bond.get("ISIN"),
                "short_name": bond.get("ShortName"),
                "maturity": bond.get("MaturityDate"),
                "issuer": bond.get("IssuerNameFull"),
                "source": source,
            }
        )
    points.sort(key=lambda item: item["years"])
    return points


def _quantile(values: list[float], q: float) -> Optional[float]:
    if not values:
        return None
    if q <= 0:
        return values[0]
    if q >= 1:
        return values[-1]
    pos = (len(values) - 1) * q
    low = int(math.floor(pos))
    high = int(math.ceil(pos))
    if low == high:
        return values[low]
    weight = pos - low
    return values[low] + weight * (values[high] - values[low])


def trim_outlier_points(
    points: list[dict[str, float]],
    *,
    iqr_multiplier: float = 3.0,
) -> tuple[list[dict[str, float]], int]:
    if not points:
        return [], 0
    yields = sorted(point["yield"] for point in points)
    q1 = _quantile(yields, 0.25)
    q3 = _quantile(yields, 0.75)
    if q1 is None or q3 is None:
        return points, 0
    iqr = q3 - q1
    low = q1 - iqr_multiplier * iqr
    high = q3 + iqr_multiplier * iqr
    filtered = [point for point in points if low <= point["yield"] <= high]
    return filtered, len(points) - len(filtered)


def _pchip_slopes(xs: list[float], ys: list[float]) -> list[float]:
    n = len(xs)
    if n < 2:
        return [0.0] * n
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    delta = [(ys[i + 1] - ys[i]) / h[i] if h[i] != 0 else 0.0 for i in range(n - 1)]
    m = [0.0] * n
    if n == 2:
        m[0] = delta[0]
        m[1] = delta[0]
        return m

    # Endpoints
    m[0] = ((2 * h[0] + h[1]) * delta[0] - h[0] * delta[1]) / (h[0] + h[1])
    if m[0] * delta[0] <= 0:
        m[0] = 0.0
    elif abs(m[0]) > 3 * abs(delta[0]):
        m[0] = 3 * delta[0]

    m[-1] = ((2 * h[-1] + h[-2]) * delta[-1] - h[-1] * delta[-2]) / (h[-1] + h[-2])
    if m[-1] * delta[-1] <= 0:
        m[-1] = 0.0
    elif abs(m[-1]) > 3 * abs(delta[-1]):
        m[-1] = 3 * delta[-1]

    for i in range(1, n - 1):
        if delta[i - 1] == 0 or delta[i] == 0 or delta[i - 1] * delta[i] < 0:
            m[i] = 0.0
        else:
            w1 = 2 * h[i] + h[i - 1]
            w2 = h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / ((w1 / delta[i - 1]) + (w2 / delta[i]))
    return m


def pchip_interpolate(xs: list[float], ys: list[float], samples: list[float]) -> list[float]:
    if len(xs) != len(ys) or len(xs) < 2:
        return []
    slopes = _pchip_slopes(xs, ys)
    results: list[float] = []
    n = len(xs)
    for x in samples:
        if x <= xs[0]:
            results.append(ys[0])
            continue
        if x >= xs[-1]:
            results.append(ys[-1])
            continue
        idx = 0
        for i in range(n - 1):
            if xs[i] <= x <= xs[i + 1]:
                idx = i
                break
        h = xs[idx + 1] - xs[idx]
        if h == 0:
            results.append(ys[idx])
            continue
        t = (x - xs[idx]) / h
        h00 = (2 * t**3) - (3 * t**2) + 1
        h10 = (t**3) - (2 * t**2) + t
        h01 = (-2 * t**3) + (3 * t**2)
        h11 = (t**3) - (t**2)
        y = (
            h00 * ys[idx]
            + h10 * h * slopes[idx]
            + h01 * ys[idx + 1]
            + h11 * h * slopes[idx + 1]
        )
        results.append(y)
    return results


def _solve_linear_3x3(matrix: list[list[float]], vector: list[float]) -> Optional[list[float]]:
    m = [row[:] for row in matrix]
    v = vector[:]
    for i in range(3):
        pivot = m[i][i]
        if abs(pivot) < 1e-12:
            return None
        inv = 1.0 / pivot
        for j in range(i, 3):
            m[i][j] *= inv
        v[i] *= inv
        for k in range(3):
            if k == i:
                continue
            factor = m[k][i]
            for j in range(i, 3):
                m[k][j] -= factor * m[i][j]
            v[k] -= factor * v[i]
    return v


def _ns_factors(years: float, tau: float) -> tuple[float, float]:
    if years <= 0 or tau <= 0:
        return 1.0, 0.0
    x = years / tau
    if abs(x) < 1e-8:
        return 1.0, 0.0
    e = math.exp(-x)
    f1 = (1 - e) / x
    f2 = f1 - e
    return f1, f2


def fit_nelson_siegel(points: list[dict[str, float]]) -> Optional[dict[str, float]]:
    if len(points) < 3:
        return None
    xs = [point["years"] for point in points]
    ys = [point["yield"] for point in points]
    max_x = max(xs)
    tau_min = 0.25
    tau_max = max(5.0, min(30.0, max_x * 2))
    best = None
    tau = tau_min
    while tau <= tau_max + 1e-9:
        x_cols = []
        for x in xs:
            f1, f2 = _ns_factors(x, tau)
            x_cols.append((1.0, f1, f2))

        a00 = sum(col[0] * col[0] for col in x_cols)
        a01 = sum(col[0] * col[1] for col in x_cols)
        a02 = sum(col[0] * col[2] for col in x_cols)
        a11 = sum(col[1] * col[1] for col in x_cols)
        a12 = sum(col[1] * col[2] for col in x_cols)
        a22 = sum(col[2] * col[2] for col in x_cols)
        b0 = sum(col[0] * y for col, y in zip(x_cols, ys))
        b1 = sum(col[1] * y for col, y in zip(x_cols, ys))
        b2 = sum(col[2] * y for col, y in zip(x_cols, ys))
        coeffs = _solve_linear_3x3(
            [[a00, a01, a02], [a01, a11, a12], [a02, a12, a22]],
            [b0, b1, b2],
        )
        if coeffs is None:
            tau += 0.25
            continue
        beta0, beta1, beta2 = coeffs
        sse = 0.0
        for x, y in zip(xs, ys):
            f1, f2 = _ns_factors(x, tau)
            y_hat = beta0 + beta1 * f1 + beta2 * f2
            sse += (y - y_hat) ** 2
        if best is None or sse < best["sse"]:
            best = {
                "beta0": beta0,
                "beta1": beta1,
                "beta2": beta2,
                "tau": tau,
                "sse": sse,
            }
        tau += 0.25
    return best


def build_gov_curve_fits(points: list[dict[str, float]]) -> dict[str, Any]:
    if not points:
        return {"spline": [], "nelson_siegel": [], "meta": {}}
    trimmed, excluded = trim_outlier_points(points)
    if len(trimmed) < 3:
        trimmed = points
        excluded = 0
    xs = [point["years"] for point in trimmed]
    ys = [point["yield"] for point in trimmed]
    min_x = min(xs)
    max_x = max(xs)
    samples = 60
    grid = [min_x + (max_x - min_x) * i / (samples - 1) for i in range(samples)]
    spline_values = pchip_interpolate(xs, ys, grid)
    spline = [
        {"years": x, "yield": y}
        for x, y in zip(grid, spline_values)
        if y is not None
    ]

    ns_fit = fit_nelson_siegel(trimmed)
    nelson = []
    if ns_fit:
        for x in grid:
            f1, f2 = _ns_factors(x, ns_fit["tau"])
            y_hat = ns_fit["beta0"] + ns_fit["beta1"] * f1 + ns_fit["beta2"] * f2
            nelson.append({"years": x, "yield": y_hat})

    return {
        "spline": spline,
        "nelson_siegel": nelson,
        "meta": {
            "excluded_outliers": excluded,
            "used_points": len(trimmed),
            "total_points": len(points),
            "tau": ns_fit["tau"] if ns_fit else None,
            "beta0": ns_fit["beta0"] if ns_fit else None,
            "beta1": ns_fit["beta1"] if ns_fit else None,
            "beta2": ns_fit["beta2"] if ns_fit else None,
        },
    }


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
