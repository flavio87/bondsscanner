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
                fitch TEXT,
                sp TEXT,
                vegan_score REAL,
                vegan_friendly INTEGER,
                vegan_explanation TEXT,
                esg_summary TEXT,
                sources_json TEXT,
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
        _ensure_columns(
            conn,
            "issuer_enrichment",
            [
                ("fitch", "TEXT"),
                ("vegan_friendly", "INTEGER"),
                ("vegan_explanation", "TEXT"),
                ("sources_json", "TEXT"),
            ],
        )


def _ensure_columns(conn: sqlite3.Connection, table: str, columns: list[tuple[str, str]]) -> None:
    existing = {
        row["name"]
        for row in conn.execute(f"PRAGMA table_info({table})")
    }
    for name, col_type in columns:
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {col_type}")


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
    sources_raw = data.get("sources_json")
    if sources_raw:
        try:
            data["sources"] = json.loads(sources_raw)
        except json.JSONDecodeError:
            data["sources"] = sources_raw
    data.pop("sources_json", None)
    if data.get("pinned"):
        return data
    expires_at = data.get("expires_at") or 0
    if not include_expired and expires_at and expires_at < _now_ts():
        return None
    return data


def get_issuer_enrichments(
    issuer_names: list[str],
    include_expired: bool = False,
) -> dict[str, dict]:
    names = [name for name in issuer_names if name]
    if not names:
        return {}
    placeholders = ",".join("?" for _ in names)
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM issuer_enrichment WHERE issuer_name IN ({placeholders})",
            names,
        ).fetchall()
    results: dict[str, dict] = {}
    now = _now_ts()
    for row in rows:
        data = dict(row)
        sources_raw = data.get("sources_json")
        if sources_raw:
            try:
                data["sources"] = json.loads(sources_raw)
            except json.JSONDecodeError:
                data["sources"] = sources_raw
        data.pop("sources_json", None)
        if not data.get("pinned"):
            expires_at = data.get("expires_at") or 0
            if not include_expired and expires_at and expires_at < now:
                continue
        results[data.get("issuer_name")] = data
    return results


def upsert_issuer_enrichment(
    *,
    issuer_name: str,
    summary_md: Optional[str],
    moodys: Optional[str],
    fitch: Optional[str],
    sp: Optional[str],
    vegan_score: Optional[float],
    vegan_friendly: Optional[bool],
    vegan_explanation: Optional[str],
    esg_summary: Optional[str],
    sources: Optional[list[str]],
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
                fitch,
                sp,
                vegan_score,
                vegan_friendly,
                vegan_explanation,
                esg_summary,
                sources_json,
                source,
                model,
                updated_at,
                expires_at,
                pinned
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(issuer_name) DO UPDATE SET
                summary_md=excluded.summary_md,
                moodys=excluded.moodys,
                fitch=excluded.fitch,
                sp=excluded.sp,
                vegan_score=excluded.vegan_score,
                vegan_friendly=excluded.vegan_friendly,
                vegan_explanation=excluded.vegan_explanation,
                esg_summary=excluded.esg_summary,
                sources_json=excluded.sources_json,
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
                fitch,
                sp,
                vegan_score,
                1 if vegan_friendly else 0 if vegan_friendly is not None else None,
                vegan_explanation,
                esg_summary,
                json.dumps(sources) if sources is not None else None,
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


def cleanup_stale_jobs(stale_seconds: int, *, action: str = "fail") -> int:
    if stale_seconds <= 0:
        return 0
    now = _now_ts()
    cutoff = now - stale_seconds
    if action not in {"fail", "requeue"}:
        action = "fail"
    status = "queued" if action == "requeue" else "failed"
    error = None if action == "requeue" else f"stale job (> {stale_seconds}s)"
    with _connect() as conn:
        cursor = conn.execute(
            """
            UPDATE llm_jobs
            SET status = ?, error = ?, updated_at = ?
            WHERE status = 'running' AND updated_at < ?
            """,
            (status, error, now, cutoff),
        )
    return cursor.rowcount


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
