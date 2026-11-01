from datetime import UTC, datetime

from sqlalchemy import func, select

from app.ledger import compare_hlc, next_server_seq
from app.models import ConflictLogModel, LedgerEntryModel

from tests.test_api import auth_header, register_participant
from tests.test_invites import create_context_with_owner_membership


def entry_payload(entry_id: str, hlc: str, version: int = 1, description: str = "Rent") -> dict:
    now = datetime.now(UTC).isoformat()
    return {
        "entry_id": entry_id,
        "context_id": "ctx-home",
        "type": "expense",
        "recorded_at": now,
        "effective_date": "2026-07-01",
        "payer_id": "alice",
        "total_amount": 30000,
        "currency": "INR",
        "description": description,
        "allocations": [{"participant_id": "alice", "share_amount": 30000, "is_payer": True}],
        "version": version,
        "hlc": hlc,
    }


def with_allocations(payload: dict, alice_share: int, bob_share: int) -> dict:
    return {
        **payload,
        "allocations": [
            {"participant_id": "alice", "share_amount": alice_share, "is_payer": True},
            {"participant_id": "bob", "share_amount": bob_share, "is_payer": False},
        ],
    }


def test_compare_hlc_orders_numerically_not_lexicographically():
    assert compare_hlc("1000-10-node", "1000-2-node") > 0
    assert compare_hlc("999-0-node", "1000-0-node") < 0
    assert compare_hlc("1000-2-a", "1000-2-b") < 0
    assert compare_hlc("1000-2-a", "1000-2-a") == 0


def test_next_server_seq_continues_after_existing_entries(client, db_session):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)
    push = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [entry_payload("rent-1", "1000-0-a"), entry_payload("rent-2", "1001-0-a")]},
    )
    assert [item["server_seq"] for item in push.json()] == [1, 2]
    assert next_server_seq(db_session) == 3


def test_idempotent_replay_is_accepted_without_conflict_log(client, db_session):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)

    first = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [entry_payload("rent-1", "1000-0-a")]},
    )
    assert first.json()[0]["status"] == "accepted"
    original_seq = first.json()[0]["server_seq"]

    # Same version + same HLC = client retry after a lost response.
    replay = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [entry_payload("rent-1", "1000-0-a")]},
    )
    assert replay.json()[0] == {
        "entry_id": "rent-1",
        "server_seq": original_seq,
        "version": 1,
        "status": "accepted",
        "error_code": None,
        "message": None,
    }
    assert db_session.scalar(select(func.count(ConflictLogModel.conflict_id))) == 0


def test_conflicting_write_still_resolves_lww_and_logs(client, db_session):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)

    client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [entry_payload("rent-1", "1000-0-a", version=1)]},
    )
    # Same version from another device with a later HLC (counter 10 exercises
    # the numeric comparison): the later write wins and the conflict is logged.
    conflicting = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [entry_payload("rent-1", "1000-10-b", version=1, description="Rent (edited)")]},
    )
    assert conflicting.json()[0]["status"] == "accepted"
    entry = db_session.get(LedgerEntryModel, "rent-1")
    assert entry.description == "Rent (edited)"
    assert entry.conflict_resolved_by == "lww"
    assert db_session.scalar(select(func.count(ConflictLogModel.conflict_id))) == 1


def test_hlc_far_in_the_future_is_rejected(client):
    # unified-expense-os-9tw: a wildly-skewed (or crafted) HLC must not be
    # able to win every future LWW conflict permanently.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)

    push = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [entry_payload("rent-1", "99999999999999-0-x")]},
    )
    assert push.json()[0] == {
        "entry_id": "rent-1",
        "server_seq": None,
        "version": None,
        "status": "rejected",
        "error_code": "hlc_clock_skew_exceeded",
        "message": "validation_failed",
    }


def test_hlc_slightly_in_the_future_is_accepted(client):
    # A few seconds of skew (normal clock drift, not a poisoning attempt)
    # must not be rejected.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)

    near_future_ms = int(datetime.now(UTC).timestamp() * 1000) + 30_000
    push = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [entry_payload("rent-1", f"{near_future_ms}-0-a")]},
    )
    assert push.json()[0]["status"] == "accepted"


def test_sequential_update_persists_category_change(client, db_session):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)

    client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [{**entry_payload("rent-1", "1000-0-a", version=1), "category": "Housing"}]},
    )
    push = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [{**entry_payload("rent-1", "1001-0-a", version=2), "category": "Utilities"}]},
    )
    assert push.json()[0]["status"] == "accepted"

    entry = db_session.get(LedgerEntryModel, "rent-1")
    assert entry.category == "Utilities"


