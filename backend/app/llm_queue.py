import json
import logging
import threading
import time
from pathlib import Path
from typing import Optional

from .cache_db import (
    cleanup_stale_jobs,
    fetch_next_job,
    get_issuer_enrichment,
    get_job,
    update_job_status,
    update_job_status,
    upsert_issuer_enrichment,
)
from .llm_client import LlmClientError, call_llm, extract_json
from .settings import get_env
from .celery_app import celery_app

_worker_started = False
LOG_PATH = Path(__file__).resolve().parent / "data" / "llm_fetch.log"


def is_celery_enabled() -> bool:
    backend = (get_env("LLM_QUEUE_BACKEND", "") or "").strip().lower()
    if backend and backend != "celery":
        return False
    return celery_app is not None


def _get_logger() -> logging.Logger:
    logger = logging.getLogger("llm_fetch")
    if logger.handlers:
        return logger
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(LOG_PATH, encoding="utf-8")
    formatter = logging.Formatter(
        fmt="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    return logger


def _coerce_bool(value: object) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "yes", "y", "1"}:
            return True
        if normalized in {"false", "no", "n", "0"}:
            return False
    return None


def _build_profile_prompt(issuer_name: str, context: Optional[str]) -> str:
    context_block = context or "No extra context provided."
    return (
        "You are enriching a bond issuer profile. "
        "Return JSON with keys: summary_md, vegan_friendly, vegan_explanation, esg_summary.\n"
        "Summary must be exactly one sentence. "
        "vegan_friendly must be true/false, with a brief explanation in vegan_explanation. "
        "Set vegan_friendly=false ONLY if there is clear evidence the issuer sells animal-derived products "
        "OR performs/commissions animal testing. "
        "Otherwise set vegan_friendly=true (including industries like construction, software, finance). "
        "If the context is insufficient, return null and state the uncertainty in vegan_explanation. "
        "Only use the provided context; do not browse or guess.\n\n"
        f"Issuer: {issuer_name}\n"
        f"Context:\n{context_block}\n"
    )


def _build_ratings_prompt(issuer_name: str) -> str:
    return (
        "What is the credit rating of the issuer below? "
        "Show Moody's, Fitch, and S&P (whichever are available). "
        "Use only the issuer's official website as a source. "
        "Return JSON with keys: moodys, fitch, sp, sources. "
        "If a rating is not available on the issuer website, return null for that rating. "
        "Only use verifiable information; do not guess.\n\n"
        f"Issuer: {issuer_name}\n"
    )


def _merge_enrichment(existing: Optional[dict], updates: dict) -> dict:
    merged = dict(existing or {})
    for key, value in updates.items():
        if value is not None:
            merged[key] = value
    return merged


