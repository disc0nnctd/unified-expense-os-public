from __future__ import annotations

from calendar import monthrange
from dataclasses import dataclass
from datetime import date, timedelta


@dataclass(frozen=True, slots=True)
class SplitRequest:
    amount: int
    rule: dict
    participant_ids: tuple[str, ...]
    payer_id: str


def _coerce_anchor_day(year: int, month: int, anchor_day: int) -> int:
    return min(anchor_day, monthrange(year, month)[1])


def weekly_due_dates(start: date, through: date) -> list[date]:
    # Weekly occurrences step seven days from the template's next_due_date;
    # anchor_day is a day-of-month concept and does not apply.
    due_dates: list[date] = []
    cursor = start
    while cursor <= through:
        due_dates.append(cursor)
        cursor = cursor + timedelta(days=7)
    return due_dates


def monthly_due_dates(start: date, through: date, anchor_day: int) -> list[date]:
    due_dates: list[date] = []
    cursor = date(start.year, start.month, _coerce_anchor_day(start.year, start.month, anchor_day))
    while cursor <= through:
        if cursor >= start:
            due_dates.append(cursor)
        if cursor.month == 12:
            year, month = cursor.year + 1, 1
        else:
            year, month = cursor.year, cursor.month + 1
        cursor = date(year, month, _coerce_anchor_day(year, month, anchor_day))
    return due_dates


def resolve_split(request: SplitRequest) -> list[dict]:
    split_type = request.rule["type"]
    if split_type == "equal":
        base = request.amount // len(request.participant_ids)
        remainder = request.amount % len(request.participant_ids)
        allocations = []
        for participant_id in sorted(request.participant_ids):
            allocations.append(
                {
                    "participant_id": participant_id,
                    "share_amount": base + (remainder if participant_id == request.payer_id else 0),
                    "is_payer": participant_id == request.payer_id,
                }
            )
        return allocations

    if split_type == "fixed":
        allocations = [
            {
                "participant_id": participant_id,
                "share_amount": int(request.rule["amounts"][participant_id]),
                "is_payer": participant_id == request.payer_id,
            }
            for participant_id in request.participant_ids
        ]
        if sum(item["share_amount"] for item in allocations) != request.amount:
            raise ValueError("fixed_split_mismatch")
        return allocations

    if split_type in {"ratio", "percentage"}:
        values = request.rule["values"]
        total_weight = sum(values[participant_id] for participant_id in request.participant_ids)
        allocated = 0
        allocations = []
        for participant_id in sorted(request.participant_ids):
            share = (request.amount * values[participant_id]) // total_weight
            allocations.append(
                {
                    "participant_id": participant_id,
                    "share_amount": int(share),
                    "is_payer": participant_id == request.payer_id,
                }
            )
            allocated += int(share)
        payer_allocation = next(
            allocation for allocation in allocations if allocation["participant_id"] == request.payer_id
        )
        payer_allocation["share_amount"] += request.amount - allocated
        return allocations

    raise ValueError("unsupported_split_rule")


def generate_due_occurrences(
    template_id: str,
    next_due_date: date,
    cadence: str,
    anchor_day: int,
    as_of_date: date,
    existing_generation_keys: set[str],
) -> list[tuple[date, str]]:
    if cadence == "monthly":
        dates = monthly_due_dates(next_due_date, as_of_date, anchor_day)
    elif cadence == "weekly":
        dates = weekly_due_dates(next_due_date, as_of_date)
    else:
        raise ValueError("unsupported_cadence")
    occurrences: list[tuple[date, str]] = []
    for due_date in dates:
        generation_key = f"{template_id}:{due_date.isoformat()}"
        if generation_key not in existing_generation_keys:
            occurrences.append((due_date, generation_key))
    return occurrences
