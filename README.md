# BondScanner (Versified Bonds)

FastAPI + React app to search SIX-listed bonds, model after-tax IRR using cashflow schedules, and build a portfolio with liquidity and issuer enrichment overlays.

## What this app does

- Search SIX bonds by currency, country, sector, and maturity bucket.
- Compute IRR (after-tax) using dirty price and actual cashflow timing (worst-case call vs maturity).
- Compare bonds vs Swiss government curve ("Swissies") and show gov spread.
- Build a portfolio with aggregate IRR, fees, and liquidity haircut estimates.
- Enrich issuers with summary, ratings, and vegan-friendly assessment (LLM-assisted).
- Optional ICTax lookup for IUP flags per ISIN/maturity.

## Key differentiators

- Uses cashflow-based IRR, not just quoted YTW.
- After-tax IRR is first-class (editable tax and fee assumptions).
- Swiss government spread derived from current Swiss Confederation bonds (not only SNB curve).
- Portfolio aggregation uses aligned cashflow timing to avoid IRR distortions.
- Issuer enrichment and vegan checks are integrated into the workflow.

## Assumptions and methodology

- Prices are treated as clean; dirty price = clean + accrued (30E/360).
- Yield-to-worst is computed from actual cashflows when available; otherwise falls back to market YTW.
- Gov spread uses the Swiss Confederation bond curve ("Swissies") with a fitted spline.
- Liquidity haircut estimates use historical bid/ask spreads (when available).

## Architecture

- Backend: FastAPI (127.0.0.1:8080), optional Celery worker for LLM jobs.
- Frontend: Vite dev server (default 5173), API proxied to backend.
- Cache/queue DB: `backend/app/data/cache.sqlite`.

## Backend setup

```bash
uv venv -p 3.13 .venv
uv pip install -r backend/requirements.txt --python .venv/bin/python
source .venv/bin/activate
cd backend
uvicorn app.main:app --reload --port 8080
```

### Optional: Celery + Redis for LLM jobs

```bash
# ensure Redis is running locally
# set in .env: LLM_QUEUE_BACKEND=celery and REDIS_URL=redis://localhost:6379/0

cd backend
source .venv/bin/activate
celery -A app.celery_app worker --loglevel=INFO --concurrency=3 -Q bonds
```

## Frontend setup

```bash
cd frontend
npm install
npm run dev
```

The frontend proxies `/api` to `http://localhost:8080` in development.

## Configuration (.env)

Common settings:

- `OPENROUTER_API_KEY` or `GEMINI_API_KEY` (LLM provider)
- `LLM_QUEUE_BACKEND` (`inline` or `celery`)
- `REDIS_URL` (when using Celery)
- `PUBLIC_APP_PASSWORD` (optional; enables password gate for non-Tailscale clients)

Do not commit secrets.

## Auth behavior

If `PUBLIC_APP_PASSWORD` is set, the app requires a password unless the client IP is on the Tailscale range (100.64.0.0/10) or Docker bridge (172.17.0.0/16).

## Gov curve caching

`/api/bonds/gov-curve` is cached server-side (TTL 6h). SIX list endpoints are already cached in the client.

## Development notes

- Backend changes (routes, DB, settings, cache) require a backend restart.
- If backend schema changes, restart to run migrations.
- Avoid unrelated cleanups; keep edits small and reversible.
