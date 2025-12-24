export function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

export function computeTieredFee(tradeValue, tierOneNotional, tierOneRate, tierTwoRate) {
  const base = parseNumber(tradeValue);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const limit = parseNumber(tierOneNotional) ?? 0;
  const rate1 = (parseNumber(tierOneRate) || 0) / 100;
  const rate2 = (parseNumber(tierTwoRate) || 0) / 100;
  const tierOneValue = Math.min(base, Math.max(0, limit));
  const tierTwoValue = Math.max(0, base - tierOneValue);
  return tierOneValue * rate1 + tierTwoValue * rate2;
}

export function estimatePeriods(years, frequency) {
  if (!Number.isFinite(years) || years <= 0) return null;
  const freq = Number.isFinite(frequency) && frequency > 0 ? frequency : 1;
  return Math.max(1, Math.round(years * freq));
}

export function yieldToMaturity({
  price,
  couponRate,
  years,
  frequency,
  notional,
  periodsOverride
}) {
  const priceValue = parseNumber(price);
  if (!Number.isFinite(priceValue) || priceValue <= 0) return null;
  const freq = Number.isFinite(frequency) && frequency > 0 ? frequency : 1;
  const periods = Number.isFinite(periodsOverride)
    ? Math.max(1, Math.round(periodsOverride))
    : estimatePeriods(years, freq);
  if (!periods) return null;
  const par = Number.isFinite(notional) && notional > 0 ? notional : 100000;
  const coupon = (parseNumber(couponRate) || 0) / 100 * par / freq;

  const pv = (rate) => {
    const perRate = rate / freq;
    let total = 0;
    for (let i = 1; i <= periods; i += 1) {
      total += coupon / Math.pow(1 + perRate, i);
    }
    total += par / Math.pow(1 + perRate, periods);
    return total;
  };

  let low = -0.99;
  let high = 2.0;
  let fLow = pv(low) - priceValue;
  let fHigh = pv(high) - priceValue;
  if (Number.isNaN(fLow) || Number.isNaN(fHigh)) return null;
  if (fLow * fHigh > 0) return null;

  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    const fMid = pv(mid) - priceValue;
    if (Math.abs(fMid) < 1e-6) return mid * 100;
    if (fLow * fMid <= 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }
  return ((low + high) / 2) * 100;
}

