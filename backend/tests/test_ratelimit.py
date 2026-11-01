from app.ratelimit import SlidingWindowLimiter


def test_allows_up_to_max_requests_then_blocks():
    limiter = SlidingWindowLimiter(max_requests=3, window_seconds=60)
    assert limiter.allow("k", now=0) is True
    assert limiter.allow("k", now=1) is True
    assert limiter.allow("k", now=2) is True
    assert limiter.allow("k", now=3) is False


def test_window_expiry_allows_requests_again():
    limiter = SlidingWindowLimiter(max_requests=2, window_seconds=10)
    assert limiter.allow("k", now=0) is True
    assert limiter.allow("k", now=1) is True
    assert limiter.allow("k", now=2) is False
    # Past the window: old hits should no longer count.
    assert limiter.allow("k", now=12) is True


def test_keys_are_independent():
    limiter = SlidingWindowLimiter(max_requests=1, window_seconds=60)
    assert limiter.allow("a", now=0) is True
    assert limiter.allow("b", now=0) is True
    assert limiter.allow("a", now=1) is False
