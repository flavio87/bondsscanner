import { useEffect, useMemo, useRef, useState } from "react";

import {
  enrichIssuer,
  fetchBondDetails,
  fetchBondVolumes,
  fetchBonds,
  fetchIssuerEnrichment,
  fetchIssuerEnrichmentBatch,
  fetchIssuerEnrichmentJob,
  fetchGovBondCurve,
  fetchSnbCurve
} from "./api.js";
import {
  buildCashflows,
  computeTieredFee,
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
const ZERO_FEES = { tierOneNotional: 0, tierOneRate: 0, tierTwoRate: 0 };

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

function interpolateCurveYield(points, targetYears) {
  if (!Array.isArray(points) || !Number.isFinite(targetYears)) return null;
  const sorted = [...points].sort((a, b) => a.years - b.years);
  if (sorted.length < 2) return null;
  if (targetYears <= sorted[0].years) {
    const low = sorted[0];
    const high = sorted[1];
    if (high.years === low.years) return low.yield;
    const weight = (targetYears - low.years) / (high.years - low.years);
    return low.yield + weight * (high.yield - low.yield);
  }
  if (targetYears >= sorted[sorted.length - 1].years) {
    const high = sorted[sorted.length - 1];
    const low = sorted[sorted.length - 2];
    if (high.years === low.years) return high.yield;
    const weight = (targetYears - low.years) / (high.years - low.years);
    return low.yield + weight * (high.yield - low.yield);
  }
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].years >= targetYears) {
      const low = sorted[i - 1];
      const high = sorted[i];
      if (high.years === low.years) return low.yield;
      const weight = (targetYears - low.years) / (high.years - low.years);
      return low.yield + weight * (high.yield - low.yield);
    }
  }
  return null;
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

function computeAverageLiquiditySpread(liquidity) {
  const rows = Array.isArray(liquidity) ? liquidity : [];
  const spreads = rows
    .map((row) => {
      const spread = parseNumber(row.avgSpread);
      const date = parseDateValue(row.tradingDate);
      return { spread, date };
    })
    .filter((row) => Number.isFinite(row.spread) && row.spread > 0)
    .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));

  if (spreads.length === 0) return null;
  const sample = spreads.slice(0, LIQUIDITY_SPREAD_DAYS);
  const average =
    sample.reduce((total, row) => total + row.spread, 0) / sample.length;
  return { average, sampleSize: sample.length };
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

