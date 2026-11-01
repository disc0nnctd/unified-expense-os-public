from datetime import UTC, datetime


def register_participant(client, participant_id: str, display_name: str, created_at: str) -> str:
    response = client.post(
        "/participants",
        json={
            "participant_id": participant_id,
            "display_name": display_name,
            "is_ghost": False,
            "created_at": created_at,
        },
    )
    assert response.status_code == 200
    return response.json()["auth_token"]


def auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_context_entry_and_sync_round_trip(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    register_participant(client, "bob", "Bob", now)

    context_response = client.post(
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
    assert context_response.status_code == 200

    membership_a = client.post(
        "/memberships",
        headers=auth_header(alice_token),
        json={
            "membership_id": "m1",
            "context_id": "ctx-home",
            "participant_id": "alice",
            "joined_at": now,
            "default_share": "1/2",
            "allow_simplify_for_me": True,
        },
    )
    membership_b = client.post(
        "/memberships",
        headers=auth_header(alice_token),
        json={
            "membership_id": "m2",
            "context_id": "ctx-home",
            "participant_id": "bob",
            "joined_at": now,
            "default_share": "1/2",
            "allow_simplify_for_me": True,
        },
    )
    assert membership_a.status_code == 200
    assert membership_b.status_code == 200

    push = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={
            "entries": [
                {
                    "entry_id": "rent-june",
                    "context_id": "ctx-home",
                    "type": "expense",
                    "recorded_at": now,
                    "effective_date": "2026-06-01",
                    "payer_id": "alice",
                    "total_amount": 30000,
                    "currency": "INR",
                    "description": "Rent",
                    "allocations": [
                        {"participant_id": "alice", "share_amount": 15000, "is_payer": True},
                        {"participant_id": "bob", "share_amount": 15000, "is_payer": False},
                    ],
                    "version": 1,
                    "hlc": "1000-0-device",
                }
            ]
        },
    )
    assert push.status_code == 200
    assert push.json()[0]["status"] == "accepted"

    balances = client.get("/contexts/ctx-home/balances", headers=auth_header(alice_token))
    assert balances.status_code == 200
    assert balances.json() == [
        {"participant_id": "alice", "net_balance": 15000, "currency": "INR"},
        {"participant_id": "bob", "net_balance": -15000, "currency": "INR"},
    ]

    pull = client.get("/sync/pull", headers=auth_header(alice_token), params={"context_id": "ctx-home", "after_seq": 0})
    assert pull.status_code == 200
    body = pull.json()
    assert body["max_server_seq"] == 1
    assert body["entries"][0]["entry_id"] == "rent-june"

    contexts = client.get("/contexts", headers=auth_header(alice_token))
    assert contexts.status_code == 200
    assert contexts.json()[0]["context_id"] == "ctx-home"

    memberships = client.get("/contexts/ctx-home/memberships", headers=auth_header(alice_token))
    assert memberships.status_code == 200
    assert {row["participant_id"] for row in memberships.json()} == {"alice", "bob"}


def test_settlement_plan_respects_opt_out_members(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    bob_token = register_participant(client, "bob", "Bob", now)
    register_participant(client, "carol", "Carol", now)

    context_response = client.post(
        "/contexts",
        headers=auth_header(alice_token),
        json={
            "context_id": "ctx-trip",
            "name": "Trip",
            "type": "shared",
            "owner_participant_id": "alice",
            "created_at": now,
            "default_split": "equal",
            "allow_simplified_debts": True,
        },
    )
    assert context_response.status_code == 200

    for membership_id, participant_id, allow_simplify_for_me in (
        ("m-trip-alice", "alice", True),
        ("m-trip-bob", "bob", False),
        ("m-trip-carol", "carol", True),
    ):
        response = client.post(
            "/memberships",
            headers=auth_header(alice_token),
            json={
                "membership_id": membership_id,
                "context_id": "ctx-trip",
                "participant_id": participant_id,
                "joined_at": now,
                "default_share": "1/3",
                "allow_simplify_for_me": allow_simplify_for_me,
            },
        )
        assert response.status_code == 200

    push = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={
            "entries": [
                {
                    "entry_id": "bob-paid-for-alice",
                    "context_id": "ctx-trip",
                    "type": "expense",
                    "recorded_at": now,
                    "effective_date": "2026-06-01",
                    "payer_id": "bob",
                    "total_amount": 10000,
                    "currency": "INR",
                    "description": "Bob covered Alice",
                    "allocations": [
                        {"participant_id": "bob", "share_amount": 0, "is_payer": True},
                        {"participant_id": "alice", "share_amount": 10000, "is_payer": False},
                    ],
                    "version": 1,
                    "hlc": "1000-0-device",
                },
                {
                    "entry_id": "carol-paid-for-bob",
                    "context_id": "ctx-trip",
                    "type": "expense",
                    "recorded_at": now,
                    "effective_date": "2026-06-01",
                    "payer_id": "carol",
                    "total_amount": 10000,
                    "currency": "INR",
                    "description": "Carol covered Bob",
                    "allocations": [
                        {"participant_id": "carol", "share_amount": 0, "is_payer": True},
                        {"participant_id": "bob", "share_amount": 10000, "is_payer": False},
                    ],
                    "version": 1,
                    "hlc": "1001-0-device",
                },
            ]
        },
    )
    assert push.status_code == 200

    plan = client.get("/contexts/ctx-trip/settlement-plan", headers=auth_header(alice_token))
    assert plan.status_code == 200
    assert plan.json() == {
        "context_id": "ctx-trip",
        "currency": "INR",
        "simplification_enabled": True,
        "excluded_participant_ids": ["bob"],
        "recommendations": [
            {
                "from_participant_id": "alice",
                "to_participant_id": "bob",
                "amount_cents": 10000,
                "kind": "pairwise",
                "currency": "INR",
            },
            {
                "from_participant_id": "bob",
                "to_participant_id": "carol",
                "amount_cents": 10000,
                "kind": "pairwise",
                "currency": "INR",
            },
        ],
    }

    toggle = client.patch(
        "/memberships/m-trip-bob/preferences",
        headers=auth_header(bob_token),
        json={"allow_simplify_for_me": True},
    )
    assert toggle.status_code == 200

    simplified_plan = client.get("/contexts/ctx-trip/settlement-plan", headers=auth_header(alice_token))
    assert simplified_plan.status_code == 200
    assert simplified_plan.json() == {
        "context_id": "ctx-trip",
        "currency": "INR",
        "simplification_enabled": True,
        "excluded_participant_ids": [],
        "recommendations": [
            {
                "from_participant_id": "alice",
                "to_participant_id": "carol",
                "amount_cents": 10000,
                "kind": "simplified",
                "currency": "INR",
            }
        ],
    }


def test_confirm_settlement_recommendation_records_pairwise_entry(client):
    # Given: Bob owes Alice from a synced household expense.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    bob_token = register_participant(client, "bob", "Bob", now)

    context_response = client.post(
        "/contexts",
        headers=auth_header(alice_token),
        json={
            "context_id": "ctx-settle",
            "name": "Home",
            "type": "shared",
            "owner_participant_id": "alice",
            "created_at": now,
            "default_split": "equal",
            "allow_simplified_debts": False,
        },
    )
    assert context_response.status_code == 200

    for membership_id, participant_id in (("m-settle-alice", "alice"), ("m-settle-bob", "bob")):
        response = client.post(
            "/memberships",
            headers=auth_header(alice_token),
            json={
                "membership_id": membership_id,
                "context_id": "ctx-settle",
                "participant_id": participant_id,
                "joined_at": now,
                "default_share": "1/2",
                "allow_simplify_for_me": True,
            },
        )
        assert response.status_code == 200

    push = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={
            "entries": [
                {
                    "entry_id": "rent-settle",
                    "context_id": "ctx-settle",
                    "type": "expense",
                    "recorded_at": now,
                    "effective_date": "2026-06-01",
                    "payer_id": "alice",
                    "total_amount": 30000,
                    "currency": "INR",
                    "description": "Rent",
                    "allocations": [
                        {"participant_id": "alice", "share_amount": 15000, "is_payer": True},
                        {"participant_id": "bob", "share_amount": 15000, "is_payer": False},
                    ],
                    "version": 1,
                    "hlc": "1000-0-device",
                }
            ]
        },
    )
    assert push.status_code == 200

    # When: the current recommendation is confirmed.
    response = client.post(
        "/contexts/ctx-settle/settlements",
        headers=auth_header(bob_token),
        json={
            "from_participant_id": "bob",
            "to_participant_id": "alice",
            "amount_cents": 15000,
            "kind": "pairwise",
        },
    )

    # Then: a settlement ledger entry is recorded and balances are neutralized.
    assert response.status_code == 200
    body = response.json()
    assert body["type"] == "settlement"
    assert body["payer_id"] == "bob"
    assert body["total_amount"] == 15000
    assert body["description"] == "Settlement: Bob paid Alice"
    assert body["allocations"] == [
        {"participant_id": "bob", "share_amount": 0, "is_payer": True},
        {"participant_id": "alice", "share_amount": 15000, "is_payer": False},
    ]

    balances = client.get("/contexts/ctx-settle/balances", headers=auth_header(alice_token))
    assert balances.status_code == 200
    assert balances.json() == [
        {"participant_id": "alice", "net_balance": 0, "currency": "INR"},
        {"participant_id": "bob", "net_balance": 0, "currency": "INR"},
    ]


