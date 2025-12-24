export async function fetchBonds({ maturityBucket, currency, country, page, pageSize }) {
  const params = new URLSearchParams({
    maturity_bucket: maturityBucket,
    currency,
    country,
    page: String(page),
    page_size: String(pageSize)
  });
  const response = await fetch(`/api/bonds/search?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Search failed (${response.status})`);
  }
  return response.json();
}

export async function fetchBondDetails(valorId) {
  const response = await fetch(`/api/bonds/${encodeURIComponent(valorId)}`);
  if (!response.ok) {
    throw new Error(`Details failed (${response.status})`);
  }
  return response.json();
}

export async function fetchSnbCurve() {
  const response = await fetch("/api/snb/curve");
  if (!response.ok) {
    throw new Error(`Curve failed (${response.status})`);
  }
  return response.json();
}

export async function fetchBondVolumes(ids) {
  if (!ids || ids.length === 0) {
    return { items: {} };
  }
  const params = new URLSearchParams({
    ids: ids.join(",")
  });
  const response = await fetch(`/api/bonds/volumes?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Volumes failed (${response.status})`);
  }
  return response.json();
}
