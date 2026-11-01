import json
from datetime import UTC, datetime

from tests.test_api import auth_header, register_participant


def test_registration_begin_requires_auth(client):
    response = client.post("/webauthn/registration/begin")
    assert response.status_code == 401


def test_registration_begin_returns_options_bound_to_participant(client):
    token = register_participant(client, "alice", "Alice", datetime.now(UTC).isoformat())
    response = client.post("/webauthn/registration/begin", headers=auth_header(token))
    assert response.status_code == 200
    body = response.json()
    options = json.loads(body["options_json"])
    assert options["user"]["name"] == "alice"
    assert options["rp"]["id"] == "localhost"


def test_login_begin_for_participant_with_no_passkey_returns_404_never_a_token(client):
    register_participant(client, "alice", "Alice", datetime.now(UTC).isoformat())
    response = client.post("/webauthn/login/begin", json={"participant_id": "alice"})
    assert response.status_code == 404
    assert "auth_token" not in response.json()


def test_login_begin_for_unknown_participant_returns_404(client):
    response = client.post("/webauthn/login/begin", json={"participant_id": "nobody"})
    assert response.status_code == 404


def test_registration_finish_rejects_forged_credential(client):
    """Adversarial check: a well-formed-but-fabricated credential response
    must be rejected by real signature verification, not accepted because
    the shape looks right."""
    token = register_participant(client, "alice", "Alice", datetime.now(UTC).isoformat())
    begin = client.post("/webauthn/registration/begin", headers=auth_header(token))
    flow_id = begin.json()["flow_id"]

    forged_credential = {
        "id": "not-a-real-credential-id",
        "rawId": "bm90LWEtcmVhbC1jcmVkZW50aWFsLWlk",
        "response": {
            "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiZmFrZSIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6NTE3MyJ9",
            "attestationObject": "o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVjE",
        },
        "type": "public-key",
        "clientExtensionResults": {},
    }
    finish = client.post(
        "/webauthn/registration/finish",
        headers=auth_header(token),
        json={"flow_id": flow_id, "credential": forged_credential},
    )
    assert finish.status_code == 400


def test_login_finish_rejects_forged_assertion_against_no_registered_credential(client):
    """A participant with zero registered credentials can never reach a
    successful login, no matter what assertion shape is submitted."""
    register_participant(client, "alice", "Alice", datetime.now(UTC).isoformat())
    response = client.post(
        "/webauthn/login/finish",
        json={
            "flow_id": "auth_nonexistent",
            "participant_id": "alice",
            "credential": {"id": "x", "rawId": "eA==", "response": {}, "type": "public-key"},
        },
    )
    assert response.status_code == 401
    assert "auth_token" not in response.json()


def test_rename_requires_auth(client):
    response = client.patch("/participants/me", json={"display_name": "New Name"})
    assert response.status_code == 401


def test_rename_updates_display_name(client):
    token = register_participant(client, "alice", "Alice", datetime.now(UTC).isoformat())
    response = client.patch("/participants/me", json={"display_name": "Alicia"}, headers=auth_header(token))
    assert response.status_code == 200
    assert response.json()["display_name"] == "Alicia"

    # Propagation check: a membership summary fetched by anyone with access
    # reflects the new name immediately — no separate sync step needed,
    # since display_name is denormalized fresh into MembershipSummary on
    # every read rather than cached/diffed client-side.
    now = datetime.now(UTC).isoformat()
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
        headers=auth_header(token),
    )
    client.post(
        "/memberships",
        json={
            "membership_id": "m-alice",
            "context_id": "ctx-home",
            "participant_id": "alice",
            "joined_at": now,
            "default_share": "equal",
            "allow_simplify_for_me": True,
        },
        headers=auth_header(token),
    )
    memberships = client.get("/contexts/ctx-home/memberships", headers=auth_header(token)).json()
    assert memberships[0]["display_name"] == "Alicia"

