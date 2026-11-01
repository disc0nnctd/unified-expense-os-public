from datetime import UTC, datetime

from tests.test_api import auth_header, register_participant
from tests.test_invites import create_context_with_owner_membership


def test_context_preference_update_bumps_version(client):
    owner_id = "owner-cv"
    now0 = datetime.now(UTC).isoformat()
    token = register_participant(client, owner_id, "Owner", now0)
    now = datetime.now(UTC).isoformat()
    create_context_with_owner_membership(client, token, "ctx-cv-1", owner_id, now)

    response = client.patch(
        "/contexts/ctx-cv-1/preferences",
        headers=auth_header(token),
        json={"allow_simplified_debts": True},
    )
    assert response.status_code == 200
    assert response.json()["version"] == 2

    response = client.patch(
        "/contexts/ctx-cv-1/preferences",
        headers=auth_header(token),
        json={"allow_simplified_debts": False},
    )
    assert response.status_code == 200
    assert response.json()["version"] == 3


def test_context_preference_stale_expected_version_is_rejected(client):
    owner_id = "owner-cv2"
    now0 = datetime.now(UTC).isoformat()
    token = register_participant(client, owner_id, "Owner", now0)
    now = datetime.now(UTC).isoformat()
    create_context_with_owner_membership(client, token, "ctx-cv-2", owner_id, now)

    # Device A reads version 1, then someone else (device B) updates first.
    first = client.patch(
        "/contexts/ctx-cv-2/preferences",
        headers=auth_header(token),
        json={"allow_simplified_debts": True},
    )
    assert first.status_code == 200
    assert first.json()["version"] == 2

    # Device A retries against the version it originally saw (1) — stale.
    stale = client.patch(
        "/contexts/ctx-cv-2/preferences",
        headers=auth_header(token),
        json={"allow_simplified_debts": False, "expected_version": 1},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["current_version"] == 2

    # Retrying with the current version succeeds and converges.
    retry = client.patch(
        "/contexts/ctx-cv-2/preferences",
        headers=auth_header(token),
        json={"allow_simplified_debts": False, "expected_version": 2},
    )
    assert retry.status_code == 200
    assert retry.json()["version"] == 3
    assert retry.json()["allow_simplified_debts"] is False


def test_membership_preference_update_bumps_version_and_rejects_stale_write(client):
    owner_id = "owner-mv"
    now0 = datetime.now(UTC).isoformat()
    token = register_participant(client, owner_id, "Owner", now0)
    now = datetime.now(UTC).isoformat()
    create_context_with_owner_membership(client, token, "ctx-mv-1", owner_id, now)
    membership_id = f"m-ctx-mv-1-{owner_id}"

    ok = client.patch(
        f"/memberships/{membership_id}/preferences",
        headers=auth_header(token),
        json={"allow_simplify_for_me": False},
    )
    assert ok.status_code == 200
    assert ok.json()["version"] == 2

    stale = client.patch(
        f"/memberships/{membership_id}/preferences",
        headers=auth_header(token),
        json={"allow_simplify_for_me": True, "expected_version": 1},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["current_version"] == 2


def test_list_contexts_and_memberships_reflect_current_version(client):
    owner_id = "owner-lv"
    now0 = datetime.now(UTC).isoformat()
    token = register_participant(client, owner_id, "Owner", now0)
    now = datetime.now(UTC).isoformat()
    create_context_with_owner_membership(client, token, "ctx-lv-1", owner_id, now)

    client.patch(
        "/contexts/ctx-lv-1/preferences",
        headers=auth_header(token),
        json={"allow_simplified_debts": True},
    )
    contexts = client.get("/contexts", headers=auth_header(token)).json()
    ctx = next(c for c in contexts if c["context_id"] == "ctx-lv-1")
    assert ctx["version"] == 2

    membership_id = f"m-ctx-lv-1-{owner_id}"
    client.patch(
        f"/memberships/{membership_id}/preferences",
        headers=auth_header(token),
        json={"allow_simplify_for_me": False},
    )
    memberships = client.get("/contexts/ctx-lv-1/memberships", headers=auth_header(token)).json()
    membership = next(m for m in memberships if m["membership_id"] == membership_id)
    assert membership["version"] == 2
