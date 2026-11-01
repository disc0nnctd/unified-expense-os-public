from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.models import InviteModel

from tests.test_api import auth_header, register_participant


def create_context_with_owner_membership(client, token: str, context_id: str, owner_id: str, now: str) -> None:
    context_response = client.post(
        "/contexts",
        headers=auth_header(token),
        json={
            "context_id": context_id,
            "name": "Home",
            "type": "shared",
            "owner_participant_id": owner_id,
            "created_at": now,
            "default_split": "equal",
            "allow_simplified_debts": False,
        },
    )
    assert context_response.status_code == 200
    membership_response = client.post(
        "/memberships",
        headers=auth_header(token),
        json={
            "membership_id": f"m-{context_id}-{owner_id}",
            "context_id": context_id,
            "participant_id": owner_id,
            "joined_at": now,
            "default_share": "equal",
            "allow_simplify_for_me": True,
        },
    )
    assert membership_response.status_code == 200


def test_invite_redeem_enables_second_device_vertical_slice(client):
    # Given: Alice onboards on device A and owns a household context.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)

    # When: Alice generates an invite and Bob redeems it from a fresh device.
    invite_response = client.post("/contexts/ctx-home/invites", headers=auth_header(alice_token))
    assert invite_response.status_code == 200
    invite_code = invite_response.json()["invite_code"]
    assert invite_response.json()["context_name"] == "Home"

    redeem_response = client.post(
        "/invites/redeem",
        json={"invite_code": invite_code, "participant_id": "bob", "display_name": "Bob"},
    )
    assert redeem_response.status_code == 200
    redeemed = redeem_response.json()
    bob_token = redeemed["auth_token"]
    assert bob_token and bob_token != alice_token
    assert redeemed["context"]["context_id"] == "ctx-home"

    # Then: Bob's device sees the context and both member names.
    contexts = client.get("/contexts", headers=auth_header(bob_token))
    assert [context["context_id"] for context in contexts.json()] == ["ctx-home"]
    memberships = client.get("/contexts/ctx-home/memberships", headers=auth_header(bob_token))
    assert {(row["participant_id"], row["display_name"]) for row in memberships.json()} == {
        ("alice", "Alice"),
        ("bob", "Bob"),
    }

    # And: an expense pushed from Alice's device is pulled on Bob's device.
    push = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={
            "entries": [
                {
                    "entry_id": "rent-july",
                    "context_id": "ctx-home",
                    "type": "expense",
                    "recorded_at": now,
                    "effective_date": "2026-07-01",
                    "payer_id": "alice",
                    "total_amount": 30000,
                    "currency": "INR",
                    "description": "Rent",
                    "allocations": [
                        {"participant_id": "alice", "share_amount": 15000, "is_payer": True},
                        {"participant_id": "bob", "share_amount": 15000, "is_payer": False},
                    ],
                    "version": 1,
                    "hlc": "1000-0-alice-device",
                }
            ]
        },
    )
    assert push.json()[0]["status"] == "accepted"

    pull = client.get(
        "/sync/pull", headers=auth_header(bob_token), params={"context_id": "ctx-home", "after_seq": 0}
    )
    assert pull.status_code == 200
    assert [entry["entry_id"] for entry in pull.json()["entries"]] == ["rent-july"]

    balances = client.get("/contexts/ctx-home/balances", headers=auth_header(bob_token))
    assert balances.json() == [
        {"participant_id": "alice", "net_balance": 15000, "currency": "INR"},
        {"participant_id": "bob", "net_balance": -15000, "currency": "INR"},
    ]


def test_invite_is_single_use_and_normalized(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)
    invite_code = client.post("/contexts/ctx-home/invites", headers=auth_header(alice_token)).json()[
        "invite_code"
    ]

    # Lowercase and dash-grouped input still resolves to the same invite.
    friendly_code = f"{invite_code[:4].lower()}-{invite_code[4:].lower()}"
    first = client.post(
        "/invites/redeem",
        json={"invite_code": friendly_code, "participant_id": "bob", "display_name": "Bob"},
    )
    assert first.status_code == 200

    second = client.post(
        "/invites/redeem",
        json={"invite_code": invite_code, "participant_id": "carol", "display_name": "Carol"},
    )
    assert second.status_code == 409
    assert second.json() == {"detail": "invite_already_redeemed"}


def test_invite_requires_owner_and_expires(client, db_session):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    mallory_token = register_participant(client, "mallory", "Mallory", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)

    forged = client.post("/contexts/ctx-home/invites", headers=auth_header(mallory_token))
    assert forged.status_code == 403

    invite_code = client.post("/contexts/ctx-home/invites", headers=auth_header(alice_token)).json()[
        "invite_code"
    ]
    invite = db_session.scalar(select(InviteModel).where(InviteModel.invite_code == invite_code))
    invite.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    db_session.commit()

    expired = client.post(
        "/invites/redeem",
        json={"invite_code": invite_code, "participant_id": "bob", "display_name": "Bob"},
    )
    assert expired.status_code == 409
    assert expired.json() == {"detail": "invite_expired"}

    missing = client.post(
        "/invites/redeem",
        json={"invite_code": "NOPE9999", "participant_id": "bob", "display_name": "Bob"},
    )
    assert missing.status_code == 404


