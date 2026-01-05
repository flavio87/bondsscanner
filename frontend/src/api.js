export async function fetchBonds({
  maturityBucket,
  currency,
  country,
  industrySector,
  page,
  pageSize
}) {
  const params = new URLSearchParams({
    maturity_bucket: maturityBucket,
    currency,
    country,
    page: String(page),
    page_size: String(pageSize)
  });
  if (industrySector) {
    params.set("industry_sector", industrySector);
  }
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

export async function fetchGovBondCurve() {
  const response = await fetch("/api/bonds/gov-curve");
  if (!response.ok) {
    throw new Error(`Gov curve failed (${response.status})`);
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

export async function fetchIctaxSecurity({ isin, maturity }) {
  const params = new URLSearchParams();
  params.set("isin", isin);
  if (maturity) params.set("maturity", maturity);
  const response = await fetch(`/api/ictax/security?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`ICTax lookup failed (${response.status})`);
  }
  return response.json();
}

export async function enrichIssuer(payload) {
  const response = await fetch("/api/issuer/enrichment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Enrichment failed (${response.status})`);
  }
  return response.json();
}

export async function fetchIssuerEnrichment(issuerName) {
  const response = await fetch(
    `/api/issuer/enrichment/${encodeURIComponent(issuerName)}`
  );
  if (!response.ok) {
    throw new Error(`Enrichment fetch failed (${response.status})`);
  }
  return response.json();
}

export async function fetchIssuerEnrichmentBatch(issuers, includeExpired = false) {
  const response = await fetch("/api/issuer/enrichment/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ issuers, include_expired: includeExpired })
  });
  if (!response.ok) {
    throw new Error(`Batch enrichment fetch failed (${response.status})`);
  }
  return response.json();
}

export async function fetchIssuerEnrichmentJob(jobId) {
  const response = await fetch(
    `/api/issuer/enrichment/jobs/${encodeURIComponent(jobId)}`
  );
  if (!response.ok) {
    throw new Error(`Job fetch failed (${response.status})`);
  }
  return response.json();
}
