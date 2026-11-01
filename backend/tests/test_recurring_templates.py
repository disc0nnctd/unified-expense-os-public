from datetime import UTC, date, datetime

from tests.test_api import auth_header, register_participant
from tests.test_invites import create_context_with_owner_membership


def create_template(client, token: str, template_id: str, context_id: str, now: str, **overrides) -> dict:
    payload = {
        "template_id": template_id,
        "context_id": context_id,
        "description": "Rent",
        "amount": 100000,
        "split_rule": {},
        "cadence": "monthly",
        "next_due_date": "2026-08-01",
        "anchor_day": 1,
        "active": True,
        "created_at": now,
        **overrides,
    }
    response = client.post("/recurring/templates", headers=auth_header(token), json=payload)
    assert response.status_code == 200
    return response.json()


def test_create_returns_version_one(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)

    created = create_template(client, alice_token, "tpl-rent", "ctx-home", now)
    assert created["version"] == 1
    assert created["active"] is True


def test_list_includes_inactive_templates(client):
    # unified-expense-os-2x2: paused templates must stay visible (with a way
    # to resume them), not disappear from the list entirely.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)
    create_template(client, alice_token, "tpl-rent", "ctx-home", now)

    pause = client.patch(
        "/recurring/templates/tpl-rent", headers=auth_header(alice_token), json={"active": False}
    )
    assert pause.status_code == 200
    assert pause.json()["active"] is False
    assert pause.json()["version"] == 2

    listing = client.get("/contexts/ctx-home/recurring-templates", headers=auth_header(alice_token))
    assert listing.status_code == 200
    assert [row["template_id"] for row in listing.json()] == ["tpl-rent"]
    assert listing.json()[0]["active"] is False


def test_patch_edits_amount_description_and_anchor_day(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)
    create_template(client, alice_token, "tpl-rent", "ctx-home", now)

    response = client.patch(
        "/recurring/templates/tpl-rent",
        headers=auth_header(alice_token),
        json={"description": "Rent (2027 rate)", "amount": 120000, "anchor_day": 5},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["description"] == "Rent (2027 rate)"
    assert body["amount"] == 120000
    assert body["anchor_day"] == 5
    assert body["version"] == 2


def test_patch_rejects_stale_expected_version(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)
    create_template(client, alice_token, "tpl-rent", "ctx-home", now)

    stale = client.patch(
        "/recurring/templates/tpl-rent",
        headers=auth_header(alice_token),
        json={"amount": 999, "expected_version": 99},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["error"] == "version_conflict"


def test_generate_rejects_a_paused_template(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)
    create_template(client, alice_token, "tpl-rent", "ctx-home", now)
    client.patch("/recurring/templates/tpl-rent", headers=auth_header(alice_token), json={"active": False})

    response = client.post(
        "/recurring/templates/tpl-rent/generate",
        headers=auth_header(alice_token),
        params={"payer_id": "alice", "as_of": str(date(2026, 8, 15))},
    )
    assert response.status_code == 404


def test_patch_requires_context_access(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)
    create_template(client, alice_token, "tpl-rent", "ctx-home", now)

    mallory_token = register_participant(client, "mallory", "Mallory", now)
    response = client.patch(
        "/recurring/templates/tpl-rent",
        headers=auth_header(mallory_token),
        json={"amount": 1},
    )
    assert response.status_code == 403


def test_weekly_cadence_generates_weekly_occurrences(client):
    # unified-expense-os-59q: the schema advertised "weekly" while generation
    # raised unsupported_cadence, so any weekly template 500'd on generate.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)
    create_template(
        client,
        alice_token,
        "tpl-weekly",
        "ctx-home",
        now,
        description="Groceries",
        amount=50000,
        split_rule={"type": "equal"},
        cadence="weekly",
        next_due_date="2026-08-03",
    )

    generated = client.post(
        "/recurring/templates/tpl-weekly/generate",
        headers=auth_header(alice_token),
        params={"payer_id": "alice", "as_of": "2026-08-24"},
    )
    assert generated.status_code == 200
    dates = [entry["effective_date"] for entry in generated.json()["entries"]]
    assert dates == ["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"]

    # Re-running is idempotent: generation keys already exist.
    again = client.post(
        "/recurring/templates/tpl-weekly/generate",
        headers=auth_header(alice_token),
        params={"payer_id": "alice", "as_of": "2026-08-24"},
    )
    assert again.status_code == 200
    assert again.json()["entries"] == []
