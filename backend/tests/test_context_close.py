from datetime import UTC, datetime

from tests.test_api import auth_header, register_participant
from tests.test_invites import create_context_with_owner_membership


def _add_expense(client, token: str, entry_id: str, context_id: str, payer_id: str, other_id: str, now: str) -> None:
    response = client.post(
        "/ledger/entries",
        headers=auth_header(token),
        json={
            "entry_id": entry_id,
            "context_id": context_id,
            "type": "expense",
            "recorded_at": now,
            "effective_date": now[:10],
            "payer_id": payer_id,
            "total_amount": 1000,
            "currency": "INR",
            "description": "Dinner",
            "allocations": [
                {"participant_id": payer_id, "share_amount": 500, "is_payer": True},
                {"participant_id": other_id, "share_amount": 500, "is_payer": False},
            ],
            "hlc": f"{now}-0000-owner",
        },
    )
    assert response.status_code == 200


def test_close_context_blocks_with_outstanding_balances_unless_forced(client):
    owner_id = "owner-close"
    now = datetime.now(UTC).isoformat()
    token = register_participant(client, owner_id, "Owner", now)
    context_id = "ctx-close-1"
    create_context_with_owner_membership(client, token, context_id, owner_id, now)

    other_id = "other-close"
    register_participant(client, other_id, "Other", now)
    client.post(
        "/memberships",
        headers=auth_header(token),
        json={
            "membership_id": f"m-{context_id}-{other_id}",
            "context_id": context_id,
            "participant_id": other_id,
            "joined_at": now,
            "default_share": "equal",
        },
    )
    _add_expense(client, token, "e-close-1", context_id, owner_id, other_id, now)

    blocked = client.post(f"/contexts/{context_id}/close", headers=auth_header(token))
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["error"] == "outstanding_balances"

    forced = client.post(f"/contexts/{context_id}/close", headers=auth_header(token), params={"force": "true"})
    assert forced.status_code == 200
    assert forced.json()["closed_at"] is not None
    assert forced.json()["outstanding"]


def test_closed_context_rejects_new_ledger_entries_and_membership_changes(client):
    owner_id = "owner-close2"
    now = datetime.now(UTC).isoformat()
    token = register_participant(client, owner_id, "Owner", now)
    context_id = "ctx-close-2"
    create_context_with_owner_membership(client, token, context_id, owner_id, now)

    close = client.post(f"/contexts/{context_id}/close", headers=auth_header(token))
    assert close.status_code == 200

    entry_response = client.post(
        "/ledger/entries",
        headers=auth_header(token),
        json={
            "entry_id": "e-close-2",
            "context_id": context_id,
            "type": "expense",
            "recorded_at": now,
            "effective_date": now[:10],
            "payer_id": owner_id,
            "total_amount": 500,
            "currency": "INR",
            "description": "Should be rejected",
            "allocations": [{"participant_id": owner_id, "share_amount": 500, "is_payer": True}],
            "hlc": f"{now}-0001-owner",
        },
    )
    assert entry_response.status_code == 409
    assert entry_response.json()["detail"] == "context_closed"

    other_id = "other-close2"
    register_participant(client, other_id, "Other", now)
    membership_response = client.post(
        "/memberships",
        headers=auth_header(token),
        json={
            "membership_id": f"m-{context_id}-{other_id}",
            "context_id": context_id,
            "participant_id": other_id,
            "joined_at": now,
            "default_share": "equal",
        },
    )
    assert membership_response.status_code == 409

    prefs_response = client.patch(
        f"/contexts/{context_id}/preferences",
        headers=auth_header(token),
        json={"allow_simplified_debts": True},
    )
    assert prefs_response.status_code == 409

    # Re-closing an already-closed context is idempotent, not an error.
    reclose = client.post(f"/contexts/{context_id}/close", headers=auth_header(token))
    assert reclose.status_code == 200
    assert reclose.json()["closed_at"] is not None


def test_closed_context_rejects_recurring_template_writes(client):
    # unified-expense-os-rke: recurring generation writes ledger entries, so a
    # closed context must reject both creating a template and generating from
    # one that predates the close — otherwise "final" balances silently reopen.
    owner_id = "owner-close3"
    now = datetime.now(UTC).isoformat()
    token = register_participant(client, owner_id, "Owner", now)
    context_id = "ctx-close-3"
    create_context_with_owner_membership(client, token, context_id, owner_id, now)

    created = client.post(
        "/recurring/templates",
        headers=auth_header(token),
        json={
            "template_id": "tpl-close-3",
            "context_id": context_id,
            "description": "Rent",
            "amount": 100000,
            "split_rule": {"type": "equal"},
            "cadence": "monthly",
            "next_due_date": "2026-08-01",
            "anchor_day": 1,
            "active": True,
            "created_at": now,
        },
    )
    assert created.status_code == 200

    assert client.post(f"/contexts/{context_id}/close", headers=auth_header(token)).status_code == 200

    generated = client.post(
        "/recurring/templates/tpl-close-3/generate",
        headers=auth_header(token),
        params={"payer_id": owner_id, "as_of": "2026-09-02"},
    )
    assert generated.status_code == 409
    assert generated.json()["detail"] == "context_closed"

    new_template = client.post(
        "/recurring/templates",
        headers=auth_header(token),
        json={
            "template_id": "tpl-close-3b",
            "context_id": context_id,
            "description": "Internet",
            "amount": 50000,
            "split_rule": {"type": "equal"},
            "cadence": "monthly",
            "next_due_date": "2026-08-01",
            "anchor_day": 1,
            "active": True,
            "created_at": now,
        },
    )
    assert new_template.status_code == 409
    assert new_template.json()["detail"] == "context_closed"
