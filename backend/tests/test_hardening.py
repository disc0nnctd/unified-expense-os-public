from datetime import UTC, datetime

from app.ratelimit import auth_failure_limiter, invite_redemption_limiter
from tests.test_api import auth_header, register_participant
from tests.test_invites import create_context_with_owner_membership


def test_open_registration_mode_is_the_default(client):
    response = client.post(
        "/participants",
        json={
            "participant_id": "alice",
            "display_name": "Alice",
            "is_ghost": False,
            "created_at": datetime.now(UTC).isoformat(),
        },
    )
    assert response.status_code == 200


def test_invite_only_mode_blocks_open_registration(client, monkeypatch):
    # unified-expense-os-bvp: a deployment exposed beyond a trusted LAN can
    # opt into REGISTRATION_MODE=invite-only so strangers can't self-register.
    monkeypatch.setenv("REGISTRATION_MODE", "invite-only")
    response = client.post(
        "/participants",
        json={
            "participant_id": "mallory",
            "display_name": "Mallory",
            "is_ghost": False,
            "created_at": datetime.now(UTC).isoformat(),
        },
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "registration_invite_only"


def test_invite_only_mode_still_allows_redeeming_an_invite(client, monkeypatch):
    # Locking down open self-registration must not break the one legitimate
    # path for a new identity to join: redeeming an invite.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)
    invite = client.post("/contexts/ctx-home/invites", headers=auth_header(alice_token))
    invite_code = invite.json()["invite_code"]

    monkeypatch.setenv("REGISTRATION_MODE", "invite-only")
    redeem = client.post(
        "/invites/redeem",
        json={"invite_code": invite_code, "participant_id": "bob", "display_name": "Bob"},
    )
    assert redeem.status_code == 200
    assert redeem.json()["participant_id"] == "bob"


def test_capture_classify_requires_auth(client):
    response = client.post("/capture/classify", json={"text": "rent to Sharma"})
    assert response.status_code == 401


def test_security_headers_present_on_every_response(client):
    response = client.get("/healthz")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_auth_failures_are_rate_limited(client):
    auth_failure_limiter.reset()
    for _ in range(20):
        response = client.get("/contexts", headers=auth_header("not-a-real-token"))
        assert response.status_code == 401
    limited = client.get("/contexts", headers=auth_header("not-a-real-token"))
    assert limited.status_code == 429
    auth_failure_limiter.reset()


def test_invite_redemption_is_rate_limited(client):
    invite_redemption_limiter.reset()
    for _ in range(10):
        response = client.post("/invites/redeem", json={"invite_code": "NOTREAL1"})
        assert response.status_code == 404
    limited = client.post("/invites/redeem", json={"invite_code": "NOTREAL1"})
    assert limited.status_code == 429
    invite_redemption_limiter.reset()


def test_valid_auth_is_never_rate_limited_by_auth_failure_bucket(client):
    auth_failure_limiter.reset()
    token = register_participant(client, "alice", "Alice", datetime.now(UTC).isoformat())
    for _ in range(30):
        response = client.get("/contexts", headers=auth_header(token))
        assert response.status_code == 200
    auth_failure_limiter.reset()