def test_settlement_plan_and_balances_do_not_mix_currencies(client):
    # Given: a context with two INR expenses (the dominant currency by count)
    # and one USD expense — unified-expense-os-zj0 found these being summed
    # together into one nonsense "amount_cents" figure.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    bob_token = register_participant(client, "bob", "Bob", now)

    context_response = client.post(
        "/contexts",
        headers=auth_header(alice_token),
        json={
            "context_id": "ctx-multi-currency",
            "name": "Trip",
            "type": "shared",
            "owner_participant_id": "alice",
            "created_at": now,
            "default_split": "equal",
            "allow_simplified_debts": False,
        },
    )
    assert context_response.status_code == 200

    for membership_id, participant_id in (("m-mc-alice", "alice"), ("m-mc-bob", "bob")):
        response = client.post(
            "/memberships",
            headers=auth_header(alice_token),
            json={
                "membership_id": membership_id,
                "context_id": "ctx-multi-currency",
                "participant_id": participant_id,
                "joined_at": now,
                "default_share": "1/2",
            },
        )
        assert response.status_code == 200

    def expense(entry_id: str, hlc: str, currency: str, total: int) -> dict:
        return {
            "entry_id": entry_id,
            "context_id": "ctx-multi-currency",
            "type": "expense",
            "recorded_at": now,
            "effective_date": "2026-07-01",
            "payer_id": "alice",
            "total_amount": total,
            "currency": currency,
            "description": f"{currency} expense",
            "allocations": [
                {"participant_id": "alice", "share_amount": total // 2, "is_payer": True},
                {"participant_id": "bob", "share_amount": total - total // 2, "is_payer": False},
            ],
            "version": 1,
            "hlc": hlc,
        }

    push = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={
            "entries": [
                expense("inr-1", "1000-0-a", "INR", 1000),
                expense("inr-2", "1001-0-a", "INR", 2000),
                expense("usd-1", "1002-0-a", "USD", 7700),
            ]
        },
    )
    assert push.status_code == 200
    assert all(item["status"] == "accepted" for item in push.json())

    balances = client.get("/contexts/ctx-multi-currency/balances", headers=auth_header(alice_token))
    assert balances.status_code == 200
    assert balances.json() == [
        {"participant_id": "alice", "net_balance": 1500, "currency": "INR"},
        {"participant_id": "bob", "net_balance": -1500, "currency": "INR"},
    ]

    plan = client.get("/contexts/ctx-multi-currency/settlement-plan", headers=auth_header(alice_token))
    assert plan.status_code == 200
    body = plan.json()
    assert body["currency"] == "INR"
    assert body["recommendations"] == [
        {
            "from_participant_id": "bob",
            "to_participant_id": "alice",
            "amount_cents": 1500,
            "kind": "pairwise",
            "currency": "INR",
        }
    ]

    # And: recording the recommended settlement writes an INR entry, not a
    # cross-currency figure mislabeled as INR.
    settle = client.post(
        "/contexts/ctx-multi-currency/settlements",
        headers=auth_header(bob_token),
        json={
            "from_participant_id": "bob",
            "to_participant_id": "alice",
            "amount_cents": 1500,
            "kind": "pairwise",
        },
    )
    assert settle.status_code == 200
    assert settle.json()["currency"] == "INR"
    assert settle.json()["total_amount"] == 1500


def test_confirm_settlement_rejects_non_recommended_payment(client):
    # Given: a context with no outstanding recommendation.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    bob_token = register_participant(client, "bob", "Bob", now)

    context_response = client.post(
        "/contexts",
        headers=auth_header(alice_token),
        json={
            "context_id": "ctx-empty-settle",
            "name": "Home",
            "type": "shared",
            "owner_participant_id": "alice",
            "created_at": now,
            "default_split": "equal",
            "allow_simplified_debts": False,
        },
    )
    assert context_response.status_code == 200

    for membership_id, participant_id in (("m-empty-alice", "alice"), ("m-empty-bob", "bob")):
        response = client.post(
            "/memberships",
            headers=auth_header(alice_token),
            json={
                "membership_id": membership_id,
                "context_id": "ctx-empty-settle",
                "participant_id": participant_id,
                "joined_at": now,
                "default_share": "1/2",
                "allow_simplify_for_me": True,
            },
        )
        assert response.status_code == 200

    # When: a fabricated settlement is posted.
    response = client.post(
        "/contexts/ctx-empty-settle/settlements",
        headers=auth_header(bob_token),
        json={
            "from_participant_id": "bob",
            "to_participant_id": "alice",
            "amount_cents": 15000,
            "kind": "pairwise",
        },
    )

    # Then: the backend rejects it before ledger insertion.
    assert response.status_code == 409
    assert response.json() == {"detail": "settlement_not_in_current_plan"}


def test_scoped_routes_reject_unauthenticated_requests(client):
    # Given: no bearer token.
    now = datetime.now(UTC).isoformat()

    # When: scoped reads and writes are attempted.
    context_response = client.post(
        "/contexts",
        json={
            "context_id": "ctx-private",
            "name": "Private",
            "type": "shared",
            "owner_participant_id": "alice",
            "created_at": now,
            "default_split": "equal",
            "allow_simplified_debts": False,
        },
    )
    contexts_response = client.get("/contexts")
    sync_response = client.post("/sync/push", json={"entries": []})

    # Then: all scoped surfaces require authentication.
    assert context_response.status_code == 401
    assert contexts_response.status_code == 401
    assert sync_response.status_code == 401


def test_participant_registration_does_not_leak_existing_token(client):
    # Given: Alice has already registered once.
    now = datetime.now(UTC).isoformat()
    token = register_participant(client, "alice", "Alice", now)

    # When: the same participant id is registered again without credentials.
    response = client.post(
        "/participants",
        json={
            "participant_id": "alice",
            "display_name": "Alice",
            "is_ghost": False,
            "created_at": now,
        },
    )

    # Then: the existing bearer token is not returned.
    assert response.status_code == 409
    assert response.json() == {"detail": "participant_exists"}
    assert token not in response.text


def test_context_reads_are_filtered_to_authenticated_members(client):
    # Given: Alice owns one context and Mallory owns another.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    mallory_token = register_participant(client, "mallory", "Mallory", now)

    alice_context = client.post(
        "/contexts",
        headers=auth_header(alice_token),
        json={
            "context_id": "ctx-alice",
            "name": "Alice Home",
            "type": "shared",
            "owner_participant_id": "alice",
            "created_at": now,
            "default_split": "equal",
            "allow_simplified_debts": False,
        },
    )
    mallory_context = client.post(
        "/contexts",
        headers=auth_header(mallory_token),
        json={
            "context_id": "ctx-mallory",
            "name": "Mallory Home",
            "type": "shared",
            "owner_participant_id": "mallory",
            "created_at": now,
            "default_split": "equal",
            "allow_simplified_debts": False,
        },
    )
    assert alice_context.status_code == 200
    assert mallory_context.status_code == 200

    # When: Alice lists contexts and tries to read Mallory's balances.
    contexts_response = client.get("/contexts", headers=auth_header(alice_token))
    balances_response = client.get("/contexts/ctx-mallory/balances", headers=auth_header(alice_token))

    # Then: Alice sees only her context and cannot inspect Mallory's.
    assert contexts_response.status_code == 200
    assert [context["context_id"] for context in contexts_response.json()] == ["ctx-alice"]
    assert balances_response.status_code == 403
    assert balances_response.json() == {"detail": "context_forbidden"}


def test_forged_membership_is_rejected_for_non_owner(client):
    # Given: Alice owns a context and Mallory has a valid participant token.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    mallory_token = register_participant(client, "mallory", "Mallory", now)
    context_response = client.post(
        "/contexts",
        headers=auth_header(alice_token),
        json={
            "context_id": "ctx-owned",
            "name": "Owned",
            "type": "shared",
            "owner_participant_id": "alice",
            "created_at": now,
            "default_split": "equal",
            "allow_simplified_debts": False,
        },
    )
    assert context_response.status_code == 200

    # When: Mallory tries to add herself to Alice's context.
    response = client.post(
        "/memberships",
        headers=auth_header(mallory_token),
        json={
            "membership_id": "m-forged",
            "context_id": "ctx-owned",
            "participant_id": "mallory",
            "joined_at": now,
            "default_share": "1/2",
            "allow_simplify_for_me": True,
        },
    )

    # Then: owner-only membership creation blocks fabricated access.
    assert response.status_code == 403
    assert response.json() == {"detail": "context_owner_required"}


def test_sync_rejects_entries_with_participants_outside_context(client):
    # Given: Alice and Bob are active members, while Mallory is registered but not a member.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    register_participant(client, "bob", "Bob", now)
    register_participant(client, "mallory", "Mallory", now)
    context_response = client.post(
        "/contexts",
        headers=auth_header(alice_token),
        json={
            "context_id": "ctx-ledger-scope",
            "name": "Home",
            "type": "shared",
            "owner_participant_id": "alice",
            "created_at": now,
            "default_split": "equal",
            "allow_simplified_debts": False,
        },
    )
    assert context_response.status_code == 200
    for membership_id, participant_id in (("m-scope-alice", "alice"), ("m-scope-bob", "bob")):
        response = client.post(
            "/memberships",
            headers=auth_header(alice_token),
            json={
                "membership_id": membership_id,
                "context_id": "ctx-ledger-scope",
                "participant_id": participant_id,
                "joined_at": now,
                "default_share": "1/2",
                "allow_simplify_for_me": True,
            },
        )
        assert response.status_code == 200

    # When: sync tries to inject Mallory into the ledger allocations.
    response = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={
            "entries": [
                {
                    "entry_id": "forged-mallory",
                    "context_id": "ctx-ledger-scope",
                    "type": "expense",
                    "recorded_at": now,
                    "effective_date": "2026-06-01",
                    "payer_id": "alice",
                    "total_amount": 30000,
                    "currency": "INR",
                    "description": "Forged allocation",
                    "allocations": [
                        {"participant_id": "alice", "share_amount": 15000, "is_payer": True},
                        {"participant_id": "mallory", "share_amount": 15000, "is_payer": False},
                    ],
                    "version": 1,
                    "hlc": "1000-0-device",
                }
            ]
        },
    )

    # Then: sync returns a rejected item and stores no forged entry.
    assert response.status_code == 200
    assert response.json() == [
        {
            "entry_id": "forged-mallory",
            "server_seq": None,
            "version": None,
            "status": "rejected",
            "error_code": "entry_participant_forbidden",
            "message": "authorization_failed",
        }
    ]


def test_capture_classification_endpoint(client):
    token = register_participant(client, "alice", "Alice", datetime.now(UTC).isoformat())
    response = client.post(
        "/capture/classify",
        json={"text": "Paid 2500 for broadband for the flat"},
        headers=auth_header(token),
    )
    assert response.status_code == 200
    assert response.json() == {
        "context_hint": "shared-household",
        "category_hint": "wifi",
        "recurring_candidate": True,
        "participant_scope": "context-default",
        "confidence": "high",
    }