def _process_issuer_job(job: dict) -> dict:
    logger = _get_logger()
    payload = json.loads(job.get("payload_json") or "{}")
    issuer_name = payload.get("issuer_name")
    if not issuer_name:
        raise ValueError("issuer_name missing")
    existing = get_issuer_enrichment(issuer_name, include_expired=True) or {}
    ttl = payload.get("ttl_seconds", 30 * 24 * 60 * 60)
    pinned = bool(payload.get("pinned"))
    model = payload.get("model")

    profile_prompt = _build_profile_prompt(issuer_name, payload.get("context"))
    profile_start = time.monotonic()
    logger.info("START profile issuer=%s model=%s", issuer_name, model or "default")
    try:
        profile_result = call_llm(profile_prompt, model=model, use_web=False)
    except Exception as exc:
        logger.error("FAIL profile issuer=%s error=%s", issuer_name, exc)
        raise
    profile_elapsed = time.monotonic() - profile_start
    logger.info(
        "DONE profile issuer=%s provider=%s model=%s elapsed=%.2fs",
        issuer_name,
        profile_result.get("provider"),
        profile_result.get("model"),
        profile_elapsed,
    )
    profile_content = profile_result["text"]
    profile_parsed = extract_json(profile_content)
    vegan_friendly = _coerce_bool(profile_parsed.get("vegan_friendly"))
    profile_updates = {
        "summary_md": profile_parsed.get("summary_md"),
        "vegan_friendly": vegan_friendly,
        "vegan_explanation": profile_parsed.get("vegan_explanation"),
        "esg_summary": profile_parsed.get("esg_summary"),
    }
    merged_profile = _merge_enrichment(existing, profile_updates)
    upsert_issuer_enrichment(
        issuer_name=issuer_name,
        summary_md=merged_profile.get("summary_md"),
        moodys=merged_profile.get("moodys"),
        fitch=merged_profile.get("fitch"),
        sp=merged_profile.get("sp"),
        vegan_score=merged_profile.get("vegan_score"),
        vegan_friendly=merged_profile.get("vegan_friendly"),
        vegan_explanation=merged_profile.get("vegan_explanation"),
        esg_summary=merged_profile.get("esg_summary"),
        sources=merged_profile.get("sources"),
        source=profile_result["provider"],
        model=profile_result["model"],
        ttl_seconds=ttl,
        pinned=pinned,
    )

    ratings_prompt = _build_ratings_prompt(issuer_name)
    ratings_plugins = None
    if payload.get("ratings_use_web", True):
        plugin = {
            "id": "web",
            "max_results": payload.get("ratings_web_max_results", 5),
        }
        engine = payload.get("ratings_web_engine")
        if engine:
            plugin["engine"] = engine
        search_prompt = payload.get("ratings_web_search_prompt")
        if search_prompt:
            plugin["search_prompt"] = search_prompt
        ratings_plugins = [plugin]
    ratings_start = time.monotonic()
    ratings_use_web = payload.get("ratings_use_web", True)
    logger.info(
        "START ratings issuer=%s model=%s web=%s",
        issuer_name,
        model or "default",
        ratings_use_web,
    )
    try:
        ratings_result = call_llm(
            ratings_prompt,
            model=model,
            plugins=ratings_plugins,
            web_search_options=payload.get("ratings_web_search_options"),
            use_web=ratings_use_web,
        )
    except Exception as exc:
        logger.error("FAIL ratings issuer=%s error=%s", issuer_name, exc)
        raise
    ratings_elapsed = time.monotonic() - ratings_start
    logger.info(
        "DONE ratings issuer=%s provider=%s model=%s elapsed=%.2fs",
        issuer_name,
        ratings_result.get("provider"),
        ratings_result.get("model"),
        ratings_elapsed,
    )
    ratings_content = ratings_result["text"]
    ratings_parsed = extract_json(ratings_content)
    rating_sources = ratings_result.get("sources") or ratings_parsed.get("sources")
    rating_updates = {
        "moodys": ratings_parsed.get("moodys"),
        "fitch": ratings_parsed.get("fitch"),
        "sp": ratings_parsed.get("sp"),
        "sources": rating_sources,
    }
    merged_ratings = _merge_enrichment(merged_profile, rating_updates)
    if merged_profile.get("sources") and rating_sources:
        merged_ratings["sources"] = list(
            dict.fromkeys((merged_profile.get("sources") or []) + (rating_sources or []))
        )
    upsert_issuer_enrichment(
        issuer_name=issuer_name,
        summary_md=merged_ratings.get("summary_md"),
        moodys=merged_ratings.get("moodys"),
        fitch=merged_ratings.get("fitch"),
        sp=merged_ratings.get("sp"),
        vegan_score=merged_ratings.get("vegan_score"),
        vegan_friendly=merged_ratings.get("vegan_friendly"),
        vegan_explanation=merged_ratings.get("vegan_explanation"),
        esg_summary=merged_ratings.get("esg_summary"),
        sources=merged_ratings.get("sources"),
        source=ratings_result["provider"],
        model=ratings_result["model"],
        ttl_seconds=ttl,
        pinned=pinned,
    )
    return {
        "profile": profile_parsed,
        "ratings": ratings_parsed,
    }


def _worker_loop() -> None:
    poll_seconds = max(1, int(get_env("LLM_QUEUE_POLL_SECONDS", "1") or "1"))
    stale_seconds = int(get_env("LLM_JOB_STALE_SECONDS", "900") or "900")
    cleanup_interval = int(get_env("LLM_JOB_CLEANUP_INTERVAL", "60") or "60")
    last_cleanup = 0.0
    while True:
        now = time.monotonic()
        if now - last_cleanup >= cleanup_interval:
            cleanup_stale_jobs(stale_seconds, action="fail")
            last_cleanup = now
        job = fetch_next_job()
        if not job:
            time.sleep(poll_seconds)
            continue
        job_id = job["id"]
        kind = job.get("kind")
        try:
            if kind == "issuer_enrichment":
                result = _process_issuer_job(job)
            else:
                raise ValueError(f"Unknown job kind: {kind}")
            update_job_status(job_id, status="done", result=result)
        except (LlmClientError, ValueError, json.JSONDecodeError) as exc:
            update_job_status(job_id, status="failed", error=str(exc))


def start_worker() -> None:
    global _worker_started
    if _worker_started:
        return
    _worker_started = True
    thread = threading.Thread(target=_worker_loop, daemon=True)
    thread.start()


def get_job_status(job_id: str) -> Optional[dict]:
    return get_job(job_id)
