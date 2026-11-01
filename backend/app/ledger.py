from __future__ import annotations

import json
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import (
    AllocationModel,
    ConflictLogModel,
    EntryHistoryAllocationModel,
    EntryHistoryModel,
    LedgerEntryModel,
    MembershipModel,
    SyncCounterModel,
)
from .schemas import LedgerEntryIn, SettlementPlanResponse, SettlementPlanRow

SERVER_SEQ_COUNTER = "server_seq"

# docs/sync-design-home-p70.md 7.4: a device with a wildly wrong clock (or a
# malicious member crafting hlc="99999999999999-0-x") would otherwise win
# every LWW conflict on the entries it touches, permanently and
# un-out-editably — unified-expense-os-9tw.
HLC_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000


def _hlc_millis(value: str) -> int:
    try:
        return int(value.split("-", 1)[0])
    except (ValueError, IndexError):
        return 0


def check_hlc_clock_skew(hlc: str) -> None:
    now_ms = int(datetime.now(UTC).timestamp() * 1000)
    if _hlc_millis(hlc) > now_ms + HLC_MAX_FUTURE_SKEW_MS:
        raise ValueError("hlc_clock_skew_exceeded")


def validate_allocations(entry: LedgerEntryIn) -> None:
    total = sum(item.share_amount for item in entry.allocations)
    if total != entry.total_amount:
        raise ValueError("allocation_sum_mismatch")

    payers = [item for item in entry.allocations if item.is_payer]
    if len(payers) != 1 or payers[0].participant_id != entry.payer_id:
        raise ValueError("payer_allocation_invalid")


def next_server_seq(session: Session) -> int:
    # Row-locked counter so concurrent pushes on Postgres cannot assign the
    # same sequence number (max+1 in Python raced); FOR UPDATE is a no-op on
    # single-writer SQLite.
    counter = session.scalar(
        select(SyncCounterModel).where(SyncCounterModel.counter_id == SERVER_SEQ_COUNTER).with_for_update()
    )
    if counter is None:
        current = session.scalar(select(func.max(LedgerEntryModel.server_seq)))
        counter = SyncCounterModel(counter_id=SERVER_SEQ_COUNTER, value=int(current or 0))
        session.add(counter)
        session.flush()
    counter.value += 1
    session.flush()
    return counter.value


def _entry_to_model(entry: LedgerEntryIn, server_seq: int) -> LedgerEntryModel:
    return LedgerEntryModel(
        entry_id=entry.entry_id,
        context_id=entry.context_id,
        type=entry.type,
        recorded_at=entry.recorded_at,
        effective_date=entry.effective_date,
        payer_id=entry.payer_id,
        total_amount=entry.total_amount,
        currency=entry.currency,
        description=entry.description,
        category=entry.category,
        notes=entry.notes,
        linked_template_id=entry.linked_template_id,
        linked_entry_id=entry.linked_entry_id,
        generation_key=entry.generation_key,
        server_seq=server_seq,
        version=entry.version,
        hlc=entry.hlc,
        voided_at=entry.voided_at,
        void_reason=entry.void_reason,
    )


def _hlc_key(value: str) -> tuple[int, int, str]:
    # HLC format is {ms}-{counter}-{node}; ms and counter are variable-width
    # integers, so plain string comparison breaks at counter >= 10.
    parts = value.split("-", 2)
    try:
        return (int(parts[0]), int(parts[1]), parts[2] if len(parts) > 2 else "")
    except (ValueError, IndexError):
        return (0, 0, value)


def compare_hlc(left: str, right: str) -> int:
    left_key = _hlc_key(left)
    right_key = _hlc_key(right)
    return (left_key > right_key) - (left_key < right_key)


def _record_history(session: Session, entry: LedgerEntryModel, action: str, edited_by: str) -> None:
    history = EntryHistoryModel(
            entry_id=entry.entry_id,
            version=entry.version,
            hlc=entry.hlc,
            action=action,
            edited_by=edited_by,
            description=entry.description,
            total_amount=entry.total_amount,
            payer_id=entry.payer_id,
            notes=entry.notes,
            voided_at=entry.voided_at,
            recorded_at=datetime.now(UTC),
        )
    session.add(history)
    session.flush()
    history.allocations = [
        EntryHistoryAllocationModel(
            participant_id=allocation.participant_id,
            share_amount=allocation.share_amount,
            is_payer=allocation.is_payer,
        )
        for allocation in entry.allocations
    ]


