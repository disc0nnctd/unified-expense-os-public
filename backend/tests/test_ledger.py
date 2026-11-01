from datetime import UTC, date, datetime

from app.ledger import settlement_warning
from app.models import AllocationModel, ContextModel, LedgerEntryModel, ParticipantModel
from app.recurring import SplitRequest, generate_due_occurrences, resolve_split

from tests.test_api import auth_header, register_participant
from tests.test_invites import create_context_with_owner_membership


def seed_basic_household(session) -> None:
    session.add(
        ContextModel(
            context_id="ctx-home",
            name="Home",
            type="shared",
            owner_participant_id="alice",
            created_at=datetime.now(UTC),
            default_split="equal",
            allow_simplified_debts=False,
            updated_at=datetime.now(UTC),
        )
    )
    session.add(
        ParticipantModel(
            participant_id="alice",
            display_name="Alice",
            is_ghost=False,
            ghost_managed_by=None,
            created_at=datetime.now(UTC),
        )
    )
    session.add(
        ParticipantModel(
            participant_id="bob",
            display_name="Bob",
            is_ghost=False,
            ghost_managed_by=None,
            created_at=datetime.now(UTC),
        )
    )
    session.add(
        LedgerEntryModel(
            entry_id="rent-1",
            context_id="ctx-home",
            type="expense",
            recorded_at=datetime.now(UTC),
            effective_date=date(2026, 6, 1),
            payer_id="alice",
            total_amount=30000,
            currency="INR",
            description="Rent",
            linked_template_id=None,
            linked_entry_id=None,
            generation_key=None,
            server_seq=1,
            version=1,
            hlc="1-0-a",
            voided_at=None,
            void_reason=None,
            conflict_resolved_by=None,
        )
    )
    session.add_all(
        [
            AllocationModel(entry_id="rent-1", participant_id="alice", share_amount=15000, is_payer=True),
            AllocationModel(entry_id="rent-1", participant_id="bob", share_amount=15000, is_payer=False),
        ]
    )
    session.commit()


def test_generate_due_occurrences_is_idempotent():
    generated = generate_due_occurrences(
        template_id="wifi",
        next_due_date=date(2026, 4, 1),
        cadence="monthly",
        anchor_day=1,
        as_of_date=date(2026, 6, 30),
        existing_generation_keys={"wifi:2026-05-01"},
    )
    assert generated == [
        (date(2026, 4, 1), "wifi:2026-04-01"),
        (date(2026, 6, 1), "wifi:2026-06-01"),
    ]


def test_equal_split_handles_remainder():
    allocations = resolve_split(
        SplitRequest(
            amount=1001,
            rule={"type": "equal"},
            participant_ids=("bob", "alice", "carol"),
            payer_id="bob",
        )
    )
    assert allocations == [
        {"participant_id": "alice", "share_amount": 333, "is_payer": False},
        {"participant_id": "bob", "share_amount": 335, "is_payer": True},
        {"participant_id": "carol", "share_amount": 333, "is_payer": False},
    ]


def test_settlement_warning_flags_overpayment(db_session):
    seed_basic_household(db_session)
    assert settlement_warning(db_session, "ctx-home", "alice", "bob", 16000) == "overpayment_warning"
    assert settlement_warning(db_session, "ctx-home", "alice", "bob", 15000) is None


def test_invalid_allocations_return_422_not_500(client):
    # unified-expense-os-59q: domain validation raised ValueError out of the
    # endpoint, which FastAPI surfaced as a 500. These are client errors.
    now = datetime.now(UTC).isoformat()
    token = register_participant(client, "alice", "Alice", now)
    create_context_with_owner_membership(client, token, "ctx-home", "alice", now)

    mismatched = client.post(
        "/ledger/entries",
        headers=auth_header(token),
        json={
            "entry_id": "e-bad-sum",
            "context_id": "ctx-home",
            "type": "expense",
            "recorded_at": now,
            "effective_date": now[:10],
            "payer_id": "alice",
            "total_amount": 1000,
            "currency": "INR",
            "description": "Mismatched",
            "allocations": [{"participant_id": "alice", "share_amount": 999, "is_payer": True}],
            "hlc": f"{int(datetime.now(UTC).timestamp() * 1000)}-0-a",
        },
    )
    assert mismatched.status_code == 422
    assert mismatched.json()["detail"] == "allocation_sum_mismatch"

    no_payer_allocation = client.post(
        "/ledger/entries",
        headers=auth_header(token),
        json={
            "entry_id": "e-bad-payer",
            "context_id": "ctx-home",
            "type": "expense",
            "recorded_at": now,
            "effective_date": now[:10],
            "payer_id": "alice",
            "total_amount": 1000,
            "currency": "INR",
            "description": "No payer allocation",
            "allocations": [{"participant_id": "alice", "share_amount": 1000, "is_payer": False}],
            "hlc": f"{int(datetime.now(UTC).timestamp() * 1000)}-1-a",
        },
    )
    assert no_payer_allocation.status_code == 422
    assert no_payer_allocation.json()["detail"] == "payer_allocation_invalid"
