#!/bin/sh
set -e
# Apply database migrations before serving
alembic upgrade head
if [ "${CW_SEED_DEMO:-false}" = "true" ]; then
  python -m app.seed
fi
exec gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w "${WEB_CONCURRENCY:-3}" -b 0.0.0.0:8000 \
  --forwarded-allow-ips="*" --access-logfile - --timeout 120
