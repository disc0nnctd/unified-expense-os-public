from __future__ import annotations

import json
from datetime import UTC, date, datetime
from types import SimpleNamespace
from unittest.mock import patch

from pywebpush import WebPushException

from app.models import ContextModel, MembershipModel, ParticipantModel, PushSubscriptionModel, RecurringTemplateModel
from app.notifications import NotificationPayload
from app.push_sender import notify_participants, send_rent_reminders, send_to_subscription


def _subscription(subscription_id: str = "push_1", participant_id: str = "p1") -> PushSubscriptionModel:
    return PushSubscriptionModel(
        subscription_id=subscription_id,
        participant_id=participant_id,
        endpoint="https://push.example/abc",
        p256dh_key="p256dh",
        auth_key="auth",
        created_at=datetime.now(UTC),
    )


def test_send_to_subscription_no_vapid_key_configured_is_a_noop_success(monkeypatch):
    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    payload = NotificationPayload(title="t", body="b", tag="x")
    assert send_to_subscription(_subscription(), payload) is True


def test_send_to_subscription_success(monkeypatch):
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "fake-private-key")
    payload = NotificationPayload(title="t", body="b", tag="x")
    with patch("app.push_sender.webpush") as mock_webpush:
        mock_webpush.return_value = None
        assert send_to_subscription(_subscription(), payload) is True
        mock_webpush.assert_called_once()


def test_send_to_subscription_payload_is_valid_json_with_correct_fields(monkeypatch):
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "fake-private-key")
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:ops@example.com")
    subscription = _subscription()
    payload = NotificationPayload(title="Home", body="Ravi added ₹50.00 Coffee", tag="activity-Home")
    with patch("app.push_sender.webpush") as mock_webpush:
        send_to_subscription(subscription, payload)

    kwargs = mock_webpush.call_args.kwargs
    assert kwargs["subscription_info"] == {
        "endpoint": subscription.endpoint,
        "keys": {"p256dh": subscription.p256dh_key, "auth": subscription.auth_key},
    }
    assert json.loads(kwargs["data"]) == {"title": "Home", "body": "Ravi added ₹50.00 Coffee", "tag": "activity-Home"}
    assert kwargs["vapid_private_key"] == "fake-private-key"
    assert kwargs["vapid_claims"] == {"sub": "mailto:ops@example.com"}


def test_send_to_subscription_expired_returns_false(monkeypatch):
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "fake-private-key")
    payload = NotificationPayload(title="t", body="b", tag="x")
    error = WebPushException("gone", response=SimpleNamespace(status_code=410, text="gone", headers={}))
    with patch("app.push_sender.webpush", side_effect=error):
        assert send_to_subscription(_subscription(), payload) is False


def test_send_to_subscription_other_failure_does_not_raise(monkeypatch):
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "fake-private-key")
    payload = NotificationPayload(title="t", body="b", tag="x")
    error = WebPushException("server error", response=SimpleNamespace(status_code=500, text="err", headers={}))
    with patch("app.push_sender.webpush", side_effect=error):
        assert send_to_subscription(_subscription(), payload) is True


def test_send_to_subscription_unexpected_exception_does_not_raise(monkeypatch):
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "fake-private-key")
    payload = NotificationPayload(title="t", body="b", tag="x")
    with patch("app.push_sender.webpush", side_effect=RuntimeError("network down")):
        assert send_to_subscription(_subscription(), payload) is True


def test_notify_participants_deletes_expired_subscription(db_session):
    subscription = _subscription()
    db_session.add(subscription)
    db_session.commit()

    with patch("app.push_sender.send_to_subscription", return_value=False):
        notify_participants(db_session, ["p1"], NotificationPayload(title="t", body="b", tag="x"))

    remaining = db_session.get(PushSubscriptionModel, "push_1")
    assert remaining is None


def test_notify_participants_keeps_valid_subscription(db_session):
    subscription = _subscription()
    db_session.add(subscription)
    db_session.commit()

    with patch("app.push_sender.send_to_subscription", return_value=True):
        notify_participants(db_session, ["p1"], NotificationPayload(title="t", body="b", tag="x"))

    remaining = db_session.get(PushSubscriptionModel, "push_1")
    assert remaining is not None


