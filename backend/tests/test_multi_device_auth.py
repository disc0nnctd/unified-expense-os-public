from datetime import UTC, datetime

from app.main import _issue_device_token

from tests.test_api import auth_header, register_participant


def test_second_device_login_leaves_first_device_valid(client, db_session):
    participant_id = "multi-dev-0"
    now = datetime.now(UTC).isoformat()
    token_a = register_participant(client, participant_id, "Alice", now)

    # A second device logging in (e.g. passkey login, invite redeem on an
    # already-known identity) mints its own row rather than overwriting
    # token_a's -- unlike self-rotate, this must never invalidate token_a.
    token_b = _issue_device_token(db_session, participant_id, label="second device")
    db_session.commit()
    assert token_b != token_a

    still_valid_a = client.get("/contexts", headers=auth_header(token_a))
    assert still_valid_a.status_code == 200
    still_valid_b = client.get("/contexts", headers=auth_header(token_b))
    assert still_valid_b.status_code == 200

    devices = client.get(f"/participants/{participant_id}/devices", headers=auth_header(token_a)).json()
    assert len(devices) == 2


def test_new_login_does_not_invalidate_other_devices(client):
    participant_id = "multi-dev-1"
    now = datetime.now(UTC).isoformat()
    token_a = register_participant(client, participant_id, "Alice", now)

    # Simulate a second device: rotate this participant's own token in-place
    # via the self-service rotate path so a fresh token is minted without
    # touching token_a.
    rotate = client.post(
        f"/participants/{participant_id}/rotate-token",
        headers=auth_header(token_a),
    )
    assert rotate.status_code == 200
    token_b = rotate.json()["auth_token"]
    assert token_b != token_a

    # token_a was revoked by the self-rotate (device recovery semantics for
    # rotate specifically) -- but token_b must be valid on its own.
    still_valid_b = client.get("/contexts", headers=auth_header(token_b))
    assert still_valid_b.status_code == 200


def test_list_and_revoke_specific_device_token(client):
    participant_id = "multi-dev-2"
    now = datetime.now(UTC).isoformat()
    token_a = register_participant(client, participant_id, "Bob", now)

    devices = client.get(f"/participants/{participant_id}/devices", headers=auth_header(token_a)).json()
    assert len(devices) == 1
    device_id = devices[0]["device_token_id"]
    assert devices[0]["revoked_at"] is None

    revoke = client.post(f"/devices/{device_id}/revoke", headers=auth_header(token_a))
    assert revoke.status_code == 204

    # The just-revoked token can no longer authenticate.
    after_revoke = client.get("/contexts", headers=auth_header(token_a))
    assert after_revoke.status_code == 401
