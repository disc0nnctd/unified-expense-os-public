from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


class AllocationIn(BaseModel):
    participant_id: str
    share_amount: int
    is_payer: bool = False


class LedgerEntryIn(BaseModel):
    entry_id: str
    context_id: str
    type: Literal["expense", "settlement", "transfer_out", "transfer_in", "adjustment"]
    recorded_at: datetime
    effective_date: date
    payer_id: str
    total_amount: int = Field(gt=0)
    currency: str = "INR"
    description: str
    category: str | None = None
    notes: str | None = None
    allocations: list[AllocationIn]
    linked_template_id: str | None = None
    linked_entry_id: str | None = None
    generation_key: str | None = None
    version: int = 1
    hlc: str
    voided_at: datetime | None = None
    void_reason: str | None = None


class LedgerEntryOut(LedgerEntryIn):
    server_seq: int
    conflict_resolved_by: str | None = None
    warning: str | None = None


class EntryHistoryOut(BaseModel):
    version: int
    hlc: str
    action: Literal["created", "updated", "voided", "conflict_resolved"]
    edited_by: str
    description: str
    total_amount: int
    payer_id: str
    notes: str | None = None
    voided_at: datetime | None = None
    recorded_at: datetime
    allocations: list[AllocationIn]


class ContextIn(BaseModel):
    context_id: str
    name: str
    type: Literal["personal", "shared"]
    owner_participant_id: str
    created_at: datetime
    default_split: str = "equal"
    allow_simplified_debts: bool = False
    version: int = 1


class ParticipantIn(BaseModel):
    participant_id: str
    display_name: str
    is_ghost: bool = False
    ghost_managed_by: str | None = None
    created_at: datetime


class ParticipantOut(ParticipantIn):
    # Only present on registration; other endpoints returning ParticipantOut
    # never disclose a token for a device they didn't just issue (abb).
    auth_token: str | None = None


class DeviceTokenOut(BaseModel):
    device_token_id: str
    participant_id: str
    label: str | None = None
    created_at: datetime
    revoked_at: datetime | None = None


class TokenRotationOut(BaseModel):
    participant_id: str
    # Present only when the caller rotated their own token; omitted when an
    # owner revokes another participant's device access on their behalf, so
    # the new token is never disclosed to anyone but its owner.
    auth_token: str | None = None


class MembershipIn(BaseModel):
    membership_id: str
    context_id: str
    participant_id: str
    joined_at: datetime
    left_at: datetime | None = None
    default_share: str
    allow_simplify_for_me: bool = True
    version: int = 1


# expected_version is optional: omitted (or None) applies last-write-wins,
# matching the rest of this codebase's LWW default; supplying it opts into
# optimistic-concurrency rejection (409) on a stale write (home-d7f).
class ContextPreferencesUpdate(BaseModel):
    allow_simplified_debts: bool
    expected_version: int | None = None


class InviteOut(BaseModel):
    invite_code: str
    context_id: str
    context_name: str
    created_by: str
    created_at: datetime
    expires_at: datetime
    redeemed_at: datetime | None = None
    redeemed_by: str | None = None
    claim_participant_id: str | None = None
    claim_display_name: str | None = None


class InviteCreateIn(BaseModel):
    claim_participant_id: str | None = None


class InviteRedeemIn(BaseModel):
    invite_code: str
    participant_id: str | None = None
    display_name: str | None = None


class GhostParticipantIn(BaseModel):
    display_name: str


class GhostParticipantOut(BaseModel):
    participant_id: str
    display_name: str
    membership_id: str
    is_ghost: bool = True


class MembershipPreferencesUpdate(BaseModel):
    allow_simplify_for_me: bool
    expected_version: int | None = None


class RecurringTemplateIn(BaseModel):
    template_id: str
    context_id: str
    description: str
    amount: int = Field(gt=0)
    split_rule: dict
    cadence: Literal["monthly", "weekly"]
    next_due_date: date
    anchor_day: int = Field(ge=1, le=31)
    active: bool = True
    created_at: datetime
    version: int = 1


# All fields optional: only the ones supplied are changed. active=false
# pauses the template (generate/list still see it; auto-reminders don't)
# without deleting its history of already-generated entries.
class RecurringTemplateUpdate(BaseModel):
    description: str | None = None
    amount: int | None = Field(default=None, gt=0)
    anchor_day: int | None = Field(default=None, ge=1, le=31)
    active: bool | None = None
    expected_version: int | None = None


class SyncPushRequest(BaseModel):
    # Bounded so one request cannot hold a write transaction open arbitrarily
    # long; the client pushes in batches well under this (unified-expense-os-3ao).
    entries: list[LedgerEntryIn] = Field(max_length=200)


class SyncPushResponseItem(BaseModel):
    entry_id: str
    server_seq: int | None = None
    version: int | None = None
    status: Literal["accepted", "rejected"]
    error_code: str | None = None
    message: str | None = None


