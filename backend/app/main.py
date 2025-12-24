from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

from .cache_db import get_issuer_enrichment, init_db, upsert_issuer_enrichment, enqueue_job
from .llm_queue import get_job_status, start_worker
from .settings import load_env
from .cache import TTLCache
from .six_client import (
    SixClientError,
    fetch_bond_details,
    fetch_bond_liquidity,
    fetch_bond_market_data,
    fetch_bond_overview,
    fetch_bonds,
    maturity_bucket_to_range,
)
from .snb_client import SnbClientError, fetch_snb_curve
from .spread import (
    compute_gov_spread_bps,
    interpolate_curve_yield,
    maturity_years_from_value,
    parse_number,
    build_spread_price_meta,
)

app = FastAPI(title="Versified Bonds API")

VOLUME_CACHE = TTLCache(ttl_seconds=3600)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup() -> None:
    load_env()
    init_db()
    start_worker()

ALLOWED_ORDER_FIELDS = {
    "MaturityDate",
    "ShortName",
    "IssuerNameFull",
    "YieldToWorst",
    "CouponRate",
}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/snb/curve")
def snb_curve() -> dict:
    try:
        data = fetch_snb_curve()
    except SnbClientError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"latest_date": data.get("latest_date"), "points": data.get("points", [])}


class IssuerEnrichmentRequest(BaseModel):
    issuer_name: str
    context: Optional[str] = None
    force_refresh: bool = False
    pinned: bool = False
    ttl_seconds: int = 30 * 24 * 60 * 60
    model: Optional[str] = None


class IssuerEnrichmentOverride(BaseModel):
    issuer_name: str
    summary_md: Optional[str] = None
    moodys: Optional[str] = None
    sp: Optional[str] = None
    vegan_score: Optional[float] = None
    esg_summary: Optional[str] = None
    pinned: bool = True
    ttl_seconds: int = 30 * 24 * 60 * 60
    source: str = "manual"
    model: Optional[str] = None


@app.get("/api/issuer/enrichment/{issuer_name}")
def issuer_enrichment(issuer_name: str, include_expired: bool = False) -> dict:
    data = get_issuer_enrichment(issuer_name, include_expired=include_expired)
    if not data:
        raise HTTPException(status_code=404, detail="Issuer enrichment not found")
    return data


@app.post("/api/issuer/enrichment")
def enqueue_issuer_enrichment(request: IssuerEnrichmentRequest) -> dict:
    if not request.force_refresh:
        cached = get_issuer_enrichment(request.issuer_name)
        if cached:
            return {"status": "cached", "enrichment": cached}
    job_id = enqueue_job(
        "issuer_enrichment",
        {
            "issuer_name": request.issuer_name,
            "context": request.context,
            "pinned": request.pinned,
            "ttl_seconds": request.ttl_seconds,
            "model": request.model,
        },
    )
    return {"status": "queued", "job_id": job_id}


@app.post("/api/issuer/enrichment/override")
def override_issuer_enrichment(payload: IssuerEnrichmentOverride) -> dict:
    upsert_issuer_enrichment(
        issuer_name=payload.issuer_name,
        summary_md=payload.summary_md,
        moodys=payload.moodys,
        sp=payload.sp,
        vegan_score=payload.vegan_score,
        esg_summary=payload.esg_summary,
        source=payload.source,
        model=payload.model,
        ttl_seconds=payload.ttl_seconds,
        pinned=payload.pinned,
    )
    return {"status": "ok"}