function formatImpliedGovSpreadTooltip({ yieldToWorst, govYield, source }) {
  if (!Number.isFinite(yieldToWorst) || !Number.isFinite(govYield)) {
    return "No spread data available.";
  }
  return [
    `YieldToWorst (SIX): ${formatPercent(yieldToWorst, 2)}`,
    `Implied gov yield: ${formatPercent(govYield, 2)}`,
    `Curve source: ${source || "implied gov curve"}`,
    "Spread = (YieldToWorst - implied gov curve)."
  ].join("\n");
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

function yearFraction30E360(start, end) {
  if (!start || !end) return null;
  const y1 = start.getFullYear();
  const y2 = end.getFullYear();
  const m1 = start.getMonth() + 1;
  const m2 = end.getMonth() + 1;
  const d1 = Math.min(start.getDate(), 30);
  const d2 = Math.min(end.getDate(), 30);
  return (360 * (y2 - y1) + 30 * (m2 - m1) + (d2 - d1)) / 360;
}

function buildCashflowScheduleFromRedemption({
  redemptionDate,
  frequency,
  notional,
  couponRate,
  settlementDate
}) {
  if (!redemptionDate) return [];
  const freq = Number.isFinite(frequency) && frequency > 0 ? frequency : 1;
  const monthsStep = Math.max(1, Math.round(12 / freq));
  const cutoff = startOfDay(settlementDate || new Date());
  const schedule = [];
  const redemptionTime = redemptionDate.getTime();
  let cursor = redemptionDate;

  for (let i = 0; i < 200; i += 1) {
    const cursorDay = startOfDay(cursor);
    if (cursorDay >= cutoff) {
      const isRedemption = cursor.getTime() === redemptionTime;
      const coupon = (couponRate / 100) * notional / freq;
      const principal = isRedemption ? notional : 0;
      schedule.unshift({
        date: cursorDay,
        coupon,
        principal,
        total: coupon + principal,
        isRedemption
      });
    } else {
      break;
    }
    cursor = addMonths(cursor, -monthsStep);
  }
  return schedule;
}

function computeAccruedInterest({ couponRate, notional, accrualStart, settlementDate }) {
  if (!accrualStart || !settlementDate) return null;
  const frac = yearFraction30E360(accrualStart, settlementDate);
  if (!Number.isFinite(frac) || frac < 0) return null;
  return ((couponRate || 0) / 100) * notional * frac;
}

function alignAccrualStart({ accrualStart, settlementDate, frequency }) {
  if (!accrualStart || !settlementDate) return accrualStart;
  const freq = Number.isFinite(frequency) && frequency > 0 ? frequency : 1;
  const monthsStep = Math.max(1, Math.round(12 / freq));
  let anchor = startOfDay(accrualStart);
  const settlement = startOfDay(settlementDate);

  // If anchor is after settlement, walk backwards.
  while (anchor > settlement) {
    anchor = addMonths(anchor, -monthsStep);
  }

  // Walk forward to the latest coupon date before settlement.
  for (let i = 0; i < 120; i += 1) {
    const next = addMonths(anchor, monthsStep);
    if (next > settlement) break;
    anchor = next;
  }

  return anchor;
}

function computeYieldFromSchedule({ price, schedule, settlementDate }) {
  const priceValue = parseNumber(price);
  if (!Number.isFinite(priceValue) || priceValue <= 0) return null;
  if (!schedule || schedule.length === 0) return null;
  const cashflows = [{ t: 0, amount: -priceValue }];
  schedule.forEach((row) => {
    const t = yearFraction30E360(settlementDate, row.date);
    if (!Number.isFinite(t) || t <= 0) return;
    cashflows.push({ t, amount: row.coupon + row.principal });
  });
  return xirr(cashflows);
}

function computeDurationFromSchedule({ pricePer100, schedule, settlementDate, yieldRate }) {
  const priceValue = parseNumber(pricePer100);
  if (!Number.isFinite(priceValue) || priceValue <= 0) return null;
  if (!schedule || schedule.length === 0) return null;
  let y = parseNumber(yieldRate);
  if (!Number.isFinite(y)) {
    y = computeYieldFromSchedule({
      price: priceValue,
      schedule,
      settlementDate
    });
  }
  if (!Number.isFinite(y)) return null;
  const rate = y / 100;
  let pv = 0;
  let weighted = 0;
  schedule.forEach((row) => {
    const t = yearFraction30E360(settlementDate, row.date);
    if (!Number.isFinite(t) || t <= 0) return;
    const cf = row.coupon + row.principal;
    const df = 1 / Math.pow(1 + rate, t);
    pv += cf * df;
    weighted += t * cf * df;
  });
  if (!Number.isFinite(pv) || pv <= 0) return null;
  const macaulay = weighted / pv;
  const modified = macaulay / (1 + rate);
  return { macaulay, modified };
}

function computeOneYearBreakEvenShift({
  pricePer100,
  schedule,
  settlementDate,
  yieldRate,
  duration
}) {
  const priceValue = parseNumber(pricePer100);
  if (!Number.isFinite(priceValue) || priceValue <= 0) return null;
  if (!schedule || schedule.length === 0) return null;
  const modDuration = Number.isFinite(duration) ? duration : null;
  if (!modDuration || modDuration <= 0) return null;
  const y = parseNumber(yieldRate);
  if (!Number.isFinite(y)) return null;
  const rate = y / 100;
  const horizon = addMonths(settlementDate, 12);
  let cashWithin = 0;
  let priceAtHorizon = 0;
  schedule.forEach((row) => {
    if (row.date <= horizon) {
      cashWithin += row.coupon + row.principal;
      return;
    }
    const t = yearFraction30E360(horizon, row.date);
    if (!Number.isFinite(t) || t <= 0) return;
    const cf = row.coupon + row.principal;
    priceAtHorizon += cf / Math.pow(1 + rate, t);
  });
  const totalReturn = cashWithin + (priceAtHorizon - priceValue);
  if (!Number.isFinite(totalReturn)) return null;
  return totalReturn / (modDuration * priceValue);
}

function buildActualScenarioForSchedule({
  pricePer100,
  schedule,
  settlementDate,
  notional,
  couponRate,
  taxRate,
  fees
}) {
  const priceValue = parseNumber(pricePer100);
  if (!Number.isFinite(priceValue) || priceValue <= 0) return null;
  if (!schedule || schedule.length === 0) return null;
  const tradeValue = (priceValue / 100) * notional;
  const tax = Number.isFinite(taxRate) ? taxRate : 0;
  const buyFee = computeTieredFee(
    tradeValue,
    fees.tierOneNotional,
    fees.tierOneRate,
    fees.tierTwoRate
  );
  const sellFee = computeTieredFee(
    tradeValue,
    fees.tierOneNotional,
    fees.tierOneRate,
    fees.tierTwoRate
  );

  const cashflowsGross = [{ t: 0, amount: -tradeValue }];
  const cashflowsFee = [{ t: 0, amount: -(tradeValue + buyFee) }];
  const cashflowsTax = [{ t: 0, amount: -(tradeValue + buyFee) }];

  schedule.forEach((row) => {
    const t = yearFraction30E360(settlementDate, row.date);
    if (!Number.isFinite(t) || t <= 0) return;
    const grossAmount = row.coupon + row.principal;
    const taxAmount = row.coupon * (1 - tax) + row.principal;
    cashflowsGross.push({ t, amount: grossAmount });
    cashflowsFee.push({ t, amount: grossAmount });
    cashflowsTax.push({ t, amount: taxAmount });
  });

  const grossIrr = xirr(cashflowsGross);
  const feeIrr = xirr(cashflowsFee);
  const taxIrr = xirr(cashflowsTax);
  const grossAbs = cashflowsGross.reduce((sum, flow) => sum + flow.amount, 0);
  const feeAbs = cashflowsFee.reduce((sum, flow) => sum + flow.amount, 0);
  const taxAbs = cashflowsTax.reduce((sum, flow) => sum + flow.amount, 0);

  const annualYieldValue =
    tradeValue && Number.isFinite(grossIrr) ? tradeValue * (grossIrr / 100) : null;
  const annualTax = ((couponRate || 0) / 100) * notional * tax;
  const breakEvenFees =
    annualYieldValue && annualYieldValue > 0
      ? (buyFee + sellFee) / annualYieldValue
      : null;
  const netAnnual = annualYieldValue !== null ? annualYieldValue - annualTax : null;
  const breakEvenFeesTax =
    netAnnual && netAnnual > 0 ? (buyFee + sellFee) / netAnnual : null;

  return {
    tradeValue,
    buyFee,
    sellFee,
    grossAbs,
    feeAbs,
    taxAbs,
    grossIrr,
    feeIrr,
    taxIrr,
    breakEvenFees,
    breakEvenFeesTax
  };
}

function minIgnoreNull(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a ?? null;
  if (!Number.isFinite(a)) return Number.isFinite(b) ? b : null;
  if (!Number.isFinite(b)) return a;
  return Math.min(a, b);
}

function computeActualGrossIrrForBond({ bond, detail }) {
  if (!bond || !detail) return null;
  const market = detail?.market || {};
  const askYield = parseNumber(bond.YieldToWorst);
  if (!Number.isFinite(askYield)) return null;

  const lastPrice = parseNumber(
    market.PreviousClosingPrice ?? market.ClosingPrice ?? bond.ClosingPrice
  );
  const ask = parseNumber(market.AskPrice ?? bond.AskPrice);
  const bid = parseNumber(market.BidPrice ?? bond.BidPrice);
  const mid =
    Number.isFinite(ask) && Number.isFinite(bid) && ask > 0 && bid > 0
      ? (ask + bid) / 2
      : null;
  const cleanPrice = Number.isFinite(lastPrice)
    ? lastPrice
    : Number.isFinite(mid)
      ? mid
      : Number.isFinite(ask)
        ? ask
        : null;
  if (!Number.isFinite(cleanPrice)) return null;

  const couponRate = parseNumber(detail?.details?.couponInfo?.couponRate ?? bond.CouponRate) || 0;
  const frequency = parseNumber(detail?.details?.couponInfo?.interestFrequency) || 1;
  const settlementRaw = market.MarketDate ?? market.LatestTradeDate ?? bond.MarketDate;
  const settlementDate = startOfDay(parseDateValue(settlementRaw) || new Date());
  const maturityDate = parseDateValue(
    detail?.details?.maturity ?? detail?.overview?.maturityDate ?? bond.MaturityDate
  );
  if (!maturityDate) return null;

  let accrualStart = parseDateValue(detail?.details?.couponInfo?.accruedInterestFromDate);
  if (!accrualStart) {
    const nextCouponSchedule = buildCashflowScheduleFromRedemption({
      redemptionDate: maturityDate,
      frequency,
      notional: 100,
      couponRate,
      settlementDate
    });
    if (nextCouponSchedule.length > 0) {
      const nextCouponDate = nextCouponSchedule[0].date;
      const monthsStep = Math.max(1, Math.round(12 / frequency));
      accrualStart = addMonths(nextCouponDate, -monthsStep);
    }
  }
  accrualStart = alignAccrualStart({
    accrualStart,
    settlementDate,
    frequency
  });

  const accrued = computeAccruedInterest({
    couponRate,
    notional: 100,
    accrualStart,
    settlementDate
  });
  const dirtyPrice = Number.isFinite(accrued) ? cleanPrice + accrued : cleanPrice;

  const maturitySchedule = buildCashflowScheduleFromRedemption({
    redemptionDate: maturityDate,
    frequency,
    notional: 100,
    couponRate,
    settlementDate
  });
  const maturityScenario = buildActualScenarioForSchedule({
    pricePer100: dirtyPrice,
    schedule: maturitySchedule,
    settlementDate,
    notional: 100,
    couponRate,
    taxRate: 0,
    fees: ZERO_FEES
  });
  let chosenScenario = maturityScenario;

  const callDate = parseDateValue(detail?.details?.earliestRedemptionDate);
  if (callDate && callDate > settlementDate) {
    const callSchedule = buildCashflowScheduleFromRedemption({
      redemptionDate: callDate,
      frequency,
      notional: 100,
      couponRate,
      settlementDate
    });
    const callScenario = buildActualScenarioForSchedule({
      pricePer100: dirtyPrice,
      schedule: callSchedule,
      settlementDate,
      notional: 100,
      couponRate,
      taxRate: 0,
      fees: ZERO_FEES
    });
    if (callScenario && Number.isFinite(callScenario.grossIrr)) {
      if (!chosenScenario || !Number.isFinite(chosenScenario.grossIrr)) {
        chosenScenario = callScenario;
      } else if (callScenario.grossIrr < chosenScenario.grossIrr) {
        chosenScenario = callScenario;
      }
    }
  }

  if (!chosenScenario || !Number.isFinite(chosenScenario.grossIrr)) return null;
  return { grossIrr: chosenScenario.grossIrr, askYield };
}

function computeDirtyYtwScenarioForBond({ bond, detail, taxRate, fees }) {
  if (!bond || !detail) return null;
  const market = detail?.market || {};
  const askYield = parseNumber(bond.YieldToWorst);
  if (!Number.isFinite(askYield)) return null;

  const lastPrice = parseNumber(
    market.PreviousClosingPrice ?? market.ClosingPrice ?? bond.ClosingPrice
  );
  const ask = parseNumber(market.AskPrice ?? bond.AskPrice);
  const bid = parseNumber(market.BidPrice ?? bond.BidPrice);
  const mid =
    Number.isFinite(ask) && Number.isFinite(bid) && ask > 0 && bid > 0
      ? (ask + bid) / 2
      : null;
  const cleanPrice = Number.isFinite(lastPrice)
    ? lastPrice
    : Number.isFinite(mid)
      ? mid
      : Number.isFinite(ask)
        ? ask
        : null;
  if (!Number.isFinite(cleanPrice)) return null;

  const couponRate = parseNumber(detail?.details?.couponInfo?.couponRate ?? bond.CouponRate) || 0;
  const frequency = parseNumber(detail?.details?.couponInfo?.interestFrequency) || 1;
  const settlementRaw = market.MarketDate ?? market.LatestTradeDate ?? bond.MarketDate;
  const settlementDate = startOfDay(parseDateValue(settlementRaw) || new Date());
  const maturityDate = parseDateValue(
    detail?.details?.maturity ?? detail?.overview?.maturityDate ?? bond.MaturityDate
  );
  if (!maturityDate) return null;

  let accrualStart = parseDateValue(detail?.details?.couponInfo?.accruedInterestFromDate);
  if (!accrualStart) {
    const nextCouponSchedule = buildCashflowScheduleFromRedemption({
      redemptionDate: maturityDate,
      frequency,
      notional: 100,
      couponRate,
      settlementDate
    });
    if (nextCouponSchedule.length > 0) {
      const nextCouponDate = nextCouponSchedule[0].date;
      const monthsStep = Math.max(1, Math.round(12 / frequency));
      accrualStart = addMonths(nextCouponDate, -monthsStep);
    }
  }
  accrualStart = alignAccrualStart({
    accrualStart,
    settlementDate,
    frequency
  });

  const accrued = computeAccruedInterest({
    couponRate,
    notional: 100,
    accrualStart,
    settlementDate
  });
  const dirtyPrice = Number.isFinite(accrued) ? cleanPrice + accrued : cleanPrice;

  const maturitySchedule = buildCashflowScheduleFromRedemption({
    redemptionDate: maturityDate,
    frequency,
    notional: 100,
    couponRate,
    settlementDate
  });
  const maturityScenario = buildActualScenarioForSchedule({
    pricePer100: dirtyPrice,
    schedule: maturitySchedule,
    settlementDate,
    notional: 100,
    couponRate,
    taxRate: taxRate || 0,
    fees: fees || ZERO_FEES
  });
  let chosenScenario = maturityScenario;

  const callDate = parseDateValue(detail?.details?.earliestRedemptionDate);
  if (callDate && callDate > settlementDate) {
    const callSchedule = buildCashflowScheduleFromRedemption({
      redemptionDate: callDate,
      frequency,
      notional: 100,
      couponRate,
      settlementDate
    });
    const callScenario = buildActualScenarioForSchedule({
      pricePer100: dirtyPrice,
      schedule: callSchedule,
      settlementDate,
      notional: 100,
      couponRate,
      taxRate: taxRate || 0,
      fees: fees || ZERO_FEES
    });
    if (callScenario && Number.isFinite(callScenario.grossIrr)) {
      if (!chosenScenario || !Number.isFinite(chosenScenario.grossIrr)) {
        chosenScenario = callScenario;
      } else if (callScenario.grossIrr < chosenScenario.grossIrr) {
        chosenScenario = callScenario;
      }
    }
  }

  if (!chosenScenario || !Number.isFinite(chosenScenario.grossIrr)) return null;

  return {
    scenario: chosenScenario,
    askYield,
    cleanPrice,
    dirtyPrice,
    accrued,
    settlementDate,
    callDate,
    maturityDate
  };
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

function ScatterPlot({ data, onPointClick, yLabel = "Ask yield (%)" }) {
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
        {yLabel}
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
              {`${yLabel.replace(" (%)", "")}: ${hovered.askYield.toFixed(2)}%`}
            </tspan>
          </text>
        </g>
      ) : null}
    </svg>
  );
}

