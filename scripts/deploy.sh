#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/ubuntu/Projects/bondsscanner"
export PATH="/home/ubuntu/.bun/bin:$PATH"

cd "$ROOT"
git pull --ff-only origin main

mkdir -p .logs

if [ ! -x ".venv/bin/python" ]; then
  uv venv -p 3.13 .venv
fi

uv pip install -r backend/requirements.txt --python .venv/bin/python

cd frontend
bun install
cd "$ROOT"

pkill -f "uvicorn app.main:app" || true
cd "$ROOT/backend"
nohup ../.venv/bin/uvicorn app.main:app --reload --port 8080 --host 127.0.0.1 > ../.logs/backend.log 2>&1 &

pkill -f "vite" || true
cd "$ROOT/frontend"
nohup bun run dev -- --host 0.0.0.0 --port 5173 > ../.logs/frontend.log 2>&1 &

if [ -f ".env" ] && rg -q "^LLM_QUEUE_BACKEND=celery" ".env"; then
  pkill -f "celery -A app.celery_app" || true
  nohup .venv/bin/celery -A app.celery_app worker --loglevel=INFO --concurrency=3 -Q bonds > .logs/celery.log 2>&1 &
fi