def test_existing_participant_joins_second_context_via_invite(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    bob_token = register_participant(client, "bob", "Bob", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)
    invite_code = client.post("/contexts/ctx-home/invites", headers=auth_header(alice_token)).json()[
        "invite_code"
    ]

    # Bob already has an identity on his device; redeem attaches it, no new token.
    redeem = client.post(
        "/invites/redeem", headers=auth_header(bob_token), json={"invite_code": invite_code}
    )
    assert redeem.status_code == 200
    assert redeem.json()["participant_id"] == "bob"
    assert redeem.json()["auth_token"] is None

    contexts = client.get("/contexts", headers=auth_header(bob_token))
    assert [context["context_id"] for context in contexts.json()] == ["ctx-home"]

    # A second invite cannot re-add an active member.
    second_code = client.post("/contexts/ctx-home/invites", headers=auth_header(alice_token)).json()[
        "invite_code"
    ]
    duplicate = client.post(
        "/invites/redeem", headers=auth_header(bob_token), json={"invite_code": second_code}
    )
    assert duplicate.status_code == 409
    assert duplicate.json() == {"detail": "already_member"}

    open_invites = client.get("/contexts/ctx-home/invites", headers=auth_header(alice_token))
    assert [invite["invite_code"] for invite in open_invites.json()] == [second_code]


def test_ghost_member_can_be_added_by_name_and_later_claim_identity_via_invite(client):
    # Given: Alice adds Priya to the household by name only, before Priya has a device.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)

    ghost_response = client.post(
        "/contexts/ctx-home/ghost-members",
        headers=auth_header(alice_token),
        json={"display_name": "Priya"},
    )
    assert ghost_response.status_code == 200
    ghost = ghost_response.json()
    assert ghost["display_name"] == "Priya"
    priya_participant_id = ghost["participant_id"]

    # Priya is immediately usable as an active member for splits.
    memberships = client.get("/contexts/ctx-home/memberships", headers=auth_header(alice_token))
    priya_membership = next(m for m in memberships.json() if m["participant_id"] == priya_participant_id)
    assert priya_membership["is_ghost"] is True
    assert priya_membership["left_at"] is None

    entry_response = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={
            "entries": [
                {
                    "entry_id": "rent-1",
                    "context_id": "ctx-home",
                    "type": "expense",
                    "recorded_at": now,
                    "effective_date": now[:10],
                    "payer_id": "alice",
                    "total_amount": 1000,
                    "currency": "INR",
                    "description": "Rent",
                    "allocations": [
                        {"participant_id": "alice", "share_amount": 500, "is_payer": True},
                        {"participant_id": priya_participant_id, "share_amount": 500, "is_payer": False},
                    ],
                    "version": 1,
                    "hlc": "1000-0-a",
                }
            ]
        },
    )
    assert entry_response.status_code == 200
    assert entry_response.json()[0]["status"] == "accepted"

    # When: Alice mints an invite that claims Priya's ghost identity specifically.
    invite_response = client.post(
        "/contexts/ctx-home/invites",
        headers=auth_header(alice_token),
        json={"claim_participant_id": priya_participant_id},
    )
    assert invite_response.status_code == 200
    invite_body = invite_response.json()
    assert invite_body["claim_participant_id"] == priya_participant_id
    assert invite_body["claim_display_name"] == "Priya"

    redeem_response = client.post(
        "/invites/redeem",
        json={"invite_code": invite_body["invite_code"], "display_name": "Priya S."},
    )
    assert redeem_response.status_code == 200
    redeemed = redeem_response.json()

    # Then: Priya's device takes over the SAME participant_id (and its ledger history),
    # gets a fresh auth token, and is no longer a ghost.
    assert redeemed["participant_id"] == priya_participant_id
    assert redeemed["auth_token"] is not None
    priya_token = redeemed["auth_token"]

    memberships_after = client.get("/contexts/ctx-home/memberships", headers=auth_header(priya_token))
    priya_membership_after = next(
        m for m in memberships_after.json() if m["participant_id"] == priya_participant_id
    )
    assert priya_membership_after["is_ghost"] is False
    assert priya_membership_after["display_name"] == "Priya S."

    # The rent entry Priya was already split into before she had a device is still hers.
    contexts = client.get("/contexts", headers=auth_header(priya_token))
    assert [context["context_id"] for context in contexts.json()] == ["ctx-home"]


def test_claiming_ghost_from_an_already_authed_device_is_rejected(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    bob_token = register_participant(client, "bob", "Bob", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)

    ghost = client.post(
        "/contexts/ctx-home/ghost-members",
        headers=auth_header(alice_token),
        json={"display_name": "Priya"},
    ).json()

    invite = client.post(
        "/contexts/ctx-home/invites",
        headers=auth_header(alice_token),
        json={"claim_participant_id": ghost["participant_id"]},
    ).json()

    # Bob's device already has an identity; it cannot absorb someone else's ghost slot.
    response = client.post(
        "/invites/redeem",
        headers=auth_header(bob_token),
        json={"invite_code": invite["invite_code"]},
    )
    assert response.status_code == 400
    assert response.json() == {"detail": "ghost_claim_requires_new_device"}