function RatingScatterPlot({ data, onPointClick, xLabel, yLabel }) {
  const [hovered, setHovered] = useState(null);
  const [mouse, setMouse] = useState(null);
  const width = 800;
  const height = 320;
  const padding = { left: 60, right: 20, top: 20, bottom: 50 };
  const { points, xMin, xMax, yMin, yMax, ticks } = data;

  const xScale = (value) =>
    padding.left +
    ((value - xMin) / (xMax - xMin)) * (width - padding.left - padding.right);
  const yScale = (value) =>
    height -
    padding.bottom -
    ((value - yMin) / (yMax - yMin)) * (height - padding.top - padding.bottom);

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const value = yMin + ((yMax - yMin) / 4) * i;
    return { value, y: yScale(value) };
  });
  const xTicks = ticks.map((tick) => ({
    ...tick,
    x: xScale(tick.rank)
  }));

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
        <g key={`x-${tick.rank}`}>
          <line
            x1={tick.x}
            y1={height - padding.bottom}
            x2={tick.x}
            y2={height - padding.bottom + 6}
            className="tick"
          />
          <text x={tick.x} y={height - padding.bottom + 22} textAnchor="middle">
            {tick.label}
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
        {xLabel}
      </text>
      <text
        x={18}
        y={(height + padding.top - padding.bottom) / 2}
        textAnchor="middle"
        transform={`rotate(-90 18 ${(height + padding.top - padding.bottom) / 2})`}
        className="axis-label"
      >
        {yLabel}
      </text>
      {points.map((point) => (
        <circle
          key={`${point.bond.ValorId}-${point.rating}`}
          cx={xScale(point.ratingRank)}
          cy={yScale(point.afterTax)}
          r={hovered?.bond?.ValorId === point.bond.ValorId ? 6 : 4.5}
          className={`chart-point${
            hovered?.bond?.ValorId === point.bond.ValorId ? " is-hovered" : ""
          }`}
          onClick={() => onPointClick(point.bond)}
          onMouseEnter={() =>
            setHovered({
              ...point,
              x: xScale(point.ratingRank),
              y: yScale(point.afterTax)
            })
          }
          onMouseLeave={() => setHovered(null)}
        >
          <title>
            {`${point.bond.ShortName || "Bond"} • ${point.rating} • ${point.afterTax.toFixed(2)}%`}
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
              {`S&P: ${hovered.rating}`}
            </tspan>
            <tspan x={tooltip.x + 12} dy={18}>
              {`${yLabel.replace(" (%)", "")}: ${hovered.afterTax.toFixed(2)}%`}
            </tspan>
          </text>
        </g>
      ) : null}
    </svg>
  );
}

function XYScatterPlot({ data, onPointClick, xLabel, yLabel }) {
  const [hovered, setHovered] = useState(null);
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

  const tooltip = hovered
    ? {
        width: 220,
        height: 64,
        x: Math.min(
          width - padding.right - 220,
          Math.max(padding.left, hovered.screenX + 12)
        ),
        y: Math.min(
          height - padding.bottom - 64,
          Math.max(padding.top, hovered.screenY - 12 - 64)
        )
      }
    : null;

  return (
    <svg
      className="scatter"
      viewBox={`0 0 ${width} ${height}`}
      onMouseLeave={() => setHovered(null)}
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
            {tick.value.toFixed(2)}
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
        {xLabel}
      </text>
      <text
        x={18}
        y={(height + padding.top - padding.bottom) / 2}
        textAnchor="middle"
        transform={`rotate(-90 18 ${(height + padding.top - padding.bottom) / 2})`}
        className="axis-label"
      >
        {yLabel}
      </text>
      {points.map((point) => (
        <circle
          key={point.bond.ValorId}
          cx={xScale(point.x)}
          cy={yScale(point.y)}
          r={hovered?.bond?.ValorId === point.bond.ValorId ? 6 : 4.5}
          className={`chart-point${
            hovered?.bond?.ValorId === point.bond.ValorId ? " is-hovered" : ""
          }`}
          onClick={() => onPointClick(point.bond)}
          onMouseEnter={() =>
            setHovered({
              ...point,
              screenX: xScale(point.x),
              screenY: yScale(point.y)
            })
          }
        >
          <title>
            {`${point.bond.ShortName || "Bond"} • ${point.x.toFixed(
              2
            )}% • ${point.y.toFixed(2)}%`}
          </title>
        </circle>
      ))}
      {hovered && tooltip ? (
        <g className="tooltip" pointerEvents="none">
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
              {`${xLabel.replace(" (%)", "")}: ${hovered.x.toFixed(2)}%`}
            </tspan>
            <tspan x={tooltip.x + 12} dy={18}>
              {`${yLabel.replace(" (%)", "")}: ${hovered.y.toFixed(2)}%`}
            </tspan>
          </text>
        </g>
      ) : null}
    </svg>
  );
}

function ViolinPlot({ data, onPointClick, yLabel }) {
  const [hovered, setHovered] = useState(null);
  const width = 800;
  const height = 320;
  const padding = { left: 60, right: 40, top: 20, bottom: 50 };
  const { points, yMin, yMax } = data;
  const plotWidth = width - padding.left - padding.right;
  const centerX = padding.left + plotWidth / 2;

  const values = points.map((point) => point.spread);
  const n = values.length;
  const mean =
    n > 0 ? values.reduce((total, value) => total + value, 0) / n : 0;
  const variance =
    n > 1
      ? values.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  const range = yMax - yMin || 1;
  const bandwidth =
    stdDev > 0
      ? 1.06 * stdDev * Math.pow(n, -0.2)
      : range / 6 || 1;

  const densityAt = (value) => {
    if (n === 0) return 0;
    const denom = bandwidth * Math.sqrt(2 * Math.PI);
    const total = values.reduce((sum, sample) => {
      const u = (value - sample) / bandwidth;
      return sum + Math.exp(-0.5 * u * u);
    }, 0);
    return total / (n * denom);
  };

  const sampleCount = 60;
  const densitySamples = Array.from({ length: sampleCount }, (_, i) => {
    const value = yMin + (range / (sampleCount - 1)) * i;
    return { value, density: densityAt(value) };
  });
  const maxDensity = Math.max(0.0001, ...densitySamples.map((d) => d.density));
  const maxWidth = plotWidth / 2 - 24;

  const yScale = (value) =>
    height -
    padding.bottom -
    ((value - yMin) / (yMax - yMin)) * (height - padding.top - padding.bottom);

  const leftPath = densitySamples
    .map((sample, index) => {
      const widthOffset = (sample.density / maxDensity) * maxWidth;
      const x = centerX - widthOffset;
      const y = yScale(sample.value);
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");

  const rightPath = densitySamples
    .slice()
    .reverse()
    .map((sample) => {
      const widthOffset = (sample.density / maxDensity) * maxWidth;
      const x = centerX + widthOffset;
      const y = yScale(sample.value);
      return `L ${x} ${y}`;
    })
    .join(" ");

  const violinPath = points.length > 0 ? `${leftPath} ${rightPath} Z` : "";

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const value = yMin + ((yMax - yMin) / 4) * i;
    return { value, y: yScale(value) };
  });

  const jitterFromSeed = (seed) => {
    let hash = 0;
    const str = String(seed);
    for (let i = 0; i < str.length; i += 1) {
      hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    const normalized = ((hash >>> 0) % 1000) / 1000 - 0.5;
    return normalized;
  };

  const tooltip = hovered
    ? {
        width: 240,
        height: 72,
        x: Math.min(
          width - padding.right - 240,
          Math.max(padding.left, hovered.screenX + 12)
        ),
        y: Math.min(
          height - padding.bottom - 72,
          Math.max(padding.top, hovered.screenY - 12 - 72)
        )
      }
    : null;

  return (
    <svg
      className="scatter"
      viewBox={`0 0 ${width} ${height}`}
      onMouseLeave={() => setHovered(null)}
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
            {tick.value.toFixed(3)}
          </text>
        </g>
      ))}
      <text
        x={(width + padding.left - padding.right) / 2}
        y={height - 10}
        textAnchor="middle"
        className="axis-label"
      >
        Density
      </text>
      <text
        x={18}
        y={(height + padding.top - padding.bottom) / 2}
        textAnchor="middle"
        transform={`rotate(-90 18 ${(height + padding.top - padding.bottom) / 2})`}
        className="axis-label"
      >
        {yLabel}
      </text>
      {violinPath ? <path d={violinPath} className="violin-shape" /> : null}
      {points.map((point) => {
        const density = densityAt(point.spread);
        const widthOffset = (density / maxDensity) * maxWidth;
        const jitter = jitterFromSeed(point.bond.ValorId || point.spread) * widthOffset;
        const x = centerX + jitter;
        const y = yScale(point.spread);
        return (
          <circle
            key={point.bond.ValorId}
            cx={x}
            cy={y}
            r={hovered?.bond?.ValorId === point.bond.ValorId ? 6 : 4.5}
            className={`chart-point${
              hovered?.bond?.ValorId === point.bond.ValorId ? " is-hovered" : ""
            }`}
            onClick={() => onPointClick(point.bond)}
            onMouseEnter={() =>
              setHovered({
                ...point,
                screenX: x,
                screenY: y
              })
            }
          >
            <title>
              {`${point.bond.ShortName || "Bond"} • ${formatNumber(point.spread, 4)}`}
            </title>
          </circle>
        );
      })}
      {hovered && tooltip ? (
        <g className="tooltip" pointerEvents="none">
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
              {`Avg spread (last ${hovered.sampleSize} days): ${formatNumber(
                hovered.spread,
                4
              )}`}
            </tspan>
            <tspan x={tooltip.x + 12} dy={18}>
              {hovered.bond.IssuerNameFull || ""}
            </tspan>
          </text>
        </g>
      ) : null}
    </svg>
  );
}