class SyncPullResponse(BaseModel):
    entries: list[LedgerEntryOut]
    max_server_seq: int


class BalanceRow(BaseModel):
    participant_id: str
    net_balance: int
    currency: str


class SettlementPlanRow(BaseModel):
    from_participant_id: str
    to_participant_id: str
    amount_cents: int = Field(gt=0)
    kind: Literal["pairwise", "simplified"]
    currency: str = "INR"


class SettlementConfirmationIn(BaseModel):
    from_participant_id: str
    to_participant_id: str
    amount_cents: int = Field(gt=0)
    kind: Literal["pairwise", "simplified"]


class SettlementPlanResponse(BaseModel):
    context_id: str
    currency: str = "INR"
    simplification_enabled: bool
    excluded_participant_ids: list[str]
    recommendations: list[SettlementPlanRow]


class PushSubscriptionIn(BaseModel):
    endpoint: str
    p256dh_key: str
    auth_key: str


class ReceiptVisionRequest(BaseModel):
    image_base64: str


class ReceiptVisionItem(BaseModel):
    label: str
    amount_paise: int


class ReceiptVisionResponse(BaseModel):
    merchant: str | None
    date: str | None
    total_paise: int | None
    items: list[ReceiptVisionItem]


class WebauthnRegistrationBeginOut(BaseModel):
    flow_id: str
    options_json: str


class WebauthnRegistrationFinishIn(BaseModel):
    flow_id: str
    credential: dict


class WebauthnLoginBeginIn(BaseModel):
    participant_id: str


class WebauthnLoginBeginOut(BaseModel):
    flow_id: str
    options_json: str


class WebauthnLoginFinishIn(BaseModel):
    flow_id: str
    participant_id: str
    credential: dict


class WebauthnLoginFinishOut(BaseModel):
    participant_id: str
    display_name: str
    auth_token: str


class RenameParticipantIn(BaseModel):
    display_name: str


class CaptureRequest(BaseModel):
    text: str


class CaptureSuggestion(BaseModel):
    context_hint: str | None = None
    category_hint: str | None = None
    recurring_candidate: bool = False
    participant_scope: str = "context-default"
    confidence: Literal["low", "medium", "high"]


class LlmCaptureRequest(BaseModel):
    text: str


class LlmCaptureDraftOut(BaseModel):
    description: str | None
    amount_paise: int | None
    category: str | None
    participants: list[str]
    # Extended draft fields (voice/chat capture) — all optional so pre-
    # extension clients and model responses stay compatible. Names are
    # plain strings; only the client resolves them to participant ids.
    payer: str | None = None
    split_mode: Literal["equal", "shares", "custom"] | None = None
    shares: dict[str, float] | None = None
    amounts_paise: dict[str, int] | None = None
    context_hint: str | None = None
    date: str | None = None
    currency: str | None = None


class LlmConfigIn(BaseModel):
    base_url: str = Field(min_length=1, max_length=300)
    model: str = Field(min_length=1, max_length=200)
    # None/absent keeps any already-stored key (so users can change the
    # model without re-pasting their key); empty string "" clears it to a
    # deliberate keyless config (LAN inference servers).
    api_key: str | None = Field(default=None, max_length=500)


# Never carries the stored api_key itself — only whether one exists.
class LlmConfigOut(BaseModel):
    configured: bool
    base_url: str | None
    model: str | None
    has_api_key: bool


class ChatMessageIn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class ChatIntentRequest(BaseModel):
    messages: list[ChatMessageIn] = Field(min_length=1, max_length=12)
    context_names: list[str] = Field(default_factory=list, max_length=50)
    participant_names: list[str] = Field(default_factory=list, max_length=100)
    category_names: list[str] = Field(default_factory=list, max_length=100)


class AgentPromptIn(BaseModel):
    # Full agent-mode prompt built client-side (ledger digest + action
    # schema + conversation). The server is a relay; it never parses this.
    prompt: str = Field(min_length=1, max_length=30000)


class AgentTextOut(BaseModel):
    text: str


class ChatQueryOut(BaseModel):
    metric: str | None
    timeframe: str | None
    category: str | None
    person: str | None


class ChatIntentResponse(BaseModel):
    intent: Literal[
        "query_ledger",
        "draft_expense",
        "draft_settlement",
        "draft_recurring",
        "void_expense",
        "clarify",
        "none",
    ]
    draft: LlmCaptureDraftOut | None
    query: ChatQueryOut | None
    clarify_question: str | None
    reply: str | None
    # void_expense only: the user's words for which entry to void; the
    # client resolves and confirms locally.
    void_target: str | None = None


class LlmColdStartRequest(BaseModel):
    text: str


class ContextCloseOut(BaseModel):
    context_id: str
    closed_at: datetime | None
    outstanding: list[SettlementPlanRow]


class LlmColdStartSuggestionOut(BaseModel):
    category: str | None
    split_hint: str
    confidence: str
