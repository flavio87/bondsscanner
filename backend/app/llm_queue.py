import json
import threading
import time
from typing import Optional

from .cache_db import (
    fetch_next_job,
    get_job,
    update_job_status,
    upsert_issuer_enrichment,
)
from .llm_client import LlmClientError, call_openrouter, extract_json
from .settings import get_env

_worker_started = False


def _build_issuer_prompt(issuer_name: str, context: Optional[str]) -> str:
    context_block = context or "No extra context provided."
    return (
        "You are enriching a bond issuer profile. "
        "Return JSON with keys: summary_md, moodys, sp, vegan_score, esg_summary, sources.\n"
        "If you do not know a rating, return null. "
        "Vegan_score should be 0-1, where 1 is fully vegan-friendly. "
        "Only use information from the provided context; do not guess.\n\n"
        f"Issuer: {issuer_name}\n"
        f"Context:\n{context_block}\n"
    )


def _process_issuer_job(job: dict) -> dict:
    payload = json.loads(job.get("payload_json") or "{}")
    issuer_name = payload.get("issuer_name")
    if not issuer_name:
        raise ValueError("issuer_name missing")
    prompt = _build_issuer_prompt(issuer_name, payload.get("context"))
    response = call_openrouter(prompt, model=payload.get("model"))
    content = response["choices"][0]["message"]["content"]
    parsed = extract_json(content)
    ttl = payload.get("ttl_seconds", 30 * 24 * 60 * 60)
    pinned = bool(payload.get("pinned"))
    upsert_issuer_enrichment(
        issuer_name=issuer_name,
        summary_md=parsed.get("summary_md"),
        moodys=parsed.get("moodys"),
        sp=parsed.get("sp"),
        vegan_score=parsed.get("vegan_score"),
        esg_summary=parsed.get("esg_summary"),
        source="openrouter",
        model=payload.get("model"),
        ttl_seconds=ttl,
        pinned=pinned,
    )
    return parsed


def _worker_loop() -> None:
    poll_seconds = int(get_env("LLM_QUEUE_POLL_SECONDS", "5") or "5")
    while True:
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
