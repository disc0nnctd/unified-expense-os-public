from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta
from typing import Annotated
from uuid import uuid4

import webauthn
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from .api_models import ContextSummary, InviteRedeemOut, MembershipSummary
from .capture import classify_capture
from .db import Base, engine, ensure_runtime_schema, get_session
from .logging_config import configure_logging
from .llm_vision import LlmVisionUnavailableError, extract_receipt_via_llm, http_poster
from .llm_capture import LlmCaptureUnavailableError, draft_capture_via_llm
from .llm_capture import http_poster as llm_capture_http_poster
from .llm_coldstart import LlmColdStartUnavailableError, suggest_coldstart_via_llm
from .llm_coldstart import http_poster as llm_coldstart_http_poster
from .llm_chat_intent import LlmChatIntentUnavailableError, chat_intent_via_llm, raw_completion
from .llm_chat_intent import http_poster as llm_chat_intent_http_poster
from .llm_provider import LlmBaseUrlNotAllowed, resolve_llm_config_for, validate_participant_base_url
from .ledger import (
    context_primary_currency,
    context_balances,
    entry_history,
    settlement_plan,
    settlement_warning,
    upsert_entry,
    validate_allocations,
)
from .notifications import activity_notification
from .push_sender import notify_participants
from .models import (
    ContextModel,
    DeviceTokenModel,
    InviteModel,
    LedgerEntryModel,
    LlmConfigModel,
    MembershipModel,
    ParticipantModel,
    PushSubscriptionModel,
    RecurringTemplateModel,
)
from . import webauthn_service
from .ratelimit import auth_failure_limiter, invite_redemption_limiter, llm_relay_limiter
from .recurring import SplitRequest, generate_due_occurrences, resolve_split
from .schemas import (
    BalanceRow,
    CaptureRequest,
    CaptureSuggestion,
    AgentPromptIn,
    AgentTextOut,
    ChatIntentRequest,
    ChatIntentResponse,
    ChatQueryOut,
    ContextCloseOut,
    ContextIn,
    DeviceTokenOut,
    ContextPreferencesUpdate,
    EntryHistoryOut,
    GhostParticipantIn,
    GhostParticipantOut,
    InviteCreateIn,
    InviteOut,
    InviteRedeemIn,
    LedgerEntryIn,
    LedgerEntryOut,
    LlmCaptureDraftOut,
    LlmCaptureRequest,
    LlmColdStartRequest,
    LlmColdStartSuggestionOut,
    LlmConfigIn,
    LlmConfigOut,
    MembershipIn,
    MembershipPreferencesUpdate,
    ParticipantIn,
    ParticipantOut,
    PushSubscriptionIn,
    ReceiptVisionRequest,
    ReceiptVisionResponse,
    RecurringTemplateIn,
    RecurringTemplateUpdate,
    RenameParticipantIn,
    TokenRotationOut,
    SettlementConfirmationIn,
    SettlementPlanResponse,
    SyncPullResponse,
    SyncPushRequest,
    SyncPushResponseItem,
    WebauthnLoginBeginIn,
    WebauthnLoginBeginOut,
    WebauthnLoginFinishIn,
    WebauthnLoginFinishOut,
    WebauthnRegistrationBeginOut,
    WebauthnRegistrationFinishIn,
)

INVITE_TTL = timedelta(days=7)
# No 0/O/1/I/L so codes survive being read aloud or retyped.
INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


@asynccontextmanager
async def lifespan(_: FastAPI):
    configure_logging()
    Base.metadata.create_all(bind=engine)
    ensure_runtime_schema()
    yield


app = FastAPI(title="Unified Expense OS Backend", version="0.1.0", lifespan=lifespan)

# Defaults to an explicit localhost allowlist rather than "*" — a
# self-hosted deployment must opt into its real origin(s) via
# CORS_ALLOWED_ORIGINS (comma-separated) instead of silently trusting every
# site on the internet. "*" remains available for local dev by explicitly
# setting CORS_ALLOWED_ORIGINS="*".
# The Capacitor native shells serve the packaged bundle from a fixed local
# origin — Android from https://localhost, iOS from capacitor://localhost — so
# those are always trusted (they are the app itself, not a remote site). Web
# dev origins round out the default allowlist.
_NATIVE_APP_ORIGINS = ["https://localhost", "capacitor://localhost"]
_cors_origins_env = os.getenv("CORS_ALLOWED_ORIGINS", "").strip()
if _cors_origins_env:
    CORS_ORIGINS = [origin.strip() for origin in _cors_origins_env.split(",") if origin.strip()]
    # Keep the native shells trusted even when a deployment sets its own web
    # allowlist, unless the operator explicitly opted into "*".
    if "*" not in CORS_ORIGINS:
        CORS_ORIGINS.extend(o for o in _NATIVE_APP_ORIGINS if o not in CORS_ORIGINS)
else:
    CORS_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", *_NATIVE_APP_ORIGINS]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Domain validation raises ValueError with a machine-readable code; outside
# /sync/push (which maps them to per-entry rejections) these used to escape
# as 500s (unified-expense-os-59q). Map only the *known* codes to 422 —
# an unrecognized ValueError is a genuine bug and should still surface as a
# 500 rather than masquerade as client error.
_DOMAIN_VALIDATION_CODES = {
    "hlc_clock_skew_exceeded",
    "allocation_sum_mismatch",
    "payer_allocation_invalid",
    "fixed_split_mismatch",
    "unsupported_split_rule",
    "unsupported_cadence",
    # LlmBaseUrlNotAllowed subclasses ValueError and can surface from
    # resolve_llm_config_for() at call time, outside the LLM endpoints' own
    # try blocks (unified-expense-os-vf8).
    "base_url_private_not_allowed",
    "base_url_host_required",
}


@app.exception_handler(ValueError)
async def domain_validation_error_handler(request: Request, exc: ValueError):
    code = str(exc)
    if code in _DOMAIN_VALIDATION_CODES:
        return JSONResponse(status_code=422, content={"detail": code})
    raise exc

# REGISTRATION_MODE=open (default) leaves POST /participants unauthenticated,
# fine for a LAN-only self-hosted instance. A deployment exposed to the
# internet (port-forwarded, tunneled, etc.) should set
# REGISTRATION_MODE=invite-only so new identities can only be minted through
# /invites/redeem — which still works normally, since it never calls through
# create_participant below (unified-expense-os-bvp). Read per-request (not
# cached at import time) so it can be toggled without a process restart —
# tests rely on this too.
def _registration_mode() -> str:
    return os.getenv("REGISTRATION_MODE", "open").strip().lower()


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "geolocation=(), camera=(), microphone=()"
    return response


def _new_auth_token() -> str:
    return f"pt_{uuid4().hex}"


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _issue_device_token(session: Session, participant_id: str, label: str | None = None) -> str:
    token = _new_auth_token()
    session.add(
        DeviceTokenModel(
            device_token_id=f"dt_{uuid4().hex}",
            token_hash=_hash_token(token),
            participant_id=participant_id,
            label=label,
            created_at=datetime.now(UTC),
        )
    )
    return token


def require_participant(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    session: Session = Depends(get_session),
) -> ParticipantModel:
    client_key = request.client.host if request.client else "unknown"
    if authorization is None or not authorization.startswith("Bearer "):
        if not auth_failure_limiter.allow(client_key):
            raise HTTPException(status_code=429, detail="too_many_auth_failures")
        raise HTTPException(status_code=401, detail="auth_required")
    token = authorization.removeprefix("Bearer ").strip()
    device_token = session.scalar(
        select(DeviceTokenModel).where(
            DeviceTokenModel.token_hash == _hash_token(token), DeviceTokenModel.revoked_at.is_(None)
        )
    )
    participant = session.get(ParticipantModel, device_token.participant_id) if device_token else None
    if participant is None:
        if not auth_failure_limiter.allow(client_key):
            raise HTTPException(status_code=429, detail="too_many_auth_failures")
        raise HTTPException(status_code=401, detail="invalid_token")
    request.state.device_token = device_token
    return participant


CurrentParticipant = Annotated[ParticipantModel, Depends(require_participant)]


