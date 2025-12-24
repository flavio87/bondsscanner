import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

DB_PATH = Path(__file__).resolve().parent / "data" / "cache.sqlite"


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS issuer_enrichment (
                issuer_name TEXT PRIMARY KEY,
                summary_md TEXT,
                moodys TEXT,
                sp TEXT,
                vegan_score REAL,
                esg_summary TEXT,
                source TEXT,
                model TEXT,
                updated_at INTEGER,
                expires_at INTEGER,
                pinned INTEGER DEFAULT 0
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS llm_jobs (
                id TEXT PRIMARY KEY,
                kind TEXT,
                status TEXT,
                payload_json TEXT,
                result_json TEXT,
                error TEXT,
                created_at INTEGER,
                updated_at INTEGER
            )
            """
        )


def _now_ts() -> int:
    return int(time.time())


def get_issuer_enrichment(issuer_name: str, include_expired: bool = False) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM issuer_enrichment WHERE issuer_name = ?",
            (issuer_name,),
        ).fetchone()
    if not row:
        return None
    data = dict(row)
    if data.get("pinned"):
        return data
    expires_at = data.get("expires_at") or 0
    if not include_expired and expires_at and expires_at < _now_ts():
        return None
    return data


def upsert_issuer_enrichment(
    *,
    issuer_name: str,
    summary_md: Optional[str],
    moodys: Optional[str],
    sp: Optional[str],
    vegan_score: Optional[float],
    esg_summary: Optional[str],
    source: str,
    model: Optional[str],
    ttl_seconds: int,
    pinned: bool = False,
) -> None:
    now = _now_ts()
    expires_at = now + ttl_seconds if ttl_seconds else None
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO issuer_enrichment (
                issuer_name,
                summary_md,
                moodys,
                sp,
                vegan_score,
                esg_summary,
                source,
                model,
                updated_at,
                expires_at,
                pinned
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(issuer_name) DO UPDATE SET
                summary_md=excluded.summary_md,
                moodys=excluded.moodys,
                sp=excluded.sp,
                vegan_score=excluded.vegan_score,
                esg_summary=excluded.esg_summary,
                source=excluded.source,
                model=excluded.model,
                updated_at=excluded.updated_at,
                expires_at=excluded.expires_at,
                pinned=excluded.pinned
            """,
            (
                issuer_name,
                summary_md,
                moodys,
                sp,
                vegan_score,
                esg_summary,
                source,
                model,
                now,
                expires_at,
                1 if pinned else 0,
            ),
        )


def enqueue_job(kind: str, payload: dict[str, Any]) -> str:
    job_id = os.urandom(12).hex()
    now = _now_ts()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO llm_jobs (id, kind, status, payload_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (job_id, kind, "queued", json.dumps(payload), now, now),
        )
    return job_id


def fetch_next_job() -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM llm_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1"
        ).fetchone()
        if not row:
            return None
        job_id = row["id"]
        conn.execute(
            "UPDATE llm_jobs SET status = ?, updated_at = ? WHERE id = ?",
            ("running", _now_ts(), job_id),
        )
    return dict(row)


def update_job_status(
    job_id: str,
    *,
    status: str,
    result: Optional[dict] = None,
    error: Optional[str] = None,
) -> None:
    payload = json.dumps(result) if result is not None else None
    with _connect() as conn:
        conn.execute(
            """
            UPDATE llm_jobs
            SET status = ?, result_json = ?, error = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, payload, error, _now_ts(), job_id),
        )


def get_job(job_id: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM llm_jobs WHERE id = ?", (job_id,)).fetchone()
    return dict(row) if row else None