def upsert_entry(session: Session, entry: LedgerEntryIn, editor_id: str) -> tuple[str, int, int]:
    validate_allocations(entry)
    check_hlc_clock_skew(entry.hlc)
    existing = session.get(LedgerEntryModel, entry.entry_id)

    if existing is not None and entry.hlc == existing.hlc:
        # Idempotent replay of an already-committed write: accept without
        # reassigning server_seq or logging a spurious conflict. HLC equality
        # alone identifies the write — every client mutation mints a fresh
        # HLC, and the stored version may legitimately differ from the pushed
        # one after an LWW resolution bumped it (unified-expense-os-0d2).
        return (entry.entry_id, existing.server_seq, existing.version)

    if existing is None:
        model = _entry_to_model(entry, next_server_seq(session))
        session.add(model)
        session.flush()
        for allocation in entry.allocations:
            session.add(
                AllocationModel(
                    entry_id=entry.entry_id,
                    participant_id=allocation.participant_id,
                    share_amount=allocation.share_amount,
                    is_payer=allocation.is_payer,
                )
            )
        session.flush()
        _record_history(session, model, "created", editor_id)
        return (entry.entry_id, model.server_seq, model.version)

    if entry.version != existing.version + 1:
        winner = existing
        if compare_hlc(entry.hlc, existing.hlc) > 0:
            existing.type = entry.type
            existing.recorded_at = entry.recorded_at
            existing.effective_date = entry.effective_date
            existing.payer_id = entry.payer_id
            existing.total_amount = entry.total_amount
            existing.currency = entry.currency
            existing.description = entry.description
            existing.category = entry.category
            existing.notes = entry.notes
            existing.linked_template_id = entry.linked_template_id
            existing.linked_entry_id = entry.linked_entry_id
            existing.generation_key = entry.generation_key
            # The winner's version must stay monotonic: copying the incoming
            # version wholesale could move a v3 entry back to v2 when a
            # later-HLC v2 wins, and the sync contract promises versions
            # never regress (unified-expense-os-0d2).
            existing.version = max(existing.version, entry.version) + 1
            existing.hlc = entry.hlc
            existing.voided_at = entry.voided_at
            existing.void_reason = entry.void_reason
            existing.server_seq = next_server_seq(session)
            existing.conflict_resolved_by = "lww"
            session.query(AllocationModel).filter(AllocationModel.entry_id == existing.entry_id).delete()
            for allocation in entry.allocations:
                session.add(
                    AllocationModel(
                        entry_id=entry.entry_id,
                        participant_id=allocation.participant_id,
                        share_amount=allocation.share_amount,
                        is_payer=allocation.is_payer,
                    )
                )
            session.flush()
            _record_history(session, existing, "conflict_resolved", editor_id)
            winner = existing

        session.add(
            ConflictLogModel(
                entry_id=entry.entry_id,
                rejected_version=entry.version,
                rejected_hlc=entry.hlc,
                payload_json=json.dumps(entry.model_dump(mode="json")),
                created_at=datetime.now(UTC),
            )
        )
        session.flush()
        return (entry.entry_id, winner.server_seq, winner.version)

    existing.type = entry.type
    existing.recorded_at = entry.recorded_at
    existing.effective_date = entry.effective_date
    existing.payer_id = entry.payer_id
    existing.total_amount = entry.total_amount
    existing.currency = entry.currency
    existing.description = entry.description
    existing.category = entry.category
    existing.notes = entry.notes
    existing.linked_template_id = entry.linked_template_id
    existing.linked_entry_id = entry.linked_entry_id
    existing.generation_key = entry.generation_key
    existing.version = entry.version
    existing.hlc = entry.hlc
    existing.voided_at = entry.voided_at
    existing.void_reason = entry.void_reason
    existing.server_seq = next_server_seq(session)
    session.query(AllocationModel).filter(AllocationModel.entry_id == existing.entry_id).delete()
    for allocation in entry.allocations:
        session.add(
            AllocationModel(
                entry_id=entry.entry_id,
                participant_id=allocation.participant_id,
                share_amount=allocation.share_amount,
                is_payer=allocation.is_payer,
            )
        )
    session.flush()
    _record_history(session, existing, "voided" if entry.voided_at else "updated", editor_id)
    return (entry.entry_id, existing.server_seq, existing.version)


