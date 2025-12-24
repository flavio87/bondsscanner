# Versified Bonds

FastAPI + React tool to search SIX bonds and estimate returns (gross, after fees, after tax).

## Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
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
