from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from .schemas import SettlementPlanRow


class ContextSummary(BaseModel):
    context_id: str
    name: str
    type: str
    owner_participant_id: str
    created_at: datetime
    archived_at: datetime | None = None
    closed_at: datetime | None = None
    default_split: str
    allow_simplified_debts: bool
    version: int = 1


class MembershipSummary(BaseModel):
    membership_id: str
    context_id: str
    participant_id: str
    display_name: str
    is_ghost: bool = False
    joined_at: datetime
    left_at: datetime | None = None
    default_share: str
    allow_simplify_for_me: bool
    version: int = 1


class InviteRedeemOut(BaseModel):
    participant_id: str
    display_name: str
    auth_token: str | None = None
    context: ContextSummary
    membership_id: str