function CurveChart({ points, govPoints, govFits, onPointClick }) {
  const [hovered, setHovered] = useState(null);
  const width = 800;
  const height = 240;
  const padding = { left: 60, right: 20, top: 20, bottom: 50 };
  const sorted = [...points].sort((a, b) => a.years - b.years);
  const govSorted = Array.isArray(govPoints)
    ? [...govPoints].sort((a, b) => a.years - b.years)
    : [];

  const fitSpline = govFits?.spline || [];
  const fitNelson = govFits?.nelson_siegel || [];
  const xValues = [
    ...sorted.map((point) => point.years),
    ...govSorted.map((point) => point.years),
    ...fitSpline.map((point) => point.years),
    ...fitNelson.map((point) => point.years)
  ];
  const yValues = [
    ...sorted.map((point) => point.yield),
    ...govSorted.map((point) => point.yield),
    ...fitSpline.map((point) => point.yield),
    ...fitNelson.map((point) => point.yield)
  ];
  let xMin = xValues.length ? Math.min(...xValues) : 0;
  let xMax = xValues.length ? Math.max(...xValues) : 1;
  let yMin = yValues.length ? Math.min(...yValues) : 0;
  let yMax = yValues.length ? Math.max(...yValues) : 1;
  xMin = Math.min(0, xMin);
  yMax = Math.max(yMax, 0.8);
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

  const govPath =
    govSorted.length > 1
      ? govSorted
          .map((point, index) => {
            const x = xScale(point.years);
            const y = yScale(point.yield);
            return `${index === 0 ? "M" : "L"} ${x} ${y}`;
          })
          .join(" ")
      : "";
  const splinePath =
    fitSpline.length > 1
      ? fitSpline
          .map((point, index) => {
            const x = xScale(point.years);
            const y = yScale(point.yield);
            return `${index === 0 ? "M" : "L"} ${x} ${y}`;
          })
          .join(" ")
      : "";
  const nelsonPath =
    fitNelson.length > 1
      ? fitNelson
          .map((point, index) => {
            const x = xScale(point.years);
            const y = yScale(point.yield);
            return `${index === 0 ? "M" : "L"} ${x} ${y}`;
          })
          .join(" ")
      : "";

  const tooltip = hovered
    ? {
        width: 240,
        height: 72,
        x: Math.min(
          width - padding.right - 240,
          Math.max(padding.left, hovered.x + 12)
        ),
        y: Math.min(
          height - padding.bottom - 72,
          Math.max(padding.top, hovered.y - 12 - 72)
        )
      }
    : null;

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
      <path d={path} className="curve-line snb" />
      {govPath ? <path d={govPath} className="curve-line gov" /> : null}
      {splinePath ? <path d={splinePath} className="curve-line spline" /> : null}
      {nelsonPath ? <path d={nelsonPath} className="curve-line nelson" /> : null}
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
      {govSorted.map((point, index) => {
        const bondPayload = point.valor_id
          ? {
              ValorId: point.valor_id,
              ShortName: point.short_name,
              MaturityDate: point.maturity,
              IssuerNameFull: point.issuer,
              YieldToWorst: point.yield
            }
          : null;
        const x = xScale(point.years);
        const y = yScale(point.yield);
        return (
          <circle
            key={`${point.years}-${index}`}
            cx={x}
            cy={y}
            r={hovered?.valor_id === point.valor_id ? 5.5 : 3.6}
            className={`curve-point gov${hovered?.valor_id === point.valor_id ? " is-hovered" : ""}`}
            onClick={() => {
              if (bondPayload && onPointClick) onPointClick(bondPayload);
            }}
            onMouseEnter={() => {
              setHovered({
                ...point,
                x,
                y
              });
            }}
            onMouseLeave={() => setHovered(null)}
          >
            <title>{`${point.short_name || "Gov bond"} • ${point.yield.toFixed(2)}%`}</title>
          </circle>
        );
      })}
      {hovered && tooltip ? (
        <g className="tooltip" pointerEvents="none">
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
              {hovered.short_name || hovered.isin || "Government bond"}
            </tspan>
            <tspan x={tooltip.x + 12} dy={18}>
              {`${hovered.yield.toFixed(2)}% • ${hovered.years.toFixed(1)}y`}
            </tspan>
            <tspan x={tooltip.x + 12} dy={18}>
              {hovered.source ? `Source: ${hovered.source}` : ""}
            </tspan>
          </text>
        </g>
      ) : null}
    </svg>
  );
}