def entry_history(session: Session, entry_id: str) -> list[EntryHistoryModel]:
    return list(
        session.scalars(
            select(EntryHistoryModel)
            .where(EntryHistoryModel.entry_id == entry_id)
            .order_by(EntryHistoryModel.history_id.asc())
        ).all()
    )


def context_primary_currency(session: Session, context_id: str) -> str:
    """Dominant currency of a context, for paths that must mint a new entry
    (recurring generation) rather than read one (unified-expense-os-crh)."""
    return _primary_currency(_context_entries(session, context_id))


def _primary_currency(entries: list[LedgerEntryModel]) -> str:
    # Mirrors web/src/lib/currencies.ts partitionByCurrency: a context can hold
    # entries in more than one currency, so balance/settlement math must pick
    # one dominant currency (by entry count) rather than summing amounts that
    # aren't denominated the same way — see unified-expense-os-zj0.
    counts: dict[str, int] = {}
    order: list[str] = []
    for entry in entries:
        if entry.currency not in counts:
            order.append(entry.currency)
        counts[entry.currency] = counts.get(entry.currency, 0) + 1
    if not order:
        return "INR"
    return max(order, key=lambda currency: counts[currency])


def _context_entries(session: Session, context_id: str) -> list[LedgerEntryModel]:
    return list(
        session.scalars(
            select(LedgerEntryModel).where(
                LedgerEntryModel.context_id == context_id, LedgerEntryModel.voided_at.is_(None)
            )
        ).all()
    )


def context_balances(session: Session, context_id: str) -> tuple[dict[str, int], str]:
    entries = _context_entries(session, context_id)
    currency = _primary_currency(entries)
    balances: dict[str, int] = {}
    for entry in entries:
        if entry.currency != currency:
            continue
        for allocation in entry.allocations:
            balances.setdefault(allocation.participant_id, 0)
            balances[allocation.participant_id] -= allocation.share_amount
        balances.setdefault(entry.payer_id, 0)
        balances[entry.payer_id] += entry.total_amount
    return balances, currency


def pairwise_balance(
    session: Session, context_id: str, creditor_id: str, debtor_id: str, currency: str | None = None
) -> int:
    entries = _context_entries(session, context_id)
    if currency is None:
        currency = _primary_currency(entries)
    entries = [entry for entry in entries if entry.currency == currency]
    value = 0
    for entry in entries:
        if entry.type == "settlement":
            if entry.payer_id == debtor_id:
                for allocation in entry.allocations:
                    if allocation.participant_id == creditor_id and not allocation.is_payer:
                        value -= allocation.share_amount
            elif entry.payer_id == creditor_id:
                for allocation in entry.allocations:
                    if allocation.participant_id == debtor_id and not allocation.is_payer:
                        value += allocation.share_amount
            continue

        if entry.payer_id == creditor_id:
            for allocation in entry.allocations:
                if allocation.participant_id == debtor_id and not allocation.is_payer:
                    value += allocation.share_amount
        if entry.payer_id == debtor_id:
            for allocation in entry.allocations:
                if allocation.participant_id == creditor_id and not allocation.is_payer:
                    value -= allocation.share_amount
    return value


def pairwise_obligations(
    session: Session, context_id: str, participant_ids: list[str], currency: str
) -> list[SettlementPlanRow]:
    obligations: list[SettlementPlanRow] = []
    for debtor_id in participant_ids:
        for creditor_id in participant_ids:
            if debtor_id == creditor_id:
                continue
            value = pairwise_balance(session, context_id, creditor_id, debtor_id, currency=currency)
            if value > 0:
                obligations.append(
                    SettlementPlanRow(
                        from_participant_id=debtor_id,
                        to_participant_id=creditor_id,
                        amount_cents=value,
                        kind="pairwise",
                        currency=currency,
                    )
                )
    return obligations


