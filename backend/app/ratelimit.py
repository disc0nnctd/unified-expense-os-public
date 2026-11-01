from __future__ import annotations

import time


class SlidingWindowLimiter:
    """In-memory per-key sliding-window rate limiter.

    Deliberately simple (no Redis) since this is a single-process
    self-hosted deployment target; a multi-process deployment would need a
    shared store, which is out of scope here.
    """

    def __init__(self, max_requests: int, window_seconds: float) -> None:
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._hits: dict[str, list[float]] = {}

    def allow(self, key: str, now: float | None = None) -> bool:
        now = now if now is not None else time.monotonic()
        cutoff = now - self.window_seconds
        hits = [hit for hit in self._hits.get(key, []) if hit > cutoff]
        if len(hits) >= self.max_requests:
            self._hits[key] = hits
            return False
        hits.append(now)
        self._hits[key] = hits
        return True

    def reset(self) -> None:
        self._hits.clear()


# Shared instances so rate state persists across requests within one process.
invite_redemption_limiter = SlidingWindowLimiter(max_requests=10, window_seconds=60)
auth_failure_limiter = SlidingWindowLimiter(max_requests=20, window_seconds=60)
# The LLM relay endpoints forward participant-supplied prompts to a provider
# on the operator's key. Household chat volume is far below this ceiling; the
# cap is here so one authenticated member cannot run the endpoint as a
# general-purpose proxy (unified-expense-os-vf8).
llm_relay_limiter = SlidingWindowLimiter(max_requests=60, window_seconds=60)
