from __future__ import annotations

from typing import Optional

from celery import Celery

from .settings import get_env, load_env


def _build_celery_app() -> Optional[Celery]:
    load_env()
    broker = get_env("REDIS_URL") or get_env("CELERY_BROKER_URL")
    if not broker:
        return None
    app = Celery("bonds", broker=broker, backend=broker, include=["app.llm_queue"])
    queue_name = get_env("CELERY_QUEUE_NAME", "bonds")
    app.conf.update(
        task_serializer="json",
        accept_content=["json"],
        result_serializer="json",
        task_track_started=True,
        timezone="UTC",
        task_default_queue=queue_name,
        task_routes={
            "bonds.issuer_enrichment": {"queue": queue_name},
        },
    )
    return app


celery_app = _build_celery_app()

if celery_app:
    # Ensure task registration when running `celery -A app.celery_app ...`
    from . import llm_queue  # noqa: F401

# Aliases for Celery CLI discovery (-A app.celery_app)
celery = celery_app
app = celery_app