@app.get("/api/issuer/enrichment/jobs/{job_id}")
def issuer_enrichment_job(job_id: str) -> dict:
    job = get_job_status(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

@app.get("/api/bonds/volumes")
def bond_volumes(ids: str = Query("", description="Comma-separated ValorIds")) -> dict:
    id_list = [item.strip() for item in ids.split(",") if item.strip()]
    if not id_list:
        return {"items": {}}
    if len(id_list) > 200:
        id_list = id_list[:200]

    items: dict[str, dict[str, object]] = {}
    for valor_id in id_list:
        cached = VOLUME_CACHE.get(valor_id)
        if cached is not None:
            items[valor_id] = cached
            continue
        try:
            liquidity = fetch_bond_liquidity(valor_id)
        except SixClientError:
            liquidity = []
        if liquidity:
            latest = max(
                liquidity,
                key=lambda row: parse_number(row.get("tradingDate")) or 0,
            )
            buy_volume = parse_number(latest.get("avgBuyVolume")) or 0
            sell_volume = parse_number(latest.get("avgSellVolume")) or 0
            volume = buy_volume + sell_volume or None
            volume_date = latest.get("tradingDate")
        else:
            volume = None
            volume_date = None
        payload = {"volume": volume, "date": volume_date}
        VOLUME_CACHE.set(valor_id, payload)
        items[valor_id] = payload
    return {"items": items}


@app.get("/api/bonds/search")
def bonds_search(
    maturity_bucket: str = Query("2-3", description="lt1, 1-2, 2-3, 3-5, 5-10, 10+"),
    currency: str = Query("CHF", min_length=1, max_length=6),
    country: str = Query("CH", min_length=1, max_length=6),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    order_by: str = Query("MaturityDate"),
) -> dict:
    if order_by not in ALLOWED_ORDER_FIELDS:
        order_by = "MaturityDate"
    maturity_from, maturity_to = maturity_bucket_to_range(maturity_bucket)
    try:
        response = fetch_bonds(
            country=country,
            currency=currency,
            maturity_from=maturity_from,
            maturity_to=maturity_to,
            page=page,
            page_size=page_size,
            order_by=order_by,
        )
        try:
            snb_curve = fetch_snb_curve()
            curve_points = snb_curve.get("points", [])
        except SnbClientError:
            curve_points = []
        for item in response.get("items", []):
            years = maturity_years_from_value(item.get("MaturityDate"))
            price_meta = build_spread_price_meta(
                ask=item.get("AskPrice"),
                bid=item.get("BidPrice"),
                close=item.get("ClosingPrice"),
            )
            gov_yield = (
                interpolate_curve_yield(curve_points, years) if curve_points else None
            )
            item["GovSpreadBps"] = compute_gov_spread_bps(
                price=price_meta.get("price"),
                coupon_rate=item.get("CouponRate"),
                years=years,
                frequency=1,
                curve_points=curve_points,
            )
            item["GovSpreadMeta"] = {
                **price_meta,
                "gov_yield": gov_yield,
                "curve_date": snb_curve.get("latest_date") if curve_points else None,
                "years": years,
            }
        return response
    except (SixClientError, SnbClientError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/bonds/{valor_id}")
def bond_details(valor_id: str) -> dict:
    try:
        overview = fetch_bond_overview(valor_id)
        details = fetch_bond_details(valor_id)
        liquidity = fetch_bond_liquidity(valor_id)
        market = fetch_bond_market_data(valor_id)
        try:
            snb_curve = fetch_snb_curve()
            curve_points = snb_curve.get("points", [])
        except SnbClientError:
            curve_points = []
        coupon_info = details.get("couponInfo", {})
        years = parse_number(coupon_info.get("remainingLifeInYear"))
        if years is None:
            years = maturity_years_from_value(details.get("maturity") or overview.get("maturityDate"))
        frequency = parse_number(coupon_info.get("interestFrequency")) or 1
        price_meta = build_spread_price_meta(
            ask=market.get("AskPrice"),
            bid=market.get("BidPrice"),
            close=market.get("PreviousClosingPrice"),
        )
        gov_yield = (
            interpolate_curve_yield(curve_points, years) if curve_points else None
        )
        gov_spread_bps = compute_gov_spread_bps(
            price=price_meta.get("price"),
            coupon_rate=coupon_info.get("couponRate"),
            years=years,
            frequency=frequency,
            curve_points=curve_points,
        )
    except SixClientError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    if not overview and not details and not market:
        raise HTTPException(status_code=404, detail="Bond not found")

    return {
        "valor_id": valor_id,
        "overview": overview,
        "details": details,
        "market": market,
        "liquidity": liquidity,
        "gov_spread_bps": gov_spread_bps,
        "gov_spread_meta": {
            **price_meta,
            "gov_yield": gov_yield,
            "curve_date": snb_curve.get("latest_date") if curve_points else None,
            "years": years,
        },
    }