export function computeScenario({
  price,
  couponRate,
  years,
  frequency,
  notional,
  yieldToWorst,
  fees,
  taxRate,
  periodsOverride
}) {
  const tradeValue = parseNumber(price) === null
    ? null
    : (parseNumber(price) / 100) * notional;

  const freq = Number.isFinite(frequency) && frequency > 0 ? frequency : 1;
  const periods = Number.isFinite(periodsOverride)
    ? Math.max(1, Math.round(periodsOverride))
    : estimatePeriods(years, freq);
  const couponAnnual = ((parseNumber(couponRate) || 0) / 100) * notional;
  const couponTotal = periods ? couponAnnual * (periods / freq) : null;
  const tax = Number.isFinite(taxRate) ? taxRate : 0;
  const couponTotalAfterTax = couponTotal === null ? null : couponTotal * (1 - tax);

  const buyFee = computeTieredFee(
    tradeValue || 0,
    fees.tierOneNotional,
    fees.tierOneRate,
    fees.tierTwoRate
  );
  const sellFee = computeTieredFee(
    tradeValue || 0,
    fees.tierOneNotional,
    fees.tierOneRate,
    fees.tierTwoRate
  );

  const grossAbs = tradeValue && couponTotal !== null
    ? couponTotal + notional - tradeValue
    : null;
  const feeAbs = tradeValue && couponTotal !== null
    ? couponTotal + notional - tradeValue - buyFee
    : null;
  const taxAbs = tradeValue && couponTotalAfterTax !== null
    ? couponTotalAfterTax + notional - tradeValue - buyFee
    : null;

  const grossIrr = tradeValue
    ? yieldToMaturity({
        price: tradeValue,
        couponRate,
        years,
        frequency: freq,
        notional,
        periodsOverride: periods
      })
    : null;
  const feeIrr = tradeValue
    ? yieldToMaturity({
        price: tradeValue + buyFee,
        couponRate,
        years,
        frequency: freq,
        notional,
        periodsOverride: periods
      })
    : null;
  const taxIrr = tradeValue
    ? yieldToMaturity({
        price: tradeValue + buyFee,
        couponRate: (parseNumber(couponRate) || 0) * (1 - tax),
        years,
        frequency: freq,
        notional,
        periodsOverride: periods
      })
    : null;

  const annualYieldValue = tradeValue && Number.isFinite(yieldToWorst)
    ? tradeValue * (yieldToWorst / 100)
    : null;
  const annualTax = couponAnnual * tax;

  const breakEvenFees = annualYieldValue && annualYieldValue > 0
    ? (buyFee + sellFee) / annualYieldValue
    : null;
  const netAnnual = annualYieldValue !== null ? annualYieldValue - annualTax : null;
  const breakEvenFeesTax = netAnnual && netAnnual > 0
    ? (buyFee + sellFee) / netAnnual
    : null;

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

export function buildCashflows({
  price,
  couponRate,
  years,
  frequency,
  notional,
  fees,
  taxRate,
  periodsOverride
}) {
  const priceValue = parseNumber(price);
  if (!Number.isFinite(priceValue) || priceValue <= 0 || !Number.isFinite(years)) {
    return { cashflowsGross: [], cashflowsFee: [], cashflowsTax: [], tradeValue: null, buyFee: 0 };
  }
  const freq = Number.isFinite(frequency) && frequency > 0 ? frequency : 1;
  const periods = Number.isFinite(periodsOverride)
    ? Math.max(1, Math.round(periodsOverride))
    : estimatePeriods(years, freq);
  if (!periods) {
    return { cashflowsGross: [], cashflowsFee: [], cashflowsTax: [], tradeValue: null, buyFee: 0 };
  }
  const par = Number.isFinite(notional) && notional > 0 ? notional : 100000;
  const tradeValue = (priceValue / 100) * par;
  const couponPerPeriod = ((parseNumber(couponRate) || 0) / 100) * par / freq;
  const tax = Number.isFinite(taxRate) ? taxRate : 0;

  const buyFee = computeTieredFee(
    tradeValue,
    fees.tierOneNotional,
    fees.tierOneRate,
    fees.tierTwoRate
  );

  const cashflowsGross = [{ t: 0, amount: -tradeValue }];
  const cashflowsFee = [{ t: 0, amount: -(tradeValue + buyFee) }];
  const cashflowsTax = [{ t: 0, amount: -(tradeValue + buyFee) }];

  for (let i = 1; i <= periods; i += 1) {
    const t = i / freq;
    let amount = couponPerPeriod;
    let amountTax = couponPerPeriod * (1 - tax);
    if (i === periods) {
      amount += par;
      amountTax += par;
    }
    cashflowsGross.push({ t, amount });
    cashflowsFee.push({ t, amount });
    cashflowsTax.push({ t, amount: amountTax });
  }

  return { cashflowsGross, cashflowsFee, cashflowsTax, tradeValue, buyFee };
}

export function xirr(cashflows) {
  if (!cashflows || cashflows.length < 2) return null;
  const hasPositive = cashflows.some((flow) => flow.amount > 0);
  const hasNegative = cashflows.some((flow) => flow.amount < 0);
  if (!hasPositive || !hasNegative) return null;

  const npv = (rate) =>
    cashflows.reduce((sum, flow) => sum + flow.amount / Math.pow(1 + rate, flow.t), 0);

  let low = -0.99;
  let high = 1.5;
  let fLow = npv(low);
  let fHigh = npv(high);

  let attempts = 0;
  while (fLow * fHigh > 0 && attempts < 6) {
    high += 1.5;
    fHigh = npv(high);
    attempts += 1;
  }
  if (fLow * fHigh > 0) return null;

  for (let i = 0; i < 100; i += 1) {
    const mid = (low + high) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-8) return mid * 100;
    if (fLow * fMid <= 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }

  return ((low + high) / 2) * 100;
}
