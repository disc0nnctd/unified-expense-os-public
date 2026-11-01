import hashlib
from datetime import UTC, datetime

from app.models import DeviceTokenModel

from tests.test_api import auth_header, register_participant


def test_device_token_is_stored_only_as_a_hash(client, db_session):
    # unified-expense-os-jyg: DB/backup access must not hand out a live
    # credential — only a SHA-256 of the bearer token should ever be at rest.
    alice_token = register_participant(client, "alice", "Alice", datetime.now(UTC).isoformat())

    rows = db_session.query(DeviceTokenModel).filter_by(participant_id="alice").all()
    assert len(rows) == 1
    assert not hasattr(DeviceTokenModel, "token")
    assert rows[0].token_hash == hashlib.sha256(alice_token.encode()).hexdigest()
    assert rows[0].token_hash != alice_token


def test_self_rotation_returns_new_token_and_invalidates_old(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)

    response = client.post("/participants/alice/rotate-token", headers=auth_header(alice_token))
    assert response.status_code == 200
    new_token = response.json()["auth_token"]
    assert new_token is not None
    assert new_token != alice_token

    # Old token no longer works.
    stale = client.get("/contexts", headers=auth_header(alice_token))
    assert stale.status_code == 401

    # New token does.
    fresh = client.get("/contexts", headers=auth_header(new_token))
    assert fresh.status_code == 200


def test_owner_can_revoke_a_shared_context_members_token_without_learning_it(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    bob_token = register_participant(client, "bob", "Bob", now)

    client.post(
        "/contexts",
        json={
            "context_id": "ctx-home",
            "name": "Home",
            "type": "shared",
            "owner_participant_id": "alice",
            "created_at": now,
            "default_split": "equal",
            "allow_simplified_debts": False,
        },
        headers=auth_header(alice_token),
    )
    client.post(
        "/memberships",
        json={
            "membership_id": "m-bob",
            "context_id": "ctx-home",
            "participant_id": "bob",
            "joined_at": now,
            "default_share": "equal",
            "allow_simplify_for_me": True,
        },
        headers=auth_header(alice_token),
    )

    revoke = client.post("/participants/bob/rotate-token", headers=auth_header(alice_token))
    assert revoke.status_code == 200
    assert revoke.json()["auth_token"] is None  # owner never learns bob's new token

    # Bob's old token is now dead.
    stale = client.get("/contexts", headers=auth_header(bob_token))
    assert stale.status_code == 401


def test_departed_members_owner_loses_device_authority(client):
    # unified-expense-os-d55: the owner of a context Bob has since left must
    # not still be able to list or revoke Bob's devices.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    bob_token = register_participant(client, "bob", "Bob", now)

    client.post(
        "/contexts",
        json={
            "context_id": "ctx-home",
            "name": "Home",
            "type": "shared",
            "owner_participant_id": "alice",
            "created_at": now,
            "default_split": "equal",
            "allow_simplified_debts": False,
        },
        headers=auth_header(alice_token),
    )
    client.post(
        "/memberships",
        json={
            "membership_id": "m-bob",
            "context_id": "ctx-home",
            "participant_id": "bob",
            "joined_at": now,
            "default_share": "equal",
            "allow_simplify_for_me": True,
        },
        headers=auth_header(alice_token),
    )
    leave = client.post("/memberships/m-bob/leave", headers=auth_header(bob_token))
    assert leave.status_code == 200

    devices = client.get("/participants/bob/devices", headers=auth_header(alice_token))
    assert devices.status_code == 403

    revoke = client.post("/participants/bob/rotate-token", headers=auth_header(alice_token))
    assert revoke.status_code == 403

    # Bob's token is unaffected.
    still_valid = client.get("/contexts", headers=auth_header(bob_token))
    assert still_valid.status_code == 200


def test_non_owner_non_self_cannot_revoke(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    register_participant(client, "bob", "Bob", now)
    register_participant(client, "carol", "Carol", now)

    response = client.post("/participants/bob/rotate-token", headers=auth_header(alice_token))
    assert response.status_code == 403
