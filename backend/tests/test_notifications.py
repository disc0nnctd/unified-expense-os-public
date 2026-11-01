from datetime import date

from app.notifications import activity_notification, rent_due_reminder, settle_up_reminder


def test_activity_notification_formats_amount_and_actor():
    payload = activity_notification("Ravi", "Home", "Groceries", 45000)
    assert payload.body == "Ravi added ₹450.00 Groceries"
    assert payload.title == "Home"


def test_settle_up_reminder_fires_only_above_threshold():
    assert settle_up_reminder("Alice", "Bob", 400, 1000) is None
    payload = settle_up_reminder("Alice", "Bob", -1500, 1000)
    assert payload is not None
    assert payload.body == "Alice owes Bob ₹15.00"


def test_rent_due_reminder_window():
    assert rent_due_reminder("Rent", anchor_day=5, today=date(2026, 7, 1), lead_days=3) is None
    payload = rent_due_reminder("Rent", anchor_day=5, today=date(2026, 7, 3), lead_days=3)
    assert payload is not None
    assert payload.tag == "rent-Rent-2026-7"
    assert rent_due_reminder("Rent", anchor_day=5, today=date(2026, 7, 6), lead_days=3) is None