export default function App() {
  const [view, setView] = useState("search");
  const [filters, setFilters] = useState({
    maturityBucket: "2-3",
    currency: "CHF",
    country: "CH",
    industrySector: ""
  });
  const [sortState, setSortState] = useState({ key: "MaturityDate", dir: "asc" });
  const [pageSize, setPageSize] = useState(50);
  const [bonds, setBonds] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showChart, setShowChart] = useState(false);
  const [curve, setCurve] = useState(null);
  const [curveLoading, setCurveLoading] = useState(false);
  const [curveError, setCurveError] = useState("");
  const [govCurve, setGovCurve] = useState(null);
  const [govCurveLoading, setGovCurveLoading] = useState(false);
  const [govCurveError, setGovCurveError] = useState("");
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

  const sectorOptions = useMemo(() => {
    const values = new Set();
    bonds.forEach((bond) => {
      if (bond?.IndustrySectorCode || bond?.IndustrySectorDesc) {
        const code = bond.IndustrySectorCode ? String(bond.IndustrySectorCode) : "";
        const desc = bond.IndustrySectorDesc ? String(bond.IndustrySectorDesc) : "";
        values.add(code && desc ? `${code} - ${desc}` : desc || code);
      }
    });
    if (filters.industrySector) {
      values.add(String(filters.industrySector));
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b, "en"));
  }, [bonds, filters.industrySector]);

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
  const [grossIrrChartDetails, setGrossIrrChartDetails] = useState({});
  const [grossIrrChartLoading, setGrossIrrChartLoading] = useState(false);
  const [grossIrrChartError, setGrossIrrChartError] = useState("");

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

  useEffect(() => {
    const loadGovCurve = async () => {
      setGovCurveLoading(true);
      setGovCurveError("");
      try {
        const data = await fetchGovBondCurve();
        setGovCurve(data);
      } catch (err) {
        setGovCurveError(err.message || "Failed to load government bond curve.");
      } finally {
        setGovCurveLoading(false);
      }
    };
    loadGovCurve();
  }, []);

  const afterTaxYieldMap = useMemo(() => {
    const map = {};
    const tax = Number.isFinite(taxRate) ? taxRate : 0;
    bonds.forEach((bond) => {
      const detailEntry = grossIrrChartDetails[bond.ValorId];
      if (!detailEntry || detailEntry.error) return;
      const result = computeDirtyYtwScenarioForBond({
        bond,
        detail: detailEntry,
        taxRate: tax / 100,
        fees: ZERO_FEES
      });
      if (!result || !Number.isFinite(result.scenario?.taxIrr)) return;

      const tooltip = [
        `Price basis: dirty (${formatNumber(result.dirtyPrice, 4)}), clean ${formatNumber(
          result.cleanPrice,
          4
        )}`,
        `Accrued interest (30E/360): ${formatNumber(result.accrued, 4)}`,
        `Settlement: ${formatDateYMD(result.settlementDate)}`,
        `Call date: ${formatDateYMD(result.callDate) || "-"}`,
        `Tax rate: ${formatNumber(tax, 1)}%`,
        "After-tax IRR uses actual cashflow timing + YTW (call vs maturity)."
      ].join("\n");

      map[bond.ValorId] = { yield: result.scenario.taxIrr, tooltip };
    });
    return map;
  }, [bonds, taxRate, grossIrrChartDetails]);

  const impliedGovSpreadMap = useMemo(() => {
    const map = {};
    const fitPoints = govCurve?.fits?.spline?.length
      ? govCurve.fits.spline
      : govCurve?.points || [];
    if (!fitPoints || fitPoints.length === 0) return map;
    bonds.forEach((bond) => {
      const years = maturityYearsFromValue(bond.MaturityDate);
      const yieldToWorst = parseNumber(bond.YieldToWorst);
      if (!Number.isFinite(years) || !Number.isFinite(yieldToWorst)) return;
      const govYield = interpolateCurveYield(fitPoints, years);
      if (!Number.isFinite(govYield)) return;
      map[bond.ValorId] = {
        spread: (yieldToWorst - govYield) * 100,
        govYield,
        yieldToWorst,
        source: govCurve?.fits?.spline?.length ? "PCHIP fit" : "implied points"
      };
    });
    return map;
  }, [bonds, govCurve]);

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
      const sectorCode = filters.industrySector
        ? String(filters.industrySector).split("-")[0].trim()
        : "";
      const response = await fetchBonds({
        maturityBucket: filters.maturityBucket,
        currency: filters.currency,
        country: filters.country,
        industrySector: sectorCode,
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

  const getIssuerRatingInfo = (issuerName) => {
    if (!issuerName) return { status: "missing", values: [], rank: null };
    const entry = issuerTableEnrichment[issuerName];
    const status = entry?.status;
    if (!entry || status === "missing" || status === "idle") {
      return { status: "missing", values: [], rank: null };
    }
    if (status === "loading" || status === "queued") {
      return { status: "loading", values: [], rank: null };
    }
    if (status === "error") {
      return { status: "error", values: [], rank: null };
    }
    const moodys = normalizeMoodysRating(entry?.enrichment?.moodys);
    const fitch = normalizeSpFitchRating(entry?.enrichment?.fitch);
    const sp = normalizeSpFitchRating(entry?.enrichment?.sp);
    const rankCandidates = [
      moodysRatingRank(entry?.enrichment?.moodys),
      spFitchRatingRank(entry?.enrichment?.fitch),
      spFitchRatingRank(entry?.enrichment?.sp)
    ].filter((rank) => rank !== null);
    const values = [
      moodys ? { agency: "Moody's", value: moodys } : null,
      fitch ? { agency: "Fitch", value: fitch } : null,
      sp ? { agency: "S&P", value: sp } : null
    ].filter(Boolean);
    return {
      status: "ready",
      values,
      rank: rankCandidates.length ? Math.min(...rankCandidates) : null
    };
  };

  const sortedBonds = useMemo(() => {
    if (!sortState.key) return bonds;
    const direction = sortState.dir === "asc" ? 1 : -1;
    const stringKeys = new Set(["IssuerNameFull", "ShortName", "IndustrySectorDesc"]);

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
        case "IndustrySectorDesc":
          return bond.IndustrySectorDesc || bond.IndustrySectorCode || "";
        case "YieldToWorst":
          return parseNumber(bond.YieldToWorst);
        case "AskPrice":
          return parseNumber(bond.AskPrice);
        case "BidPrice":
          return parseNumber(bond.BidPrice);
        case "ImpliedGovSpreadBps":
          return parseNumber(impliedGovSpreadMap[bond.ValorId]?.spread);
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
        case "IssuerRating": {
          const issuerName = bond.IssuerNameFull || "";
          const ratingInfo = getIssuerRatingInfo(issuerName);
          return ratingInfo.rank;
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
  }, [
    bonds,
    sortState,
    volumes,
    afterTaxYieldMap,
    issuerTableEnrichment,
    impliedGovSpreadMap
  ]);

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

  const afterTaxChartData = useMemo(() => {
    const points = bonds
      .map((bond) => {
        const years = maturityYearsFromValue(bond.MaturityDate);
        if (!Number.isFinite(years)) return null;
        const afterTax = parseNumber(afterTaxYieldMap[bond.ValorId]?.yield);
        if (!Number.isFinite(afterTax)) return null;
        return { years, askYield: afterTax, bond };
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
  }, [bonds, afterTaxYieldMap]);

  const ratingChartData = useMemo(() => {
    const points = bonds
      .map((bond) => {
        const issuerName = bond.IssuerNameFull || "";
        if (!issuerName) return null;
        const entry = issuerTableEnrichment[issuerName];
        if (!entry || entry.status !== "ready") return null;
        const spRaw = entry?.enrichment?.sp;
        const rating = normalizeSpFitchRating(spRaw);
        if (!rating) return null;
        const ratingRank = spFitchRatingRank(rating);
        if (!Number.isFinite(ratingRank)) return null;
        const afterTax = parseNumber(afterTaxYieldMap[bond.ValorId]?.yield);
        if (!Number.isFinite(afterTax)) return null;
        return { rating, ratingRank, afterTax, bond };
      })
      .filter(Boolean);

    if (points.length === 0) {
      return { points: [], xMin: 0, xMax: 1, yMin: 0, yMax: 1, ticks: [] };
    }

    const xValues = points.map((p) => p.ratingRank);
    const yValues = points.map((p) => p.afterTax);
    let xMin = Math.min(...xValues);
    let xMax = Math.max(...xValues);
    let yMin = Math.min(...yValues);
    let yMax = Math.max(...yValues);
    if (xMin === xMax) {
      xMin = Math.max(1, xMin - 1);
      xMax = xMax + 1;
    }
    if (yMin === yMax) {
      yMin = yMin - 1;
      yMax = yMax + 1;
    }

    const ticks = Array.from(
      new Map(
        points
          .map((point) => [point.ratingRank, point.rating])
          .sort((a, b) => a[0] - b[0])
      )
    ).map(([rank, label]) => ({ rank, label }));

    return { points, xMin, xMax, yMin, yMax, ticks };
  }, [bonds, issuerTableEnrichment, afterTaxYieldMap]);

  useEffect(() => {
    if (bonds.length === 0) return;
    const missing = bonds
      .filter((bond) => bond?.ValorId)
      .filter((bond) => !grossIrrChartDetails[bond.ValorId])
      .map((bond) => bond.ValorId);
    if (missing.length === 0) return;

    let active = true;
    setGrossIrrChartLoading(true);
    setGrossIrrChartError("");

    Promise.all(
      missing.map(async (valorId) => {
        try {
          const data = await fetchBondDetails(valorId);
          return { valorId, data };
        } catch (err) {
          return { valorId, error: err };
        }
      })
    )
      .then((results) => {
        if (!active) return;
        setGrossIrrChartDetails((prev) => {
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
          setGrossIrrChartError(
            "Some bonds could not be enriched for gross IRR. Plot uses available data."
          );
        }
      })
      .finally(() => {
        if (active) setGrossIrrChartLoading(false);
      });

    return () => {
      active = false;
    };
  }, [showChart, view, bonds, grossIrrChartDetails]);

  const ratingAskChartData = useMemo(() => {
    const points = bonds
      .map((bond) => {
        const issuerName = bond.IssuerNameFull || "";
        if (!issuerName) return null;
        const entry = issuerTableEnrichment[issuerName];
        if (!entry || entry.status !== "ready") return null;
        const spRaw = entry?.enrichment?.sp;
        const rating = normalizeSpFitchRating(spRaw);
        if (!rating) return null;
        const ratingRank = spFitchRatingRank(rating);
        if (!Number.isFinite(ratingRank)) return null;
        const askYield = parseNumber(bond.YieldToWorst);
        if (!Number.isFinite(askYield)) return null;
        return { rating, ratingRank, afterTax: askYield, bond };
      })
      .filter(Boolean);

    if (points.length === 0) {
      return { points: [], xMin: 0, xMax: 1, yMin: 0, yMax: 1, ticks: [] };
    }

    const xValues = points.map((p) => p.ratingRank);
    const yValues = points.map((p) => p.afterTax);
    let xMin = Math.min(...xValues);
    let xMax = Math.max(...xValues);
    let yMin = Math.min(...yValues);
    let yMax = Math.max(...yValues);
    if (xMin === xMax) {
      xMin = Math.max(1, xMin - 1);
      xMax = xMax + 1;
    }
    if (yMin === yMax) {
      yMin = yMin - 1;
      yMax = yMax + 1;
    }

    const ticks = Array.from(
      new Map(
        points
          .map((point) => [point.ratingRank, point.rating])
          .sort((a, b) => a[0] - b[0])
      )
    ).map(([rank, label]) => ({ rank, label }));

    return { points, xMin, xMax, yMin, yMax, ticks };
  }, [bonds, issuerTableEnrichment]);

  const grossIrrAskYieldChart = useMemo(() => {
    const points = bonds
      .map((bond) => {
        const detailEntry = grossIrrChartDetails[bond.ValorId];
        if (!detailEntry || detailEntry.error) return null;
        const metrics = computeActualGrossIrrForBond({
          bond,
          detail: detailEntry
        });
        if (!metrics || !Number.isFinite(metrics.grossIrr)) return null;
        if (!Number.isFinite(metrics.askYield)) return null;
        return {
          x: metrics.grossIrr,
          y: metrics.askYield,
          bond
        };
      })
      .filter(Boolean);

    if (points.length === 0) {
      return { points: [], xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
    }

    const xValues = points.map((p) => p.x);
    const yValues = points.map((p) => p.y);
    let xMin = Math.min(...xValues);
    let xMax = Math.max(...xValues);
    let yMin = Math.min(...yValues);
    let yMax = Math.max(...yValues);
    if (xMin === xMax) {
      xMin = xMin - 1;
      xMax = xMax + 1;
    }
    if (yMin === yMax) {
      yMin = yMin - 1;
      yMax = yMax + 1;
    }

    return { points, xMin, xMax, yMin, yMax };
  }, [bonds, grossIrrChartDetails]);

  const liquidityViolinData = useMemo(() => {
    const points = bonds
      .map((bond) => {
        const detailEntry = grossIrrChartDetails[bond.ValorId];
        if (!detailEntry || detailEntry.error) return null;
        const average = computeAverageLiquiditySpread(detailEntry.liquidity);
        if (!average || !Number.isFinite(average.average)) return null;
        return {
          spread: average.average,
          sampleSize: average.sampleSize,
          bond
        };
      })
      .filter(Boolean);

    if (points.length === 0) {
      return { points: [], yMin: 0, yMax: 1 };
    }

    const yValues = points.map((point) => point.spread);
    let yMin = Math.min(...yValues);
    let yMax = Math.max(...yValues);
    if (yMin === yMax) {
      yMin = Math.max(0, yMin - 0.5);
      yMax = yMax + 0.5;
    }
    return { points, yMin, yMax };
  }, [bonds, grossIrrChartDetails]);

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

  const actualYieldMetrics = useMemo(() => {
    if (!selected) return null;
    const priceCandidates = [
      { label: "last price", value: pricing.lastPrice },
      { label: "mid price", value: pricing.mid },
      { label: "ask price", value: pricing.ask }
    ];
    const chosen = priceCandidates.find((item) => Number.isFinite(item.value));
    if (!chosen) return null;

    const cleanPrice = chosen.value;
    const priceLabel = chosen.label;
    const couponRate = bondInputs.couponRate || 0;
    const frequency = bondInputs.frequency || 1;
    const settlementRaw =
      detail?.market?.MarketDate ?? detail?.market?.LatestTradeDate ?? null;
    const settlementDate = startOfDay(parseDateValue(settlementRaw) || new Date());
    const maturityRaw =
      detail?.details?.maturity ??
      detail?.overview?.maturityDate ??
      selected?.MaturityDate;
    const maturityDate = parseDateValue(maturityRaw);
    if (!maturityDate) return null;

    const accrualStartRaw = detail?.details?.couponInfo?.accruedInterestFromDate;
    let accrualStart = parseDateValue(accrualStartRaw);
    if (!accrualStart) {
      const nextCouponSchedule = buildCashflowScheduleFromRedemption({
        redemptionDate: maturityDate,
        frequency,
        notional: 100,
        couponRate,
        settlementDate
      });
      if (nextCouponSchedule.length > 0) {
        const nextCouponDate = nextCouponSchedule[0].date;
        const monthsStep = Math.max(1, Math.round(12 / frequency));
        accrualStart = addMonths(nextCouponDate, -monthsStep);
      }
    }
    accrualStart = alignAccrualStart({
      accrualStart,
      settlementDate,
      frequency
    });

    const accrued = computeAccruedInterest({
      couponRate,
      notional: 100,
      accrualStart,
      settlementDate
    });
    const dirtyPrice = Number.isFinite(accrued) ? cleanPrice + accrued : null;

    const maturitySchedule = buildCashflowScheduleFromRedemption({
      redemptionDate: maturityDate,
      frequency,
      notional: 100,
      couponRate,
      settlementDate
    });
    const cleanYtm = computeYieldFromSchedule({
      price: cleanPrice,
      schedule: maturitySchedule,
      settlementDate
    });
    const dirtyYtm = Number.isFinite(dirtyPrice)
      ? computeYieldFromSchedule({
          price: dirtyPrice,
          schedule: maturitySchedule,
          settlementDate
        })
      : null;

    const callRaw = detail?.details?.earliestRedemptionDate;
    const callDate = parseDateValue(callRaw);
    let cleanYtw = cleanYtm;
    let dirtyYtw = dirtyYtm;
    if (callDate && callDate > settlementDate) {
      const callSchedule = buildCashflowScheduleFromRedemption({
        redemptionDate: callDate,
        frequency,
        notional: 100,
        couponRate,
        settlementDate
      });
      const cleanYtc = computeYieldFromSchedule({
        price: cleanPrice,
        schedule: callSchedule,
        settlementDate
      });
      const dirtyYtc = Number.isFinite(dirtyPrice)
        ? computeYieldFromSchedule({
            price: dirtyPrice,
            schedule: callSchedule,
            settlementDate
          })
        : null;
      cleanYtw = minIgnoreNull(cleanYtc, cleanYtm);
      dirtyYtw = minIgnoreNull(dirtyYtc, dirtyYtm);
    }

    return {
      priceLabel,
      cleanPrice,
      dirtyPrice,
      accrued,
      settlementDate,
      maturityDate,
      callDate,
      cleanYtm,
      dirtyYtm,
      cleanYtw,
      dirtyYtw
    };
  }, [selected, pricing, bondInputs, detail]);

  const govCurveYield = useMemo(() => {
    if (!curve?.points || !Number.isFinite(bondInputs.years)) return null;
    return interpolateCurveYield(curve.points, bondInputs.years);
  }, [curve, bondInputs.years]);

  const impliedGovCurveYield = useMemo(() => {
    if (!Number.isFinite(bondInputs.years)) return null;
    const fitPoints = govCurve?.fits?.spline?.length
      ? govCurve.fits.spline
      : govCurve?.points || [];
    if (!fitPoints || fitPoints.length === 0) return null;
    return interpolateCurveYield(fitPoints, bondInputs.years);
  }, [govCurve, bondInputs.years]);

  const govSpreadByYtw = useMemo(() => {
    if (!Number.isFinite(pricing.yieldToWorst) || !Number.isFinite(govCurveYield)) {
      return null;
    }
    return (pricing.yieldToWorst - govCurveYield) * 100;
  }, [pricing.yieldToWorst, govCurveYield]);

  const govSpreadBySchedule = useMemo(() => {
    const scheduleYield =
      actualYieldMetrics?.dirtyYtw ??
      actualYieldMetrics?.dirtyYtm ??
      actualYieldMetrics?.cleanYtw ??
      actualYieldMetrics?.cleanYtm;
    if (!Number.isFinite(scheduleYield) || !Number.isFinite(govCurveYield)) {
      return null;
    }
    return (scheduleYield - govCurveYield) * 100;
  }, [actualYieldMetrics, govCurveYield]);

  const impliedGovSpreadByYtw = useMemo(() => {
    if (!Number.isFinite(pricing.yieldToWorst) || !Number.isFinite(impliedGovCurveYield)) {
      return null;
    }
    return (pricing.yieldToWorst - impliedGovCurveYield) * 100;
  }, [pricing.yieldToWorst, impliedGovCurveYield]);

  const impliedGovSpreadTooltip = useMemo(() => {
    return formatImpliedGovSpreadTooltip({
      yieldToWorst: pricing.yieldToWorst,
      govYield: impliedGovCurveYield,
      source: govCurve?.fits?.spline?.length ? "PCHIP fit" : "implied points"
    });
  }, [pricing.yieldToWorst, impliedGovCurveYield, govCurve]);

  const govSpreadByYtwTooltip = useMemo(() => {
    if (!Number.isFinite(govCurveYield)) return "Curve yield unavailable.";
    return [
      `YieldToWorst (SIX): ${formatPercent(pricing.yieldToWorst, 2)}`,
      `Gov curve yield: ${formatPercent(govCurveYield, 2)}`,
      `Curve date: ${curve?.latest_date || "-"}`,
      "Spread = (YieldToWorst - gov curve)."
    ].join("\n");
  }, [pricing.yieldToWorst, govCurveYield, curve?.latest_date]);

  const govSpreadByScheduleTooltip = useMemo(() => {
    if (!actualYieldMetrics) return "Schedule-based yield unavailable.";
    const scheduleYield =
      actualYieldMetrics.dirtyYtw ??
      actualYieldMetrics.dirtyYtm ??
      actualYieldMetrics.cleanYtw ??
      actualYieldMetrics.cleanYtm;
    return [
      `Price basis: ${actualYieldMetrics.priceLabel || "-"}`,
      `Clean: ${formatNumber(actualYieldMetrics.cleanPrice, 2)} / Dirty: ${formatNumber(
        actualYieldMetrics.dirtyPrice,
        4
      )}`,
      `Schedule yield: ${formatPercent(scheduleYield, 2)}`,
      `Gov curve yield: ${formatPercent(govCurveYield, 2)}`,
      `Curve date: ${curve?.latest_date || "-"}`,
      "Spread = (schedule yield - gov curve)."
    ].join("\n");
  }, [actualYieldMetrics, govCurveYield, curve?.latest_date]);

  const actualTimingScenarioLast = useMemo(() => {
    if (!actualYieldMetrics) return null;
    const priceDirty = Number.isFinite(actualYieldMetrics.dirtyPrice)
      ? actualYieldMetrics.dirtyPrice
      : actualYieldMetrics.cleanPrice;
    if (!Number.isFinite(priceDirty) || !actualYieldMetrics.maturityDate) return null;

    const couponRate = bondInputs.couponRate || 0;
    const frequency = bondInputs.frequency || 1;
    const settlementDate = actualYieldMetrics.settlementDate;
    const maturitySchedule = buildCashflowScheduleFromRedemption({
      redemptionDate: actualYieldMetrics.maturityDate,
      frequency,
      notional,
      couponRate,
      settlementDate
    });
    const maturityScenario = buildActualScenarioForSchedule({
      pricePer100: priceDirty,
      schedule: maturitySchedule,
      settlementDate,
      notional,
      couponRate,
      taxRate: taxRate / 100,
      fees: feeInputs
    });

    let chosenScenario = maturityScenario;
    if (actualYieldMetrics.callDate && actualYieldMetrics.callDate > settlementDate) {
      const callSchedule = buildCashflowScheduleFromRedemption({
        redemptionDate: actualYieldMetrics.callDate,
        frequency,
        notional,
        couponRate,
        settlementDate
      });
      const callScenario = buildActualScenarioForSchedule({
        pricePer100: priceDirty,
        schedule: callSchedule,
        settlementDate,
        notional,
        couponRate,
        taxRate: taxRate / 100,
        fees: feeInputs
      });
      if (callScenario && Number.isFinite(callScenario.grossIrr)) {
        if (!chosenScenario || !Number.isFinite(chosenScenario.grossIrr)) {
          chosenScenario = callScenario;
        } else if (callScenario.grossIrr < chosenScenario.grossIrr) {
          chosenScenario = callScenario;
        }
      }
    }

    return chosenScenario;
  }, [actualYieldMetrics, bondInputs, notional, feeInputs, taxRate]);

  const riskFreeMetrics = useMemo(() => {
    if (!actualYieldMetrics || !selected) return null;
    const couponRate = bondInputs.couponRate || 0;
    const frequency = bondInputs.frequency || 1;
    const settlementDate = actualYieldMetrics.settlementDate;
    const maturityDate = actualYieldMetrics.maturityDate;
    if (!maturityDate || !settlementDate) return null;

    const pricePer100 = Number.isFinite(actualYieldMetrics.dirtyPrice)
      ? actualYieldMetrics.dirtyPrice
      : actualYieldMetrics.cleanPrice;
    if (!Number.isFinite(pricePer100)) return null;

    const schedule = buildCashflowScheduleFromRedemption({
      redemptionDate: maturityDate,
      frequency,
      notional: 100,
      couponRate,
      settlementDate
    });
    const yieldRate =
      actualYieldMetrics.dirtyYtm ??
      actualYieldMetrics.cleanYtm ??
      computeYieldFromSchedule({
        price: pricePer100,
        schedule,
        settlementDate
      });

    const duration = computeDurationFromSchedule({
      pricePer100,
      schedule,
      settlementDate,
      yieldRate
    });
    const modDuration = duration?.modified ?? null;
    const priceValue = (pricePer100 / 100) * notional;
    const pnlForShift = (bps) =>
      modDuration ? -modDuration * (bps / 10000) * priceValue : null;

    const breakEvenShift = computeOneYearBreakEvenShift({
      pricePer100,
      schedule,
      settlementDate,
      yieldRate,
      duration: modDuration
    });

    return {
      modDuration,
      macaulay: duration?.macaulay ?? null,
      pnlPlus100: pnlForShift(100),
      pnlMinus100: pnlForShift(-100),
      pnlPlus25: pnlForShift(25),
      pnlMinus25: pnlForShift(-25),
      breakEvenShift
    };
  }, [actualYieldMetrics, bondInputs, notional, selected]);

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

    const market = detail?.market || {};
    const settlementRaw = market.MarketDate ?? market.LatestTradeDate ?? selected?.MarketDate;
    const settlementDate = startOfDay(parseDateValue(settlementRaw) || new Date());
    const frequency = bondInputs.frequency || 1;
    let accrualStart = parseDateValue(detail?.details?.couponInfo?.accruedInterestFromDate);
    if (!accrualStart && cashflowSchedule.length > 0) {
      const nextCouponDate = cashflowSchedule[0].date;
      const monthsStep = Math.max(1, Math.round(12 / frequency));
      accrualStart = addMonths(nextCouponDate, -monthsStep);
    }
    accrualStart = alignAccrualStart({
      accrualStart,
      settlementDate,
      frequency
    });
    const accruedPer100 = computeAccruedInterest({
      couponRate: bondInputs.couponRate || 0,
      notional: 100,
      accrualStart,
      settlementDate
    });
    const cleanValue = (price / 100) * notional;
    const accruedValue = Number.isFinite(accruedPer100)
      ? (accruedPer100 / 100) * notional
      : null;
    const dirtyValue =
      cleanValue + (Number.isFinite(accruedValue) ? accruedValue : 0);

    const purchaseTotal = -dirtyValue;
    const breakdown =
      Number.isFinite(accruedValue) && Math.abs(accruedValue) > 0
        ? `dirty = ${formatCurrency(cleanValue, 2)} + ${formatCurrency(accruedValue, 2)}`
        : `dirty = ${formatCurrency(cleanValue, 2)}`;
    const purchaseRow = {
      date: startOfDay(new Date()),
      coupon: 0,
      principal: 0,
      total: purchaseTotal,
      isMaturity: false,
      type: `Purchase (${priceLabel}, ${breakdown})`
    };
    return [purchaseRow, ...rows];
  }, [cashflowSchedule, pricing, notional, bondInputs, detail, selected]);

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
              Sector
              <select
                value={filters.industrySector}
                onChange={(event) =>
                  setFilters({ ...filters, industrySector: event.target.value })
                }
              >
                <option value="">All</option>
                {sectorOptions.map((sector) => (
                  <option key={sector} value={sector}>
                    {sector}
                  </option>
                ))}
              </select>
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
            {showChart ? "Hide Charts" : "View Charts"}
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
        {showChart ? (
          <div className="chart-card">
            <div className="chart-header">
              <h3>Maturity vs after-tax yield</h3>
              <span>{afterTaxChartData.points.length} bonds plotted</span>
            </div>
            {afterTaxChartData.points.length === 0 ? (
              <p className="meta">No after-tax yield data available.</p>
            ) : (
              <ScatterPlot
                data={afterTaxChartData}
                onPointClick={(bond) => openDetails(bond)}
                yLabel="After-tax yield (%)"
              />
            )}
          </div>
        ) : null}
        {showChart ? (
          <div className="chart-card">
            <div className="chart-header">
              <h3>S&amp;P rating vs after-tax yield</h3>
              <span>{ratingChartData.points.length} bonds plotted</span>
            </div>
            {ratingChartData.points.length === 0 ? (
              <p className="meta">No S&amp;P ratings with after-tax yield available.</p>
            ) : (
              <RatingScatterPlot
                data={ratingChartData}
                onPointClick={(bond) => openDetails(bond)}
                xLabel="S&P rating"
                yLabel="After-tax yield (%)"
              />
            )}
          </div>
        ) : null}
        {showChart ? (
          <div className="chart-card">
            <div className="chart-header">
              <h3>S&amp;P rating vs ask yield</h3>
              <span>{ratingAskChartData.points.length} bonds plotted</span>
            </div>
            {ratingAskChartData.points.length === 0 ? (
              <p className="meta">No S&amp;P ratings with ask yield available.</p>
            ) : (
              <RatingScatterPlot
                data={ratingAskChartData}
                onPointClick={(bond) => openDetails(bond)}
                xLabel="S&P rating"
                yLabel="Ask yield (%)"
              />
            )}
          </div>
        ) : null}
        {showChart ? (
          <div className="chart-card">
            <div className="chart-header">
              <h3>Gross IRR vs SIX ask yield</h3>
              <span>{grossIrrAskYieldChart.points.length} bonds plotted</span>
            </div>
            {grossIrrChartLoading ? (
              <p className="meta">Loading gross IRR points...</p>
            ) : null}
            {grossIrrChartError ? <p className="error">{grossIrrChartError}</p> : null}
            {!grossIrrChartLoading && grossIrrAskYieldChart.points.length === 0 ? (
              <p className="meta">No gross IRR data available yet.</p>
            ) : null}
            {!grossIrrChartLoading && grossIrrAskYieldChart.points.length > 0 ? (
              <XYScatterPlot
                data={grossIrrAskYieldChart}
                onPointClick={(bond) => openDetails(bond)}
                xLabel="Gross IRR (%)"
                yLabel="SIX ask yield (%)"
              />
            ) : null}
          </div>
        ) : null}
        {showChart ? (
          <div className="chart-card">
            <div className="chart-header">
              <h3>Avg bid/ask spread distribution (last 5 days)</h3>
              <span>{liquidityViolinData.points.length} bonds plotted</span>
            </div>
            {grossIrrChartLoading ? (
              <p className="meta">Loading liquidity spreads...</p>
            ) : null}
            {!grossIrrChartLoading && liquidityViolinData.points.length === 0 ? (
              <p className="meta">No liquidity spread history available yet.</p>
            ) : null}
            {!grossIrrChartLoading && liquidityViolinData.points.length > 0 ? (
              <ViolinPlot
                data={liquidityViolinData}
                onPointClick={(bond) => openDetails(bond)}
                yLabel="Avg spread (%)"
              />
            ) : null}
          </div>
        ) : null}
        <div className="chart-card">
          <div className="chart-header">
            <h3>SNB Swiss government curve</h3>
            <span>
              {curve?.latest_date ? `Latest ${curve.latest_date}` : "Latest curve"}
            </span>
          </div>
          <div className="curve-legend">
            <div className="legend-item">
              <span className="legend-swatch snb" />
              <span>SNB curve</span>
            </div>
            <div className="legend-item">
              <span className="legend-swatch gov" />
              <span>Implied gov (raw)</span>
            </div>
            <div className="legend-item">
              <span className="legend-swatch spline" />
              <span>PCHIP fit</span>
            </div>
            <div className="legend-item">
              <span className="legend-swatch nelson" />
              <span>Nelson–Siegel fit</span>
            </div>
          </div>
          {curveLoading || govCurveLoading ? (
            <p className="meta">Loading curve...</p>
          ) : null}
          {curveError ? <p className="error">{curveError}</p> : null}
          {govCurveError && !(govCurve?.points && govCurve.points.length > 0) ? (
            <p className="error">{govCurveError}</p>
          ) : null}
          {!curveLoading && !curveError ? (
            curve?.points && curve.points.length > 1 ? (
              <CurveChart
                points={curve.points}
                govPoints={govCurve?.points}
                govFits={govCurve?.fits}
                onPointClick={(bond) => openDetails(bond)}
              />
            ) : (
              <p className="meta">No SNB curve data available.</p>
            )
          ) : null}
          {govCurve?.points && govCurve.points.length > 0 ? (
            <p className="meta">
              Implied curve from {govCurve.count || govCurve.points.length} Swiss
              Confederation bonds (dashed). PCHIP fit in teal, Nelson–Siegel in green.
            </p>
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
                  aria-sort={sortState.key === "IssuerRating" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("IssuerRating")}
                  >
                    Ratings{sortIndicator("IssuerRating")}
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
                <th aria-sort={sortState.key === "IndustrySectorDesc" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("IndustrySectorDesc")}
                  >
                    Sector{sortIndicator("IndustrySectorDesc")}
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
                <th aria-sort={sortState.key === "ImpliedGovSpreadBps" ? (sortState.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="sortable-button"
                    onClick={() => handleSort("ImpliedGovSpreadBps")}
                  >
                    Implied spread (YTW bps){sortIndicator("ImpliedGovSpreadBps")}
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
                      const ratingInfo = getIssuerRatingInfo(issuerName);
                      if (ratingInfo.status === "missing") {
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
                      if (ratingInfo.status === "loading") {
                        return "Fetching…";
                      }
                      if (ratingInfo.status === "error") {
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
                      if (!ratingInfo.values.length) return "—";
                      return (
                        <div className="rating-summary">
                          {ratingInfo.values.map((rating) => (
                            <span key={rating.agency} className="rating-pill">
                              <span className="rating-pill-label">{rating.agency}</span>
                              <span className="rating-pill-value">{rating.value}</span>
                            </span>
                          ))}
                        </div>
                      );
                    })()}
                  </td>
                  <td>{bond.ShortName || "-"}</td>
                  <td>{bond.IndustrySectorDesc || bond.IndustrySectorCode || "-"}</td>
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
                    {Number.isFinite(
                      parseNumber(impliedGovSpreadMap[bond.ValorId]?.spread)
                    ) ? (
                      <MetricInline
                        label={`${formatNumber(impliedGovSpreadMap[bond.ValorId].spread, 1)} bps`}
                        tooltip={formatImpliedGovSpreadTooltip({
                          yieldToWorst: impliedGovSpreadMap[bond.ValorId]?.yieldToWorst,
                          govYield: impliedGovSpreadMap[bond.ValorId]?.govYield,
                          source: impliedGovSpreadMap[bond.ValorId]?.source
                        })}
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
                  <td colSpan="12" className="empty">
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
                      <th>Sector</th>
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
                          <td>{bond.IndustrySectorDesc || bond.IndustrySectorCode || "-"}</td>
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
                    <span>Industry sector</span>
                    <strong>
                      {selected?.IndustrySectorDesc ||
                        selected?.IndustrySectorCode ||
                        "-"}
                    </strong>
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
                    <span className="metric-label-inline">
                      Duration (yrs)
                      <InfoTooltip text="Approx. modified duration using 30E/360 cashflow timing and dirty YTM (ignores calls)." />
                    </span>
                    <strong>{formatNumber(riskFreeMetrics?.modDuration, 2)}</strong>
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
                    <span className="metric-label-inline">
                      Gov spread (YTW, bps)
                      <InfoTooltip text={govSpreadByYtwTooltip} />
                    </span>
                    <strong>
                      {Number.isFinite(govSpreadByYtw)
                        ? `${formatNumber(govSpreadByYtw, 1)} bps`
                        : "-"}
                    </strong>
                  </div>
                  <div>
                    <span className="metric-label-inline">
                      Implied spread (YTW, bps)
                      <InfoTooltip text={impliedGovSpreadTooltip} />
                    </span>
                    <strong>
                      {Number.isFinite(impliedGovSpreadByYtw)
                        ? `${formatNumber(impliedGovSpreadByYtw, 1)} bps`
                        : "-"}
                    </strong>
                  </div>
                  <div>
                    <span className="metric-label-inline">
                      Gov spread (schedule, bps)
                      <InfoTooltip text={govSpreadByScheduleTooltip} />
                    </span>
                    <strong>
                      {Number.isFinite(govSpreadBySchedule)
                        ? `${formatNumber(govSpreadBySchedule, 1)} bps`
                        : "-"}
                    </strong>
                  </div>
                </div>
              </section>

              <section>
                <h4>Risk-Free Rate Change Sensitivity</h4>
                <div className="detail-list">
                  <div>
                    <span>Duration (yrs)</span>
                    <strong>{formatNumber(riskFreeMetrics?.modDuration, 2)}</strong>
                  </div>
                  <div>
                    <span>P&L +100 bps</span>
                    <strong>{formatCurrency(riskFreeMetrics?.pnlPlus100, 0)}</strong>
                  </div>
                  <div>
                    <span>P&L -100 bps</span>
                    <strong>{formatCurrency(riskFreeMetrics?.pnlMinus100, 0)}</strong>
                  </div>
                  <div>
                    <span>P&L +25 bps</span>
                    <strong>{formatCurrency(riskFreeMetrics?.pnlPlus25, 0)}</strong>
                  </div>
                  <div>
                    <span>P&L -25 bps</span>
                    <strong>{formatCurrency(riskFreeMetrics?.pnlMinus25, 0)}</strong>
                  </div>
                  <div>
                    <span className="metric-label-inline">
                      1Y break-even rate rise
                      <InfoTooltip text="If market yields for similar bonds are ≤X% higher when you sell in ~12 months, your coupon income and the bond aging should about offset the price drop. Assumes a parallel shift, same credit quality, and no default." />
                    </span>
                    <strong>
                      {formatPercent(
                        Number.isFinite(riskFreeMetrics?.breakEvenShift)
                          ? riskFreeMetrics.breakEvenShift * 100
                          : null,
                        2
                      )}
                    </strong>
                  </div>
                </div>
                <p className="meta">
                  Assumptions: Parallel shift (no slope change). Credit spread unchanged.
                  Coupons paid and not reinvested. No calls/exercise events.
                </p>
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
                    <h5>Yield (actual timing)</h5>
                    <p>
                      Price basis: {actualYieldMetrics?.priceLabel || "-"} (
                      {formatNumber(actualYieldMetrics?.cleanPrice, 2)})
                    </p>
                    <p>
                      Accrued interest (30E/360):{" "}
                      {formatNumber(actualYieldMetrics?.accrued, 4)} → Dirty:{" "}
                      {formatNumber(actualYieldMetrics?.dirtyPrice, 4)}
                    </p>
                    <p>
                      Settlement date: {formatDateYMD(actualYieldMetrics?.settlementDate)}
                    </p>
                    <p>
                      Call date: {formatDateYMD(actualYieldMetrics?.callDate) || "-"}
                    </p>
                    <p>
                      Clean YTM: {formatPercent(actualYieldMetrics?.cleanYtm, 2)}
                    </p>
                    <p>
                      Dirty YTM: {formatPercent(actualYieldMetrics?.dirtyYtm, 2)}
                    </p>
                    <p>
                      Clean YTW (call): {formatPercent(actualYieldMetrics?.cleanYtw, 2)}
                    </p>
                    <p>
                      Dirty YTW (call): {formatPercent(actualYieldMetrics?.dirtyYtw, 2)}
                    </p>
                  </div>
                  <div className="return-card">
                    <h5>Last price</h5>
                    <p>
                      <MetricInline
                        label="Gross return"
                        tooltip={RETURN_TOOLTIPS.grossReturn}
                      />
                      : {formatCurrency(actualTimingScenarioLast?.grossAbs)}
                    </p>
                    <p>
                      <MetricInline label="Gross IRR" tooltip={RETURN_TOOLTIPS.grossIrr} />
                      : {formatPercent(actualTimingScenarioLast?.grossIrr, 2)}
                    </p>
                    <p>
                      <MetricInline label="SIX ask yield" tooltip="SIX Yield-to-Worst (ask yield)." />
                      : {formatPercent(pricing.yieldToWorst, 2)}
                    </p>
                    <p>
                      <MetricInline label="After fees" tooltip={RETURN_TOOLTIPS.afterFees} />:{" "}
                      {formatCurrency(actualTimingScenarioLast?.feeAbs)}
                    </p>
                    <p>
                      <MetricInline label="Fee IRR" tooltip={RETURN_TOOLTIPS.feeIrr} />:{" "}
                      {formatPercent(actualTimingScenarioLast?.feeIrr, 2)}
                    </p>
                    <p>
                      <MetricInline label="After tax" tooltip={RETURN_TOOLTIPS.afterTax} />:{" "}
                      {formatCurrency(actualTimingScenarioLast?.taxAbs)}
                    </p>
                    <p>
                      <MetricInline label="Tax IRR" tooltip={RETURN_TOOLTIPS.taxIrr} />:{" "}
                      {formatPercent(actualTimingScenarioLast?.taxIrr, 2)}
                    </p>
                    <p>
                      <MetricInline
                        label="Break-even (fees)"
                        tooltip={RETURN_TOOLTIPS.breakEvenFees}
                      />
                      : {formatDurationYears(actualTimingScenarioLast?.breakEvenFees)}
                    </p>
                    <p>
                      <MetricInline
                        label="Break-even (fees + tax)"
                        tooltip={RETURN_TOOLTIPS.breakEvenFeesTax}
                      />
                      : {formatDurationYears(actualTimingScenarioLast?.breakEvenFeesTax)}
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
