from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class ContextModel(Base):
    __tablename__ = "contexts"

    context_id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    type: Mapped[str] = mapped_column(String, nullable=False)
    owner_participant_id: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Distinct from archived_at: a trip/event context transitions to closed
    # via POST /contexts/{id}/close after final settlement, becoming
    # read-only (no new entries, membership, or preference writes). Archiving
    # alone is cosmetic; closing is a one-way state change (35p).
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    default_split: Mapped[str] = mapped_column(String, nullable=False, default="equal")
    allow_simplified_debts: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Bumped on every mutation (preferences, archive) so devices can detect
    # and resolve concurrent metadata edits instead of silently clobbering
    # each other on the next full-refresh sync (home-d7f).
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    memberships: Mapped[list[MembershipModel]] = relationship(back_populates="context")


class ParticipantModel(Base):
    __tablename__ = "participants"

    participant_id: Mapped[str] = mapped_column(String, primary_key=True)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    is_ghost: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    ghost_managed_by: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    memberships: Mapped[list[MembershipModel]] = relationship(back_populates="participant")
    device_tokens: Mapped[list[DeviceTokenModel]] = relationship(back_populates="participant")


# One participant can hold many simultaneously-valid device tokens (abb): a
# fresh login (passkey or invite redemption) mints a new row rather than
# overwriting a single column, so authenticating on a new device never
# invalidates any other device's session. Auth matches the presented bearer
# token against any row here with revoked_at is null.
class DeviceTokenModel(Base):
    __tablename__ = "device_tokens"

    device_token_id: Mapped[str] = mapped_column(String, primary_key=True)
    # SHA-256 hex digest of the bearer token, never the raw value — anyone
    # with DB/backup access must not get a live credential (unified-expense-os-jyg).
    # Tokens are random 128-bit values, so a bare hash (no salt/KDF) is fine.
    token_hash: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    participant_id: Mapped[str] = mapped_column(ForeignKey("participants.participant_id"), nullable=False, index=True)
    label: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    participant: Mapped[ParticipantModel] = relationship(back_populates="device_tokens")


class MembershipModel(Base):
    __tablename__ = "memberships"

    membership_id: Mapped[str] = mapped_column(String, primary_key=True)
    context_id: Mapped[str] = mapped_column(ForeignKey("contexts.context_id"), nullable=False)
    participant_id: Mapped[str] = mapped_column(ForeignKey("participants.participant_id"), nullable=False)
    joined_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    left_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    default_share: Mapped[str] = mapped_column(String, nullable=False)
    allow_simplify_for_me: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    context: Mapped[ContextModel] = relationship(back_populates="memberships")
    participant: Mapped[ParticipantModel] = relationship(back_populates="memberships")


