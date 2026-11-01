from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import webauthn
from sqlalchemy import select
from sqlalchemy.orm import Session
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from .models import PasskeyCredentialModel, WebauthnChallengeModel

CHALLENGE_TTL = timedelta(minutes=5)


def rp_id() -> str:
    return os.getenv("WEBAUTHN_RP_ID", "localhost")


def rp_name() -> str:
    return "Unified Expense OS"


def expected_origin() -> str:
    return os.getenv("WEBAUTHN_ORIGIN", "http://localhost:5173")


class ChallengeExpiredError(Exception):
    pass


class NoCredentialsRegisteredError(Exception):
    """Raised on login-begin for a participant with zero passkeys — there is
    nothing to authenticate against, and this must never fall back to
    issuing a token some other way."""


def store_challenge(session: Session, flow_id: str, participant_id: str, purpose: str, challenge: bytes) -> None:
    now = datetime.now(UTC)
    session.add(
        WebauthnChallengeModel(
            flow_id=flow_id,
            participant_id=participant_id,
            purpose=purpose,
            challenge=webauthn.helpers.bytes_to_base64url(challenge),
            created_at=now,
            expires_at=now + CHALLENGE_TTL,
        )
    )
    session.commit()


def consume_challenge(session: Session, flow_id: str, purpose: str) -> tuple[str, bytes]:
    """Returns (participant_id, challenge_bytes) and marks the challenge
    consumed — a challenge can only ever be used once, closing the replay
    window even within its TTL."""
    row = session.get(WebauthnChallengeModel, flow_id)
    if row is None or row.purpose != purpose or row.consumed_at is not None:
        raise ChallengeExpiredError("challenge_not_found_or_used")
    now = datetime.now(UTC)
    expires_at = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=UTC)
    if expires_at <= now:
        raise ChallengeExpiredError("challenge_expired")
    row.consumed_at = now
    session.commit()
    return row.participant_id, webauthn.helpers.base64url_to_bytes(row.challenge)


def build_registration_options(session: Session, flow_id: str, participant_id: str, display_name: str):
    existing_credential_ids = session.scalars(
        select(PasskeyCredentialModel.credential_id).where(PasskeyCredentialModel.participant_id == participant_id)
    ).all()
    options = webauthn.generate_registration_options(
        rp_id=rp_id(),
        rp_name=rp_name(),
        user_id=participant_id.encode(),
        user_name=participant_id,
        user_display_name=display_name,
        attestation=webauthn.helpers.structs.AttestationConveyancePreference.NONE,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.PREFERRED,
        ),
        exclude_credentials=[
            PublicKeyCredentialDescriptor(id=webauthn.base64url_to_bytes(cred_id))
            for cred_id in existing_credential_ids
        ],
    )
    store_challenge(session, flow_id, participant_id, "registration", options.challenge)
    return options


def finish_registration(session: Session, flow_id: str, participant_id: str, credential: dict) -> None:
    stored_participant_id, challenge = consume_challenge(session, flow_id, "registration")
    if stored_participant_id != participant_id:
        raise ChallengeExpiredError("participant_mismatch")
    verified = webauthn.verify_registration_response(
        credential=credential,
        expected_challenge=challenge,
        expected_rp_id=rp_id(),
        expected_origin=expected_origin(),
    )
    session.add(
        PasskeyCredentialModel(
            credential_id=webauthn.helpers.bytes_to_base64url(verified.credential_id),
            participant_id=participant_id,
            public_key=webauthn.helpers.bytes_to_base64url(verified.credential_public_key),
            sign_count=verified.sign_count,
            created_at=datetime.now(UTC),
        )
    )
    session.commit()


def build_authentication_options(session: Session, flow_id: str, participant_id: str):
    credentials = session.scalars(
        select(PasskeyCredentialModel).where(PasskeyCredentialModel.participant_id == participant_id)
    ).all()
    if not credentials:
        raise NoCredentialsRegisteredError(participant_id)
    options = webauthn.generate_authentication_options(
        rp_id=rp_id(),
        allow_credentials=[
            PublicKeyCredentialDescriptor(id=webauthn.base64url_to_bytes(cred.credential_id)) for cred in credentials
        ],
        user_verification=UserVerificationRequirement.PREFERRED,
    )
    store_challenge(session, flow_id, participant_id, "authentication", options.challenge)
    return options


def finish_authentication(session: Session, flow_id: str, participant_id: str, credential: dict) -> None:
    """Verifies the assertion signature against the stored public key and
    strictly-increasing sign counter. Raises on any mismatch — there is no
    path here that issues a token without a valid signature."""
    stored_participant_id, challenge = consume_challenge(session, flow_id, "authentication")
    if stored_participant_id != participant_id:
        raise ChallengeExpiredError("participant_mismatch")
    credential_id = credential.get("id") if isinstance(credential, dict) else None
    row = session.get(PasskeyCredentialModel, credential_id) if credential_id else None
    if row is None or row.participant_id != participant_id:
        raise ChallengeExpiredError("credential_not_found")
    verified = webauthn.verify_authentication_response(
        credential=credential,
        expected_challenge=challenge,
        expected_rp_id=rp_id(),
        expected_origin=expected_origin(),
        credential_public_key=webauthn.helpers.base64url_to_bytes(row.public_key),
        credential_current_sign_count=row.sign_count,
    )
    row.sign_count = verified.new_sign_count
    session.commit()
