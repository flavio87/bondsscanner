import { useEffect, useMemo, useState } from "react";

import { fetchBondDetails, fetchBondVolumes, fetchBonds, fetchSnbCurve } from "./api.js";
import {
  buildCashflows,
  computeScenario,
  parseNumber,
  xirr,
  yieldToMaturity
} from "./calculations.js";
import {
  formatCurrency,
  formatDateYMD,
  formatDurationYears,
  formatNumber,
  formatPercent
} from "./format.js";

const MATURITY_OPTIONS = [
  { value: "lt1", label: "< 1 year" },
  { value: "1-2", label: "1-2 years" },
  { value: "2-3", label: "2-3 years" },
  { value: "3-5", label: "3-5 years" },
  { value: "5-10", label: "5-10 years" },
  { value: "10+", label: "Longer" }
];

const CURRENCY_OPTIONS = ["CHF", "EUR", "USD", "GBP", "JPY"];
const SIX_DETAIL_BASE =
  "https://www.six-group.com/de/market-data/bonds/bond-explorer/bond-details.html";

function maturityYearsFromValue(value) {
  if (!value) return null;
  const str = String(value);
  let year = null;
  let month = null;
  let day = null;
  if (str.length === 8 && /^\d+$/.test(str)) {
    year = Number(str.slice(0, 4));
    month = Number(str.slice(4, 6)) - 1;
    day = Number(str.slice(6, 8));
  } else if (str.length >= 10 && str[4] === "-" && str[7] === "-") {
    year = Number(str.slice(0, 4));
    month = Number(str.slice(5, 7)) - 1;
    day = Number(str.slice(8, 10));
  } else {
    return null;
  }
  const maturityDate = new Date(year, month, day);
  const now = new Date();
  const diff = maturityDate - now;
  if (!Number.isFinite(diff) || diff <= 0) return null;
  return diff / (365.25 * 24 * 60 * 60 * 1000);
}

function buildSixDetailUrl(valorId) {
  if (!valorId) return SIX_DETAIL_BASE;
  const parts = SIX_DETAIL_BASE.split(".");
  if (parts.length > 1) {
    const ext = parts.pop();
    return `${parts.join(".")}.${valorId}.${ext}`;
  }
  return `${SIX_DETAIL_BASE}.${valorId}`;
}

const METRIC_TOOLTIPS = {
  holdings: "Count of holdings in the portfolio.",
  totalNotional: "Sum of holding notionals.",
  costAtAsk: "Sum of (askPrice / 100) * notional.",
  avgMaturity: "Sum(years * notional) / Sum(notional).",
  avgAskYield: "Sum(askYield * notional) / Sum(notional).",
  grossReturn: "Sum(coupons + principal - tradeValue).\ntradeValue = (askPrice / 100) * notional.",
  returnAfterFees: "Gross return - Sum(buy fees).",
  returnAfterTax:
    "Sum(coupons * (1 - tax) + principal - tradeValue - buy fee).",
  portfolioIrr:
    "IRR of aggregated cashflows.\nt0 = -tradeValue; coupons + principal at maturity.",
  portfolioIrrFees: "IRR with t0 = -(tradeValue + buyFee).",
  portfolioIrrFeesTax:
    "IRR with after-tax coupons and t0 = -(tradeValue + buyFee).",
  totalBuyFees: "Sum of buy commissions across holdings.",
  roundTripFees: "Sum of (buy fee + sell fee) across holdings."
};

const RETURN_TOOLTIPS = {
  grossReturn: "couponTotal + notional - tradeValue.",
  grossIrr: "YTM solving PV(coupons + principal) = tradeValue.",
  afterFees: "gross return - buy fee.",
  feeIrr: "YTM with price = tradeValue + buyFee.",
  afterTax: "couponTotal * (1 - tax) + notional - tradeValue - buyFee.",
  taxIrr: "YTM with after-tax coupon and price = tradeValue + buyFee.",
  breakEvenFees:
    "(buyFee + sellFee) / annualYieldValue.\nannualYieldValue = tradeValue * (askYield / 100).",
  breakEvenFeesTax:
    "(buyFee + sellFee) / (annualYieldValue - annualTax).\nannualTax = notional * (couponRate / 100) * tax."
};

function formatGovSpreadTooltip(meta) {
  if (!meta) return "No spread data available.";
  const price = parseNumber(meta.price);
  const ask = parseNumber(meta.ask);
  const bid = parseNumber(meta.bid);
  const close = parseNumber(meta.close);
  const govYield = parseNumber(meta.gov_yield);
  const years = parseNumber(meta.years);
  const source = meta.source || "unknown";
  const curveDate = meta.curve_date || "unknown";
  const askOk = Number.isFinite(ask) && ask > 0;
  const bidOk = Number.isFinite(bid) && bid > 0;

  let priceLine = "Price basis: ";
  if (source === "mid" && askOk && bidOk) {
    priceLine += `mid = (${formatNumber(ask, 2)} + ${formatNumber(bid, 2)}) / 2 = ${formatNumber(price, 2)}`;
  } else if (source === "close" && Number.isFinite(close)) {
    priceLine += `close = ${formatNumber(close, 2)}`;
    if (askOk) {
      priceLine += ` (ask ${formatNumber(ask, 2)}${bidOk ? `, bid ${formatNumber(bid, 2)}` : ""})`;
    }
  } else if (source === "ask" && Number.isFinite(ask)) {
    priceLine += `ask = ${formatNumber(ask, 2)}`;
  } else {
    priceLine += "unavailable";
  }

  const yieldLine =
    Number.isFinite(govYield) && Number.isFinite(years)
      ? `Interpolated SNB gov yield @ ${formatNumber(years, 2)}y = ${formatPercent(govYield, 2)}`
      : "Interpolated SNB gov yield unavailable";

  return `${priceLine}\n${yieldLine}\nCurve date: ${curveDate}\nSpread solves PV(cashflows, curve + spread) = price.`;
}

function InfoTooltip({ text }) {
  return (
    <span className="info-tooltip" data-tooltip={text} tabIndex={0}>
      i
    </span>
  );
}

function MetricLabel({ label, tooltip }) {
  return (
    <div className="metric-label">
      <span>{label}</span>
      <InfoTooltip text={tooltip} />
    </div>
  );
}

function MetricInline({ label, tooltip }) {
  return (
    <span className="metric-inline">
      <span>{label}</span>
      <InfoTooltip text={tooltip} />
    </span>
  );
}

function dateValueFromString(value) {
  if (!value) return null;
  const str = String(value);
  if (str.length === 8 && /^\d+$/.test(str)) {
    return Number(str);
  }
  if (str.length >= 10 && str[4] === "-" && str[7] === "-") {
    const year = Number(str.slice(0, 4));
    const month = Number(str.slice(5, 7)) - 1;
    const day = Number(str.slice(8, 10));
    const date = new Date(year, month, day);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }
  return null;
}

