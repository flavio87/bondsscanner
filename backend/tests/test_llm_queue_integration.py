import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import cache_db
from app import llm_queue
from app.main import app


@pytest.fixture(autouse=True)
def isolate_db(tmp_path, monkeypatch):
    db_path = tmp_path / "cache.sqlite"
    monkeypatch.setattr(cache_db, "DB_PATH", db_path)
    cache_db.init_db()
    yield


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr("app.main.start_worker", lambda: None)

    def immediate_dispatch(job_id, kind):
        llm_queue._process_job_by_id(job_id)

    monkeypatch.setattr("app.main.dispatch_job", immediate_dispatch)

    def fake_call_llm(prompt, *args, **kwargs):
        if "summary_md" in prompt:
            payload = {
                "summary_md": "Issuer summary sentence.",
                "vegan_friendly": True,
                "vegan_explanation": "No animal products or testing found.",
                "esg_summary": "ESG info."
            }
            return {"provider": "test", "model": "test-model", "text": json.dumps(payload)}
        payload = {
            "moodys": "A2",
            "fitch": "A+",
            "sp": "A",
            "sources": ["https://issuer.example.com/ratings"]
        }
        return {"provider": "test", "model": "test-model", "text": json.dumps(payload)}

    monkeypatch.setattr(llm_queue, "call_llm", fake_call_llm)
    return TestClient(app)


def test_enrichment_queue_flow(client):
    issuer = "Test Issuer SA"
    response = client.post(
        "/api/issuer/enrichment",
        json={
            "issuer_name": issuer,
            "force_refresh": True,
            "ratings_use_web": True
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "queued"
    job_id = payload["job_id"]

    job = client.get(f"/api/issuer/enrichment/jobs/{job_id}")
    assert job.status_code == 200
    assert job.json()["status"] == "done"

    enrichment = client.get(f"/api/issuer/enrichment/{issuer}")
    assert enrichment.status_code == 200
    data = enrichment.json()
    assert data["summary_md"] == "Issuer summary sentence."
    assert data["moodys"] == "A2"
    assert data["fitch"] == "A+"
    assert data["sp"] == "A"
    assert data["vegan_friendly"] == 1