class LedgerEntryModel(Base):
    __tablename__ = "ledger_entries"

    entry_id: Mapped[str] = mapped_column(String, primary_key=True)
    context_id: Mapped[str] = mapped_column(ForeignKey("contexts.context_id"), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    effective_date: Mapped[date] = mapped_column(Date, nullable=False)
    payer_id: Mapped[str] = mapped_column(String, nullable=False)
    total_amount: Mapped[int] = mapped_column(Integer, nullable=False)
    currency: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(String, nullable=False)
    category: Mapped[str | None] = mapped_column(String, nullable=True)
    # Free-text settlement/context notes distinct from category (e.g. "for the
    # ski trip lift tickets") — reference-app parity gap unified-expense-os-ufz.
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    linked_template_id: Mapped[str | None] = mapped_column(String, nullable=True)
    linked_entry_id: Mapped[str | None] = mapped_column(String, nullable=True)
    generation_key: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    server_seq: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    hlc: Mapped[str] = mapped_column(String, nullable=False)
    voided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    void_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    conflict_resolved_by: Mapped[str | None] = mapped_column(String, nullable=True)

    allocations: Mapped[list[AllocationModel]] = relationship(
        back_populates="entry", cascade="all, delete-orphan"
    )


class AllocationModel(Base):
    __tablename__ = "allocations"

    allocation_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entry_id: Mapped[str] = mapped_column(ForeignKey("ledger_entries.entry_id"), nullable=False, index=True)
    participant_id: Mapped[str] = mapped_column(String, nullable=False)
    share_amount: Mapped[int] = mapped_column(Integer, nullable=False)
    is_payer: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    entry: Mapped[LedgerEntryModel] = relationship(back_populates="allocations")


class InviteModel(Base):
    __tablename__ = "invites"

    invite_code: Mapped[str] = mapped_column(String, primary_key=True)
    context_id: Mapped[str] = mapped_column(ForeignKey("contexts.context_id"), nullable=False, index=True)
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    redeemed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    redeemed_by: Mapped[str | None] = mapped_column(String, nullable=True)
    claim_participant_id: Mapped[str | None] = mapped_column(String, nullable=True)


class PasskeyCredentialModel(Base):
    __tablename__ = "passkey_credentials"

    credential_id: Mapped[str] = mapped_column(String, primary_key=True)  # base64url
    participant_id: Mapped[str] = mapped_column(ForeignKey("participants.participant_id"), nullable=False, index=True)
    public_key: Mapped[str] = mapped_column(String, nullable=False)  # base64url-encoded COSE key
    sign_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class WebauthnChallengeModel(Base):
    __tablename__ = "webauthn_challenges"

    flow_id: Mapped[str] = mapped_column(String, primary_key=True)
    participant_id: Mapped[str] = mapped_column(String, nullable=False)
    purpose: Mapped[str] = mapped_column(String, nullable=False)  # "registration" | "authentication"
    challenge: Mapped[str] = mapped_column(String, nullable=False)  # base64url
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class PushSubscriptionModel(Base):
    __tablename__ = "push_subscriptions"

    subscription_id: Mapped[str] = mapped_column(String, primary_key=True)
    participant_id: Mapped[str] = mapped_column(ForeignKey("participants.participant_id"), nullable=False, index=True)
    endpoint: Mapped[str] = mapped_column(String, nullable=False)
    p256dh_key: Mapped[str] = mapped_column(String, nullable=False)
    auth_key: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


# Per-participant LLM provider override: users can point the four opt-in
# LLM assist endpoints at their own OpenAI-compatible provider (OpenRouter,
# NVIDIA NIM, Cloudflare Workers AI, OpenCode Zen, a LAN llama-server, ...)
# instead of the server operator's env config. The api_key is stored and
# used exclusively server-side — it is never returned by any endpoint (GET
# /me/llm-config only reports has_api_key). An empty/NULL api_key is a
# deliberate keyless config (typical for LAN inference servers), not a
# missing one.
class LlmConfigModel(Base):
    __tablename__ = "llm_configs"

    llm_config_id: Mapped[str] = mapped_column(String, primary_key=True)
    participant_id: Mapped[str] = mapped_column(
        ForeignKey("participants.participant_id"), nullable=False, unique=True, index=True
    )
    base_url: Mapped[str] = mapped_column(String, nullable=False)
    model: Mapped[str] = mapped_column(String, nullable=False)
    api_key: Mapped[str | None] = mapped_column(String, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class SyncCounterModel(Base):
    __tablename__ = "sync_counters"

    counter_id: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class RecurringTemplateModel(Base):
    __tablename__ = "recurring_templates"

    template_id: Mapped[str] = mapped_column(String, primary_key=True)
    context_id: Mapped[str] = mapped_column(ForeignKey("contexts.context_id"), nullable=False, index=True)
    description: Mapped[str] = mapped_column(String, nullable=False)
    amount: Mapped[int] = mapped_column(Integer, nullable=False)
    split_rule_json: Mapped[str] = mapped_column(Text, nullable=False)
    cadence: Mapped[str] = mapped_column(String, nullable=False)
    next_due_date: Mapped[date] = mapped_column(Date, nullable=False)
    anchor_day: Mapped[int] = mapped_column(Integer, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    # Same versioned-metadata pattern as ContextModel/MembershipModel, so
    # PATCH /recurring/templates/{id} can offer optimistic concurrency
    # (unified-expense-os-2x2).
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class ConflictLogModel(Base):
    __tablename__ = "conflict_log"

    conflict_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entry_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    rejected_version: Mapped[int] = mapped_column(Integer, nullable=False)
    rejected_hlc: Mapped[str] = mapped_column(String, nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class EntryHistoryModel(Base):
    __tablename__ = "entry_history"

    history_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entry_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    hlc: Mapped[str] = mapped_column(String, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    edited_by: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(String, nullable=False)
    total_amount: Mapped[int] = mapped_column(Integer, nullable=False)
    payer_id: Mapped[str] = mapped_column(String, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    voided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    allocations: Mapped[list[EntryHistoryAllocationModel]] = relationship(
        back_populates="history", cascade="all, delete-orphan"
    )


class EntryHistoryAllocationModel(Base):
    __tablename__ = "entry_history_allocations"

    history_allocation_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    history_id: Mapped[int] = mapped_column(ForeignKey("entry_history.history_id"), nullable=False, index=True)
    participant_id: Mapped[str] = mapped_column(String, nullable=False)
    share_amount: Mapped[int] = mapped_column(Integer, nullable=False)
    is_payer: Mapped[bool] = mapped_column(Boolean, nullable=False)

    history: Mapped[EntryHistoryModel] = relationship(back_populates="allocations")
