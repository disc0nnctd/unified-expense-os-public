from datetime import UTC, datetime

from tests.test_api import auth_header, register_participant


def test_settlement_plan_still_includes_a_removed_members_debt(client):
    """unified-expense-os-dr1: removing a member must not make their real
    debt un-settleable. Ravi owes Alice, Ravi gets removed from the context,
    and the settlement plan must still recommend Ravi -> Alice."""
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    register_participant(client, "ravi", "Ravi", now)

    client.post(
        "/contexts",
        headers=auth_header(alice_token),
        json={
            "context_id": "ctx-home",
            "name": "Home",
            "type": "shared",
            "owner_participant_id": "alice",
            "created_at": now,
            "default_split": "equal",
            "allow_simplified_debts": False,
        },
    )
    client.post(
        "/memberships",
        headers=auth_header(alice_token),
        json={
            "membership_id": "m-alice",
            "context_id": "ctx-home",
            "participant_id": "alice",
            "joined_at": now,
            "default_share": "equal",
            "allow_simplify_for_me": True,
        },
    )
    ravi_membership = client.post(
        "/memberships",
        headers=auth_header(alice_token),
        json={
            "membership_id": "m-ravi",
            "context_id": "ctx-home",
            "participant_id": "ravi",
            "joined_at": now,
            "default_share": "equal",
            "allow_simplify_for_me": True,
        },
    )
    assert ravi_membership.status_code == 200

    client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={
            "entries": [
                {
                    "entry_id": "e1",
                    "context_id": "ctx-home",
                    "type": "expense",
                    "recorded_at": now,
                    "effective_date": "2026-07-01",
                    "payer_id": "alice",
                    "total_amount": 1000,
                    "currency": "INR",
                    "description": "Groceries",
                    "allocations": [
                        {"participant_id": "alice", "share_amount": 500, "is_payer": True},
                        {"participant_id": "ravi", "share_amount": 500, "is_payer": False},
                    ],
                    "version": 1,
                    "hlc": "1-0-device",
                }
            ]
        },
    )

    before = client.get("/contexts/ctx-home/settlement-plan", headers=auth_header(alice_token)).json()
    assert any(row["from_participant_id"] == "ravi" and row["to_participant_id"] == "alice" for row in before["recommendations"])

    remove = client.post("/memberships/m-ravi/remove", headers=auth_header(alice_token))
    assert remove.status_code == 200

    after = client.get("/contexts/ctx-home/settlement-plan", headers=auth_header(alice_token)).json()
    assert any(
        row["from_participant_id"] == "ravi" and row["to_participant_id"] == "alice" and row["amount_cents"] == 500
        for row in after["recommendations"]
    ), f"Ravi's debt disappeared after removal: {after}"


def test_balances_endpoint_still_includes_a_removed_members_balance(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    register_participant(client, "ravi", "Ravi", now)

    client.post(
        "/contexts",
        headers=auth_header(alice_token),
        json={
            "context_id": "ctx-home2",
            "name": "Home2",
            "type": "shared",
            "owner_participant_id": "alice",
            "created_at": now,
            "default_split": "equal",
            "allow_simplified_debts": False,
        },
    )
    client.post(
        "/memberships",
        headers=auth_header(alice_token),
        json={
            "membership_id": "m-alice2",
            "context_id": "ctx-home2",
            "participant_id": "alice",
            "joined_at": now,
            "default_share": "equal",
            "allow_simplify_for_me": True,
        },
    )
    client.post(
        "/memberships",
        headers=auth_header(alice_token),
        json={
            "membership_id": "m-ravi2",
            "context_id": "ctx-home2",
            "participant_id": "ravi",
            "joined_at": now,
            "default_share": "equal",
            "allow_simplify_for_me": True,
        },
    )
    client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={
            "entries": [
                {
                    "entry_id": "e2",
                    "context_id": "ctx-home2",
                    "type": "expense",
                    "recorded_at": now,
                    "effective_date": "2026-07-01",
                    "payer_id": "alice",
                    "total_amount": 1000,
                    "currency": "INR",
                    "description": "Groceries",
                    "allocations": [
                        {"participant_id": "alice", "share_amount": 500, "is_payer": True},
                        {"participant_id": "ravi", "share_amount": 500, "is_payer": False},
                    ],
                    "version": 1,
                    "hlc": "1-0-device",
                }
            ]
        },
    )
    client.post("/memberships/m-ravi2/remove", headers=auth_header(alice_token))
    balances = client.get("/contexts/ctx-home2/balances", headers=auth_header(alice_token)).json()
    ravi_row = next((row for row in balances if row["participant_id"] == "ravi"), None)
    assert ravi_row is not None, f"Ravi missing from balances entirely: {balances}"
    assert ravi_row["net_balance"] == -500
