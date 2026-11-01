"""Server-side web push delivery.

Requires VAPID keys (generate once with `uv run vapid --gen`, which writes
`private_key.pem`; derive the public key with `uv run vapid --applicationServerKey`,
or use `py_vapid.Vapid01().generate_keys()` programmatically) and set:

    VAPID_PUBLIC_KEY=<base64url application server key, shared with clients>
    VAPID_PRIVATE_KEY=<PEM private key contents>
    VAPID_SUBJECT=mailto:you@example.com

Delivery is best-effort: callers must never let a push failure affect the
primary request. `notify_participants` swallows all per-subscription errors,
logs them, and deletes subscriptions the push service reports as gone.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Iterable
from datetime import date

from pywebpush import WebPushException, webpush
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import MembershipModel, PushSubscriptionModel, RecurringTemplateModel
from .notifications import NotificationPayload, rent_due_reminder

logger = logging.getLogger("push_sender")

# Subscription is gone from the push service's point of view — stop retrying.
_EXPIRED_STATUS_CODES = {404, 410}


def _vapid_claims() -> dict[str, str] | None:
    subject = os.getenv("VAPID_SUBJECT")
    return {"sub": subject} if subject else None


def send_to_subscription(subscription: PushSubscriptionModel, payload: NotificationPayload) -> bool:
    """Send one push message. Returns True if the subscription is still
    valid, False if the push service reports it's expired/gone (caller
    should delete the row). Raises nothing — all errors are logged."""
    private_key = os.getenv("VAPID_PRIVATE_KEY")
    if not private_key:
        logger.info("push_sender.skip", extra={"reason": "no_vapid_private_key"})
        return True

    try:
        webpush(
            subscription_info={
                "endpoint": subscription.endpoint,
                "keys": {"p256dh": subscription.p256dh_key, "auth": subscription.auth_key},
            },
            data=json.dumps({"title": payload.title, "body": payload.body, "tag": payload.tag}),
            vapid_private_key=private_key,
            vapid_claims=_vapid_claims(),
        )
        return True
    except WebPushException as error:
        status_code = getattr(error.response, "status_code", None)
        if status_code in _EXPIRED_STATUS_CODES:
            logger.info(
                "push_sender.expired",
                extra={"subscription_id": subscription.subscription_id, "status_code": status_code},
            )
            return False
        logger.warning(
            "push_sender.failed",
            extra={"subscription_id": subscription.subscription_id, "error": str(error)},
        )
        return True
    except Exception as error:  # noqa: BLE001 - delivery must never raise into the caller
        logger.warning(
            "push_sender.failed",
            extra={"subscription_id": subscription.subscription_id, "error": str(error)},
        )
        return True


def notify_participants(session: Session, participant_ids: Iterable[str], payload: NotificationPayload | None) -> None:
    """Best-effort fan-out to every subscription for the given participants.
    No-op if payload is None (a decision function declined to notify)."""
    if payload is None:
        return
    participant_ids = list(participant_ids)
    if not participant_ids:
        return
    try:
        subscriptions = session.scalars(
            select(PushSubscriptionModel).where(PushSubscriptionModel.participant_id.in_(participant_ids))
        ).all()
        for subscription in subscriptions:
            still_valid = send_to_subscription(subscription, payload)
            if not still_valid:
                session.delete(subscription)
        session.commit()
    except Exception as error:  # noqa: BLE001 - never let notification fan-out break the caller
        logger.warning("push_sender.notify_failed", extra={"error": str(error)})
        session.rollback()


def send_rent_reminders(session: Session, today: date | None = None) -> int:
    """Evaluate rent_due_reminder() for every active recurring template and
    notify each context's active members if it fires. Callable directly
    (e.g. from a script or a test); there is no scheduler in this codebase,
    so periodic invocation (cron/systemd timer) is an ops concern for
    whoever deploys this, not something this module manages. Returns the
    number of templates that triggered a notification, mostly for tests/logs.
    """
    today = today or date.today()
    templates = session.scalars(
        select(RecurringTemplateModel).where(RecurringTemplateModel.active.is_(True))
    ).all()
    notified = 0
    for template in templates:
        payload = rent_due_reminder(template.description, template.anchor_day, today)
        if payload is None:
            continue
        recipient_ids = [
            membership.participant_id
            for membership in session.scalars(
                select(MembershipModel).where(
                    MembershipModel.context_id == template.context_id,
                    MembershipModel.left_at.is_(None),
                )
            ).all()
        ]
        notify_participants(session, recipient_ids, payload)
        notified += 1
    return notified