def simplified_obligations(obligations: list[SettlementPlanRow], currency: str) -> list[SettlementPlanRow]:
    balances: dict[str, int] = {}
    for obligation in obligations:
        balances[obligation.from_participant_id] = balances.get(obligation.from_participant_id, 0) - obligation.amount_cents
        balances[obligation.to_participant_id] = balances.get(obligation.to_participant_id, 0) + obligation.amount_cents

    creditors = sorted(
        ((participant_id, amount) for participant_id, amount in balances.items() if amount > 0),
        key=lambda item: item[0],
    )
    debtors = sorted(
        ((participant_id, -amount) for participant_id, amount in balances.items() if amount < 0),
        key=lambda item: item[0],
    )
    recommendations: list[SettlementPlanRow] = []
    creditor_index = 0
    debtor_index = 0

    while debtor_index < len(debtors) and creditor_index < len(creditors):
        debtor_id, owed_amount = debtors[debtor_index]
        creditor_id, receivable_amount = creditors[creditor_index]
        amount = min(owed_amount, receivable_amount)
        if amount > 0:
            recommendations.append(
                SettlementPlanRow(
                    from_participant_id=debtor_id,
                    to_participant_id=creditor_id,
                    amount_cents=amount,
                    kind="simplified",
                    currency=currency,
                )
            )
        owed_amount -= amount
        receivable_amount -= amount
        debtors[debtor_index] = (debtor_id, owed_amount)
        creditors[creditor_index] = (creditor_id, receivable_amount)
        if owed_amount == 0:
            debtor_index += 1
        if receivable_amount == 0:
            creditor_index += 1

    return recommendations


def settlement_plan(session: Session, context_id: str) -> SettlementPlanResponse:
    memberships = session.scalars(
        select(MembershipModel)
        .where(MembershipModel.context_id == context_id)
        .order_by(MembershipModel.joined_at.asc(), MembershipModel.membership_id.asc())
    ).all()
    # Include departed members too — removing/leaving a context doesn't
    # erase a real debt, and dropping them here would silently make their
    # obligation un-settleable (unified-expense-os-dr1).
    participant_ids = [membership.participant_id for membership in memberships]
    currency = _primary_currency(_context_entries(session, context_id))
    raw_obligations = pairwise_obligations(session, context_id, participant_ids, currency)
    context_membership_by_participant = {membership.participant_id: membership for membership in memberships}
    context = next((membership.context for membership in memberships), None)
    simplification_enabled = bool(context and context.allow_simplified_debts)
    if not simplification_enabled:
        return SettlementPlanResponse(
            context_id=context_id,
            currency=currency,
            simplification_enabled=False,
            excluded_participant_ids=[],
            recommendations=raw_obligations,
        )

    excluded_participant_ids = sorted(
        participant_id
        for participant_id, membership in context_membership_by_participant.items()
        if membership.left_at is None and not membership.allow_simplify_for_me
    )
    included_participant_ids = {
        participant_id
        for participant_id in participant_ids
        if participant_id not in excluded_participant_ids
    }
    direct_recommendations = [
        obligation
        for obligation in raw_obligations
        if obligation.from_participant_id in excluded_participant_ids
        or obligation.to_participant_id in excluded_participant_ids
    ]
    simplifiable_obligations = [
        obligation
        for obligation in raw_obligations
        if obligation.from_participant_id in included_participant_ids
        and obligation.to_participant_id in included_participant_ids
    ]
    recommendations = direct_recommendations + simplified_obligations(simplifiable_obligations, currency)
    recommendations.sort(
        key=lambda row: (row.from_participant_id, row.to_participant_id, row.kind, row.amount_cents)
    )
    return SettlementPlanResponse(
        context_id=context_id,
        currency=currency,
        simplification_enabled=True,
        excluded_participant_ids=excluded_participant_ids,
        recommendations=recommendations,
    )


def settlement_warning(
    session: Session, context_id: str, creditor_id: str, debtor_id: str, amount: int
) -> str | None:
    current = pairwise_balance(session, context_id, creditor_id, debtor_id)
    if current > 0 and amount > current:
        return "overpayment_warning"
    return None
