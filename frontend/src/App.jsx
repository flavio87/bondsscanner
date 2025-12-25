import { useEffect, useMemo, useRef, useState } from "react";

import {
  enrichIssuer,
  fetchBondDetails,
  fetchBondVolumes,
  fetchBonds,
  fetchIssuerEnrichment,
  fetchIssuerEnrichmentBatch,
  fetchIssuerEnrichmentJob,
  fetchSnbCurve
} from "./api.js";
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
const LIQUIDITY_SPREAD_DAYS = 5;
const LLM_POLL_INTERVAL_MS = 1000;
const LLM_MAX_ATTEMPTS = 120;

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

function formatVeganFriendly(value) {
  if (value === true || value === 1) return "Yes";
  if (value === false || value === 0) return "No";
  return "-";
}

function buildIssuerContext(detail, selected) {
  if (!detail && !selected) return "";
  const overview = detail?.overview || {};
  const details = detail?.details || {};
  const issuer = overview.issuerName || selected?.IssuerNameFull || "Unknown issuer";
  const country = details.issuerCountryCode || selected?.IssuerCountry || "";
  const currency = details.issueCurrency || selected?.Currency || "";
  const maturity =
    details.maturity || overview.maturityDate || selected?.MaturityDate || "";
  return [
    `Issuer: ${issuer}`,
    country ? `Issuer country: ${country}` : null,
    currency ? `Issue currency: ${currency}` : null,
    maturity ? `Maturity: ${maturity}` : null,
    selected?.ShortName ? `Bond: ${selected.ShortName}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeSources(sources) {
  if (!sources) return [];
  if (Array.isArray(sources)) {
    return sources.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof sources === "string") {
    return sources
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [String(sources)];
}

function formatSourceLabel(source) {
  try {
    const url = new URL(source);
    return url.hostname;
  } catch {
    return source;
  }
}

const MOODYS_RATING_SCALE = [
  "Aaa",
  "Aa1",
  "Aa2",
  "Aa3",
  "A1",
  "A2",
  "A3",
  "Baa1",
  "Baa2",
  "Baa3",
  "Ba1",
  "Ba2",
  "Ba3",
  "B1",
  "B2",
  "B3",
  "Caa1",
  "Caa2",
  "Caa3",
  "Ca",
  "C"
];

const MOODYS_RATING_RANK = new Map(
  MOODYS_RATING_SCALE.map((rating, index) => [rating.toLowerCase(), index + 1])
);

const SP_FITCH_RATING_SCALE = [
  "AAA",
  "AA+",
  "AA",
  "AA-",
  "A+",
  "A",
  "A-",
  "BBB+",
  "BBB",
  "BBB-",
  "BB+",
  "BB",
  "BB-",
  "B+",
  "B",
  "B-",
  "CCC+",
  "CCC",
  "CCC-",
  "CC",
  "C",
  "D"
];

const SP_FITCH_RATING_RANK = new Map(
  SP_FITCH_RATING_SCALE.map((rating, index) => [rating.toLowerCase(), index + 1])
);

function normalizeMoodysRating(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "null") return null;
  const token = raw.split(/\s|\/|,|\(|\)|;|:/)[0];
  return token || null;
}

function moodysRatingRank(value) {
  const normalized = normalizeMoodysRating(value);
  if (!normalized) return null;
  return MOODYS_RATING_RANK.get(normalized.toLowerCase()) ?? null;
}

function normalizeSpFitchRating(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "null") return null;
  const match = raw.toUpperCase().match(
    /\b(AAA|AA\+|AA-|AA|A\+|A-|A|BBB\+|BBB-|BBB|BB\+|BB-|BB|B\+|B-|B|CCC\+|CCC-|CCC|CC|C|D)\b/
  );
  return match ? match[1] : null;
}

function spFitchRatingRank(value) {
  const normalized = normalizeSpFitchRating(value);
  if (!normalized) return null;
  return SP_FITCH_RATING_RANK.get(normalized.toLowerCase()) ?? null;
}

function computeLiquiditySpread(liquidity, market, ask, bid) {
  const rows = Array.isArray(liquidity) ? liquidity : [];
  const spreads = rows
    .map((row) => {
      const spread = parseNumber(row.avgSpread);
      const date = parseDateValue(row.tradingDate);
      return { spread, date };
    })
    .filter((row) => Number.isFinite(row.spread) && row.spread > 0)
    .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));

  if (spreads.length > 0) {
    const sample = spreads.slice(0, LIQUIDITY_SPREAD_DAYS);
    const average =
      sample.reduce((total, row) => total + row.spread, 0) / sample.length;
    return {
      spread: average,
      source: `avg spread (last ${sample.length} days)`
    };
  }

  const midSpread = parseNumber(market?.MidSpread);
  if (Number.isFinite(midSpread) && midSpread > 0) {
    return { spread: midSpread, source: "mid spread" };
  }

  if (Number.isFinite(ask) && Number.isFinite(bid) && ask > bid) {
    return { spread: ask - bid, source: "ask-bid spread" };
  }

  return null;
}

function computeLiquidityHaircut(spread, price, notional) {
  if (!Number.isFinite(spread) || spread <= 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(notional) || notional <= 0) return null;
  const halfSpread = spread / 2;
  const haircutValue = (halfSpread / 100) * notional;
  const haircutPct = halfSpread;
  const estBid = price - halfSpread;
  return {
    halfSpread,
    haircutValue,
    haircutPct,
    estBid
  };
}

function formatLiquidityTooltip(meta) {
  if (!meta) return "";
  const {
    source,
    spread,
    basePrice,
    baseLabel,
    estBid,
    haircutPct,
    haircutValue
  } = meta;
  return [
    `Spread source: ${source || "unknown"}`,
    Number.isFinite(spread) ? `Avg spread: ${formatNumber(spread, 3)}` : null,
    baseLabel && Number.isFinite(basePrice)
      ? `Base price (${baseLabel}): ${formatNumber(basePrice, 2)}`
      : null,
    Number.isFinite(estBid) ? `Est. bid price: ${formatNumber(estBid, 2)}` : null,
    Number.isFinite(haircutPct) ? `Haircut: ${formatNumber(haircutPct, 3)}%` : null,
    Number.isFinite(haircutValue)
      ? `Haircut value (notional): ${formatCurrency(haircutValue, 0)}`
      : null
  ]
    .filter(Boolean)
    .join("\n");
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

function SourcePopover({ sources }) {
  const list = normalizeSources(sources);
  if (list.length === 0) {
    return <p className="rating-empty">No sources available.</p>;
  }
  return (
    <ul className="rating-sources">
      {list.map((source) => {
        const label = formatSourceLabel(source);
        const isUrl = /^https?:\/\//i.test(source);
        return (
          <li key={source}>
            {isUrl ? (
              <a href={source} target="_blank" rel="noopener noreferrer">
                {label}
              </a>
            ) : (
              <span>{label}</span>
            )}
          </li>
        );
      })}
    </ul>
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

  const issuerNames = useMemo(() => {
    const names = new Set();
    bonds.forEach((bond) => {
      if (bond?.IssuerNameFull) {
        names.add(bond.IssuerNameFull);
      }
    });
    return Array.from(names);
  }, [bonds]);
  const issuerNamesKey = issuerNames.join("|");

  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [issuerEnrichment, setIssuerEnrichment] = useState(null);
  const [issuerEnrichmentStatus, setIssuerEnrichmentStatus] = useState({
    state: "idle",
    message: ""
  });
  const [issuerTableEnrichment, setIssuerTableEnrichment] = useState({});
  const issuerEnrichmentRequestId = useRef(0);
  const [ratingPopover, setRatingPopover] = useState(null);
  const ratingContainerRef = useRef(null);

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
    const ids = bonds
      .filter((bond) => {
        const totalVolume = parseNumber(bond.TotalVolume);
        return !Number.isFinite(totalVolume) || totalVolume <= 0;
      })
      .map((bond) => bond.ValorId)
      .filter(Boolean);
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
    if (issuerNames.length === 0) return;
    let active = true;

    const loadIssuerEnrichment = async () => {
      try {
        const response = await fetchIssuerEnrichmentBatch(issuerNames);
        if (!active) return;
        const items = response.items || {};
        setIssuerTableEnrichment((prev) => {
          const next = { ...prev };
          issuerNames.forEach((issuer) => {
            const existing = prev[issuer];
            const enrichment = items[issuer];
            if (enrichment) {
              next[issuer] = { status: "ready", enrichment };
              return;
            }
            if (!existing || existing.status === "idle" || existing.status === "missing") {
              next[issuer] = { status: "missing", enrichment: null };
            }
          });
          return next;
        });
      } catch (err) {
        if (!active) return;
        setIssuerTableEnrichment((prev) => {
          const next = { ...prev };
          issuerNames.forEach((issuer) => {
            if (!next[issuer]) {
              next[issuer] = { status: "missing", enrichment: null };
            }
          });
          return next;
        });
      }
    };

    loadIssuerEnrichment();
    return () => {
      active = false;
    };
  }, [issuerNamesKey]);

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
          {
            const totalVolume = parseNumber(bond.TotalVolume);
            if (Number.isFinite(totalVolume) && totalVolume > 0) {
              return totalVolume;
            }
            const fallback = parseNumber(volumes[bond.ValorId]?.volume);
            return Number.isFinite(fallback) ? fallback : totalVolume;
          }
        case "AfterTaxYield":
          return parseNumber(afterTaxYieldMap[bond.ValorId]?.yield);
        case "MoodysRating": {
          const issuerName = bond.IssuerNameFull || "";
          const entry = issuerTableEnrichment[issuerName];
          return moodysRatingRank(entry?.enrichment?.moodys);
        }
        case "FitchRating": {
          const issuerName = bond.IssuerNameFull || "";
          const entry = issuerTableEnrichment[issuerName];
          return spFitchRatingRank(entry?.enrichment?.fitch);
        }
        case "SPRating": {
          const issuerName = bond.IssuerNameFull || "";
          const entry = issuerTableEnrichment[issuerName];
          return spFitchRatingRank(entry?.enrichment?.sp);
        }
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
  }, [bonds, sortState, volumes, afterTaxYieldMap, issuerTableEnrichment]);

  const sortIndicator = (key) => {
    if (sortState.key !== key) return "";
    return sortState.dir === "asc" ? " ^" : " v";
  };

  const openDetails = async (bond) => {
    issuerEnrichmentRequestId.current += 1;
    setIssuerEnrichment(null);
    setIssuerEnrichmentStatus({ state: "idle", message: "" });
    setRatingPopover(null);
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

  const pollIssuerEnrichment = async (jobId, issuerName, requestId, attempt = 0) => {
    if (issuerEnrichmentRequestId.current !== requestId) return;
    try {
      const job = await fetchIssuerEnrichmentJob(jobId);
      if (issuerEnrichmentRequestId.current !== requestId) return;
      if (job?.status === "done") {
        const enrichment = await fetchIssuerEnrichment(issuerName);
        if (issuerEnrichmentRequestId.current !== requestId) return;
        setIssuerEnrichment(enrichment);
        setIssuerTableEnrichment((prev) => ({
          ...prev,
          [issuerName]: { status: "ready", enrichment }
        }));
        setIssuerEnrichmentStatus({ state: "done", message: "" });
        return;
      }
      if (job?.status === "failed") {
        setIssuerEnrichmentStatus({
          state: "failed",
          message: job?.error || "Issuer enrichment failed."
        });
        return;
      }
      if (attempt >= LLM_MAX_ATTEMPTS) {
        setIssuerEnrichmentStatus({
          state: "queued",
          message: "Still processing. You can refresh in a bit to check again."
        });
        return;
      }
      setTimeout(() => {
        pollIssuerEnrichment(jobId, issuerName, requestId, attempt + 1);
      }, LLM_POLL_INTERVAL_MS);
    } catch (err) {
      if (attempt >= LLM_MAX_ATTEMPTS) {
        setIssuerEnrichmentStatus({
          state: "queued",
          message: "Still processing. You can refresh in a bit to check again."
        });
        return;
      }
      setTimeout(() => {
        pollIssuerEnrichment(jobId, issuerName, requestId, attempt + 1);
      }, LLM_POLL_INTERVAL_MS);
    }
  };

  const pollIssuerTableEnrichment = async (jobId, issuerName, attempt = 0) => {
    try {
      const job = await fetchIssuerEnrichmentJob(jobId);
      if (job?.status === "done") {
        const enrichment = await fetchIssuerEnrichment(issuerName);
        setIssuerTableEnrichment((prev) => ({
          ...prev,
          [issuerName]: { status: "ready", enrichment }
        }));
        return;
      }
      if (job?.status === "failed") {
        setIssuerTableEnrichment((prev) => ({
          ...prev,
          [issuerName]: {
            status: "error",
            enrichment: prev[issuerName]?.enrichment || null
          }
        }));
        return;
      }
      if (attempt >= LLM_MAX_ATTEMPTS) {
        setIssuerTableEnrichment((prev) => ({
          ...prev,
          [issuerName]: {
            status: "queued",
            enrichment: prev[issuerName]?.enrichment || null
          }
        }));
        return;
      }
      setTimeout(() => {
        pollIssuerTableEnrichment(jobId, issuerName, attempt + 1);
      }, LLM_POLL_INTERVAL_MS);
    } catch (err) {
      if (attempt >= LLM_MAX_ATTEMPTS) {
        setIssuerTableEnrichment((prev) => ({
          ...prev,
          [issuerName]: {
            status: "queued",
            enrichment: prev[issuerName]?.enrichment || null
          }
        }));
        return;
      }
      setTimeout(() => {
        pollIssuerTableEnrichment(jobId, issuerName, attempt + 1);
      }, LLM_POLL_INTERVAL_MS);
    }
  };

  const handleFetchIssuerRatings = async (issuerName) => {
    if (!issuerName) return;
    setIssuerTableEnrichment((prev) => ({
      ...prev,
      [issuerName]: { status: "loading", enrichment: prev[issuerName]?.enrichment || null }
    }));
    try {
      const response = await enrichIssuer({
        issuer_name: issuerName,
        force_refresh: true,
        ratings_use_web: true,
        ratings_web_max_results: 5,
        ratings_web_search_options: { search_context_size: "high" }
      });
      if (response?.status === "cached" && response.enrichment) {
        setIssuerTableEnrichment((prev) => ({
          ...prev,
          [issuerName]: { status: "ready", enrichment: response.enrichment }
        }));
        return;
      }
      if (response?.status === "queued" && response.job_id) {
        setIssuerTableEnrichment((prev) => ({
          ...prev,
          [issuerName]: { status: "queued", enrichment: prev[issuerName]?.enrichment || null }
        }));
        pollIssuerTableEnrichment(response.job_id, issuerName);
        return;
      }
      setIssuerTableEnrichment((prev) => ({
        ...prev,
        [issuerName]: { status: "error", enrichment: prev[issuerName]?.enrichment || null }
      }));
    } catch (err) {
      setIssuerTableEnrichment((prev) => ({
        ...prev,
        [issuerName]: { status: "error", enrichment: prev[issuerName]?.enrichment || null }
      }));
    }
  };

  const buildIssuerPromptPreview = () => {
    const issuerName = detail?.overview?.issuerName || selected?.IssuerNameFull || "";
    const context = buildIssuerContext(detail, selected);
    const profilePrompt = [
      "You are enriching a bond issuer profile.",
      "Return JSON with keys: summary_md, vegan_friendly, vegan_explanation, esg_summary.",
      "Summary must be exactly one sentence.",
      "vegan_friendly must be true/false, with a brief explanation in vegan_explanation.",
      "Set vegan_friendly=false ONLY if there is clear evidence the issuer sells animal-derived products OR performs/commissions animal testing.",
      "Otherwise set vegan_friendly=true (including industries like construction, software, finance).",
      "If the context is insufficient, return null and state the uncertainty in vegan_explanation.",
      "Only use the provided context; do not browse or guess.",
      "",
      `Issuer: ${issuerName || "Unknown issuer"}`,
      "Context:",
      context || "No extra context provided."
    ].join("\n");

    const ratingsPrompt = [
      "What is the credit rating of the issuer below?",
      "Show Moody's, Fitch, and S&P (whichever are available).",
      "Use only the issuer's official website as a source.",
      "Return JSON with keys: moodys, fitch, sp, sources.",
      "If a rating is not available on the issuer website, return null for that rating.",
      "Only use verifiable information; do not guess.",
      "",
      `Issuer: ${issuerName || "Unknown issuer"}`
    ].join("\n");

    return [
      "Profile prompt:",
      profilePrompt,
      "",
      "Ratings prompt (web-enabled):",
      ratingsPrompt
    ].join("\n");
  };

  const handleCopyPrompt = async () => {
    const text = buildIssuerPromptPreview();
    try {
      await navigator.clipboard.writeText(text);
      setIssuerEnrichmentStatus({
        state: "done",
        message: "Prompt copied to clipboard."
      });
    } catch (err) {
      setIssuerEnrichmentStatus({
        state: "failed",
        message: err.message || "Failed to copy prompt."
      });
    }
  };

  const runIssuerEnrichment = async (forceRefresh) => {
    if (!selected) return;
    const issuerName = detail?.overview?.issuerName || selected?.IssuerNameFull || "";
    if (!issuerName) {
      setIssuerEnrichmentStatus({
        state: "failed",
        message: "Issuer name not available for enrichment."
      });
      return;
    }

    const requestId = issuerEnrichmentRequestId.current + 1;
    issuerEnrichmentRequestId.current = requestId;
    setIssuerEnrichment(null);
    setIssuerEnrichmentStatus({ state: "loading", message: "Enriching issuer..." });

    try {
      const response = await enrichIssuer({
        issuer_name: issuerName,
        context: buildIssuerContext(detail, selected),
        force_refresh: forceRefresh,
        ratings_use_web: true,
        ratings_web_max_results: 5,
        ratings_web_search_options: { search_context_size: "high" }
      });
      if (response?.status === "cached" && response.enrichment) {
        setIssuerEnrichment(response.enrichment);
        setIssuerTableEnrichment((prev) => ({
          ...prev,
          [issuerName]: { status: "ready", enrichment: response.enrichment }
        }));
        setIssuerEnrichmentStatus({ state: "done", message: "" });
        return;
      }
      if (response?.status === "queued" && response.job_id) {
        setIssuerEnrichmentStatus({
          state: "queued",
          message: "Queued for enrichment..."
        });
        pollIssuerEnrichment(response.job_id, issuerName, requestId);
        return;
      }
      setIssuerEnrichmentStatus({
        state: "failed",
        message: "Unexpected enrichment response."
      });
    } catch (err) {
      setIssuerEnrichmentStatus({
        state: "failed",
        message: err.message || "Issuer enrichment failed."
      });
    }
  };

  const handleEnrichIssuer = async () => {
    await runIssuerEnrichment(false);
  };

  const handleForceRefresh = async () => {
    await runIssuerEnrichment(true);
  };

  useEffect(() => {
    if (!selected) return;
    if (issuerEnrichment || issuerEnrichmentStatus.state === "loading" || issuerEnrichmentStatus.state === "queued") {
      return;
    }
    const issuerName = detail?.overview?.issuerName || selected?.IssuerNameFull || "";
    if (!issuerName) return;
    let active = true;
    fetchIssuerEnrichment(issuerName)
      .then((data) => {
        if (!active) return;
        setIssuerEnrichment(data);
        setIssuerTableEnrichment((prev) => ({
          ...prev,
          [issuerName]: { status: "ready", enrichment: data }
        }));
        setIssuerEnrichmentStatus({ state: "done", message: "" });
      })
      .catch((err) => {
        if (!active) return;
        if (String(err.message || "").includes("(404)")) return;
        setIssuerEnrichmentStatus({
          state: "failed",
          message: err.message || "Issuer enrichment failed."
        });
      });
    return () => {
      active = false;
    };
  }, [selected, detail, issuerEnrichment, issuerEnrichmentStatus.state]);

  useEffect(() => {
    if (!ratingPopover) return;
    const handleClick = (event) => {
      if (!ratingContainerRef.current) return;
      if (!ratingContainerRef.current.contains(event.target)) {
        setRatingPopover(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("mousedown", handleClick);
    };
  }, [ratingPopover]);

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
    issuerEnrichmentRequestId.current += 1;
    setIssuerEnrichment(null);
    setIssuerEnrichmentStatus({ state: "idle", message: "" });
    setRatingPopover(null);
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

  const liquidityEstimate = useMemo(() => {
    const market = detail?.market || {};
    const spreadInfo = computeLiquiditySpread(
      detail?.liquidity,
      market,
      pricing.ask,
      pricing.bid
    );
    if (!spreadInfo) return null;
    let basePrice = null;
    let baseLabel = null;
    if (Number.isFinite(pricing.lastPrice) && pricing.lastPrice > 0) {
      basePrice = pricing.lastPrice;
      baseLabel = "last price";
    } else if (Number.isFinite(pricing.mid) && pricing.mid > 0) {
      basePrice = pricing.mid;
      baseLabel = "mid price";
    } else if (Number.isFinite(pricing.ask) && pricing.ask > 0) {
      basePrice = pricing.ask;
      baseLabel = "ask price";
    }
    const haircut = computeLiquidityHaircut(spreadInfo.spread, basePrice, notional);
    if (!haircut) return null;
    return {
      ...spreadInfo,
      ...haircut,
      basePrice,
      baseLabel
    };
  }, [detail, pricing, notional]);

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

  const cashflowScheduleDisplay = useMemo(() => {
    if (cashflowSchedule.length === 0) return [];
    let price = null;
    let priceLabel = null;
    if (Number.isFinite(pricing.lastPrice) && pricing.lastPrice > 0) {
      price = pricing.lastPrice;
      priceLabel = "last price";
    } else if (Number.isFinite(pricing.mid) && pricing.mid > 0) {
      price = pricing.mid;
      priceLabel = "mid price";
    } else if (Number.isFinite(pricing.ask) && pricing.ask > 0) {
      price = pricing.ask;
      priceLabel = "ask price";
    }

    const rows = cashflowSchedule.map((row) => ({
      ...row,
      type: row.isMaturity ? "Coupon + principal" : "Coupon"
    }));
    if (!Number.isFinite(price)) {
      return rows;
    }

    const purchaseTotal = -((price / 100) * notional);
    const purchaseRow = {
      date: startOfDay(new Date()),
      coupon: 0,
      principal: 0,
      total: purchaseTotal,
      isMaturity: false,
      type: `Purchase (${priceLabel})`
    };
    return [purchaseRow, ...rows];
  }, [cashflowSchedule, pricing, notional]);

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
  const portfolioCostTooltip = `Sum((${portfolioBasisLabel} price / 100) * notional).`;
  const portfolioAvgYieldTooltip = `Sum(${portfolioBasisLabel} yield * notional) / Sum(notional).`;

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
    const spreadInfo = computeLiquiditySpread(
      detailData.liquidity,
      detailData.market,
      askPrice,
      bidPrice
    );

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
      yieldToWorst,
      liquiditySpread: spreadInfo?.spread ?? null,
      liquiditySource: spreadInfo?.source ?? null
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
    let totalLiquidityHaircut = 0;
    let liquidityNotional = 0;
    let liquiditySamples = 0;
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

      const liquidityHaircut = computeLiquidityHaircut(
        inputs.liquiditySpread,
        price,
        notionalValue
      );
      if (liquidityHaircut) {
        totalLiquidityHaircut += liquidityHaircut.haircutValue;
        liquidityNotional += notionalValue;
        liquiditySamples += 1;
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
      liquidityHaircutTotal: totalLiquidityHaircut,
      liquidityHaircutPct: liquidityNotional
        ? (totalLiquidityHaircut / liquidityNotional) * 100
        : null,
      liquidityCoverage: {
        samples: liquiditySamples,
        total: portfolio.length
      },
      avgMaturity: maturityWeight ? maturityWeighted / maturityWeight : null,
      avgYield: yieldWeight ? yieldWeighted / yieldWeight : null,
      portfolioIrrGross: xirr(cashflowsGross),
      portfolioIrrFee: xirr(cashflowsFee),
      portfolioIrrTax: xirr(cashflowsTax)
    };
  }, [portfolio, feeInputs, taxRate, notional, portfolioDetails, portfolioPricingBasis]);

  const portfolioLiquidityTooltip = useMemo(() => {
    if (!portfolioStats) return "";
    return (
      `Assumes immediate sale at estimated bid. Estimated bid = ${portfolioBasisLabel} price - ` +
      `(avg spread / 2). Spread source uses avg of last ${LIQUIDITY_SPREAD_DAYS} days when available. ` +
      `Coverage: ${portfolioStats.liquidityCoverage.samples}/${portfolioStats.liquidityCoverage.total} holdings.`
    );
  }, [portfolioStats, portfolioBasisLabel]);

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
      const bond = inputs.bond || {};
      const label = bond.ShortName || bond.IssuerNameFull || holding.valorId;
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
          total: 0,
          sources: new Set()
        };
        existing.coupon += row.coupon;
        existing.principal += row.principal;
        existing.total += row.total;
        if (row.total > 0) {
          existing.sources.add(label);
        }
        map.set(key, existing);
      });
    });
    return Array.from(map.values())
      .map((row) => ({
        ...row,
        sources: Array.from(row.sources || []).sort()
      }))
      .sort((a, b) => a.date - b.date);
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
        <div className="table-wrap results-table">
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
                <th
                  className="rating-col"
                  aria-sort={sortState.key === "MoodysRating" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("MoodysRating")}
                  >
                    Moody&apos;s{sortIndicator("MoodysRating")}
                  </button>
                </th>
                <th
                  className="rating-col"
                  aria-sort={sortState.key === "FitchRating" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("FitchRating")}
                  >
                    Fitch{sortIndicator("FitchRating")}
                  </button>
                </th>
                <th
                  className="rating-col"
                  aria-sort={sortState.key === "SPRating" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("SPRating")}
                  >
                    S&amp;P{sortIndicator("SPRating")}
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
                    Term / Maturity{sortIndicator("MaturityDate")}
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
                  <td className="rating-col">
                    {(() => {
                      const issuerName = bond.IssuerNameFull || "";
                      if (!issuerName) return "-";
                      const entry = issuerTableEnrichment[issuerName];
                      const status = entry?.status;
                      if (!entry || status === "missing" || status === "idle") {
                        return (
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => handleFetchIssuerRatings(issuerName)}
                          >
                            Fetch ratings
                          </button>
                        );
                      }
                      if (status === "loading" || status === "queued") {
                        return "Fetching…";
                      }
                      if (status === "error") {
                        return (
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => handleFetchIssuerRatings(issuerName)}
                          >
                            Retry
                          </button>
                        );
                      }
                      const moodysRaw = entry?.enrichment?.moodys;
                      const moodysValue = normalizeMoodysRating(moodysRaw);
                      return moodysValue ? moodysValue : "null";
                    })()}
                  </td>
                  <td className="rating-col">
                    {(() => {
                      const issuerName = bond.IssuerNameFull || "";
                      if (!issuerName) return "-";
                      const entry = issuerTableEnrichment[issuerName];
                      const status = entry?.status;
                      if (!entry || status === "missing" || status === "idle") {
                        return "-";
                      }
                      if (status === "loading" || status === "queued") {
                        return "Fetching…";
                      }
                      if (status === "error") {
                        return "Error";
                      }
                      const fitchRaw = entry?.enrichment?.fitch;
                      const fitchValue = normalizeSpFitchRating(fitchRaw);
                      return fitchValue ? fitchValue : "null";
                    })()}
                  </td>
                  <td className="rating-col">
                    {(() => {
                      const issuerName = bond.IssuerNameFull || "";
                      if (!issuerName) return "-";
                      const entry = issuerTableEnrichment[issuerName];
                      const status = entry?.status;
                      if (!entry || status === "missing" || status === "idle") {
                        return "-";
                      }
                      if (status === "loading" || status === "queued") {
                        return "Fetching…";
                      }
                      if (status === "error") {
                        return "Error";
                      }
                      const spRaw = entry?.enrichment?.sp;
                      const spValue = normalizeSpFitchRating(spRaw);
                      return spValue ? spValue : "null";
                    })()}
                  </td>
                  <td>{bond.ShortName || "-"}</td>
                  <td>
                    <div className="term-stack">
                      <span>{formatDurationYears(maturityYearsFromValue(bond.MaturityDate))}</span>
                      <span className="term-stack-sub">{formatDateYMD(bond.MaturityDate)}</span>
                    </div>
                  </td>
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
                  <td>
                    {(() => {
                      const totalVolume = parseNumber(bond.TotalVolume);
                      const entry = volumes[bond.ValorId];
                      const fallback = parseNumber(entry?.volume);
                      const useFallback =
                        !(Number.isFinite(totalVolume) && totalVolume > 0) &&
                        Number.isFinite(fallback);
                      if (!useFallback && Number.isFinite(totalVolume)) {
                        const label = formatNumber(totalVolume, 0);
                        return bond.MarketDate ? (
                          <MetricInline
                            label={label}
                            tooltip={`Market volume (${formatDateYMD(bond.MarketDate)})`}
                          />
                        ) : (
                          label
                        );
                      }
                      if (useFallback) {
                        const label = formatNumber(fallback, 0);
                        if (entry?.date) {
                          const sourceLabel = entry.source
                            ? ` (${entry.source.replace(/_/g, " ")})`
                            : "";
                          return (
                            <MetricInline
                              label={label}
                              tooltip={`Market volume${sourceLabel} (${formatDateYMD(entry.date)})`}
                            />
                          );
                        }
                        return label;
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
                  <td colSpan="14" className="empty">
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
              <div className="summary-groups">
                <section className="summary-group">
                  <h4>Exposure</h4>
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
                        tooltip={portfolioCostTooltip}
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
                        tooltip={portfolioAvgYieldTooltip}
                      />
                      <strong>{formatPercent(portfolioStats?.avgYield, 2)}</strong>
                    </div>
                  </div>
                </section>
                <section className="summary-group">
                  <h4>Returns</h4>
                  <div className="summary-grid">
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
                  </div>
                </section>
                <section className="summary-group">
                  <h4>IRR &amp; fees</h4>
                  <div className="summary-grid">
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
                    <div>
                      <MetricLabel
                        label="Est liquidation haircut"
                        tooltip={portfolioLiquidityTooltip}
                      />
                      <strong>
                        {formatCurrency(portfolioStats?.liquidityHaircutTotal, 0)}
                      </strong>
                    </div>
                    <div>
                      <MetricLabel label="Avg haircut (%)" tooltip={portfolioLiquidityTooltip} />
                      <strong>
                        {formatPercent(portfolioStats?.liquidityHaircutPct, 2)}
                      </strong>
                    </div>
                  </div>
                </section>
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
                      <th>Liquidity haircut</th>
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
                      const liquidityHaircut = computeLiquidityHaircut(
                        inputs.liquiditySpread,
                        inputs.price,
                        holding.notional
                      );
                      const liquidityMeta = liquidityHaircut
                        ? {
                            ...liquidityHaircut,
                            spread: inputs.liquiditySpread,
                            source: inputs.liquiditySource,
                            basePrice: inputs.price,
                            baseLabel: portfolioBasisLabel
                          }
                        : null;
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
                          <td>
                            {liquidityHaircut ? (
                              <MetricInline
                                label={formatCurrency(liquidityHaircut.haircutValue, 0)}
                                tooltip={formatLiquidityTooltip(liquidityMeta)}
                              />
                            ) : (
                              "-"
                            )}
                          </td>
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
                          <th>Bonds</th>
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
                            <td>
                              <span className="schedule-sources">
                                {row.sources && row.sources.length
                                  ? row.sources.join(", ")
                                  : "-"}
                              </span>
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
                <div className="enrichment-card">
                  <div className="enrichment-header">
                    <div>
                      <p className="eyebrow">Issuer enrichment</p>
                      <p className="meta">On-demand summary, ratings, and vegan check.</p>
                    </div>
                    <div className="enrichment-actions">
                      <button
                        type="button"
                        className="ghost"
                        onClick={handleCopyPrompt}
                        disabled={
                          issuerEnrichmentStatus.state === "loading" ||
                          issuerEnrichmentStatus.state === "queued"
                        }
                      >
                        Copy LLM prompt
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={handleForceRefresh}
                        disabled={
                          issuerEnrichmentStatus.state === "loading" ||
                          issuerEnrichmentStatus.state === "queued"
                        }
                      >
                        Force refresh
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={handleEnrichIssuer}
                        disabled={
                          issuerEnrichmentStatus.state === "loading" ||
                          issuerEnrichmentStatus.state === "queued"
                        }
                      >
                        {issuerEnrichmentStatus.state === "loading"
                          ? "Enriching..."
                          : issuerEnrichmentStatus.state === "queued"
                            ? "Queued..."
                            : "Enrich issuer"}
                      </button>
                    </div>
                  </div>
                  {issuerEnrichmentStatus.state === "failed" ? (
                    <p className="error">{issuerEnrichmentStatus.message}</p>
                  ) : issuerEnrichmentStatus.state === "queued" ||
                    issuerEnrichmentStatus.state === "loading" ? (
                    <p className="meta">{issuerEnrichmentStatus.message}</p>
                  ) : null}
                  {issuerEnrichment ? (
                    <div className="detail-list enrichment-list">
                      <div>
                        <span>Issuer summary</span>
                        <strong>{issuerEnrichment.summary_md || "-"}</strong>
                        <div className="detail-subtext enrichment-inline">
                          <span>Vegan friendly: {formatVeganFriendly(issuerEnrichment.vegan_friendly)}</span>
                          {issuerEnrichment.vegan_explanation ? (
                            <InfoTooltip text={issuerEnrichment.vegan_explanation} />
                          ) : null}
                        </div>
                      </div>
                      <div>
                        <span>Ratings</span>
                        <div className="rating-stack" ref={ratingContainerRef}>
                          <div className="rating-item">
                            <strong>Moody&apos;s</strong>
                            <button
                              type="button"
                              className="rating-button"
                              onClick={() =>
                                setRatingPopover((prev) =>
                                  prev === "moodys" ? null : "moodys"
                                )
                              }
                              aria-expanded={ratingPopover === "moodys"}
                            >
                              {issuerEnrichment.moodys || "-"}
                            </button>
                            {ratingPopover === "moodys" ? (
                              <div className="rating-popover">
                                <p>Sources</p>
                                <SourcePopover sources={issuerEnrichment.sources} />
                              </div>
                            ) : null}
                          </div>
                          <div className="rating-item">
                            <strong>Fitch</strong>
                            <button
                              type="button"
                              className="rating-button"
                              onClick={() =>
                                setRatingPopover((prev) =>
                                  prev === "fitch" ? null : "fitch"
                                )
                              }
                              aria-expanded={ratingPopover === "fitch"}
                            >
                              {issuerEnrichment.fitch || "-"}
                            </button>
                            {ratingPopover === "fitch" ? (
                              <div className="rating-popover">
                                <p>Sources</p>
                                <SourcePopover sources={issuerEnrichment.sources} />
                              </div>
                            ) : null}
                          </div>
                          <div className="rating-item">
                            <strong>S&amp;P</strong>
                            <button
                              type="button"
                              className="rating-button"
                              onClick={() =>
                                setRatingPopover((prev) => (prev === "sp" ? null : "sp"))
                              }
                              aria-expanded={ratingPopover === "sp"}
                            >
                              {issuerEnrichment.sp || "-"}
                            </button>
                            {ratingPopover === "sp" ? (
                              <div className="rating-popover">
                                <p>Sources</p>
                                <SourcePopover sources={issuerEnrichment.sources} />
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
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
                    <span className="metric-label-inline">
                      Liquidity haircut (est.)
                      {liquidityEstimate ? (
                        <InfoTooltip text={formatLiquidityTooltip(liquidityEstimate)} />
                      ) : null}
                    </span>
                    <strong>
                      {liquidityEstimate
                        ? `${formatCurrency(liquidityEstimate.haircutValue, 0)} (${formatPercent(
                            liquidityEstimate.haircutPct,
                            2
                          )})`
                        : "-"}
                    </strong>
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
                </div>
              </section>

              <section>
                <h4>Cash flow schedule</h4>
                {cashflowScheduleDisplay.length === 0 ? (
                  <p className="meta">No upcoming cash flows found.</p>
                ) : (
                  <table className="schedule-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Type</th>
                        <th>Coupon</th>
                        <th>Principal</th>
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cashflowScheduleDisplay.map((row, index) => (
                        <tr key={`${row.date.getTime()}-${row.total}`}>
                          <td>
                            {formatDateYMD(
                              `${row.date.getFullYear()}${String(
                                row.date.getMonth() + 1
                              ).padStart(2, "0")}${String(row.date.getDate()).padStart(2, "0")}`
                            )}
                          </td>
                          <td>{row.type || (index === 0 ? "Purchase" : "Coupon")}</td>
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
