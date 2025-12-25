from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

from .cache_db import (
    cleanup_stale_jobs,
    enqueue_job,
    get_issuer_enrichment,
    get_issuer_enrichments,
    init_db,
    upsert_issuer_enrichment,
)
from .llm_queue import get_job_status, start_worker
from .llm_client import LlmClientError, call_llm, extract_json
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


@app.get("/api/llm/validate")
def llm_validate(model: Optional[str] = None) -> dict:
    prompt = 'Return JSON: {"ok": true, "source": "validate"}'
    try:
        response = call_llm(prompt, model=model)
    except LlmClientError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    try:
        content = response["text"]
        parsed = extract_json(content)
    except (KeyError, ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"LLM response parse failed: {exc}",
        ) from exc
    return {
        "status": "ok",
        "response": parsed,
        "model": response.get("model"),
        "provider": response.get("provider"),
    }


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
    ratings_use_web: bool = True
    ratings_web_max_results: int = 5
    ratings_web_engine: Optional[str] = None
    ratings_web_search_prompt: Optional[str] = None
    ratings_web_search_options: Optional[dict] = None


class IssuerEnrichmentOverride(BaseModel):
    issuer_name: str
    summary_md: Optional[str] = None
    moodys: Optional[str] = None
    fitch: Optional[str] = None
    sp: Optional[str] = None
    vegan_score: Optional[float] = None
    vegan_friendly: Optional[bool] = None
    vegan_explanation: Optional[str] = None
    esg_summary: Optional[str] = None
    sources: Optional[list[str]] = None
    pinned: bool = True
    ttl_seconds: int = 30 * 24 * 60 * 60
    source: str = "manual"
    model: Optional[str] = None


class IssuerEnrichmentBatchRequest(BaseModel):
    issuers: list[str]
    include_expired: bool = False


class JobCleanupRequest(BaseModel):
    stale_seconds: int = 900
    action: str = "fail"


@app.get("/api/issuer/enrichment/{issuer_name}")
def issuer_enrichment(issuer_name: str, include_expired: bool = False) -> dict:
    data = get_issuer_enrichment(issuer_name, include_expired=include_expired)
    if not data:
        raise HTTPException(status_code=404, detail="Issuer enrichment not found")
    return data


@app.post("/api/issuer/enrichment/batch")
def issuer_enrichment_batch(request: IssuerEnrichmentBatchRequest) -> dict:
    items = get_issuer_enrichments(request.issuers, include_expired=request.include_expired)
    return {"items": items}


@app.post("/api/issuer/enrichment/jobs/cleanup")
def issuer_enrichment_job_cleanup(request: JobCleanupRequest) -> dict:
    cleaned = cleanup_stale_jobs(request.stale_seconds, action=request.action)
    return {"status": "ok", "cleaned": cleaned}


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
            "ratings_use_web": request.ratings_use_web,
            "ratings_web_max_results": request.ratings_web_max_results,
            "ratings_web_engine": request.ratings_web_engine,
            "ratings_web_search_prompt": request.ratings_web_search_prompt,
            "ratings_web_search_options": request.ratings_web_search_options,
        },
    )
    return {"status": "queued", "job_id": job_id}


@app.post("/api/issuer/enrichment/override")
def override_issuer_enrichment(payload: IssuerEnrichmentOverride) -> dict:
    upsert_issuer_enrichment(
        issuer_name=payload.issuer_name,
        summary_md=payload.summary_md,
        moodys=payload.moodys,
        fitch=payload.fitch,
        sp=payload.sp,
        vegan_score=payload.vegan_score,
        vegan_friendly=payload.vegan_friendly,
        vegan_explanation=payload.vegan_explanation,
        esg_summary=payload.esg_summary,
        sources=payload.sources,
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
            market = fetch_bond_market_data(valor_id)
        except SixClientError:
            market = {}

        total_volume = parse_number(market.get("TotalVolume"))
        on_volume = parse_number(market.get("OnMarketVolume"))
        off_volume = parse_number(market.get("OffBookVolume"))
        latest_trade_volume = parse_number(market.get("LatestTradeVolume"))

        volume = None
        source = None
        if total_volume is not None:
            volume = total_volume
            source = "total_volume"
        elif on_volume is not None or off_volume is not None:
            volume = (on_volume or 0) + (off_volume or 0)
            source = "on_off_volume"
        elif latest_trade_volume is not None:
            volume = latest_trade_volume
            source = "latest_trade_volume"

        volume_date = market.get("LatestTradeDate") or market.get("MarketDate")
        payload = {
            "volume": volume,
            "date": volume_date,
            "source": source,
            "on_volume": on_volume,
            "off_volume": off_volume,
        }
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
