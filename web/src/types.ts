export type DeviceIdentity = {
  participantId: string;
  displayName: string;
  authToken: string;
};

export type Participant = {
  participantId: string;
  displayName: string;
};

export type ContextRecord = {
  contextId: string;
  name: string;
  type: "personal" | "shared";
  ownerParticipantId: string;
  createdAt: string;
  archivedAt?: string | null;
  closedAt?: string | null;
  defaultSplit: string;
  allowSimplifiedDebts: boolean;
};

export type Membership = {
  membershipId: string;
  contextId: string;
  participantId: string;
  isGhost?: boolean;
  joinedAt: string;
  leftAt?: string | null;
  defaultShare: string;
  allowSimplifyForMe: boolean;
};

export type Allocation = {
  participantId: string;
  shareAmount: number;
  isPayer: boolean;
};

export type SyncState = "pending" | "committed" | "rejected";

export type LedgerEntry = {
  entryId: string;
  contextId: string;
  type: "expense" | "settlement" | "adjustment";
  recordedAt: string;
  effectiveDate: string;
  payerId: string;
  totalAmount: number;
  currency: string;
  description: string;
  category?: string | null;
  notes?: string | null;
  allocations: Allocation[];
  version: number;
  hlc: string;
  serverSeq?: number;
  syncState: SyncState;
  syncError?: string | null;
  voidedAt?: string | null;
  voidReason?: string | null;
  conflictResolvedBy?: string | null;
};

export type SyncQueueItem = {
  operationId: string;
  entryId: string;
  createdAt: string;
};

export type RecurringTemplate = {
  templateId: string;
  contextId: string;
  description: string;
  amount: number;
  cadence: "monthly" | "weekly";
  nextDueDate: string;
  anchorDay: number;
  active: boolean;
  createdAt: string;
  version: number;
};

export type Invite = {
  inviteCode: string;
  contextId: string;
  contextName: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  claimParticipantId?: string | null;
  claimDisplayName?: string | null;
};

export type AppSnapshot = {
  device: DeviceIdentity | null;
  participants: Participant[];
  contexts: ContextRecord[];
  memberships: Membership[];
  entries: LedgerEntry[];
  templates: RecurringTemplate[];
  queue: SyncQueueItem[];
  cursorByContext: Record<string, number>;
};

export type CaptureSuggestion = {
  context_hint: string | null;
  category_hint: string | null;
  recurring_candidate: boolean;
  participant_scope: string;
  confidence: "low" | "medium" | "high";
};

export type SettlementRecommendation = {
  fromParticipantId: string;
  toParticipantId: string;
  amountCents: number;
  kind: "pairwise" | "simplified";
  currency: string;
};

export type SettlementPlan = {
  contextId: string;
  currency: string;
  simplificationEnabled: boolean;
  excludedParticipantIds: string[];
  recommendations: SettlementRecommendation[];
};

export type EntryHistoryRecord = {
  version: number;
  hlc: string;
  action: "created" | "updated" | "voided" | "conflict_resolved";
  editedBy: string;
  description: string;
  totalAmount: number;
  payerId: string;
  notes?: string | null;
  voidedAt: string | null;
  recordedAt: string;
  allocations: Allocation[];
};