function parseDateValue(value) {
  if (!value) return null;
  const str = String(value);
  let year = null;
  let month = null;
  let day = null;
  if (str.length === 8 && /^\d+$/.test(str)) {
    year = Number(str.slice(0, 4));
    month = Number(str.slice(4, 6)) - 1;
    day = Number(str.slice(6, 8));
  } else if (str.length >= 10 && str[4] === "-" && str[7] === "-") {
    year = Number(str.slice(0, 4));
    month = Number(str.slice(5, 7)) - 1;
    day = Number(str.slice(8, 10));
  } else {
    return null;
  }
  const date = new Date(year, month, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function addMonths(date, months) {
  const result = new Date(date.getTime());
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const maxDay = daysInMonth(result.getFullYear(), result.getMonth());
  result.setDate(Math.min(day, maxDay));
  return result;
}

function startOfDay(date) {
  const result = new Date(date.getTime());
  result.setHours(0, 0, 0, 0);
  return result;
}

function buildCashflowSchedule({ maturityDate, frequency, notional, couponRate }) {
  if (!maturityDate) return [];
  const freq = Number.isFinite(frequency) && frequency > 0 ? frequency : 1;
  const monthsStep = Math.max(1, Math.round(12 / freq));
  const today = startOfDay(new Date());
  const schedule = [];
  const maturityTime = maturityDate.getTime();
  let cursor = maturityDate;

  for (let i = 0; i < 200; i += 1) {
    const cursorDay = startOfDay(cursor);
    if (cursorDay >= today) {
      const isMaturity = cursor.getTime() === maturityTime;
      const coupon = (couponRate / 100) * notional / freq;
      const principal = isMaturity ? notional : 0;
      schedule.unshift({
        date: cursorDay,
        coupon,
        principal,
        total: coupon + principal,
        isMaturity
      });
    } else {
      break;
    }
    cursor = addMonths(cursor, -monthsStep);
  }
  return schedule;
}

function countCashflowPeriods({ maturityDate, frequency }) {
  if (!maturityDate) return null;
  const freq = Number.isFinite(frequency) && frequency > 0 ? frequency : 1;
  const monthsStep = Math.max(1, Math.round(12 / freq));
  const today = startOfDay(new Date());
  let cursor = maturityDate;
  let count = 0;

  for (let i = 0; i < 200; i += 1) {
    const cursorDay = startOfDay(cursor);
    if (cursorDay >= today) {
      count += 1;
    } else {
      break;
    }
    cursor = addMonths(cursor, -monthsStep);
  }

  return count > 0 ? count : null;
}

function ScatterPlot({ data, onPointClick }) {
  const [hovered, setHovered] = useState(null);
  const [mouse, setMouse] = useState(null);
  const width = 800;
  const height = 320;
  const padding = { left: 60, right: 20, top: 20, bottom: 50 };
  const { points, xMin, xMax, yMin, yMax } = data;

  const xScale = (value) =>
    padding.left +
    ((value - xMin) / (xMax - xMin)) * (width - padding.left - padding.right);
  const yScale = (value) =>
    height -
    padding.bottom -
    ((value - yMin) / (yMax - yMin)) * (height - padding.top - padding.bottom);

  const ticks = 5;
  const xTicks = Array.from({ length: ticks }, (_, i) => {
    const value = xMin + ((xMax - xMin) / (ticks - 1)) * i;
    return { value, x: xScale(value) };
  });
  const yTicks = Array.from({ length: ticks }, (_, i) => {
    const value = yMin + ((yMax - yMin) / (ticks - 1)) * i;
    return { value, y: yScale(value) };
  });

  const handleMouseMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = width / rect.width;
    const scaleY = height / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
    const inside =
      x >= padding.left &&
      x <= width - padding.right &&
      y >= padding.top &&
      y <= height - padding.bottom;
    setMouse({ x, y, inside });
  };

  const handleMouseLeave = () => {
    setMouse(null);
    setHovered(null);
  };

  const tooltip = hovered
    ? {
        width: 220,
        height: 64,
        x: Math.min(
          width - padding.right - 220,
          Math.max(padding.left, hovered.x + 12)
        ),
        y: Math.min(
          height - padding.bottom - 64,
          Math.max(padding.top, hovered.y - 12 - 64)
        )
      }
    : null;

  return (
    <svg
      className="scatter"
      viewBox={`0 0 ${width} ${height}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <line
        x1={padding.left}
        y1={padding.top}
        x2={padding.left}
        y2={height - padding.bottom}
        className="axis"
      />
      <line
        x1={padding.left}
        y1={height - padding.bottom}
        x2={width - padding.right}
        y2={height - padding.bottom}
        className="axis"
      />
      {xTicks.map((tick) => (
        <g key={`x-${tick.value}`}>
          <line
            x1={tick.x}
            y1={height - padding.bottom}
            x2={tick.x}
            y2={height - padding.bottom + 6}
            className="tick"
          />
          <text x={tick.x} y={height - padding.bottom + 22} textAnchor="middle">
            {tick.value.toFixed(1)}
          </text>
        </g>
      ))}
      {yTicks.map((tick) => (
        <g key={`y-${tick.value}`}>
          <line
            x1={padding.left - 6}
            y1={tick.y}
            x2={padding.left}
            y2={tick.y}
            className="tick"
          />
          <text x={padding.left - 10} y={tick.y + 4} textAnchor="end">
            {tick.value.toFixed(2)}
          </text>
        </g>
      ))}
      <text
        x={(width + padding.left - padding.right) / 2}
        y={height - 10}
        textAnchor="middle"
        className="axis-label"
      >
        Maturity (years)
      </text>
      <text
        x={18}
        y={(height + padding.top - padding.bottom) / 2}
        textAnchor="middle"
        transform={`rotate(-90 18 ${(height + padding.top - padding.bottom) / 2})`}
        className="axis-label"
      >
        Ask yield (%)
      </text>
      {points.map((point) => (
        <circle
          key={point.bond.ValorId}
          cx={xScale(point.years)}
          cy={yScale(point.askYield)}
          r={hovered?.bond?.ValorId === point.bond.ValorId ? 6 : 4.5}
          className={`chart-point${
            hovered?.bond?.ValorId === point.bond.ValorId ? " is-hovered" : ""
          }`}
          onClick={() => onPointClick(point.bond)}
          onMouseEnter={() =>
            setHovered({
              ...point,
              x: xScale(point.years),
              y: yScale(point.askYield)
            })
          }
          onMouseLeave={() => setHovered(null)}
        >
          <title>
            {`${point.bond.ShortName || "Bond"} • ${point.years.toFixed(
              2
            )}y • ${point.askYield.toFixed(2)}%`}
          </title>
        </circle>
      ))}
      {hovered && tooltip ? (
        <g className="tooltip">
          <rect
            x={tooltip.x}
            y={tooltip.y}
            width={tooltip.width}
            height={tooltip.height}
            rx={10}
            ry={10}
          />
          <text x={tooltip.x + 12} y={tooltip.y + 22}>
            <tspan className="tooltip-title">
              {hovered.bond.ShortName || "Bond"}
            </tspan>
            <tspan x={tooltip.x + 12} dy={18}>
              {`Maturity: ${hovered.years.toFixed(2)}y`}
            </tspan>
            <tspan x={tooltip.x + 12} dy={18}>
              {`Ask yield: ${hovered.askYield.toFixed(2)}%`}
            </tspan>
          </text>
        </g>
      ) : null}
    </svg>
  );
}

function CurveChart({ points }) {
  const width = 800;
  const height = 240;
  const padding = { left: 60, right: 20, top: 20, bottom: 50 };
  const sorted = [...points].sort((a, b) => a.years - b.years);
  const xValues = sorted.map((point) => point.years);
  const yValues = sorted.map((point) => point.yield);
  let xMin = Math.min(...xValues);
  let xMax = Math.max(...xValues);
  let yMin = Math.min(...yValues);
  let yMax = Math.max(...yValues);
  if (xMin === xMax) {
    xMin = Math.max(0, xMin - 1);
    xMax = xMax + 1;
  }
  if (yMin === yMax) {
    yMin = yMin - 1;
    yMax = yMax + 1;
  }

  const xScale = (value) =>
    padding.left +
    ((value - xMin) / (xMax - xMin)) * (width - padding.left - padding.right);
  const yScale = (value) =>
    height -
    padding.bottom -
    ((value - yMin) / (yMax - yMin)) * (height - padding.top - padding.bottom);

  const ticks = 5;
  const xTicks = Array.from({ length: ticks }, (_, i) => {
    const value = xMin + ((xMax - xMin) / (ticks - 1)) * i;
    return { value, x: xScale(value) };
  });
  const yTicks = Array.from({ length: ticks }, (_, i) => {
    const value = yMin + ((yMax - yMin) / (ticks - 1)) * i;
    return { value, y: yScale(value) };
  });

  const path = sorted
    .map((point, index) => {
      const x = xScale(point.years);
      const y = yScale(point.yield);
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");

  return (
    <svg className="curve" viewBox={`0 0 ${width} ${height}`}>
      <line
        x1={padding.left}
        y1={padding.top}
        x2={padding.left}
        y2={height - padding.bottom}
        className="axis"
      />
      <line
        x1={padding.left}
        y1={height - padding.bottom}
        x2={width - padding.right}
        y2={height - padding.bottom}
        className="axis"
      />
      {xTicks.map((tick) => (
        <g key={`x-${tick.value}`}>
          <line
            x1={tick.x}
            y1={height - padding.bottom}
            x2={tick.x}
            y2={height - padding.bottom + 6}
            className="tick"
          />
          <text x={tick.x} y={height - padding.bottom + 22} textAnchor="middle">
            {tick.value.toFixed(1)}
          </text>
        </g>
      ))}
      {yTicks.map((tick) => (
        <g key={`y-${tick.value}`}>
          <line
            x1={padding.left - 6}
            y1={tick.y}
            x2={padding.left}
            y2={tick.y}
            className="tick"
          />
          <text x={padding.left - 10} y={tick.y + 4} textAnchor="end">
            {tick.value.toFixed(2)}
          </text>
        </g>
      ))}
      <text
        x={(width + padding.left - padding.right) / 2}
        y={height - 10}
        textAnchor="middle"
        className="axis-label"
      >
        Maturity (years)
      </text>
      <text
        x={18}
        y={(height + padding.top - padding.bottom) / 2}
        textAnchor="middle"
        transform={`rotate(-90 18 ${(height + padding.top - padding.bottom) / 2})`}
        className="axis-label"
      >
        Yield (%)
      </text>
      <path d={path} className="curve-line" />
      {sorted.map((point) => (
        <circle
          key={point.years}
          cx={xScale(point.years)}
          cy={yScale(point.yield)}
          r={4}
          className="curve-point"
        >
          <title>{`${point.years.toFixed(1)}y • ${point.yield.toFixed(2)}%`}</title>
        </circle>
      ))}
    </svg>
  );
}

export default function App() {
  const [view, setView] = useState("search");
  const [filters, setFilters] = useState({
    maturityBucket: "2-3",
    currency: "CHF",
    country: "CH"
  });
  const [sortState, setSortState] = useState({ key: "MaturityDate", dir: "asc" });
  const [pageSize, setPageSize] = useState(50);
  const [bonds, setBonds] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showChart, setShowChart] = useState(true);
  const [curve, setCurve] = useState(null);
  const [curveLoading, setCurveLoading] = useState(false);
  const [curveError, setCurveError] = useState("");
  const [volumes, setVolumes] = useState({});
  const [volumeLoading, setVolumeLoading] = useState(false);
  const [volumeError, setVolumeError] = useState("");
  const [portfolioPricingBasis, setPortfolioPricingBasis] = useState("last");
  const [portfolioScheduleView, setPortfolioScheduleView] = useState("aggregate");

  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const [notional, setNotional] = useState(100000);
  const [notionalInput, setNotionalInput] = useState("100000");
  const [commissionTierOneNotional, setCommissionTierOneNotional] = useState(10000);
  const [commissionTierOneRate, setCommissionTierOneRate] = useState(0.1);
  const [commissionTierTwoRate, setCommissionTierTwoRate] = useState(0.025);
  const [taxRate, setTaxRate] = useState(20);

  const [portfolio, setPortfolio] = useState(() => {
    try {
      const stored = localStorage.getItem("portfolio");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [portfolioDetails, setPortfolioDetails] = useState({});
  const [portfolioDetailLoading, setPortfolioDetailLoading] = useState(false);
  const [portfolioDetailError, setPortfolioDetailError] = useState("");

  useEffect(() => {
    localStorage.setItem("portfolio", JSON.stringify(portfolio));
  }, [portfolio]);

  useEffect(() => {
    if (portfolio.length === 0) {
      setPortfolioDetailLoading(false);
      setPortfolioDetailError("");
      return;
    }

    const missing = portfolio.filter(
      (holding) => !portfolioDetails[holding.valorId]
    );
    if (missing.length === 0) return;

    let active = true;
    setPortfolioDetailLoading(true);
    setPortfolioDetailError("");

    Promise.all(
      missing.map(async (holding) => {
        try {
          const data = await fetchBondDetails(holding.valorId);
          return { valorId: holding.valorId, data };
        } catch (err) {
          return { valorId: holding.valorId, error: err };
        }
      })
    )
      .then((results) => {
        if (!active) return;
        setPortfolioDetails((prev) => {
          const next = { ...prev };
          results.forEach((result) => {
            if (result.data) {
              next[result.valorId] = result.data;
              return;
            }
            if (result.error) {
              next[result.valorId] = { error: true };
            }
          });
          return next;
        });
        if (results.some((result) => result.error)) {
          setPortfolioDetailError(
            "Some bond details could not be loaded. Using listing data where needed."
          );
        }
      })
      .finally(() => {
        if (active) setPortfolioDetailLoading(false);
      });

    return () => {
      active = false;
    };
  }, [portfolio, portfolioDetails]);

  useEffect(() => {
    const loadCurve = async () => {
      setCurveLoading(true);
      setCurveError("");
      try {
        const data = await fetchSnbCurve();
        setCurve(data);
      } catch (err) {
        setCurveError(err.message || "Failed to load SNB curve.");
      } finally {
        setCurveLoading(false);
      }
    };
    loadCurve();
  }, []);

  const afterTaxYieldMap = useMemo(() => {
    const map = {};
    const tax = Number.isFinite(taxRate) ? taxRate : 0;
    bonds.forEach((bond) => {
      const years = maturityYearsFromValue(bond.MaturityDate);
      if (!Number.isFinite(years)) return;
      const ask = parseNumber(bond.AskPrice);
      const bid = parseNumber(bond.BidPrice);
      const mid =
        Number.isFinite(ask) &&
        Number.isFinite(bid) &&
        ask > 0 &&
        bid > 0
          ? (ask + bid) / 2
          : null;
      const close = parseNumber(bond.ClosingPrice);
      let price = null;
      let source = null;
      if (Number.isFinite(mid)) {
        price = mid;
        source = "mid";
      } else if (Number.isFinite(close) && close > 0) {
        price = close;
        source = "close";
      } else {
        return;
      }
      const couponRate = parseNumber(bond.CouponRate) || 0;
      const taxedCouponRate = couponRate * (1 - tax / 100);
      const ytm = yieldToMaturity({
        price,
        couponRate: taxedCouponRate,
        years,
        frequency: 1,
        notional: 100
      });

      let priceLine = "Price basis: ";
      if (source === "mid") {
        priceLine += `mid = (${formatNumber(ask, 2)} + ${formatNumber(bid, 2)}) / 2 = ${formatNumber(price, 2)}`;
      } else {
        priceLine += `close = ${formatNumber(price, 2)}`;
      }
      const couponLine =
        `Taxed coupon rate = ${formatPercent(couponRate, 2)} × (1 - ${formatNumber(tax, 1)}%) = ${formatPercent(taxedCouponRate, 2)}`;
      const maturityLine = `Maturity term = ${formatDurationYears(years)}`;
      const ytmLine = `YTM solves PV(cashflows) = ${formatNumber(price, 2)} (per 100)`;
      const tooltip = `${priceLine}\n${couponLine}\n${maturityLine}\n${ytmLine}`;

      map[bond.ValorId] = { yield: ytm, tooltip };
    });
    return map;
  }, [bonds, taxRate]);

  useEffect(() => {
    if (bonds.length === 0) return;
    const ids = bonds.map((bond) => bond.ValorId).filter(Boolean);
    const missing = ids.filter(
      (id) => !Object.prototype.hasOwnProperty.call(volumes, id)
    );
    if (missing.length === 0) return;

    let active = true;
    const loadVolumes = async () => {
      setVolumeLoading(true);
      setVolumeError("");
      try {
        const chunkSize = 50;
        const merged = {};
        for (let i = 0; i < missing.length; i += chunkSize) {
          const chunk = missing.slice(i, i + chunkSize);
          const response = await fetchBondVolumes(chunk);
          Object.assign(merged, response.items || {});
        }
        if (active) {
          setVolumes((prev) => ({ ...prev, ...merged }));
        }
      } catch (err) {
        if (active) {
          setVolumeError(err.message || "Failed to load volumes.");
        }
      } finally {
        if (active) setVolumeLoading(false);
      }
    };
    loadVolumes();
    return () => {
      active = false;
    };
  }, [bonds, volumes]);

  useEffect(() => {
    handleSearch();
  }, []);

  const handleSearch = async (event) => {
    if (event) event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetchBonds({
        maturityBucket: filters.maturityBucket,
        currency: filters.currency,
        country: filters.country,
        page: 1,
        pageSize
      });
      setBonds(response.items || []);
      setTotal(response.total || 0);
    } catch (err) {
      setError(err.message || "Failed to load bonds.");
    } finally {
      setLoading(false);
    }
  };

  const handleSort = (key) => {
    setSortState((prev) => {
      if (prev.key === key) {
        return { ...prev, dir: prev.dir === "asc" ? "desc" : "asc" };
      }
      return { key, dir: "asc" };
    });
  };

  const sortedBonds = useMemo(() => {
    if (!sortState.key) return bonds;
    const direction = sortState.dir === "asc" ? 1 : -1;
    const stringKeys = new Set(["IssuerNameFull", "ShortName"]);

    const getValue = (bond) => {
      switch (sortState.key) {
        case "IssuerNameFull":
          return bond.IssuerNameFull || "";
        case "ShortName":
          return bond.ShortName || "";
        case "MaturityDate":
          return dateValueFromString(bond.MaturityDate);
        case "Term":
          return maturityYearsFromValue(bond.MaturityDate);
        case "CouponRate":
          return parseNumber(bond.CouponRate);
        case "YieldToWorst":
          return parseNumber(bond.YieldToWorst);
        case "AskPrice":
          return parseNumber(bond.AskPrice);
        case "BidPrice":
          return parseNumber(bond.BidPrice);
        case "GovSpreadBps":
          return parseNumber(bond.GovSpreadBps);
        case "DayVolume":
          return parseNumber(volumes[bond.ValorId]?.volume);
        case "AfterTaxYield":
          return parseNumber(afterTaxYieldMap[bond.ValorId]?.yield);
        default:
          return bond[sortState.key];
      }
    };

    return [...bonds].sort((a, b) => {
      const valueA = getValue(a);
      const valueB = getValue(b);
      const aNull = valueA === null || valueA === undefined || valueA === "";
      const bNull = valueB === null || valueB === undefined || valueB === "";
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;

      if (stringKeys.has(sortState.key)) {
        return (
          String(valueA).localeCompare(String(valueB), "en", { sensitivity: "base" }) *
          direction
        );
      }

      return (Number(valueA) - Number(valueB)) * direction;
    });
  }, [bonds, sortState, volumes, afterTaxYieldMap]);

  const sortIndicator = (key) => {
    if (sortState.key !== key) return "";
    return sortState.dir === "asc" ? " ^" : " v";
  };

  const openDetails = async (bond) => {
    setSelected(bond);
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    try {
      const data = await fetchBondDetails(bond.ValorId);
      setDetail(data);
    } catch (err) {
      setDetailError(err.message || "Failed to load bond details.");
    } finally {
      setDetailLoading(false);
    }
  };

  const addToPortfolio = (bond) => {
    setPortfolio((prev) => {
      if (prev.some((holding) => holding.valorId === bond.ValorId)) return prev;
      const defaultNotional = Number.isFinite(notional) ? notional : 100000;
      return [
        ...prev,
        {
          valorId: bond.ValorId,
          bond,
          notional: defaultNotional,
          notionalInput: String(defaultNotional)
        }
      ];
    });
  };

  const removeFromPortfolio = (valorId) => {
    setPortfolio((prev) => prev.filter((holding) => holding.valorId !== valorId));
  };

  const updateHoldingNotional = (valorId, value) => {
    const text = String(value);
    setPortfolio((prev) =>
      prev.map((holding) =>
        holding.valorId === valorId
          ? {
              ...holding,
              notionalInput: text,
              notional:
                text.trim() !== "" && Number.isFinite(Number(text))
                  ? Number(text)
                  : holding.notional
            }
          : holding
      )
    );
  };

  const normalizeHoldingNotional = (valorId) => {
    setPortfolio((prev) =>
      prev.map((holding) => {
        if (holding.valorId !== valorId) return holding;
        const current = Number.isFinite(holding.notional) ? holding.notional : 0;
        const text = holding.notionalInput ?? "";
        if (text.trim() === "") {
          return { ...holding, notionalInput: String(current) };
        }
        return holding;
      })
    );
  };

  const chartData = useMemo(() => {
    const points = bonds
      .map((bond) => {
        const years = maturityYearsFromValue(bond.MaturityDate);
        if (!Number.isFinite(years)) return null;
        const askYield = parseNumber(bond.YieldToWorst);
        if (!Number.isFinite(askYield)) return null;
        return { years, askYield, bond };
      })
      .filter(Boolean);

    if (points.length === 0) return { points: [], xMin: 0, xMax: 1, yMin: 0, yMax: 1 };

    const xValues = points.map((p) => p.years);
    const yValues = points.map((p) => p.askYield);
    let xMin = Math.min(...xValues);
    let xMax = Math.max(...xValues);
    let yMin = Math.min(...yValues);
    let yMax = Math.max(...yValues);
    if (xMin === xMax) {
      xMin = Math.max(0, xMin - 1);
      xMax = xMax + 1;
    }
    if (yMin === yMax) {
      yMin = yMin - 1;
      yMax = yMax + 1;
    }

    return { points, xMin, xMax, yMin, yMax };
  }, [bonds]);

  const closeDetails = () => {
    setSelected(null);
    setDetail(null);
    setDetailError("");
    setDetailLoading(false);
  };

  const pricing = useMemo(() => {
    const market = detail?.market || {};
    const ask = parseNumber(market.AskPrice ?? selected?.AskPrice);
    const bid = parseNumber(market.BidPrice ?? selected?.BidPrice);
    const mid = ask !== null && bid !== null ? (ask + bid) / 2 : null;
    const lastPrice = parseNumber(
      market.PreviousClosingPrice ?? market.ClosingPrice ?? selected?.ClosingPrice
    );
    const yieldToWorst = parseNumber(market.YieldToWorst ?? selected?.YieldToWorst);
    return { ask, bid, mid, lastPrice, yieldToWorst };
  }, [detail, selected]);

  const bondInputs = useMemo(() => {
    const details = detail?.details || {};
    const overview = detail?.overview || {};
    const couponInfo = details.couponInfo || {};
    const couponRate = parseNumber(couponInfo.couponRate ?? selected?.CouponRate) || 0;
    const frequency = parseNumber(couponInfo.interestFrequency) || 1;
    const remainingYears = parseNumber(couponInfo.remainingLifeInYear);
    let years = remainingYears;
    if (!Number.isFinite(years)) {
      years = maturityYearsFromValue(
        details.maturity ?? overview.maturityDate ?? selected?.MaturityDate
      );
    }

    return {
      years,
      couponRate,
      frequency
    };
  }, [detail, selected]);

  const feeInputs = useMemo(
    () => ({
      tierOneNotional: commissionTierOneNotional,
      tierOneRate: commissionTierOneRate,
      tierTwoRate: commissionTierTwoRate
    }),
    [commissionTierOneNotional, commissionTierOneRate, commissionTierTwoRate]
  );

  const cashflowSchedule = useMemo(() => {
    const details = detail?.details || {};
    const overview = detail?.overview || {};
    const maturityValue = details.maturity ?? overview.maturityDate ?? selected?.MaturityDate;
    const maturityDate = parseDateValue(maturityValue);
    const couponRate = bondInputs.couponRate || 0;
    const frequency = bondInputs.frequency || 1;
    if (!maturityDate || !Number.isFinite(notional) || notional <= 0) return [];
    return buildCashflowSchedule({
      maturityDate,
      frequency,
      notional,
      couponRate
    });
  }, [detail, selected, bondInputs, notional]);

  const schedulePeriods = cashflowSchedule.length || null;

  const scenarioAsk = useMemo(() => {
    if (!selected) return null;
    return computeScenario({
      price: pricing.ask,
      couponRate: bondInputs.couponRate,
      years: bondInputs.years,
      frequency: bondInputs.frequency,
      notional,
      yieldToWorst: pricing.yieldToWorst,
      fees: feeInputs,
      taxRate: taxRate / 100,
      periodsOverride: schedulePeriods
    });
  }, [selected, pricing, bondInputs, notional, feeInputs, taxRate, schedulePeriods]);

  const scenarioMid = useMemo(() => {
    if (!selected) return null;
    return computeScenario({
      price: pricing.mid,
      couponRate: bondInputs.couponRate,
      years: bondInputs.years,
      frequency: bondInputs.frequency,
      notional,
      yieldToWorst: pricing.yieldToWorst,
      fees: feeInputs,
      taxRate: taxRate / 100,
      periodsOverride: schedulePeriods
    });
  }, [selected, pricing, bondInputs, notional, feeInputs, taxRate, schedulePeriods]);

  const scenarioLast = useMemo(() => {
    if (!selected) return null;
    return computeScenario({
      price: pricing.lastPrice,
      couponRate: bondInputs.couponRate,
      years: bondInputs.years,
      frequency: bondInputs.frequency,
      notional,
      yieldToWorst: pricing.yieldToWorst,
      fees: feeInputs,
      taxRate: taxRate / 100,
      periodsOverride: schedulePeriods
    });
  }, [selected, pricing, bondInputs, notional, feeInputs, taxRate, schedulePeriods]);

  const portfolioSet = useMemo(
    () => new Set(portfolio.map((holding) => holding.valorId)),
    [portfolio]
  );
  const portfolioBasisLabel = portfolioPricingBasis === "last" ? "last" : "ask";

  const resolveHoldingInputs = (holding, pricingBasis) => {
    const bond = holding.bond || {};
    const detailEntry = portfolioDetails[holding.valorId];
    const detailData = detailEntry && !detailEntry.error ? detailEntry : {};
    const details = detailData.details || {};
    const overview = detailData.overview || {};
    const couponInfo = details.couponInfo || {};
    const couponRate = parseNumber(couponInfo.couponRate ?? bond.CouponRate) || 0;
    const frequency = parseNumber(couponInfo.interestFrequency) || 1;
    let years = parseNumber(couponInfo.remainingLifeInYear);
    if (!Number.isFinite(years)) {
      const candidates = [
        details.maturity,
        overview.maturityDate,
        bond.MaturityDate
      ];
      for (const candidate of candidates) {
        const candidateYears = maturityYearsFromValue(candidate);
        if (Number.isFinite(candidateYears)) {
          years = candidateYears;
          break;
        }
      }
    }
    const maturityValue = details.maturity ?? overview.maturityDate ?? bond.MaturityDate;
    const maturityDate = parseDateValue(maturityValue);
    const askPriceRaw = parseNumber(detailData.market?.AskPrice ?? bond.AskPrice);
    const bidPriceRaw = parseNumber(detailData.market?.BidPrice ?? bond.BidPrice);
    const lastPriceRaw = parseNumber(
      detailData.market?.PreviousClosingPrice ??
        detailData.market?.ClosingPrice ??
        bond.ClosingPrice
    );
    const askPrice = Number.isFinite(askPriceRaw) && askPriceRaw > 0 ? askPriceRaw : null;
    const bidPrice = Number.isFinite(bidPriceRaw) && bidPriceRaw > 0 ? bidPriceRaw : null;
    const lastPrice = Number.isFinite(lastPriceRaw) && lastPriceRaw > 0 ? lastPriceRaw : null;
    const askYield = parseNumber(
      detailData.market?.YieldToWorst ?? bond.YieldToWorst
    );
    let price = pricingBasis === "last" ? lastPrice : askPrice;
    const fallbackUsed =
      (pricingBasis === "last" && !Number.isFinite(price) && Number.isFinite(askPrice)) ||
      (pricingBasis === "ask" && !Number.isFinite(price) && Number.isFinite(lastPrice));
    if (!Number.isFinite(price)) {
      price = pricingBasis === "last" ? askPrice : lastPrice;
    }
    const computedYield = Number.isFinite(price)
      ? yieldToMaturity({
          price,
          couponRate,
          years,
          frequency,
          notional: 100
        })
      : null;
    const yieldToWorst =
      pricingBasis === "last" || fallbackUsed
        ? (Number.isFinite(computedYield) ? computedYield : askYield)
        : askYield;

    return {
      bond,
      years,
      couponRate,
      frequency,
      maturityDate,
      price,
      askPrice,
      lastPrice,
      askYield,
      computedYield,
      yieldToWorst
    };
  };

  const portfolioStats = useMemo(() => {
    if (portfolio.length === 0) return null;

    let totalNotional = 0;
    let totalCost = 0;
    let totalGross = 0;
    let totalFee = 0;
    let totalTax = 0;
    let totalBuyFees = 0;
    let totalRoundTripFees = 0;
    let maturityWeighted = 0;
    let maturityWeight = 0;
    let yieldWeighted = 0;
    let yieldWeight = 0;
    const cashflowsGross = [];
    const cashflowsFee = [];
    const cashflowsTax = [];

    portfolio.forEach((holding) => {
      const inputs = resolveHoldingInputs(holding, portfolioPricingBasis);
      const years = inputs.years;
      const couponRate = inputs.couponRate;
      const askYield = inputs.yieldToWorst;
      const price = inputs.price;
      const periodsOverride = countCashflowPeriods({
        maturityDate: inputs.maturityDate,
        frequency: inputs.frequency
      });
      const notionalValue = Number.isFinite(holding.notional)
        ? holding.notional
        : notional;

      if (Number.isFinite(notionalValue)) {
        totalNotional += notionalValue;
      }

      if (Number.isFinite(askYield) && Number.isFinite(notionalValue)) {
        yieldWeighted += askYield * notionalValue;
        yieldWeight += notionalValue;
      }

      if (Number.isFinite(years) && Number.isFinite(notionalValue)) {
        maturityWeighted += years * notionalValue;
        maturityWeight += notionalValue;
      }

      const scenario = computeScenario({
        price,
        couponRate,
        years,
        frequency: inputs.frequency,
        notional: notionalValue,
        yieldToWorst: askYield,
        fees: feeInputs,
        taxRate: taxRate / 100,
        periodsOverride
      });

      if (Number.isFinite(scenario?.tradeValue)) {
        totalCost += scenario.tradeValue;
      }

      if (Number.isFinite(scenario?.grossAbs)) totalGross += scenario.grossAbs;
      if (Number.isFinite(scenario?.feeAbs)) totalFee += scenario.feeAbs;
      if (Number.isFinite(scenario?.taxAbs)) totalTax += scenario.taxAbs;
      if (Number.isFinite(scenario?.buyFee)) {
        totalBuyFees += scenario.buyFee;
      }
      if (Number.isFinite(scenario?.buyFee) && Number.isFinite(scenario?.sellFee)) {
        totalRoundTripFees += scenario.buyFee + scenario.sellFee;
      }

      const cashflows = buildCashflows({
        price,
        couponRate,
        years,
        frequency: inputs.frequency,
        notional: notionalValue,
        fees: feeInputs,
        taxRate: taxRate / 100,
        periodsOverride
      });
      cashflowsGross.push(...cashflows.cashflowsGross);
      cashflowsFee.push(...cashflows.cashflowsFee);
      cashflowsTax.push(...cashflows.cashflowsTax);
    });

    return {
      totalNotional,
      totalCost,
      totalGross,
      totalFee,
      totalTax,
      totalBuyFees,
      totalRoundTripFees,
      avgMaturity: maturityWeight ? maturityWeighted / maturityWeight : null,
      avgYield: yieldWeight ? yieldWeighted / yieldWeight : null,
      portfolioIrrGross: xirr(cashflowsGross),
      portfolioIrrFee: xirr(cashflowsFee),
      portfolioIrrTax: xirr(cashflowsTax)
    };
  }, [portfolio, feeInputs, taxRate, notional, portfolioDetails, portfolioPricingBasis]);

  const portfolioSchedule = useMemo(() => {
    if (portfolio.length === 0) return [];
    if (portfolioScheduleView === "perBond") {
      return portfolio.map((holding) => {
        const inputs = resolveHoldingInputs(holding, portfolioPricingBasis);
        const bond = inputs.bond || {};
        const notionalValue = Number.isFinite(holding.notional) ? holding.notional : 0;
        if (!inputs.maturityDate || notionalValue <= 0) {
          return {
            valorId: holding.valorId,
            label: bond.ShortName || bond.IssuerNameFull || holding.valorId,
            schedule: []
          };
        }
        const schedule = buildCashflowSchedule({
          maturityDate: inputs.maturityDate,
          frequency: inputs.frequency,
          notional: notionalValue,
          couponRate: inputs.couponRate
        });
        return {
          valorId: holding.valorId,
          label: bond.ShortName || bond.IssuerNameFull || holding.valorId,
          schedule
        };
      });
    }

    const map = new Map();
    portfolio.forEach((holding) => {
      const inputs = resolveHoldingInputs(holding, portfolioPricingBasis);
      if (!inputs.maturityDate || !Number.isFinite(holding.notional)) return;
      const schedule = buildCashflowSchedule({
        maturityDate: inputs.maturityDate,
        frequency: inputs.frequency,
        notional: holding.notional,
        couponRate: inputs.couponRate
      });
      schedule.forEach((row) => {
        const key = `${row.date.getFullYear()}${String(row.date.getMonth() + 1).padStart(2, "0")}${String(row.date.getDate()).padStart(2, "0")}`;
        const existing = map.get(key) || {
          date: row.date,
          coupon: 0,
          principal: 0,
          total: 0
        };
        existing.coupon += row.coupon;
        existing.principal += row.principal;
        existing.total += row.total;
        map.set(key, existing);
      });
    });
    return Array.from(map.values()).sort((a, b) => a.date - b.date);
  }, [portfolio, portfolioDetails, portfolioPricingBasis, portfolioScheduleView]);

  const portfolioDetailStatus = useMemo(() => {
    if (portfolio.length === 0) return null;
    const loaded = portfolio.filter((holding) => {
      const detail = portfolioDetails[holding.valorId];
      return detail && !detail.error;
    }).length;
    return { loaded, total: portfolio.length };
  }, [portfolio, portfolioDetails]);

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Versified Bond Portfolio</p>
          <h1>SIX Bond Explorer with real return math</h1>
          <p className="subtitle">
            Filter Swiss-listed bonds, inspect issuer details, and estimate
            returns after fees and tax.
          </p>
        </div>
        <div className="hero-card">
          <div>
            <span className="label">Data source</span>
            <strong>SIX Bond Explorer</strong>
          </div>
          <div>
            <span className="label">Assumptions</span>
            <strong>Dirty price + linear accrual</strong>
          </div>
          <div>
            <span className="label">Notional</span>
            <strong>CHF {formatNumber(notional, 0)}</strong>
          </div>
        </div>
      </header>

      <nav className="nav-bar">
        <button
          type="button"
          className={view === "search" ? "" : "ghost"}
          onClick={() => setView("search")}
        >
          Search
        </button>
        <button
          type="button"
          className={view === "portfolio" ? "" : "ghost"}
          onClick={() => setView("portfolio")}
        >
          Portfolio ({portfolio.length})
        </button>
      </nav>

      <div className="assumption-card">
        <div>
          <span className="label">Global assumptions</span>
          <strong>Used for portfolio + detail calculations</strong>
        </div>
        <div className="assumption-fields">
          <label>
            Marginal income tax (%)
            <input
              type="number"
              value={taxRate}
              onChange={(event) => setTaxRate(Number(event.target.value) || 0)}
            />
          </label>
          <div className="commission-block">
            <span className="label">Commissions (tiered)</span>
            <div className="commission-grid">
              <label>
                Tier 1 notional (CHF)
                <input
                  type="number"
                  value={commissionTierOneNotional}
                  onChange={(event) =>
                    setCommissionTierOneNotional(Number(event.target.value) || 0)
                  }
                />
              </label>
              <label>
                Tier 1 rate (%)
                <input
                  type="number"
                  step="0.01"
                  value={commissionTierOneRate}
                  onChange={(event) =>
                    setCommissionTierOneRate(Number(event.target.value) || 0)
                  }
                />
              </label>
              <label>
                Tier 2 rate (%)
                <input
                  type="number"
                  step="0.001"
                  value={commissionTierTwoRate}
                  onChange={(event) =>
                    setCommissionTierTwoRate(Number(event.target.value) || 0)
                  }
                />
              </label>
            </div>
            <p className="meta">Applied to both buy and sell trades.</p>
          </div>
        </div>
      </div>

      {view === "search" ? (
        <form className="filter-card" onSubmit={handleSearch}>
          <div className="filter-grid">
            <label>
              Maturity bucket
              <select
                value={filters.maturityBucket}
                onChange={(event) =>
                  setFilters({ ...filters, maturityBucket: event.target.value })
                }
              >
                {MATURITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Currency
              <select
                value={filters.currency}
                onChange={(event) =>
                  setFilters({ ...filters, currency: event.target.value })
                }
              >
                {CURRENCY_OPTIONS.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Issuer country
              <input
                type="text"
                value={filters.country}
                maxLength={4}
                onChange={(event) =>
                  setFilters({ ...filters, country: event.target.value.toUpperCase() })
                }
              />
            </label>
            <label>
              Results per page
              <input
                type="number"
                min="10"
                max="200"
                value={pageSize}
                onChange={(event) => setPageSize(Number(event.target.value) || 50)}
              />
            </label>
          </div>
          <div className="filter-actions">
            <button type="submit" disabled={loading}>
              {loading ? "Loading..." : "Fetch bonds"}
            </button>
            <span className="meta">{total ? `${total} matches` : ""}</span>
          </div>
          {error ? <p className="error">{error}</p> : null}
        </form>
      ) : null}

      {view === "search" ? (
        <section className="results">
        <div className="section-header">
          <div>
            <h2>Results</h2>
            <p>Click a bond to open the detail sheet.</p>
          </div>
          <button
            type="button"
            className="ghost"
            onClick={() => setShowChart((prev) => !prev)}
          >
            {showChart ? "Hide chart" : "Show chart"}
          </button>
        </div>
        {showChart ? (
          <div className="chart-card">
            <div className="chart-header">
              <h3>Maturity vs ask yield</h3>
              <span>{chartData.points.length} bonds plotted</span>
            </div>
            {chartData.points.length === 0 ? (
              <p className="meta">No yield/maturity data available for this filter.</p>
            ) : (
              <ScatterPlot
                data={chartData}
                onPointClick={(bond) => openDetails(bond)}
              />
            )}
          </div>
        ) : null}
        <div className="chart-card">
          <div className="chart-header">
            <h3>SNB Swiss government curve</h3>
            <span>
              {curve?.latest_date ? `Latest ${curve.latest_date}` : "Latest curve"}
            </span>
          </div>
          {curveLoading ? <p className="meta">Loading curve...</p> : null}
          {curveError ? <p className="error">{curveError}</p> : null}
          {!curveLoading && !curveError ? (
            curve?.points && curve.points.length > 1 ? (
              <CurveChart points={curve.points} />
            ) : (
              <p className="meta">No SNB curve data available.</p>
            )
          ) : null}
        </div>
        <div className="table-wrap">
          {volumeError ? <p className="error">{volumeError}</p> : null}
          <table>
            <thead>
              <tr>
                <th aria-sort={sortState.key === "IssuerNameFull" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("IssuerNameFull")}
                  >
                    Issuer{sortIndicator("IssuerNameFull")}
                  </button>
                </th>
                <th aria-sort={sortState.key === "ShortName" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("ShortName")}
                  >
                    Bond{sortIndicator("ShortName")}
                  </button>
                </th>
                <th aria-sort={sortState.key === "MaturityDate" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("MaturityDate")}
                  >
                    Maturity{sortIndicator("MaturityDate")}
                  </button>
                </th>
                <th aria-sort={sortState.key === "Term" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("Term")}
                  >
                    Term{sortIndicator("Term")}
                  </button>
                </th>
                <th aria-sort={sortState.key === "CouponRate" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("CouponRate")}
                  >
                    Coupon{sortIndicator("CouponRate")}
                  </button>
                </th>
                <th aria-sort={sortState.key === "YieldToWorst" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("YieldToWorst")}
                  >
                    Ask yield{sortIndicator("YieldToWorst")}
                  </button>
                </th>
                <th aria-sort={sortState.key === "AfterTaxYield" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("AfterTaxYield")}
                  >
                    After-tax yield{sortIndicator("AfterTaxYield")}
                  </button>
                </th>
                <th aria-sort={sortState.key === "AskPrice" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("AskPrice")}
                  >
                    Ask{sortIndicator("AskPrice")}
                  </button>
                </th>
                <th aria-sort={sortState.key === "BidPrice" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("BidPrice")}
                  >
                    Bid{sortIndicator("BidPrice")}
                  </button>
                </th>
                <th aria-sort={sortState.key === "DayVolume" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("DayVolume")}
                  >
                    Day vol{sortIndicator("DayVolume")}
                  </button>
                </th>
                <th aria-sort={sortState.key === "GovSpreadBps" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("GovSpreadBps")}
                  >
                    Gov spread (bps){sortIndicator("GovSpreadBps")}
                  </button>
                </th>
                <th>Info</th>
                <th>Add</th>
              </tr>
            </thead>
            <tbody>
              {sortedBonds.map((bond) => (
                <tr key={bond.ValorId}>
                  <td>{bond.IssuerNameFull || "-"}</td>
                  <td>{bond.ShortName || "-"}</td>
                  <td>{formatDateYMD(bond.MaturityDate)}</td>
                  <td>{formatDurationYears(maturityYearsFromValue(bond.MaturityDate))}</td>
                  <td>{formatPercent(parseNumber(bond.CouponRate), 2)}</td>
                  <td>{formatPercent(parseNumber(bond.YieldToWorst), 2)}</td>
                  <td>
                    {Number.isFinite(parseNumber(afterTaxYieldMap[bond.ValorId]?.yield)) ? (
                      <MetricInline
                        label={formatPercent(afterTaxYieldMap[bond.ValorId]?.yield, 2)}
                        tooltip={afterTaxYieldMap[bond.ValorId]?.tooltip}
                      />
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>{formatNumber(parseNumber(bond.AskPrice), 2)}</td>
                  <td>{formatNumber(parseNumber(bond.BidPrice), 2)}</td>
                  <td>
                    {(() => {
                      const entry = volumes[bond.ValorId];
                      const volume = parseNumber(entry?.volume);
                      if (Number.isFinite(volume)) {
                        const label = formatNumber(volume, 0);
                        return entry?.date ? (
                          <MetricInline
                            label={label}
                            tooltip={`Last day volume (${formatDateYMD(entry.date)})`}
                          />
                        ) : (
                          label
                        );
                      }
                      if (volumeLoading) return "…";
                      return "-";
                    })()}
                  </td>
                  <td>
                    {Number.isFinite(parseNumber(bond.GovSpreadBps)) ? (
                      <MetricInline
                        label={`${formatNumber(parseNumber(bond.GovSpreadBps), 1)} bps`}
                        tooltip={formatGovSpreadTooltip(bond.GovSpreadMeta)}
                      />
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>
                    <button type="button" className="ghost" onClick={() => openDetails(bond)}>
                      Info
                    </button>
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => addToPortfolio(bond)}
                      disabled={portfolioSet.has(bond.ValorId)}
                    >
                      {portfolioSet.has(bond.ValorId) ? "Added" : "Add"}
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && bonds.length === 0 ? (
                <tr>
                  <td colSpan="13" className="empty">
                    No bonds found for the current filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
      ) : (
        <section className="results">
          <div className="section-header">
            <div>
              <h2>Portfolio</h2>
              <p>
                Summary stats use {portfolioBasisLabel} prices and SIX coupon schedules
                when available.
              </p>
            </div>
            <div className="basis-toggle">
              <span className="label">Pricing basis</span>
              <div className="toggle-buttons">
                <button
                  type="button"
                  className={portfolioPricingBasis === "last" ? "" : "ghost"}
                  onClick={() => setPortfolioPricingBasis("last")}
                >
                  Last price
                </button>
                <button
                  type="button"
                  className={portfolioPricingBasis === "ask" ? "" : "ghost"}
                  onClick={() => setPortfolioPricingBasis("ask")}
                >
                  Ask price
                </button>
              </div>
              <button type="button" className="ghost" onClick={() => setView("search")}>
                Back to search
              </button>
            </div>
          </div>

          {portfolioDetailLoading ? (
            <p className="meta">Loading detail data for portfolio holdings...</p>
          ) : null}
          {portfolioDetailStatus ? (
            <p className="meta">
              {portfolioDetailStatus.loaded} / {portfolioDetailStatus.total} holdings
              enriched with SIX detail data.
            </p>
          ) : null}
          {portfolioDetailError ? <p className="error">{portfolioDetailError}</p> : null}

          {portfolio.length === 0 ? (
            <p className="meta">No bonds in your portfolio yet.</p>
          ) : (
            <>
              <div className="summary-grid">
                <div>
                  <MetricLabel label="Holdings" tooltip={METRIC_TOOLTIPS.holdings} />
                  <strong>{portfolio.length}</strong>
                </div>
                <div>
                  <MetricLabel
                    label="Total notional"
                    tooltip={METRIC_TOOLTIPS.totalNotional}
                  />
                  <strong>{formatCurrency(portfolioStats?.totalNotional, 0)}</strong>
                </div>
                <div>
                  <MetricLabel
                    label={`Cost at ${portfolioBasisLabel}`}
                    tooltip={METRIC_TOOLTIPS.costAtAsk}
                  />
                  <strong>{formatCurrency(portfolioStats?.totalCost, 0)}</strong>
                </div>
                <div>
                  <MetricLabel label="Avg maturity" tooltip={METRIC_TOOLTIPS.avgMaturity} />
                  <strong>{formatDurationYears(portfolioStats?.avgMaturity)}</strong>
                </div>
                <div>
                  <MetricLabel
                    label={`Avg ${portfolioBasisLabel} yield`}
                    tooltip={METRIC_TOOLTIPS.avgAskYield}
                  />
                  <strong>{formatPercent(portfolioStats?.avgYield, 2)}</strong>
                </div>
                <div>
                  <MetricLabel label="Gross return" tooltip={METRIC_TOOLTIPS.grossReturn} />
                  <strong>{formatCurrency(portfolioStats?.totalGross, 0)}</strong>
                </div>
                <div>
                  <MetricLabel
                    label="Return after fees"
                    tooltip={METRIC_TOOLTIPS.returnAfterFees}
                  />
                  <strong>{formatCurrency(portfolioStats?.totalFee, 0)}</strong>
                </div>
                <div>
                  <MetricLabel
                    label="Return after tax"
                    tooltip={METRIC_TOOLTIPS.returnAfterTax}
                  />
                  <strong>{formatCurrency(portfolioStats?.totalTax, 0)}</strong>
                </div>
                <div>
                  <MetricLabel label="Portfolio IRR" tooltip={METRIC_TOOLTIPS.portfolioIrr} />
                  <strong>{formatPercent(portfolioStats?.portfolioIrrGross, 2)}</strong>
                </div>
                <div>
                  <MetricLabel
                    label="Portfolio IRR (fees)"
                    tooltip={METRIC_TOOLTIPS.portfolioIrrFees}
                  />
                  <strong>{formatPercent(portfolioStats?.portfolioIrrFee, 2)}</strong>
                </div>
                <div>
                  <MetricLabel
                    label="Portfolio IRR (fees + tax)"
                    tooltip={METRIC_TOOLTIPS.portfolioIrrFeesTax}
                  />
                  <strong>{formatPercent(portfolioStats?.portfolioIrrTax, 2)}</strong>
                </div>
                <div>
                  <MetricLabel
                    label="Total buy fees"
                    tooltip={METRIC_TOOLTIPS.totalBuyFees}
                  />
                  <strong>{formatCurrency(portfolioStats?.totalBuyFees, 0)}</strong>
                </div>
                <div>
                  <MetricLabel
                    label="Round-trip fees"
                    tooltip={METRIC_TOOLTIPS.roundTripFees}
                  />
                  <strong>{formatCurrency(portfolioStats?.totalRoundTripFees, 0)}</strong>
                </div>
              </div>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Issuer</th>
                      <th>Bond</th>
                      <th>Maturity</th>
                      <th>Yield ({portfolioBasisLabel})</th>
                      <th>Price ({portfolioBasisLabel})</th>
                      <th>Notional</th>
                      <th>Gross return</th>
                      <th>IRR</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {portfolio.map((holding) => {
                      const inputs = resolveHoldingInputs(
                        holding,
                        portfolioPricingBasis
                      );
                      const bond = inputs.bond || {};
                      const years = inputs.years;
                      const periodsOverride = countCashflowPeriods({
                        maturityDate: inputs.maturityDate,
                        frequency: inputs.frequency
                      });
                      const scenario = computeScenario({
                        price: inputs.price,
                        couponRate: inputs.couponRate,
                        years,
                        frequency: inputs.frequency,
                        notional: holding.notional,
                        yieldToWorst: inputs.yieldToWorst,
                        fees: feeInputs,
                        taxRate: taxRate / 100,
                        periodsOverride
                      });
                      return (
                        <tr key={holding.valorId}>
                          <td>{bond.IssuerNameFull || "-"}</td>
                          <td>{bond.ShortName || "-"}</td>
                          <td>{formatDateYMD(bond.MaturityDate)}</td>
                          <td>{formatPercent(inputs.yieldToWorst, 2)}</td>
                          <td>{formatNumber(inputs.price, 2)}</td>
                          <td>
                            <input
                              type="text"
                              inputMode="decimal"
                              className="inline-input"
                              value={holding.notionalInput ?? String(holding.notional ?? "")}
                              onChange={(event) =>
                                updateHoldingNotional(holding.valorId, event.target.value)
                              }
                              onBlur={() => normalizeHoldingNotional(holding.valorId)}
                            />
                          </td>
                          <td>{formatCurrency(scenario?.grossAbs, 0)}</td>
                          <td>{formatPercent(scenario?.grossIrr, 2)}</td>
                          <td>
                            <button type="button" className="ghost" onClick={() => openDetails(bond)}>
                              Info
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => removeFromPortfolio(holding.valorId)}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <section className="portfolio-schedule">
                <div className="schedule-header">
                  <h3>Portfolio cash flow schedule</h3>
                  <div className="toggle-buttons">
                    <button
                      type="button"
                      className={portfolioScheduleView === "aggregate" ? "" : "ghost"}
                      onClick={() => setPortfolioScheduleView("aggregate")}
                    >
                      Aggregate
                    </button>
                    <button
                      type="button"
                      className={portfolioScheduleView === "perBond" ? "" : "ghost"}
                      onClick={() => setPortfolioScheduleView("perBond")}
                    >
                      Per bond
                    </button>
                  </div>
                </div>
                {portfolioScheduleView === "aggregate" ? (
                  portfolioSchedule.length === 0 ? (
                    <p className="meta">No upcoming cash flows found.</p>
                  ) : (
                    <table className="schedule-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Coupon</th>
                          <th>Principal</th>
                          <th>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {portfolioSchedule.map((row) => (
                          <tr key={`${row.date.getTime()}-${row.total}`}>
                            <td>
                              {formatDateYMD(
                                `${row.date.getFullYear()}${String(
                                  row.date.getMonth() + 1
                                ).padStart(2, "0")}${String(row.date.getDate()).padStart(2, "0")}`
                              )}
                            </td>
                            <td>{formatCurrency(row.coupon, 2)}</td>
                            <td>{formatCurrency(row.principal, 2)}</td>
                            <td>{formatCurrency(row.total, 2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                ) : portfolioSchedule.length === 0 ? (
                  <p className="meta">No upcoming cash flows found.</p>
                ) : (
                  <div className="per-bond-schedule">
                    {portfolioSchedule.map((bondSchedule) => (
                      <div key={bondSchedule.valorId} className="bond-schedule-card">
                        <h4>{bondSchedule.label}</h4>
                        {bondSchedule.schedule.length === 0 ? (
                          <p className="meta">No upcoming cash flows.</p>
                        ) : (
                          <table className="schedule-table">
                            <thead>
                              <tr>
                                <th>Date</th>
                                <th>Coupon</th>
                                <th>Principal</th>
                                <th>Total</th>
                              </tr>
                            </thead>
                            <tbody>
                              {bondSchedule.schedule.map((row) => (
                                <tr key={`${row.date.getTime()}-${row.total}`}>
                                  <td>
                                    {formatDateYMD(
                                      `${row.date.getFullYear()}${String(
                                        row.date.getMonth() + 1
                                      ).padStart(2, "0")}${String(row.date.getDate()).padStart(2, "0")}`
                                    )}
                                  </td>
                                  <td>{formatCurrency(row.coupon, 2)}</td>
                                  <td>{formatCurrency(row.principal, 2)}</td>
                                  <td>{formatCurrency(row.total, 2)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </section>
      )}

      {selected ? (
        <div className="detail-backdrop" onClick={closeDetails}>
          <aside className="detail-panel" onClick={(event) => event.stopPropagation()}>
          <div className="detail-header">
            <div>
              <p className="eyebrow">Bond details</p>
              <h3>{selected.ShortName || "Bond"}</h3>
              <p className="meta">{selected.ValorId}</p>
              <a
                className="link"
                href={buildSixDetailUrl(selected.ValorId)}
                target="_blank"
                rel="noopener noreferrer"
              >
                View on SIX
              </a>
            </div>
            <button type="button" className="ghost" onClick={closeDetails}>
              Close
            </button>
          </div>
          <div className="detail-actions">
            <button
              type="button"
              onClick={() => addToPortfolio(selected)}
              disabled={portfolioSet.has(selected.ValorId)}
            >
              {portfolioSet.has(selected.ValorId) ? "In portfolio" : "Add to portfolio"}
            </button>
          </div>

          {detailLoading ? <p>Loading details...</p> : null}
          {detailError ? <p className="error">{detailError}</p> : null}

          {!detailLoading && detail ? (
            <div className="detail-grid">
              <section>
                <h4>Issuer & security</h4>
                <div className="detail-list">
                  <div>
                    <span>Issuer</span>
                    <strong>{detail.overview?.issuerName || "-"}</strong>
                  </div>
                  <div>
                    <span>ISIN</span>
                    <strong>{detail.overview?.isin || "-"}</strong>
                  </div>
                  <div>
                    <span>Issuer country</span>
                    <strong>{detail.details?.issuerCountryCode || "-"}</strong>
                  </div>
                  <div>
                    <span>Issue currency</span>
                    <strong>{detail.details?.issueCurrency || "-"}</strong>
                  </div>
                  <div>
                    <span>Trading currency</span>
                    <strong>{detail.details?.info?.tradingCurrency || "-"}</strong>
                  </div>
                  <div>
                    <span>Maturity date</span>
                    <strong>{formatDateYMD(detail.details?.maturity)}</strong>
                  </div>
                </div>
              </section>

              <section>
                <h4>Coupon & schedule</h4>
                <div className="detail-list">
                  <div>
                    <span>Coupon rate</span>
                    <strong>{formatPercent(bondInputs.couponRate, 3)}</strong>
                  </div>
                  <div>
                    <span>Frequency</span>
                    <strong>{bondInputs.frequency || 1}x per year</strong>
                  </div>
                  <div>
                    <span>Remaining life</span>
                    <strong>{formatDurationYears(bondInputs.years)}</strong>
                  </div>
                  <div>
                    <span>Interest method</span>
                    <strong>{detail.details?.couponInfo?.interestCalculationMethod || "-"}</strong>
                  </div>
                  <div>
                    <span>Payment currency</span>
                    <strong>{detail.details?.couponInfo?.paymentCurrency || "-"}</strong>
                  </div>
                  <div>
                    <span>Accrued interest from</span>
                    <strong>{formatDateYMD(detail.details?.couponInfo?.accruedInterestFromDate)}</strong>
                  </div>
                </div>
              </section>

              <section>
                <h4>Market snapshot</h4>
                <div className="detail-list">
                  <div>
                    <span>Ask / Bid</span>
                    <strong>
                      {formatNumber(pricing.ask, 2)} / {formatNumber(pricing.bid, 2)}
                    </strong>
                  </div>
                  <div>
                    <span>Mid price</span>
                    <strong>{formatNumber(pricing.mid, 2)}</strong>
                  </div>
                  <div>
                    <span>Ask yield</span>
                    <strong>{formatPercent(pricing.yieldToWorst, 2)}</strong>
                  </div>
                  <div>
                    <span>Previous close</span>
                    <strong>{formatNumber(parseNumber(detail.market?.PreviousClosingPrice), 2)}</strong>
                  </div>
                  <div>
                    <span>Daily range</span>
                    <strong>
                      {formatNumber(parseNumber(detail.market?.DailyLowPrice), 2)} -
                      {formatNumber(parseNumber(detail.market?.DailyHighPrice), 2)}
                    </strong>
                  </div>
                  <div>
                    <span>Mid spread</span>
                    <strong>{formatPercent(parseNumber(detail.market?.MidSpread), 2)}</strong>
                  </div>
                  <div>
                    <span>Gov spread (bps)</span>
                    <strong>
                      {Number.isFinite(parseNumber(detail.gov_spread_bps)) ? (
                        <MetricInline
                          label={`${formatNumber(parseNumber(detail.gov_spread_bps), 1)} bps`}
                          tooltip={formatGovSpreadTooltip(detail.gov_spread_meta)}
                        />
                      ) : (
                        "-"
                      )}
                    </strong>
                  </div>
                </div>
              </section>

              <section className="calculator">
                <h4>Return calculator</h4>
                <div className="calculator-grid">
                  <label>
                    Notional
                    <input
                      type="text"
                      inputMode="decimal"
                      value={notionalInput}
                      onChange={(event) => {
                        const value = event.target.value;
                        setNotionalInput(value);
                        if (value.trim() === "") return;
                        const parsed = Number(value);
                        if (Number.isFinite(parsed)) {
                          setNotional(parsed);
                        }
                      }}
                      onBlur={() => {
                        if (notionalInput.trim() === "") {
                          setNotionalInput(String(notional));
                        }
                      }}
                    />
                  </label>
                </div>

                <div className="calculator-note">
                  Defaults match IBKR tiered commissions (editable). Returns use a
                  linear accrual of ask yield and assume mid-price sale.
                </div>
                <div className="formula-block">
                  <h5>Break-even formulae</h5>
                  <p>
                    tradeValue = (price / 100) × notional
                  </p>
                  <p>
                    annualYieldValue = tradeValue × (askYield / 100)
                  </p>
                  <p>
                    annualTax = notional × (couponRate / 100) × (taxRate / 100)
                  </p>
                  <p>
                    breakevenYears = (buyFee + sellFee) / annualYieldValue
                  </p>
                  <p>
                    breakevenYearsAfterTax =
                    (buyFee + sellFee) / (annualYieldValue - annualTax)
                  </p>
                </div>

                <div className="return-grid">
                  <div className="return-card">
                    <h5>Ask price</h5>
                    <p>
                      <MetricInline
                        label="Gross return"
                        tooltip={RETURN_TOOLTIPS.grossReturn}
                      />
                      : {formatCurrency(scenarioAsk?.grossAbs)}
                    </p>
                    <p>
                      <MetricInline label="Gross IRR" tooltip={RETURN_TOOLTIPS.grossIrr} />
                      : {formatPercent(scenarioAsk?.grossIrr, 2)}
                    </p>
                    <p>
                      <MetricInline label="After fees" tooltip={RETURN_TOOLTIPS.afterFees} />:{" "}
                      {formatCurrency(scenarioAsk?.feeAbs)}
                    </p>
                    <p>
                      <MetricInline label="Fee IRR" tooltip={RETURN_TOOLTIPS.feeIrr} />:{" "}
                      {formatPercent(scenarioAsk?.feeIrr, 2)}
                    </p>
                    <p>
                      <MetricInline label="After tax" tooltip={RETURN_TOOLTIPS.afterTax} />:{" "}
                      {formatCurrency(scenarioAsk?.taxAbs)}
                    </p>
                    <p>
                      <MetricInline label="Tax IRR" tooltip={RETURN_TOOLTIPS.taxIrr} />:{" "}
                      {formatPercent(scenarioAsk?.taxIrr, 2)}
                    </p>
                    <p>
                      <MetricInline
                        label="Break-even (fees)"
                        tooltip={RETURN_TOOLTIPS.breakEvenFees}
                      />
                      : {formatDurationYears(scenarioAsk?.breakEvenFees)}
                    </p>
                    <p>
                      <MetricInline
                        label="Break-even (fees + tax)"
                        tooltip={RETURN_TOOLTIPS.breakEvenFeesTax}
                      />
                      : {formatDurationYears(scenarioAsk?.breakEvenFeesTax)}
                    </p>
                  </div>
                  <div className="return-card">
                    <h5>Mid price</h5>
                    <p>
                      <MetricInline
                        label="Gross return"
                        tooltip={RETURN_TOOLTIPS.grossReturn}
                      />
                      : {formatCurrency(scenarioMid?.grossAbs)}
                    </p>
                    <p>
                      <MetricInline label="Gross IRR" tooltip={RETURN_TOOLTIPS.grossIrr} />
                      : {formatPercent(scenarioMid?.grossIrr, 2)}
                    </p>
                    <p>
                      <MetricInline label="After fees" tooltip={RETURN_TOOLTIPS.afterFees} />:{" "}
                      {formatCurrency(scenarioMid?.feeAbs)}
                    </p>
                    <p>
                      <MetricInline label="Fee IRR" tooltip={RETURN_TOOLTIPS.feeIrr} />:{" "}
                      {formatPercent(scenarioMid?.feeIrr, 2)}
                    </p>
                    <p>
                      <MetricInline label="After tax" tooltip={RETURN_TOOLTIPS.afterTax} />:{" "}
                      {formatCurrency(scenarioMid?.taxAbs)}
                    </p>
                    <p>
                      <MetricInline label="Tax IRR" tooltip={RETURN_TOOLTIPS.taxIrr} />:{" "}
                      {formatPercent(scenarioMid?.taxIrr, 2)}
                    </p>
                    <p>
                      <MetricInline
                        label="Break-even (fees)"
                        tooltip={RETURN_TOOLTIPS.breakEvenFees}
                      />
                      : {formatDurationYears(scenarioMid?.breakEvenFees)}
                    </p>
                    <p>
                      <MetricInline
                        label="Break-even (fees + tax)"
                        tooltip={RETURN_TOOLTIPS.breakEvenFeesTax}
                      />
                      : {formatDurationYears(scenarioMid?.breakEvenFeesTax)}
                    </p>
                  </div>
                  <div className="return-card">
                    <h5>Last price</h5>
                    <p>
                      <MetricInline
                        label="Gross return"
                        tooltip={RETURN_TOOLTIPS.grossReturn}
                      />
                      : {formatCurrency(scenarioLast?.grossAbs)}
                    </p>
                    <p>
                      <MetricInline label="Gross IRR" tooltip={RETURN_TOOLTIPS.grossIrr} />
                      : {formatPercent(scenarioLast?.grossIrr, 2)}
                    </p>
                    <p>
                      <MetricInline label="After fees" tooltip={RETURN_TOOLTIPS.afterFees} />:{" "}
                      {formatCurrency(scenarioLast?.feeAbs)}
                    </p>
                    <p>
                      <MetricInline label="Fee IRR" tooltip={RETURN_TOOLTIPS.feeIrr} />:{" "}
                      {formatPercent(scenarioLast?.feeIrr, 2)}
                    </p>
                    <p>
                      <MetricInline label="After tax" tooltip={RETURN_TOOLTIPS.afterTax} />:{" "}
                      {formatCurrency(scenarioLast?.taxAbs)}
                    </p>
                    <p>
                      <MetricInline label="Tax IRR" tooltip={RETURN_TOOLTIPS.taxIrr} />:{" "}
                      {formatPercent(scenarioLast?.taxIrr, 2)}
                    </p>
                    <p>
                      <MetricInline
                        label="Break-even (fees)"
                        tooltip={RETURN_TOOLTIPS.breakEvenFees}
                      />
                      : {formatDurationYears(scenarioLast?.breakEvenFees)}
                    </p>
                    <p>
                      <MetricInline
                        label="Break-even (fees + tax)"
                        tooltip={RETURN_TOOLTIPS.breakEvenFeesTax}
                      />
                      : {formatDurationYears(scenarioLast?.breakEvenFeesTax)}
                    </p>
                  </div>
                </div>
              </section>

              <section>
                <h4>Cash flow schedule</h4>
                {cashflowSchedule.length === 0 ? (
                  <p className="meta">No upcoming cash flows found.</p>
                ) : (
                  <table className="schedule-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Coupon</th>
                        <th>Principal</th>
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cashflowSchedule.map((row) => (
                        <tr key={`${row.date.getTime()}-${row.total}`}>
                          <td>
                            {formatDateYMD(
                              `${row.date.getFullYear()}${String(
                                row.date.getMonth() + 1
                              ).padStart(2, "0")}${String(row.date.getDate()).padStart(2, "0")}`
                            )}
                          </td>
                          <td>{formatCurrency(row.coupon, 2)}</td>
                          <td>{formatCurrency(row.principal, 2)}</td>
                          <td>{formatCurrency(row.total, 2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section>
                <h4>Liquidity (latest 5 days)</h4>
                <div className="liquidity-list">
                  {(detail.liquidity || []).slice(0, 5).map((row) => (
                    <div key={row.tradingDate}>
                      <span>{formatDateYMD(row.tradingDate)}</span>
                      <strong>{formatNumber(row.avgSpread, 4)} spread</strong>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  );
}
