"""Background worker: re-runs the early-warning assessment on a schedule.

Run with ``python -m app.worker``. With several replicas, a Redis lock ensures one run at a time.
"""
import logging
import signal
import time

from .config import get_settings
from .db import SessionLocal
from .services import forest_alerts, risk

log = logging.getLogger("chimpwatch.worker")
_stop = False


def _handle(*_):
    global _stop
    _stop = True


def run_once() -> dict:
    with SessionLocal() as db:
        if forest_alerts.due(db):
            try:
                log.info("forest alert sync: %s", forest_alerts.sync(db))
            except Exception:
                log.exception("forest alert sync failed")
        return risk.run_all(db)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    signal.signal(signal.SIGTERM, _handle)
    signal.signal(signal.SIGINT, _handle)
    s = get_settings()
    rds = None
    if s.redis_url:
        try:
            import redis
            rds = redis.Redis.from_url(s.redis_url)
            rds.ping()
        except Exception:
            rds = None
    interval = s.worker_interval_minutes * 60
    log.info("worker started; interval %s min", s.worker_interval_minutes)
    while not _stop:
        lock = rds.lock("chimpwatch:risk-run", timeout=1800, blocking=False) if rds else None
        if lock is None or lock.acquire():
            try:
                log.info("risk run complete: %s", run_once())
            except Exception:
                log.exception("risk run failed")
            finally:
                if lock is not None:
                    try:
                        lock.release()
                    except Exception:
                        pass
        for _ in range(interval):
            if _stop:
                break
            time.sleep(1)


if __name__ == "__main__":
    main()
