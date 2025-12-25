# Versified Bonds

FastAPI + React tool to search SIX bonds and estimate returns (gross, after fees, after tax).

## Backend

```bash
uv venv -p 3.13 .venv
uv pip install -r backend/requirements.txt --python .venv/bin/python
source .venv/bin/activate
cd backend
uvicorn app.main:app --reload --port 8080
```

### Optional: Celery + Redis for parallel LLM jobs

```bash
# ensure Redis is running locally
# set in .env: LLM_QUEUE_BACKEND=celery and REDIS_URL=redis://localhost:6379/0

cd backend
source .venv/bin/activate
celery -A app.celery_app worker --loglevel=INFO --concurrency=3 -Q bonds
```

## Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend proxies `/api` to `http://localhost:8080` in development.

## Notes

- Bond data comes from SIX public FQS and Sheldon endpoints.
- Yield math is approximate (linear accrual + simplified coupon schedule).
- Fee defaults are editable and set to a conservative IBKR-style schedule.
