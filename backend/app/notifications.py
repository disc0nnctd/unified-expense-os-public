from __future__ import annotations

from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class NotificationPayload:
    title: str
    body: str
    tag: str  # dedupe key so repeated triggers don't stack notifications


# Currency symbols for the codes we format often; anything else falls back to
# the ISO code so a USD entry never renders as rupees (unified-expense-os-crh).
_CURRENCY_SYMBOLS = {"INR": "₹", "USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥"}


def format_amount(amount_minor: int, currency: str = "INR") -> str:
    code = (currency or "INR").upper()
    major = amount_minor / 100
    symbol = _CURRENCY_SYMBOLS.get(code)
    return f"{symbol}{major:.2f}" if symbol else f"{major:.2f} {code}"


def activity_notification(
    actor_name: str, context_name: str, description: str, amount_paise: int, currency: str = "INR"
) -> NotificationPayload:
    return NotificationPayload(
        title=context_name,
        body=f"{actor_name} added {format_amount(amount_paise, currency)} {description}",
        tag=f"activity-{context_name}",
    )


# A settle-up reminder fires once a pair's net balance magnitude crosses the
# threshold — informational, never auto-generates a settlement.
def settle_up_reminder(
    from_name: str, to_name: str, balance_paise: int, threshold_paise: int
) -> NotificationPayload | None:
    if abs(balance_paise) < threshold_paise:
        return None
    rupees = abs(balance_paise) / 100
    return NotificationPayload(
        title="Settle up?",
        body=f"{from_name} owes {to_name} ₹{rupees:.2f}",
        tag=f"settle-{from_name}-{to_name}",
    )


# Rent-due reminders fire in the window [anchor_day - lead_days, anchor_day]
# of the current month, once per month (tag dedupes by month).
def rent_due_reminder(
    description: str, anchor_day: int, today: date, lead_days: int = 3
) -> NotificationPayload | None:
    if today.day < anchor_day - lead_days or today.day > anchor_day:
        return None
    return NotificationPayload(
        title="Upcoming: " + description,
        body=f"Due around day {anchor_day} of the month",
        tag=f"rent-{description}-{today.year}-{today.month}",
    )
