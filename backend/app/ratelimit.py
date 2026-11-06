"""Fixed-window rate limiter: Redis when available (shared across API replicas), in-memory otherwise."""
import threading
import time

from .config import get_settings


class Limiter:
    def __init__(self):
        self._mem: dict[str, tuple[int, float]] = {}
        self._lock = threading.Lock()
        self._redis = None
        url = get_settings().redis_url
        if url:
            try:
                import redis

                r = redis.Redis.from_url(url, socket_connect_timeout=0.5, socket_timeout=0.5)
                r.ping()
                self._redis = r
            except Exception:
                self._redis = None

    def allow(self, key: str, limit: int, window_s: int) -> bool:
        if self._redis is not None:
            try:
                bucket = f"rl:{key}:{int(time.time() // window_s)}"
                n = self._redis.incr(bucket)
                if n == 1:
                    self._redis.expire(bucket, window_s)
                return n <= limit
            except Exception:
                pass
        now = time.time()
        with self._lock:
            count, start = self._mem.get(key, (0, now))
            if now - start >= window_s:
                count, start = 0, now
            count += 1
            self._mem[key] = (count, start)
            return count <= limit

    def reset(self):
        self._mem.clear()
        if self._redis is not None:
            try:
                for k in self._redis.scan_iter("rl:*"):
                    self._redis.delete(k)
            except Exception:
                pass


limiter = Limiter()