def test_notify_participants_none_payload_is_noop(db_session):
    subscription = _subscription()
    db_session.add(subscription)
    db_session.commit()

    with patch("app.push_sender.send_to_subscription") as mock_send:
        notify_participants(db_session, ["p1"], None)
        mock_send.assert_not_called()


def test_notify_participants_swallows_unexpected_errors(db_session):
    subscription = _subscription()
    db_session.add(subscription)
    db_session.commit()

    with patch("app.push_sender.send_to_subscription", side_effect=RuntimeError("boom")):
        notify_participants(db_session, ["p1"], NotificationPayload(title="t", body="b", tag="x"))


def _seed_rent_context(db_session, *, context_id: str, template_id: str, anchor_day: int, member_ids: list[str]):
    now = datetime.now(UTC)
    db_session.add(
        ContextModel(
            context_id=context_id,
            name="Flatshare",
            type="shared",
            owner_participant_id=member_ids[0],
            created_at=now,
            updated_at=now,
        )
    )
    for member_id in member_ids:
        db_session.add(ParticipantModel(participant_id=member_id, display_name=member_id, created_at=now, is_ghost=False))
        db_session.add(
            MembershipModel(
                membership_id=f"m-{context_id}-{member_id}",
                context_id=context_id,
                participant_id=member_id,
                joined_at=now,
                default_share="equal",
                updated_at=now,
            )
        )
    db_session.add(
        RecurringTemplateModel(
            template_id=template_id,
            context_id=context_id,
            description="Rent",
            amount=100000,
            split_rule_json="{}",
            cadence="monthly",
            next_due_date=date(2026, 8, 1),
            anchor_day=anchor_day,
            active=True,
            created_at=now,
            updated_at=now,
        )
    )
    db_session.commit()


def test_send_rent_reminders_notifies_active_members_in_window(db_session):
    _seed_rent_context(db_session, context_id="ctx1", template_id="tpl1", anchor_day=5, member_ids=["alice", "bob"])

    with patch("app.push_sender.notify_participants") as mock_notify:
        notified = send_rent_reminders(db_session, today=date(2026, 7, 4))

    assert notified == 1
    mock_notify.assert_called_once()
    call_args = mock_notify.call_args.args
    assert sorted(call_args[1]) == ["alice", "bob"]
    assert call_args[2].tag == "rent-Rent-2026-7"


def test_send_rent_reminders_skips_templates_outside_window(db_session):
    _seed_rent_context(db_session, context_id="ctx2", template_id="tpl2", anchor_day=5, member_ids=["alice"])

    with patch("app.push_sender.notify_participants") as mock_notify:
        notified = send_rent_reminders(db_session, today=date(2026, 7, 20))

    assert notified == 0
    mock_notify.assert_not_called()


def test_send_rent_reminders_ignores_inactive_templates(db_session):
    _seed_rent_context(db_session, context_id="ctx3", template_id="tpl3", anchor_day=5, member_ids=["alice"])
    template = db_session.get(RecurringTemplateModel, "tpl3")
    template.active = False
    db_session.commit()

    with patch("app.push_sender.notify_participants") as mock_notify:
        notified = send_rent_reminders(db_session, today=date(2026, 7, 4))

    assert notified == 0
    mock_notify.assert_not_called()


def test_send_rent_reminders_excludes_departed_members(db_session):
    _seed_rent_context(db_session, context_id="ctx4", template_id="tpl4", anchor_day=5, member_ids=["alice", "bob"])
    membership = db_session.get(MembershipModel, "m-ctx4-bob")
    membership.left_at = datetime.now(UTC)
    db_session.commit()

    with patch("app.push_sender.notify_participants") as mock_notify:
        send_rent_reminders(db_session, today=date(2026, 7, 4))

    call_args = mock_notify.call_args.args
    assert call_args[1] == ["alice"]