def test_entry_history_tracks_create_update_and_conflict(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    register_participant(client, "bob", "Bob", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)
    client.post(
        "/memberships",
        headers=auth_header(alice_token),
        json={
            "membership_id": "m-ctx-home-bob",
            "context_id": "ctx-home",
            "participant_id": "bob",
            "joined_at": now,
            "default_share": "equal",
        },
    )

    client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [with_allocations(entry_payload("rent-1", "1000-0-a", version=1), 20000, 10000)]},
    )
    client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [with_allocations(entry_payload("rent-1", "1001-0-a", version=2, description="Rent (updated)"), 18000, 12000)]},
    )
    client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [with_allocations(entry_payload("rent-1", "1002-10-b", version=2, description="Rent (edited)"), 17000, 13000)]},
    )

    history = client.get("/ledger/entries/rent-1/history", headers=auth_header(alice_token))
    assert history.status_code == 200
    rows = history.json()
    assert [row["action"] for row in rows] == ["created", "updated", "conflict_resolved"]
    assert [row["description"] for row in rows] == ["Rent", "Rent (updated)", "Rent (edited)"]
    assert [[allocation["share_amount"] for allocation in row["allocations"]] for row in rows] == [
        [20000, 10000],
        [18000, 12000],
        [17000, 13000],
    ]
    assert all(sum(allocation["is_payer"] for allocation in row["allocations"]) == 1 for row in rows)
    assert all(row["edited_by"] == "alice" for row in rows)


def test_overpayment_warning_uses_dedicated_field(client):
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    bob_token = register_participant(client, "bob", "Bob", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)
    membership = client.post(
        "/memberships",
        headers=auth_header(alice_token),
        json={
            "membership_id": "m-ctx-home-bob",
            "context_id": "ctx-home",
            "participant_id": "bob",
            "joined_at": now,
            "default_share": "equal",
            "allow_simplify_for_me": True,
        },
    )
    assert membership.status_code == 200
    client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={
            "entries": [
                {
                    "entry_id": "dinner",
                    "context_id": "ctx-home",
                    "type": "expense",
                    "recorded_at": now,
                    "effective_date": "2026-07-01",
                    "payer_id": "alice",
                    "total_amount": 10000,
                    "currency": "INR",
                    "description": "Dinner",
                    "allocations": [
                        {"participant_id": "alice", "share_amount": 5000, "is_payer": True},
                        {"participant_id": "bob", "share_amount": 5000, "is_payer": False},
                    ],
                    "version": 1,
                    "hlc": "1000-0-a",
                }
            ]
        },
    )

    overpaying = client.post(
        "/ledger/entries",
        headers=auth_header(bob_token),
        json={
            "entry_id": "settle-over",
            "context_id": "ctx-home",
            "type": "settlement",
            "recorded_at": now,
            "effective_date": "2026-07-01",
            "payer_id": "bob",
            "total_amount": 6000,
            "currency": "INR",
            "description": "Overpaying settlement",
            "allocations": [
                {"participant_id": "bob", "share_amount": 0, "is_payer": True},
                {"participant_id": "alice", "share_amount": 6000, "is_payer": False},
            ],
            "version": 1,
            "hlc": "2000-0-b",
        },
    )
    assert overpaying.status_code == 200
    assert overpaying.json()["warning"] == "overpayment_warning"
    assert overpaying.json()["conflict_resolved_by"] is None


def test_lww_winner_never_regresses_version(client, db_session):
    # unified-expense-os-0d2: a stored v3 losing to a later-HLC v2 used to
    # leave the entry at version 2. The sync contract promises versions never
    # regress, so the winner's content is applied with a bumped version.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)

    # Device A edits twice offline: v1 -> v2 -> v3.
    for version, hlc in ((1, "1000-0-a"), (2, "1001-0-a"), (3, "1002-0-a")):
        pushed = client.post(
            "/sync/push",
            headers=auth_header(alice_token),
            json={"entries": [entry_payload("rent-1", hlc, version=version)]},
        )
        assert pushed.json()[0]["status"] == "accepted"
    assert db_session.get(LedgerEntryModel, "rent-1").version == 3

    # Device B pushes a v2 edit carrying a later HLC: it wins on LWW.
    conflicting = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [entry_payload("rent-1", "2000-0-b", version=2, description="Rent (device B)")]},
    )
    assert conflicting.json()[0]["status"] == "accepted"

    db_session.expire_all()
    entry = db_session.get(LedgerEntryModel, "rent-1")
    assert entry.description == "Rent (device B)"
    # The winner's content, but a version strictly above what was stored.
    assert entry.version == 4
    assert conflicting.json()[0]["version"] == 4


def test_replay_after_lww_resolution_is_still_idempotent(client, db_session):
    # The winning device re-pushes the same write (lost response). Its pushed
    # version no longer matches the stored one after the bump above, so replay
    # detection keys on the HLC alone rather than version+HLC.
    now = datetime.now(UTC).isoformat()
    alice_token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, alice_token, "ctx-home", "alice", now)

    client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [entry_payload("rent-1", "1000-0-a", version=1)]},
    )
    winner = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [entry_payload("rent-1", "2000-0-b", version=1, description="Winner")]},
    )
    assert winner.json()[0]["status"] == "accepted"
    settled_seq = winner.json()[0]["server_seq"]
    settled_version = winner.json()[0]["version"]
    conflicts_after_win = db_session.scalar(select(func.count(ConflictLogModel.conflict_id)))

    replay = client.post(
        "/sync/push",
        headers=auth_header(alice_token),
        json={"entries": [entry_payload("rent-1", "2000-0-b", version=1, description="Winner")]},
    )
    assert replay.json()[0]["server_seq"] == settled_seq
    assert replay.json()[0]["version"] == settled_version
    # No new conflict row and no new server_seq for a pure replay.
    assert db_session.scalar(select(func.count(ConflictLogModel.conflict_id))) == conflicts_after_win
