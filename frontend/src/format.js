export function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

export function formatPercent(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${formatNumber(value, digits)}%`;
}

export function formatCurrency(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

export function formatDateYMD(value) {
  if (!value) return "-";
  const str = String(value);
  if (str.length !== 8) return str;
  return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
}

export function formatDurationYears(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  if (!Number.isFinite(value) || value <= 0) return "-";
  const years = Math.floor(value);
  const months = Math.round((value - years) * 12);
  if (years === 0) return `${months}m`;
  if (months === 0) return `${years}y`;
  return `${years}y ${months}m`;
}
