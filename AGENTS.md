# Agent Notes

## Workflow
- Read existing project docs before changing behavior.
- Prefer small, reversible edits; avoid unrelated cleanups.
- Use `rg` for fast search; avoid destructive git commands.
- Restart the backend server after backend changes (routes, DB, settings, cache).
- If backend schema changes, restart to run migrations.
- Keep .env secrets out of commits.

## Backend
- FastAPI runs on `127.0.0.1:8080`.
- LLM calls happen only when the issuer enrichment endpoint is triggered.
- Cache/queue data is stored in `backend/app/data/cache.sqlite`.

## Frontend
- Vite dev server is used for local UI.
- Keep UI updates consistent with existing layout and styles.
- Use tooltips sparingly; keep text short and precise.

## Data & APIs
- SIX endpoints are primary source for bond data.
- SNB curve comes from `rendeiduebm` API and is cached.
- OpenRouter model is configured via `.env`.