def optional_participant(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    session: Session = Depends(get_session),
) -> ParticipantModel | None:
    if authorization is None:
        return None
    return require_participant(request, authorization, session)


OptionalParticipant = Annotated[ParticipantModel | None, Depends(optional_participant)]


def _new_invite_code() -> str:
    return "".join(secrets.choice(INVITE_ALPHABET) for _ in range(8))


def normalize_invite_code(code: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", code.upper())


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def _invite_out(invite: InviteModel, context_name: str, claim_display_name: str | None = None) -> InviteOut:
    return InviteOut(
        invite_code=invite.invite_code,
        context_id=invite.context_id,
        context_name=context_name,
        created_by=invite.created_by,
        created_at=invite.created_at,
        expires_at=invite.expires_at,
        redeemed_at=invite.redeemed_at,
        redeemed_by=invite.redeemed_by,
        claim_participant_id=invite.claim_participant_id,
        claim_display_name=claim_display_name,
    )


def _active_context_member(session: Session, context_id: str, participant_id: str) -> MembershipModel | None:
    return session.scalar(
        select(MembershipModel).where(
            MembershipModel.context_id == context_id,
            MembershipModel.participant_id == participant_id,
            MembershipModel.left_at.is_(None),
        )
    )


def _context_or_404(session: Session, context_id: str) -> ContextModel:
    context = session.get(ContextModel, context_id)
    if context is None:
        raise HTTPException(status_code=404, detail="context_not_found")
    return context


def _require_context_access(session: Session, context_id: str, participant: ParticipantModel) -> ContextModel:
    context = _context_or_404(session, context_id)
    if context.owner_participant_id == participant.participant_id:
        return context
    if _active_context_member(session, context_id, participant.participant_id) is None:
        raise HTTPException(status_code=403, detail="context_forbidden")
    return context


def _require_context_owner(session: Session, context_id: str, participant: ParticipantModel) -> ContextModel:
    context = _context_or_404(session, context_id)
    if context.owner_participant_id != participant.participant_id:
        raise HTTPException(status_code=403, detail="context_owner_required")
    return context


def _require_context_writable(context: ContextModel) -> None:
    if context.closed_at is not None:
        raise HTTPException(status_code=409, detail="context_closed")


def _active_member_ids(session: Session, context_id: str) -> set[str]:
    return set(
        session.scalars(
            select(MembershipModel.participant_id).where(
                MembershipModel.context_id == context_id,
                MembershipModel.left_at.is_(None),
            )
        ).all()
    )


def _ever_member_ids(session: Session, context_id: str) -> set[str]:
    return set(
        session.scalars(
            select(MembershipModel.participant_id).where(MembershipModel.context_id == context_id)
        ).all()
    )


def _validate_entry_scope(session: Session, entry: LedgerEntryIn, participant: ParticipantModel) -> None:
    context = _require_context_access(session, entry.context_id, participant)
    _require_context_writable(context)
    entry_participant_ids = {entry.payer_id, *(allocation.participant_id for allocation in entry.allocations)}
    # Settlements are the one entry type allowed to reference a departed member: settlement_plan()
    # deliberately recommends settling debts owed by/to members who have since left, so a member who
    # left with a nonzero balance must remain settleable against their ledger history.
    if entry.type == "settlement":
        member_ids = _ever_member_ids(session, entry.context_id)
    else:
        member_ids = _active_member_ids(session, entry.context_id)
    if not entry_participant_ids.issubset(member_ids):
        raise HTTPException(status_code=403, detail="entry_participant_forbidden")


def _entry_out(model: LedgerEntryModel) -> LedgerEntryOut:
    return LedgerEntryOut(
        entry_id=model.entry_id,
        context_id=model.context_id,
        type=model.type,
        recorded_at=model.recorded_at,
        effective_date=model.effective_date,
        payer_id=model.payer_id,
        total_amount=model.total_amount,
        currency=model.currency,
        description=model.description,
        category=model.category,
        notes=model.notes,
        allocations=[
            {
                "participant_id": allocation.participant_id,
                "share_amount": allocation.share_amount,
                "is_payer": allocation.is_payer,
            }
            for allocation in model.allocations
        ],
        linked_template_id=model.linked_template_id,
        linked_entry_id=model.linked_entry_id,
        generation_key=model.generation_key,
        version=model.version,
        hlc=model.hlc,
        voided_at=model.voided_at,
        void_reason=model.void_reason,
        server_seq=model.server_seq,
        conflict_resolved_by=model.conflict_resolved_by,
    )


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/contexts")
def create_context(
    payload: ContextIn, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> ContextIn:
    if payload.owner_participant_id != participant.participant_id:
        raise HTTPException(status_code=403, detail="context_owner_mismatch")
    existing = session.get(ContextModel, payload.context_id)
    if existing is not None:
        _require_context_access(session, existing.context_id, participant)
        return ContextIn(
            context_id=existing.context_id,
            name=existing.name,
            type=existing.type,
            owner_participant_id=existing.owner_participant_id,
            created_at=existing.created_at,
            default_split=existing.default_split,
            allow_simplified_debts=existing.allow_simplified_debts,
            version=existing.version,
        )
    model = ContextModel(**payload.model_dump(exclude={"version"}), updated_at=datetime.now(UTC))
    session.add(model)
    session.commit()
    return ContextIn(**payload.model_dump(exclude={"version"}), version=model.version)


@app.get("/contexts", response_model=list[ContextSummary])
def list_contexts(participant: CurrentParticipant, session: Session = Depends(get_session)) -> list[ContextSummary]:
    contexts = session.scalars(
        select(ContextModel)
        .outerjoin(MembershipModel, ContextModel.context_id == MembershipModel.context_id)
        .where(
            (ContextModel.owner_participant_id == participant.participant_id)
            | (
                (MembershipModel.participant_id == participant.participant_id)
                & (MembershipModel.left_at.is_(None))
            )
        )
        .order_by(ContextModel.created_at.asc())
    ).unique().all()
    return [
        ContextSummary(
            context_id=context.context_id,
            name=context.name,
            type=context.type,
            owner_participant_id=context.owner_participant_id,
            created_at=context.created_at,
            archived_at=context.archived_at,
            closed_at=context.closed_at,
            default_split=context.default_split,
            allow_simplified_debts=context.allow_simplified_debts,
            version=context.version,
        )
        for context in contexts
    ]


@app.patch("/contexts/{context_id}/preferences", response_model=ContextIn)
def update_context_preferences(
    context_id: str,
    payload: ContextPreferencesUpdate,
    participant: CurrentParticipant,
    session: Session = Depends(get_session),
) -> ContextIn:
    context = _require_context_owner(session, context_id, participant)
    _require_context_writable(context)
    if payload.expected_version is not None and payload.expected_version != context.version:
        raise HTTPException(
            status_code=409,
            detail={"error": "version_conflict", "current_version": context.version},
        )
    context.allow_simplified_debts = payload.allow_simplified_debts
    context.version += 1
    context.updated_at = datetime.now(UTC)
    session.commit()
    return ContextIn(
        context_id=context.context_id,
        name=context.name,
        type=context.type,
        owner_participant_id=context.owner_participant_id,
        created_at=context.created_at,
        default_split=context.default_split,
        allow_simplified_debts=context.allow_simplified_debts,
        version=context.version,
    )


@app.post("/participants", response_model=ParticipantOut)
def create_participant(payload: ParticipantIn, session: Session = Depends(get_session)) -> ParticipantOut:
    if _registration_mode() == "invite-only":
        raise HTTPException(status_code=403, detail="registration_invite_only")
    existing = session.get(ParticipantModel, payload.participant_id)
    if existing is not None:
        raise HTTPException(status_code=409, detail="participant_exists")
    model = ParticipantModel(**payload.model_dump())
    session.add(model)
    token = _issue_device_token(session, payload.participant_id, label="primary")
    session.commit()
    return ParticipantOut(**payload.model_dump(), auth_token=token)


@app.patch("/participants/me", response_model=ParticipantOut)
def rename_self(
    payload: RenameParticipantIn,
    participant: CurrentParticipant,
    session: Session = Depends(get_session),
) -> ParticipantOut:
    name = payload.display_name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="display_name_required")
    participant.display_name = name
    session.commit()
    return ParticipantOut(
        participant_id=participant.participant_id,
        display_name=participant.display_name,
        is_ghost=participant.is_ghost,
        ghost_managed_by=participant.ghost_managed_by,
        created_at=participant.created_at,
        auth_token=None,
    )


# --- Passkey (WebAuthn) authentication ---------------------------------
#
# Registration requires an existing bearer token (you must already be
# authenticated to bind a passkey to your identity — this can't itself mint
# a token). Login requires NO prior token: the whole point is enabling a new
# device to authenticate as an existing participant without needing to
# already possess their bearer token. If a participant has zero registered
# credentials, login-begin raises NoCredentialsRegisteredError -> 404; there
# is no fallback path that hands out a token anyway.
@app.post("/webauthn/registration/begin", response_model=WebauthnRegistrationBeginOut)
def webauthn_registration_begin(
    participant: CurrentParticipant, session: Session = Depends(get_session)
) -> WebauthnRegistrationBeginOut:
    flow_id = f"reg_{uuid4().hex}"
    options = webauthn_service.build_registration_options(
        session, flow_id, participant.participant_id, participant.display_name
    )
    return WebauthnRegistrationBeginOut(flow_id=flow_id, options_json=webauthn.options_to_json(options))


@app.post("/webauthn/registration/finish", status_code=204, response_model=None)
def webauthn_registration_finish(
    payload: WebauthnRegistrationFinishIn,
    participant: CurrentParticipant,
    session: Session = Depends(get_session),
) -> None:
    try:
        webauthn_service.finish_registration(session, payload.flow_id, participant.participant_id, payload.credential)
    except webauthn_service.ChallengeExpiredError:
        raise HTTPException(status_code=400, detail="challenge_invalid_or_expired")
    except Exception:
        raise HTTPException(status_code=400, detail="registration_verification_failed")


@app.post("/webauthn/login/begin", response_model=WebauthnLoginBeginOut)
def webauthn_login_begin(payload: WebauthnLoginBeginIn, session: Session = Depends(get_session)) -> WebauthnLoginBeginOut:
    if session.get(ParticipantModel, payload.participant_id) is None:
        raise HTTPException(status_code=404, detail="participant_not_found")
    flow_id = f"auth_{uuid4().hex}"
    try:
        options = webauthn_service.build_authentication_options(session, flow_id, payload.participant_id)
    except webauthn_service.NoCredentialsRegisteredError:
        raise HTTPException(status_code=404, detail="no_passkey_registered")
    return WebauthnLoginBeginOut(flow_id=flow_id, options_json=webauthn.options_to_json(options))


@app.post("/webauthn/login/finish", response_model=WebauthnLoginFinishOut)
def webauthn_login_finish(payload: WebauthnLoginFinishIn, session: Session = Depends(get_session)) -> WebauthnLoginFinishOut:
    try:
        webauthn_service.finish_authentication(session, payload.flow_id, payload.participant_id, payload.credential)
    except webauthn_service.ChallengeExpiredError:
        raise HTTPException(status_code=401, detail="assertion_invalid_or_expired")
    except Exception:
        raise HTTPException(status_code=401, detail="assertion_verification_failed")
    participant = session.get(ParticipantModel, payload.participant_id)
    if participant is None:
        raise HTTPException(status_code=404, detail="participant_not_found")
    # A new DeviceTokenModel row per verified passkey assertion (abb): this is
    # a *new device* logging in, so it must not invalidate any other device's
    # session the way overwriting a single auth_token column used to.
    new_token = _issue_device_token(session, participant.participant_id, label="passkey login")
    session.commit()
    return WebauthnLoginFinishOut(
        participant_id=participant.participant_id,
        display_name=participant.display_name,
        auth_token=new_token,
    )


def _require_self_or_context_owner(session: Session, participant: ParticipantModel, target_participant_id: str) -> bool:
    if participant.participant_id == target_participant_id:
        return True
    shared_context_ids = {
        membership.context_id
        for membership in session.scalars(
            select(MembershipModel).where(
                MembershipModel.participant_id == target_participant_id, MembershipModel.left_at.is_(None)
            )
        ).all()
    }
    return any(
        _context_or_404(session, context_id).owner_participant_id == participant.participant_id
        for context_id in shared_context_ids
    )


# Device management (abb): a participant can hold many simultaneously-valid
# device tokens. Self-rotation only revokes/replaces the token used to make
# *this* request, leaving any other device's session untouched. An owner
# acting on a co-member has no single "current device" to target, so it kicks
# every active device that participant currently holds — an effective forced
# logout until they re-authenticate some other way — and never learns any of
# the new tokens.
@app.post("/participants/{participant_id}/rotate-token", response_model=TokenRotationOut)
def rotate_participant_token(
    participant_id: str,
    participant: CurrentParticipant,
    request: Request,
    session: Session = Depends(get_session),
) -> TokenRotationOut:
    target = session.get(ParticipantModel, participant_id)
    if target is None:
        raise HTTPException(status_code=404, detail="participant_not_found")
    is_self = participant.participant_id == participant_id
    if not is_self and not _require_self_or_context_owner(session, participant, participant_id):
        raise HTTPException(status_code=403, detail="not_authorized_to_revoke")

    if is_self:
        current_device_token: DeviceTokenModel = request.state.device_token
        current_device_token.revoked_at = datetime.now(UTC)
        new_token = _issue_device_token(session, participant_id, label=current_device_token.label)
        session.commit()
        return TokenRotationOut(participant_id=participant_id, auth_token=new_token)

    active_tokens = session.scalars(
        select(DeviceTokenModel).where(
            DeviceTokenModel.participant_id == participant_id, DeviceTokenModel.revoked_at.is_(None)
        )
    ).all()
    now = datetime.now(UTC)
    for device_token in active_tokens:
        device_token.revoked_at = now
    session.commit()
    return TokenRotationOut(participant_id=participant_id, auth_token=None)


@app.get("/participants/{participant_id}/devices", response_model=list[DeviceTokenOut])
def list_devices(
    participant_id: str, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> list[DeviceTokenOut]:
    if not _require_self_or_context_owner(session, participant, participant_id):
        raise HTTPException(status_code=403, detail="not_authorized_to_view")
    devices = session.scalars(
        select(DeviceTokenModel)
        .where(DeviceTokenModel.participant_id == participant_id)
        .order_by(DeviceTokenModel.created_at.asc())
    ).all()
    return [
        DeviceTokenOut(
            device_token_id=device.device_token_id,
            participant_id=device.participant_id,
            label=device.label,
            created_at=device.created_at,
            revoked_at=device.revoked_at,
        )
        for device in devices
    ]


@app.post("/devices/{device_token_id}/revoke", status_code=204, response_model=None)
def revoke_device(
    device_token_id: str, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> None:
    device = session.get(DeviceTokenModel, device_token_id)
    if device is None:
        raise HTTPException(status_code=404, detail="device_not_found")
    if not _require_self_or_context_owner(session, participant, device.participant_id):
        raise HTTPException(status_code=403, detail="not_authorized_to_revoke")
    if device.revoked_at is None:
        device.revoked_at = datetime.now(UTC)
        session.commit()


@app.post("/memberships")
def create_membership(
    payload: MembershipIn, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> MembershipIn:
    _require_context_writable(_require_context_owner(session, payload.context_id, participant))
    if session.get(ParticipantModel, payload.participant_id) is None:
        raise HTTPException(status_code=404, detail="participant_not_found")
    existing = session.get(MembershipModel, payload.membership_id)
    if existing is not None:
        _require_context_owner(session, existing.context_id, participant)
        return MembershipIn(
            membership_id=existing.membership_id,
            context_id=existing.context_id,
            participant_id=existing.participant_id,
            joined_at=existing.joined_at,
            left_at=existing.left_at,
            default_share=existing.default_share,
            allow_simplify_for_me=existing.allow_simplify_for_me,
            version=existing.version,
        )
    # A second *active* membership for the same participant would double-count
    # them in every equal split generated from the member list, so reject it
    # here rather than let the ledger quietly drift (unified-expense-os-yi4).
    if payload.left_at is None and _active_context_member(
        session, payload.context_id, payload.participant_id
    ) is not None:
        raise HTTPException(status_code=409, detail="already_member")
    model = MembershipModel(**payload.model_dump(exclude={"version"}), updated_at=datetime.now(UTC))
    session.add(model)
    session.commit()
    return MembershipIn(**payload.model_dump(exclude={"version"}), version=model.version)


@app.get("/contexts/{context_id}/memberships", response_model=list[MembershipSummary])
def list_memberships(
    context_id: str, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> list[MembershipSummary]:
    _require_context_access(session, context_id, participant)
    memberships = session.scalars(
        select(MembershipModel)
        .where(MembershipModel.context_id == context_id)
        .options(selectinload(MembershipModel.participant))
        .order_by(MembershipModel.joined_at.asc())
    ).all()
    return [
        MembershipSummary(
            membership_id=membership.membership_id,
            context_id=membership.context_id,
            participant_id=membership.participant_id,
            display_name=membership.participant.display_name if membership.participant else membership.participant_id,
            is_ghost=membership.participant.is_ghost if membership.participant else False,
            joined_at=membership.joined_at,
            left_at=membership.left_at,
            default_share=membership.default_share,
            allow_simplify_for_me=membership.allow_simplify_for_me,
            version=membership.version,
        )
        for membership in memberships
    ]


@app.post("/contexts/{context_id}/ghost-members", response_model=GhostParticipantOut)
def create_ghost_member(
    context_id: str,
    payload: GhostParticipantIn,
    participant: CurrentParticipant,
    session: Session = Depends(get_session),
) -> GhostParticipantOut:
    _require_context_writable(_require_context_owner(session, context_id, participant))
    now = datetime.now(UTC)
    ghost = ParticipantModel(
        participant_id=f"g-{uuid4()}",
        display_name=payload.display_name,
        is_ghost=True,
        ghost_managed_by=participant.participant_id,
        created_at=now,
    )
    session.add(ghost)
    membership = MembershipModel(
        membership_id=f"m-{uuid4()}",
        context_id=context_id,
        participant_id=ghost.participant_id,
        joined_at=now,
        default_share="equal",
        allow_simplify_for_me=True,
        updated_at=now,
    )
    session.add(membership)
    session.commit()
    return GhostParticipantOut(
        participant_id=ghost.participant_id, display_name=ghost.display_name, membership_id=membership.membership_id
    )


@app.post("/contexts/{context_id}/invites", response_model=InviteOut)
def create_invite(
    context_id: str,
    participant: CurrentParticipant,
    payload: InviteCreateIn | None = None,
    session: Session = Depends(get_session),
) -> InviteOut:
    context = _require_context_owner(session, context_id, participant)
    claim_display_name: str | None = None
    claim_participant_id = payload.claim_participant_id if payload else None
    if claim_participant_id is not None:
        ghost = session.get(ParticipantModel, claim_participant_id)
        if ghost is None or not ghost.is_ghost:
            raise HTTPException(status_code=404, detail="ghost_not_found")
        if _active_context_member(session, context_id, claim_participant_id) is None:
            raise HTTPException(status_code=403, detail="ghost_not_member")
        claim_display_name = ghost.display_name
    now = datetime.now(UTC)
    invite = InviteModel(
        invite_code=_new_invite_code(),
        context_id=context_id,
        created_by=participant.participant_id,
        created_at=now,
        expires_at=now + INVITE_TTL,
        claim_participant_id=claim_participant_id,
    )
    session.add(invite)
    session.commit()
    return _invite_out(invite, context.name, claim_display_name)


@app.get("/contexts/{context_id}/invites", response_model=list[InviteOut])
def list_open_invites(
    context_id: str, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> list[InviteOut]:
    context = _require_context_owner(session, context_id, participant)
    now = datetime.now(UTC)
    invites = session.scalars(
        select(InviteModel)
        .where(InviteModel.context_id == context_id, InviteModel.redeemed_at.is_(None))
        .order_by(InviteModel.created_at.asc())
    ).all()
    ghost_ids = {invite.claim_participant_id for invite in invites if invite.claim_participant_id}
    ghost_names = {}
    if ghost_ids:
        ghosts = session.scalars(select(ParticipantModel).where(ParticipantModel.participant_id.in_(ghost_ids))).all()
        ghost_names = {ghost.participant_id: ghost.display_name for ghost in ghosts}
    return [
        _invite_out(invite, context.name, ghost_names.get(invite.claim_participant_id))
        for invite in invites
        if _as_utc(invite.expires_at) > now
    ]


def _claim_invite_or_409(session: Session, invite: InviteModel, now: datetime) -> None:
    """Take the single-use code atomically, as the last gate before commit.

    The redeemed_at read at the top of redeem_invite and the commit at the end
    are far apart, so two concurrent redemptions could both pass that check and
    mint two identities from one code. A conditional UPDATE ... WHERE
    redeemed_at IS NULL lets exactly one win; the loser rolls back, discarding
    the participant/membership work it did in the meantime
    (unified-expense-os-yi4)."""
    claimed = (
        session.query(InviteModel)
        .filter(InviteModel.invite_code == invite.invite_code, InviteModel.redeemed_at.is_(None))
        .update({InviteModel.redeemed_at: now}, synchronize_session=False)
    )
    if claimed != 1:
        session.rollback()
        raise HTTPException(status_code=409, detail="invite_already_redeemed")


@app.post("/invites/redeem", response_model=InviteRedeemOut)
def redeem_invite(
    payload: InviteRedeemIn,
    request: Request,
    participant: OptionalParticipant,
    session: Session = Depends(get_session),
) -> InviteRedeemOut:
    client_key = request.client.host if request.client else "unknown"
    if not invite_redemption_limiter.allow(client_key):
        raise HTTPException(status_code=429, detail="too_many_invite_attempts")
    invite = session.get(InviteModel, normalize_invite_code(payload.invite_code))
    if invite is None:
        raise HTTPException(status_code=404, detail="invite_not_found")
    if invite.redeemed_at is not None:
        raise HTTPException(status_code=409, detail="invite_already_redeemed")
    now = datetime.now(UTC)
    if _as_utc(invite.expires_at) <= now:
        raise HTTPException(status_code=409, detail="invite_expired")
    context = _context_or_404(session, invite.context_id)
    _require_context_writable(context)

    if invite.claim_participant_id is not None:
        if participant is not None:
            raise HTTPException(status_code=400, detail="ghost_claim_requires_new_device")
        ghost = session.get(ParticipantModel, invite.claim_participant_id)
        if ghost is None or not ghost.is_ghost:
            raise HTTPException(status_code=404, detail="ghost_not_found")
        claim_token = _issue_device_token(session, ghost.participant_id, label="primary")
        ghost.is_ghost = False
        ghost.ghost_managed_by = None
        if payload.display_name:
            ghost.display_name = payload.display_name
        invite.redeemed_by = ghost.participant_id
        _claim_invite_or_409(session, invite, now)
        session.commit()
        return InviteRedeemOut(
            participant_id=ghost.participant_id,
            display_name=ghost.display_name,
            auth_token=claim_token,
            context=ContextSummary(
                context_id=context.context_id,
                name=context.name,
                type=context.type,
                owner_participant_id=context.owner_participant_id,
                created_at=context.created_at,
                archived_at=context.archived_at,
                default_split=context.default_split,
                allow_simplified_debts=context.allow_simplified_debts,
    version=context.version,
            ),
            membership_id=session.scalar(
                select(MembershipModel.membership_id).where(
                    MembershipModel.context_id == context.context_id,
                    MembershipModel.participant_id == ghost.participant_id,
                )
            )
            or "",
        )

    issued_token: str | None = None
    if participant is None:
        if not payload.participant_id or not payload.display_name:
            raise HTTPException(status_code=400, detail="participant_details_required")
        if session.get(ParticipantModel, payload.participant_id) is not None:
            raise HTTPException(status_code=409, detail="participant_exists")
        participant = ParticipantModel(
            participant_id=payload.participant_id,
            display_name=payload.display_name,
            is_ghost=False,
            created_at=now,
        )
        session.add(participant)
        issued_token = _issue_device_token(session, participant.participant_id, label="primary")

    if _active_context_member(session, context.context_id, participant.participant_id) is not None:
        raise HTTPException(status_code=409, detail="already_member")

    membership = MembershipModel(
        membership_id=f"m-{uuid4()}",
        context_id=context.context_id,
        participant_id=participant.participant_id,
        joined_at=now,
        default_share="equal",
        allow_simplify_for_me=True,
        updated_at=now,
    )
    session.add(membership)
    invite.redeemed_by = participant.participant_id
    _claim_invite_or_409(session, invite, now)
    session.commit()
    return InviteRedeemOut(
        participant_id=participant.participant_id,
        display_name=participant.display_name,
        auth_token=issued_token,
        context=ContextSummary(
            context_id=context.context_id,
            name=context.name,
            type=context.type,
            owner_participant_id=context.owner_participant_id,
            created_at=context.created_at,
            archived_at=context.archived_at,
            default_split=context.default_split,
            allow_simplified_debts=context.allow_simplified_debts,
    version=context.version,
        ),
        membership_id=membership.membership_id,
    )


@app.patch("/memberships/{membership_id}/preferences", response_model=MembershipIn)
def update_membership_preferences(
    membership_id: str,
    payload: MembershipPreferencesUpdate,
    participant: CurrentParticipant,
    session: Session = Depends(get_session),
) -> MembershipIn:
    membership = session.get(MembershipModel, membership_id)
    if membership is None:
        raise HTTPException(status_code=404, detail="membership_not_found")
    if membership.participant_id != participant.participant_id:
        _require_context_owner(session, membership.context_id, participant)
    _require_context_writable(_context_or_404(session, membership.context_id))
    if payload.expected_version is not None and payload.expected_version != membership.version:
        raise HTTPException(
            status_code=409,
            detail={"error": "version_conflict", "current_version": membership.version},
        )
    membership.allow_simplify_for_me = payload.allow_simplify_for_me
    membership.version += 1
    membership.updated_at = datetime.now(UTC)
    session.commit()
    return MembershipIn(
        membership_id=membership.membership_id,
        context_id=membership.context_id,
        participant_id=membership.participant_id,
        joined_at=membership.joined_at,
        left_at=membership.left_at,
        default_share=membership.default_share,
        allow_simplify_for_me=membership.allow_simplify_for_me,
        version=membership.version,
    )


@app.post("/memberships/{membership_id}/leave", response_model=MembershipIn)
def leave_membership(
    membership_id: str, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> MembershipIn:
    membership = session.get(MembershipModel, membership_id)
    if membership is None:
        raise HTTPException(status_code=404, detail="membership_not_found")
    if membership.participant_id != participant.participant_id:
        raise HTTPException(status_code=403, detail="can_only_leave_own_membership")
    context = _context_or_404(session, membership.context_id)
    _require_context_writable(context)
    if context.owner_participant_id == participant.participant_id:
        raise HTTPException(status_code=409, detail="owner_cannot_leave_context")
    if membership.left_at is None:
        membership.left_at = datetime.now(UTC)
        membership.version += 1
        membership.updated_at = datetime.now(UTC)
        session.commit()
    return MembershipIn(
        membership_id=membership.membership_id,
        context_id=membership.context_id,
        participant_id=membership.participant_id,
        joined_at=membership.joined_at,
        left_at=membership.left_at,
        default_share=membership.default_share,
        allow_simplify_for_me=membership.allow_simplify_for_me,
        version=membership.version,
    )


@app.post("/memberships/{membership_id}/remove", response_model=MembershipIn)
def remove_membership(
    membership_id: str, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> MembershipIn:
    membership = session.get(MembershipModel, membership_id)
    if membership is None:
        raise HTTPException(status_code=404, detail="membership_not_found")
    _require_context_writable(_require_context_owner(session, membership.context_id, participant))
    if membership.participant_id == participant.participant_id:
        raise HTTPException(status_code=409, detail="owner_cannot_remove_self")
    if membership.left_at is None:
        membership.left_at = datetime.now(UTC)
        membership.version += 1
        membership.updated_at = datetime.now(UTC)
        session.commit()
    return MembershipIn(
        membership_id=membership.membership_id,
        context_id=membership.context_id,
        participant_id=membership.participant_id,
        joined_at=membership.joined_at,
        left_at=membership.left_at,
        default_share=membership.default_share,
        allow_simplify_for_me=membership.allow_simplify_for_me,
        version=membership.version,
    )


@app.post("/contexts/{context_id}/archive", response_model=ContextSummary)
def archive_context(
    context_id: str, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> ContextSummary:
    context = _require_context_owner(session, context_id, participant)
    if context.archived_at is None:
        context.archived_at = datetime.now(UTC)
        context.version += 1
        context.updated_at = datetime.now(UTC)
        session.commit()
    return ContextSummary(
        context_id=context.context_id,
        name=context.name,
        type=context.type,
        owner_participant_id=context.owner_participant_id,
        created_at=context.created_at,
        archived_at=context.archived_at,
        default_split=context.default_split,
        allow_simplified_debts=context.allow_simplified_debts,
    version=context.version,
    )


# Closing a context is one-way: unlike archiving (cosmetic), it makes the
# ledger and membership read-only. If outstanding pairwise obligations
# remain, the caller must pass force=true to close anyway (the "trip ended,
# some debts still outstanding" case) — mirrors the settlement-overpayment
# warning pattern of surfacing rather than silently blocking (35p).
@app.post("/contexts/{context_id}/close", response_model=ContextCloseOut)
def close_context(
    context_id: str,
    participant: CurrentParticipant,
    force: bool = Query(False),
    session: Session = Depends(get_session),
) -> ContextCloseOut:
    context = _require_context_owner(session, context_id, participant)
    if context.closed_at is not None:
        plan = settlement_plan(session, context_id)
        return ContextCloseOut(context_id=context.context_id, closed_at=context.closed_at, outstanding=plan.recommendations)

    plan = settlement_plan(session, context_id)
    if plan.recommendations and not force:
        raise HTTPException(
            status_code=409,
            detail={"error": "outstanding_balances", "recommendations": [row.model_dump() for row in plan.recommendations]},
        )

    context.closed_at = datetime.now(UTC)
    context.version += 1
    context.updated_at = datetime.now(UTC)
    session.commit()
    return ContextCloseOut(context_id=context.context_id, closed_at=context.closed_at, outstanding=plan.recommendations)


@app.post("/ledger/entries", response_model=LedgerEntryOut)
def create_ledger_entry(
    payload: LedgerEntryIn, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> LedgerEntryOut:
    validate_allocations(payload)
    _validate_entry_scope(session, payload, participant)
    warning = None
    if payload.type == "settlement":
        non_payers = [item for item in payload.allocations if not item.is_payer]
        if len(non_payers) == 1:
            warning = settlement_warning(
                session, payload.context_id, non_payers[0].participant_id, payload.payer_id, payload.total_amount
            )
    _, _, _ = upsert_entry(session, payload, participant.participant_id)
    session.commit()
    model = session.get(
        LedgerEntryModel,
        payload.entry_id,
        options=(selectinload(LedgerEntryModel.allocations),),
    )
    if model is None:
        raise HTTPException(status_code=500, detail="entry_missing_after_commit")
    result = _entry_out(model)
    result.warning = warning
    return result


@app.get("/ledger/entries/{entry_id}/history", response_model=list[EntryHistoryOut])
def get_entry_history(
    entry_id: str, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> list[EntryHistoryOut]:
    model = session.get(LedgerEntryModel, entry_id)
    if model is None:
        raise HTTPException(status_code=404, detail="entry_not_found")
    _require_context_access(session, model.context_id, participant)
    return [
        EntryHistoryOut(
            version=row.version,
            hlc=row.hlc,
            action=row.action,
            edited_by=row.edited_by,
            description=row.description,
            total_amount=row.total_amount,
            payer_id=row.payer_id,
            notes=row.notes,
            voided_at=row.voided_at,
            recorded_at=row.recorded_at,
            allocations=[
                {
                    "participant_id": allocation.participant_id,
                    "share_amount": allocation.share_amount,
                    "is_payer": allocation.is_payer,
                }
                for allocation in row.allocations
            ],
        )
        for row in entry_history(session, entry_id)
    ]


@app.get("/contexts/{context_id}/balances", response_model=list[BalanceRow])
def get_balances(
    context_id: str, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> list[BalanceRow]:
    _require_context_access(session, context_id, participant)
    balances, currency = context_balances(session, context_id)
    return [
        BalanceRow(participant_id=participant_id, net_balance=value, currency=currency)
        for participant_id, value in sorted(balances.items())
    ]


@app.get("/contexts/{context_id}/settlement-plan", response_model=SettlementPlanResponse)
def get_settlement_plan(
    context_id: str, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> SettlementPlanResponse:
    _require_context_access(session, context_id, participant)
    return settlement_plan(session, context_id)


@app.post("/contexts/{context_id}/settlements", response_model=LedgerEntryOut)
def confirm_settlement(
    context_id: str,
    payload: SettlementConfirmationIn,
    participant: CurrentParticipant,
    session: Session = Depends(get_session),
) -> LedgerEntryOut:
    _require_context_access(session, context_id, participant)

    current_plan = settlement_plan(session, context_id)
    recommendation_exists = any(
        recommendation.from_participant_id == payload.from_participant_id
        and recommendation.to_participant_id == payload.to_participant_id
        and recommendation.amount_cents == payload.amount_cents
        and recommendation.kind == payload.kind
        for recommendation in current_plan.recommendations
    )
    if not recommendation_exists:
        raise HTTPException(status_code=409, detail="settlement_not_in_current_plan")

    participants = session.scalars(
        select(ParticipantModel).where(
            ParticipantModel.participant_id.in_([payload.from_participant_id, payload.to_participant_id])
        )
    ).all()
    display_name_by_id = {participant.participant_id: participant.display_name for participant in participants}
    from_name = display_name_by_id.get(payload.from_participant_id, payload.from_participant_id)
    to_name = display_name_by_id.get(payload.to_participant_id, payload.to_participant_id)
    now = datetime.now(UTC)
    entry = LedgerEntryIn(
        entry_id=f"settlement-{uuid4()}",
        context_id=context_id,
        type="settlement",
        recorded_at=now,
        effective_date=now.date(),
        payer_id=payload.from_participant_id,
        total_amount=payload.amount_cents,
        currency=current_plan.currency,
        description=f"Settlement: {from_name} paid {to_name}",
        allocations=[
            {
                "participant_id": payload.from_participant_id,
                "share_amount": 0,
                "is_payer": True,
            },
            {
                "participant_id": payload.to_participant_id,
                "share_amount": payload.amount_cents,
                "is_payer": False,
            },
        ],
        version=1,
        hlc=f"{int(now.timestamp() * 1000)}-0-server",
    )
    _validate_entry_scope(session, entry, participant)
    upsert_entry(session, entry, participant.participant_id)
    session.commit()
    model = session.get(
        LedgerEntryModel,
        entry.entry_id,
        options=(selectinload(LedgerEntryModel.allocations),),
    )
    if model is None:
        raise HTTPException(status_code=500, detail="entry_missing_after_commit")

    context = session.get(ContextModel, context_id)
    if context is not None:
        notify_participants(
            session,
            [payload.to_participant_id],
            activity_notification(from_name, context.name, entry.description, payload.amount_cents, entry.currency),
        )

    return _entry_out(model)


def _recurring_template_out(template: RecurringTemplateModel) -> RecurringTemplateIn:
    return RecurringTemplateIn(
        template_id=template.template_id,
        context_id=template.context_id,
        description=template.description,
        amount=template.amount,
        split_rule=json.loads(template.split_rule_json),
        cadence=template.cadence,
        next_due_date=template.next_due_date,
        anchor_day=template.anchor_day,
        active=template.active,
        created_at=template.created_at,
        version=template.version,
    )


@app.post("/recurring/templates", response_model=RecurringTemplateIn)
def create_recurring_template(
    payload: RecurringTemplateIn, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> RecurringTemplateIn:
    _require_context_access(session, payload.context_id, participant)
    _require_context_writable(_context_or_404(session, payload.context_id))
    now = datetime.now(UTC)
    model = RecurringTemplateModel(
        template_id=payload.template_id,
        context_id=payload.context_id,
        description=payload.description,
        amount=payload.amount,
        split_rule_json=json.dumps(payload.split_rule),
        cadence=payload.cadence,
        next_due_date=payload.next_due_date,
        anchor_day=payload.anchor_day,
        active=payload.active,
        created_at=payload.created_at,
        version=1,
        updated_at=now,
    )
    session.add(model)
    session.commit()
    return _recurring_template_out(model)


@app.get("/contexts/{context_id}/recurring-templates", response_model=list[RecurringTemplateIn])
def list_recurring_templates(
    context_id: str, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> list[RecurringTemplateIn]:
    _require_context_access(session, context_id, participant)
    templates = session.scalars(
        select(RecurringTemplateModel)
        .where(RecurringTemplateModel.context_id == context_id)
        .order_by(RecurringTemplateModel.created_at.asc())
    ).all()
    return [_recurring_template_out(template) for template in templates]


@app.patch("/recurring/templates/{template_id}", response_model=RecurringTemplateIn)
def update_recurring_template(
    template_id: str,
    payload: RecurringTemplateUpdate,
    participant: CurrentParticipant,
    session: Session = Depends(get_session),
) -> RecurringTemplateIn:
    template = session.get(RecurringTemplateModel, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="template_not_found")
    _require_context_access(session, template.context_id, participant)
    _require_context_writable(_context_or_404(session, template.context_id))
    if payload.expected_version is not None and payload.expected_version != template.version:
        raise HTTPException(
            status_code=409,
            detail={"error": "version_conflict", "current_version": template.version},
        )
    if payload.description is not None:
        template.description = payload.description
    if payload.amount is not None:
        template.amount = payload.amount
    if payload.anchor_day is not None:
        template.anchor_day = payload.anchor_day
    if payload.active is not None:
        template.active = payload.active
    template.version += 1
    template.updated_at = datetime.now(UTC)
    session.commit()
    return _recurring_template_out(template)


@app.post("/recurring/templates/{template_id}/generate")
def generate_template_entries(
    template_id: str,
    participant: CurrentParticipant,
    payer_id: str = Query(...),
    as_of: date = Query(...),
    session: Session = Depends(get_session),
) -> dict[str, list[LedgerEntryOut]]:
    template = session.get(RecurringTemplateModel, template_id)
    if template is None or not template.active:
        raise HTTPException(status_code=404, detail="template_not_found")
    _require_context_access(session, template.context_id, participant)
    # Generation writes ledger entries, so a closed context must reject it
    # just like a direct entry write would (unified-expense-os-rke).
    _require_context_writable(_context_or_404(session, template.context_id))
    if payer_id not in _active_member_ids(session, template.context_id):
        raise HTTPException(status_code=403, detail="entry_participant_forbidden")

    existing_keys = set(
        session.scalars(
            select(LedgerEntryModel.generation_key).where(
                LedgerEntryModel.linked_template_id == template_id, LedgerEntryModel.generation_key.is_not(None)
            )
        ).all()
    )
    occurrences = generate_due_occurrences(
        template.template_id,
        template.next_due_date,
        template.cadence,
        template.anchor_day,
        as_of,
        existing_keys,
    )
    memberships = session.scalars(
        select(MembershipModel).where(
            MembershipModel.context_id == template.context_id, MembershipModel.left_at.is_(None)
        )
    ).all()
    participant_ids = [membership.participant_id for membership in memberships]
    split_rule = json.loads(template.split_rule_json)
    # Generated entries inherit the context's dominant currency instead of a
    # hardcoded INR, which silently mis-denominated rent in a USD-primary
    # context (unified-expense-os-crh).
    template_currency = context_primary_currency(session, template.context_id)
    created: list[LedgerEntryOut] = []
    for due_date, generation_key in occurrences:
        allocations = resolve_split(
            SplitRequest(
                amount=template.amount,
                rule=split_rule,
                participant_ids=tuple(participant_ids),
                payer_id=payer_id,
            )
        )
        payload = LedgerEntryIn(
            entry_id=f"{template.template_id}:{due_date.isoformat()}",
            context_id=template.context_id,
            type="expense",
            recorded_at=datetime.now(UTC),
            effective_date=due_date,
            payer_id=payer_id,
            total_amount=template.amount,
            currency=template_currency,
            description=template.description,
            allocations=allocations,
            linked_template_id=template.template_id,
            generation_key=generation_key,
            version=1,
            hlc=f"{int(datetime.now(UTC).timestamp() * 1000)}-0-server",
        )
        upsert_entry(session, payload, participant.participant_id)
        model = session.get(
            LedgerEntryModel,
            payload.entry_id,
            options=(selectinload(LedgerEntryModel.allocations),),
        )
        if model:
            created.append(_entry_out(model))
    session.commit()

    if created:
        payer = session.get(ParticipantModel, payer_id)
        context = session.get(ContextModel, template.context_id)
        if payer is not None and context is not None:
            recipients = [member_id for member_id in participant_ids if member_id != payer_id]
            for entry_out in created:
                notify_participants(
                    session,
                    recipients,
                    activity_notification(payer.display_name, context.name, entry_out.description, entry_out.total_amount, entry_out.currency),
                )

    return {"entries": created}


@app.post("/capture/classify", response_model=CaptureSuggestion)
def classify(payload: CaptureRequest, participant: CurrentParticipant) -> CaptureSuggestion:
    return classify_capture(payload.text)


def _capture_draft_out(draft) -> LlmCaptureDraftOut:
    return LlmCaptureDraftOut(
        description=draft.description,
        amount_paise=draft.amount_paise,
        category=draft.category,
        participants=draft.participants,
        payer=draft.payer,
        split_mode=draft.split_mode,
        shares=draft.shares,
        amounts_paise=draft.amounts_paise,
        context_hint=draft.context_hint,
        date=draft.date,
        currency=draft.currency,
    )


# --- Per-participant LLM provider configuration ------------------------
#
# Users can bring their own OpenAI-compatible provider (OpenRouter, NVIDIA
# NIM, Cloudflare Workers AI, OpenCode Zen, a LAN llama-server, ...) for the
# four opt-in LLM assist endpoints below, instead of relying on the server
# operator's env config. The api_key is stored in the server DB and used
# only server-side when this backend calls the provider — it is never
# returned to any client (GET reports has_api_key only) and never logged.


def _llm_config_out(row: LlmConfigModel | None) -> LlmConfigOut:
    if row is None:
        return LlmConfigOut(configured=False, base_url=None, model=None, has_api_key=False)
    return LlmConfigOut(
        configured=True, base_url=row.base_url, model=row.model, has_api_key=bool(row.api_key)
    )


def _my_llm_config_row(session: Session, participant: ParticipantModel) -> LlmConfigModel | None:
    return session.scalar(
        select(LlmConfigModel).where(LlmConfigModel.participant_id == participant.participant_id)
    )


@app.get("/me/llm-config", response_model=LlmConfigOut)
def get_my_llm_config(
    participant: CurrentParticipant, session: Session = Depends(get_session)
) -> LlmConfigOut:
    return _llm_config_out(_my_llm_config_row(session, participant))


@app.put("/me/llm-config", response_model=LlmConfigOut)
def put_my_llm_config(
    payload: LlmConfigIn,
    participant: CurrentParticipant,
    session: Session = Depends(get_session),
) -> LlmConfigOut:
    base_url = payload.base_url.strip()
    if not base_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=422, detail="base_url_must_be_http_or_https")
    try:
        validate_participant_base_url(base_url)
    except LlmBaseUrlNotAllowed as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    model = payload.model.strip()
    if not model:
        raise HTTPException(status_code=422, detail="model_required")
    row = _my_llm_config_row(session, participant)
    if row is None:
        row = LlmConfigModel(
            llm_config_id=f"llmcfg_{uuid4().hex}",
            participant_id=participant.participant_id,
            base_url=base_url,
            model=model,
            api_key=None,
            updated_at=datetime.now(UTC),
        )
        session.add(row)
    row.base_url = base_url
    row.model = model
    # api_key omitted/None keeps the stored key so users can edit base_url/
    # model without re-pasting it; "" explicitly clears to keyless.
    if payload.api_key is not None:
        row.api_key = payload.api_key or None
    row.updated_at = datetime.now(UTC)
    session.commit()
    return _llm_config_out(row)


@app.delete("/me/llm-config", status_code=204, response_model=None)
def delete_my_llm_config(
    participant: CurrentParticipant, session: Session = Depends(get_session)
) -> None:
    session.query(LlmConfigModel).filter(
        LlmConfigModel.participant_id == participant.participant_id
    ).delete()
    session.commit()


# Opt-in cloud LLM vision fallback for receipt capture (Phase 7). The
# provider API key lives only server-side (env config, or the calling
# participant's stored /me/llm-config) — never sent to or stored by the
# client. This endpoint returns a DRAFT the user still
# reviews/edits/confirms in ReceiptCapturePanel before anything is saved,
# same assist-only contract as the deterministic tesseract.js OCR path.
@app.post("/capture/parse-receipt-vision", response_model=ReceiptVisionResponse)
def parse_receipt_vision(
    payload: ReceiptVisionRequest,
    participant: CurrentParticipant,
    session: Session = Depends(get_session),
) -> ReceiptVisionResponse:
    llm = resolve_llm_config_for(participant, session)
    try:
        draft = extract_receipt_via_llm(
            payload.image_base64,
            api_key=llm.api_key,
            poster=http_poster,
            model=llm.model,
            chat_url=llm.chat_url,
            allow_empty_key=llm.key_optional,
        )
    except LlmVisionUnavailableError:
        raise HTTPException(status_code=503, detail="llm_vision_not_configured")
    except Exception:
        raise HTTPException(status_code=502, detail="llm_vision_request_failed")
    return ReceiptVisionResponse(
        merchant=draft.merchant,
        date=draft.date,
        total_paise=draft.total_paise,
        items=[{"label": item["label"], "amount_paise": item["amount_paise"]} for item in draft.items],
    )


# Opt-in cloud LLM fallback for NL capture (Phase 7, unified-expense-os-dfg).
# Fires only when the caller's deterministic classify_capture() confidence
# was "low" — same gating mechanism (per-participant stored config, else
# server-operator env config) as the receipt-vision fallback above. Returns
# a DRAFT the user must still review/edit/confirm; never auto-writes to the
# ledger.
@app.post("/capture/parse-nl-fallback", response_model=LlmCaptureDraftOut)
def parse_nl_capture_fallback(
    payload: LlmCaptureRequest,
    participant: CurrentParticipant,
    session: Session = Depends(get_session),
) -> LlmCaptureDraftOut:
    llm = resolve_llm_config_for(participant, session)
    try:
        draft = draft_capture_via_llm(
            payload.text,
            api_key=llm.api_key,
            poster=llm_capture_http_poster,
            model=llm.model,
            chat_url=llm.chat_url,
            allow_empty_key=llm.key_optional,
        )
    except LlmCaptureUnavailableError:
        raise HTTPException(status_code=503, detail="llm_capture_not_configured")
    except Exception:
        raise HTTPException(status_code=502, detail="llm_capture_request_failed")
    return _capture_draft_out(draft)


# Opt-in cloud LLM fallback for cold-start capture suggestions in brand-new
# contexts (Phase 7, unified-expense-os-3cf) — new contexts have no ledger
# history for classify_capture()'s co-occurrence-flavored rules to lean on,
# so this borrows phrasing-level understanding instead. Same gating and
# assist-only contract as the other Phase 7 LLM fallbacks: a suggestion
# only, never a ledger write.
@app.post("/capture/coldstart-suggest", response_model=LlmColdStartSuggestionOut)
def coldstart_suggest(
    payload: LlmColdStartRequest,
    participant: CurrentParticipant,
    session: Session = Depends(get_session),
) -> LlmColdStartSuggestionOut:
    llm = resolve_llm_config_for(participant, session)
    try:
        suggestion = suggest_coldstart_via_llm(
            payload.text,
            api_key=llm.api_key,
            poster=llm_coldstart_http_poster,
            model=llm.model,
            chat_url=llm.chat_url,
            allow_empty_key=llm.key_optional,
        )
    except LlmColdStartUnavailableError:
        raise HTTPException(status_code=503, detail="llm_coldstart_not_configured")
    except Exception:
        raise HTTPException(status_code=502, detail="llm_coldstart_request_failed")
    return LlmColdStartSuggestionOut(
        category=suggestion.category,
        split_hint=suggestion.split_hint,
        confidence=suggestion.confidence,
    )


# Opt-in LLM intent mapping for the chat assistant (unified-expense-os-kct).
# Stateless: the client holds the conversation and sends recent turns plus
# name lists only (never ledger rows or amounts); the response is a single
# closed-vocabulary intent. query_ledger answers are computed client-side by
# the deterministic query compiler — the model never returns a number from
# the ledger. Drafts are assist-only suggestions the user still reviews and
# explicitly saves through the normal validated write path; this endpoint
# touches no ledger code. Model misbehavior coerces to a "clarify" turn
# rather than an error (parse_chat_intent_response is total).
# Agent-mode relay (unified-expense-os-5kp): the client builds the whole
# prompt (its ledger digest + action schema) and validates the action JSON
# itself; every proposed change still requires an in-app confirmation.
@app.post("/capture/agent", response_model=AgentTextOut)
def capture_agent(
    payload: AgentPromptIn,
    participant: CurrentParticipant,
    session: Session = Depends(get_session),
) -> AgentTextOut:
    if not llm_relay_limiter.allow(participant.participant_id):
        raise HTTPException(status_code=429, detail="llm_rate_limited")
    llm = resolve_llm_config_for(participant, session)
    try:
        text = raw_completion(
            payload.prompt,
            api_key=llm.api_key,
            poster=llm_chat_intent_http_poster,
            model=llm.model,
            chat_url=llm.chat_url,
            allow_empty_key=llm.key_optional,
        )
    except LlmChatIntentUnavailableError:
        raise HTTPException(status_code=503, detail="llm_agent_not_configured")
    except Exception:
        raise HTTPException(status_code=502, detail="llm_agent_request_failed")
    return AgentTextOut(text=text)


@app.post("/capture/chat-intent", response_model=ChatIntentResponse)
def chat_intent(
    payload: ChatIntentRequest,
    participant: CurrentParticipant,
    session: Session = Depends(get_session),
) -> ChatIntentResponse:
    llm = resolve_llm_config_for(participant, session)
    try:
        result = chat_intent_via_llm(
            [{"role": m.role, "content": m.content} for m in payload.messages],
            context_names=payload.context_names,
            participant_names=payload.participant_names,
            category_names=payload.category_names,
            api_key=llm.api_key,
            poster=llm_chat_intent_http_poster,
            model=llm.model,
            chat_url=llm.chat_url,
            allow_empty_key=llm.key_optional,
        )
    except LlmChatIntentUnavailableError:
        raise HTTPException(status_code=503, detail="llm_chat_intent_not_configured")
    except Exception:
        raise HTTPException(status_code=502, detail="llm_chat_intent_request_failed")
    return ChatIntentResponse(
        intent=result.intent,
        draft=_capture_draft_out(result.draft) if result.draft is not None else None,
        query=ChatQueryOut(
            metric=result.query.metric,
            timeframe=result.query.timeframe,
            category=result.query.category,
            person=result.query.person,
        )
        if result.query is not None
        else None,
        clarify_question=result.clarify_question,
        reply=result.reply,
        void_target=result.void_target,
    )


# Stores a device's web-push subscription so a future notification-sender job
# (not implemented — see unified-expense-os follow-up) has somewhere to read
# from. Idempotent per-endpoint per-participant so re-registering (e.g. after
# a browser storage clear) doesn't accumulate duplicate subscriptions.
@app.post("/push/subscriptions", status_code=204, response_model=None)
def create_push_subscription(
    payload: PushSubscriptionIn,
    participant: CurrentParticipant,
    session: Session = Depends(get_session),
) -> None:
    existing = session.scalar(
        select(PushSubscriptionModel).where(
            PushSubscriptionModel.participant_id == participant.participant_id,
            PushSubscriptionModel.endpoint == payload.endpoint,
        )
    )
    if existing is not None:
        existing.p256dh_key = payload.p256dh_key
        existing.auth_key = payload.auth_key
    else:
        session.add(
            PushSubscriptionModel(
                subscription_id=f"push_{uuid4().hex}",
                participant_id=participant.participant_id,
                endpoint=payload.endpoint,
                p256dh_key=payload.p256dh_key,
                auth_key=payload.auth_key,
                created_at=datetime.now(UTC),
            )
        )
    session.commit()


@app.delete("/push/subscriptions", status_code=204, response_model=None)
def delete_push_subscription(
    endpoint: str,
    participant: CurrentParticipant,
    session: Session = Depends(get_session),
) -> None:
    session.query(PushSubscriptionModel).filter(
        PushSubscriptionModel.participant_id == participant.participant_id,
        PushSubscriptionModel.endpoint == endpoint,
    ).delete()
    session.commit()


@app.post("/sync/push", response_model=list[SyncPushResponseItem])
def sync_push(
    payload: SyncPushRequest, participant: CurrentParticipant, session: Session = Depends(get_session)
) -> list[SyncPushResponseItem]:
    results: list[SyncPushResponseItem] = []
    for entry in payload.entries:
        try:
            # Each entry gets its own savepoint so one bad row is rejected on
            # its own instead of poisoning the batch commit — notably when two
            # devices insert the same entry_id concurrently and one loses the
            # PK race (unified-expense-os-yi4).
            with session.begin_nested():
                _validate_entry_scope(session, entry, participant)
                entry_id, server_seq, version = upsert_entry(session, entry, participant.participant_id)
            results.append(
                SyncPushResponseItem(
                    entry_id=entry_id, server_seq=server_seq, version=version, status="accepted"
                )
            )
        except IntegrityError:
            results.append(
                SyncPushResponseItem(
                    entry_id=entry.entry_id,
                    status="rejected",
                    error_code="entry_conflict",
                    message="concurrent_write",
                )
            )
        except ValueError as error:
            results.append(
                SyncPushResponseItem(
                    entry_id=entry.entry_id,
                    status="rejected",
                    error_code=str(error),
                    message="validation_failed",
                )
            )
        except HTTPException as error:
            results.append(
                SyncPushResponseItem(
                    entry_id=entry.entry_id,
                    status="rejected",
                    error_code=str(error.detail),
                    message="authorization_failed",
                )
            )
    session.commit()

    accepted_ids = {result.entry_id for result in results if result.status == "accepted"}
    if accepted_ids:
        entries = session.scalars(
            select(LedgerEntryModel).where(LedgerEntryModel.entry_id.in_(accepted_ids))
        ).all()
        for entry_model in entries:
            if entry_model.type != "expense":
                continue
            payer = session.get(ParticipantModel, entry_model.payer_id)
            context = session.get(ContextModel, entry_model.context_id)
            if payer is None or context is None:
                continue
            recipients = [
                member_id for member_id in _active_member_ids(session, entry_model.context_id)
                if member_id != entry_model.payer_id
            ]
            notify_participants(
                session,
                recipients,
                activity_notification(payer.display_name, context.name, entry_model.description, entry_model.total_amount, entry_model.currency),
            )

    return results


@app.get("/sync/pull", response_model=SyncPullResponse)
def sync_pull(
    context_id: str,
    participant: CurrentParticipant,
    after_seq: int = Query(0, ge=0),
    limit: int = Query(500, ge=1, le=500),
    session: Session = Depends(get_session),
) -> SyncPullResponse:
    _require_context_access(session, context_id, participant)
    entries = session.scalars(
        select(LedgerEntryModel)
        .where(LedgerEntryModel.context_id == context_id, LedgerEntryModel.server_seq > after_seq)
        .options(selectinload(LedgerEntryModel.allocations))
        .order_by(LedgerEntryModel.server_seq.asc())
        .limit(limit)
    ).all()
    max_server_seq = after_seq
    if entries:
        max_server_seq = entries[-1].server_seq
    return SyncPullResponse(entries=[_entry_out(entry) for entry in entries], max_server_seq=max_server_seq)
