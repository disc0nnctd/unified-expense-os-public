import { buildEqualAllocations, localDateString, rescaleAllocations } from "./finance";
import { nextHlc } from "./hlc";
import { getServerBaseUrl } from "./serverConfig";
import { randomId } from "./uuid";
import {
  addPendingEntry,
  clearDevice,
  forgetDevice,
  getDevice,
  getDeviceHistory,
  getMeta,
  markCommitted,
  markRejected,
  readSnapshot,
  rememberDevice,
  setCursor,
  setDevice,
  upsertContexts,
  upsertEntries,
  upsertMemberships,
  upsertParticipants,
  upsertTemplates,
} from "./localDb";
import { addLocalMember, createLocalContext, isLocalOnly } from "./localMode";
import type {
  Allocation,
  CaptureSuggestion,
  ContextRecord,
  DeviceIdentity,
  EntryHistoryRecord,
  Invite,
  LedgerEntry,
  Membership,
  RecurringTemplate,
  SettlementPlan,
  SettlementRecommendation,
} from "../types";

// The backend base URL is resolved dynamically (see serverConfig): the web PWA
// infers it from the serving origin, while native shells read a user-configured,
// persisted value. Never cache it in a module const — it can change at runtime
// when the user re-points the app at a different server.
const PULL_PAGE_LIMIT = 500;

type SyncPushResponseItem = {
  entry_id: string;
  server_seq: number | null;
  version: number | null;
  status: "accepted" | "rejected";
  error_code: string | null;
  message: string | null;
};

type LedgerEntryApiRecord = {
  entry_id: string;
  context_id: string;
  type: "expense" | "settlement" | "adjustment";
  recorded_at: string;
  effective_date: string;
  payer_id: string;
  total_amount: number;
  currency: string;
  description: string;
  category?: string | null;
  notes?: string | null;
  allocations: Array<{
    participant_id: string;
    share_amount: number;
    is_payer: boolean;
  }>;
  version: number;
  hlc: string;
  server_seq: number;
  voided_at: string | null;
  void_reason: string | null;
  conflict_resolved_by?: string | null;
  warning?: string | null;
};

type SyncPullResponse = {
  entries: LedgerEntryApiRecord[];
  max_server_seq: number;
};

type ContextApiRecord = {
  context_id: string;
  name: string;
  type: "personal" | "shared";
  owner_participant_id: string;
  created_at: string;
  archived_at?: string | null;
  closed_at?: string | null;
  default_split: string;
  allow_simplified_debts: boolean;
};

type MembershipApiRecord = {
  membership_id: string;
  context_id: string;
  participant_id: string;
  display_name: string;
  is_ghost?: boolean;
  joined_at: string;
  left_at: string | null;
  default_share: string;
  allow_simplify_for_me: boolean;
};

type InviteApiRecord = {
  invite_code: string;
  context_id: string;
  context_name: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  claim_participant_id?: string | null;
  claim_display_name?: string | null;
};

type GhostParticipantApiResponse = {
  participant_id: string;
  display_name: string;
  membership_id: string;
};

type InviteRedeemApiResponse = {
  participant_id: string;
  display_name: string;
  auth_token: string | null;
  context: ContextApiRecord;
  membership_id: string;
};

type RecurringTemplateApiRecord = {
  template_id: string;
  context_id: string;
  description: string;
  amount: number;
  cadence: "monthly" | "weekly";
  next_due_date: string;
  anchor_day: number;
  active: boolean;
  created_at: string;
  version: number;
};

type EntryHistoryApiRecord = {
  version: number;
  hlc: string;
  action: "created" | "updated" | "voided" | "conflict_resolved";
  edited_by: string;
  description: string;
  total_amount: number;
  payer_id: string;
  notes?: string | null;
  voided_at: string | null;
  recorded_at: string;
  allocations: Array<{
    participant_id: string;
    share_amount: number;
    is_payer: boolean;
  }>;
};

type SettlementPlanApiResponse = {
  context_id: string;
  currency: string;
  simplification_enabled: boolean;
  excluded_participant_ids: string[];
  recommendations: Array<{
    from_participant_id: string;
    to_participant_id: string;
    amount_cents: number;
    kind: "pairwise" | "simplified";
    currency: string;
  }>;
};

/** Thrown when something tries to reach the server in local-only mode. */
export class LocalOnlyError extends Error {
  constructor() {
    super("local_only_mode");
    this.name = "LocalOnlyError";
  }
}

async function apiFetch(path: string, init: RequestInit = {}, token?: string): Promise<unknown> {
  // Local-only mode is enforced here rather than at each call site: gating
  // per-caller meant every new server-backed feature had to remember, and one
  // already forgot — SettleUpPanel was firing real requests at the inferred
  // server URL with the placeholder token (unified-expense-os-kxb).
  if (isLocalOnly()) {
    throw new LocalOnlyError();
  }
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${getServerBaseUrl()}${path}`, { ...init, headers });
  if (!response.ok) {
    let detail = `request_failed_${response.status}`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (body && typeof body.detail === "string") {
        detail = body.detail;
      }
    } catch {
      // non-JSON error body; keep the status-based code
    }
    throw new Error(detail);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function postJson(path: string, body: unknown, token?: string) {
  return apiFetch(path, { method: "POST", body: JSON.stringify(body) }, token);
}

// apiFetch already returns null on 204, so these are thin wrappers rather
// than a separate fetch path — going through apiFetch also means they honor
// local-only mode and surface server error codes like every other call
// (unified-expense-os-vwi).
async function postNoContent(path: string, body: unknown, token: string): Promise<void> {
  await apiFetch(path, { method: "POST", body: JSON.stringify(body) }, token);
}

async function deleteNoContent(path: string, token: string): Promise<void> {
  await apiFetch(path, { method: "DELETE" }, token);
}

function patchJson(path: string, body: unknown, token: string) {
  return apiFetch(path, { method: "PATCH", body: JSON.stringify(body) }, token);
}

function getJson(path: string, token: string) {
  return apiFetch(path, {}, token);
}

async function requireDevice(): Promise<DeviceIdentity> {
  const device = await getDevice();
  if (!device) {
    throw new Error("device_not_onboarded");
  }
  return device;
}

function contextFromApi(context: ContextApiRecord): ContextRecord {
  return {
    contextId: context.context_id,
    name: context.name,
    type: context.type,
    ownerParticipantId: context.owner_participant_id,
    createdAt: context.created_at,
    archivedAt: context.archived_at ?? null,
    closedAt: context.closed_at ?? null,
    defaultSplit: context.default_split,
    allowSimplifiedDebts: context.allow_simplified_debts,
  };
}

function membershipFromApi(membership: MembershipApiRecord): Membership {
  return {
    membershipId: membership.membership_id,
    contextId: membership.context_id,
    participantId: membership.participant_id,
    isGhost: membership.is_ghost ?? false,
    joinedAt: membership.joined_at,
    leftAt: membership.left_at,
    defaultShare: membership.default_share,
    allowSimplifyForMe: membership.allow_simplify_for_me,
  };
}

function inviteFromApi(invite: InviteApiRecord): Invite {
  return {
    inviteCode: invite.invite_code,
    contextId: invite.context_id,
    contextName: invite.context_name,
    createdBy: invite.created_by,
    createdAt: invite.created_at,
    expiresAt: invite.expires_at,
    claimParticipantId: invite.claim_participant_id ?? null,
    claimDisplayName: invite.claim_display_name ?? null,
  };
}

function templateFromApi(template: RecurringTemplateApiRecord): RecurringTemplate {
  return {
    templateId: template.template_id,
    contextId: template.context_id,
    description: template.description,
    amount: template.amount,
    cadence: template.cadence,
    nextDueDate: template.next_due_date,
    anchorDay: template.anchor_day,
    active: template.active,
    createdAt: template.created_at,
    version: template.version,
  };
}

function entryFromApi(entry: LedgerEntryApiRecord): LedgerEntry {
  return {
    entryId: entry.entry_id,
    contextId: entry.context_id,
    type: entry.type,
    recordedAt: entry.recorded_at,
    effectiveDate: entry.effective_date,
    payerId: entry.payer_id,
    totalAmount: entry.total_amount,
    currency: entry.currency,
    description: entry.description,
    category: entry.category ?? null,
    notes: entry.notes ?? null,
    allocations: entry.allocations.map((allocation) => ({
      participantId: allocation.participant_id,
      shareAmount: allocation.share_amount,
      isPayer: allocation.is_payer,
    })),
    version: entry.version,
    hlc: entry.hlc,
    serverSeq: entry.server_seq,
    syncState: "committed",
    syncError: null,
    voidedAt: entry.voided_at,
    voidReason: entry.void_reason,
    conflictResolvedBy: entry.conflict_resolved_by ?? null,
  };
}

function entryToApi(entry: LedgerEntry) {
  return {
    entry_id: entry.entryId,
    context_id: entry.contextId,
    type: entry.type,
    recorded_at: entry.recordedAt,
    effective_date: entry.effectiveDate,
    payer_id: entry.payerId,
    total_amount: entry.totalAmount,
    currency: entry.currency,
    description: entry.description,
    category: entry.category ?? null,
    notes: entry.notes ?? null,
    allocations: entry.allocations.map((allocation) => ({
      participant_id: allocation.participantId,
      share_amount: allocation.shareAmount,
      is_payer: allocation.isPayer,
    })),
    version: entry.version,
    hlc: entry.hlc,
    voided_at: entry.voidedAt ?? null,
    void_reason: entry.voidReason ?? null,
  };
}

// --- Onboarding -------------------------------------------------------------

// Registers this device's one-and-only identity; the token never leaves it.
export async function registerIdentity(displayName: string): Promise<DeviceIdentity> {
  const participantId = `p-${randomId()}`;
  const body = (await postJson("/participants", {
    participant_id: participantId,
    display_name: displayName,
    is_ghost: false,
    created_at: new Date().toISOString(),
  })) as { participant_id: string; display_name: string; auth_token: string };
  const device: DeviceIdentity = {
    participantId: body.participant_id,
    displayName: body.display_name,
    authToken: body.auth_token,
  };
  await setDevice(device);
  await rememberDevice(device);
  await upsertParticipants([{ participantId: device.participantId, displayName: device.displayName }]);
  return device;
}

export async function joinWithInvite(inviteCode: string, displayName?: string): Promise<DeviceIdentity> {
  const existing = await getDevice();
  if (existing) {
    await postJson("/invites/redeem", { invite_code: inviteCode }, existing.authToken);
    await syncNow();
    return existing;
  }
  if (!displayName) {
    throw new Error("display_name_required");
  }
  const body = (await postJson("/invites/redeem", {
    invite_code: inviteCode,
    participant_id: `p-${randomId()}`,
    display_name: displayName,
  })) as InviteRedeemApiResponse;
  if (!body.auth_token) {
    throw new Error("invite_token_missing");
  }
  const device: DeviceIdentity = {
    participantId: body.participant_id,
    displayName: body.display_name,
    authToken: body.auth_token,
  };
  await setDevice(device);
  await rememberDevice(device);
  await upsertParticipants([{ participantId: device.participantId, displayName: device.displayName }]);
  await syncNow();
  return device;
}

// --- Session switching (no password auth yet — see unified-expense-os follow-up) --------

export async function logout(): Promise<void> {
  await clearDevice();
}

// Switches the active identity to a previously-remembered device on this
// browser, then pulls its data down. Not password-protected: anyone with
// this browser profile can switch to any remembered identity.
export async function loginAsRememberedDevice(participantId: string): Promise<DeviceIdentity> {
  const history = await getDeviceHistory();
  const device = history.find((entry) => entry.participantId === participantId);
  if (!device) {
    throw new Error("remembered_device_not_found");
  }
  await clearDevice();
  await setDevice(device);
  await rememberDevice(device);
  await syncNow();
  return device;
}

export async function listRememberedDevices(): Promise<DeviceIdentity[]> {
  return getDeviceHistory();
}

export async function forgetRememberedDevice(participantId: string): Promise<void> {
  await forgetDevice(participantId);
}

export async function createContext(name: string, type: "personal" | "shared"): Promise<string> {
  const device = await requireDevice();
  // Local-only mode: the context and self-membership are generated on-device
  // and never leave it (unified-expense-os-1r4).
  if (isLocalOnly()) {
    return createLocalContext(device, name, type);
  }
  const createdAt = new Date().toISOString();
  const contextId = `ctx-${randomId()}`;
  await postJson(
    "/contexts",
    {
      context_id: contextId,
      name,
      type,
      owner_participant_id: device.participantId,
      created_at: createdAt,
      default_split: "equal",
      allow_simplified_debts: false,
    },
    device.authToken,
  );
  await postJson(
    "/memberships",
    {
      membership_id: `m-${randomId()}`,
      context_id: contextId,
      participant_id: device.participantId,
      joined_at: createdAt,
      default_share: "equal",
      allow_simplify_for_me: true,
    },
    device.authToken,
  );
  await syncNow();
  return contextId;
}

// --- Invites ----------------------------------------------------------------

// claimParticipantId lets the invite hand over an existing ghost member's
// identity (and its ledger history) to whoever redeems the code, instead of
// creating a brand new participant.
export async function createInvite(contextId: string, claimParticipantId?: string): Promise<Invite> {
  const device = await requireDevice();
  const body = (await postJson(
    `/contexts/${contextId}/invites`,
    { claim_participant_id: claimParticipantId ?? null },
    device.authToken,
  )) as InviteApiRecord;
  return inviteFromApi(body);
}

export async function listOpenInvites(contextId: string): Promise<Invite[]> {
  const device = await requireDevice();
  const body = (await getJson(`/contexts/${contextId}/invites`, device.authToken)) as InviteApiRecord[];
  return body.map(inviteFromApi);
}

// --- Named members without a device yet ("ghosts") ---------------------------

// Adds a person to the context by name only, so they can be picked as a
// payer/split participant immediately. They can later redeem an invite that
// hands them this same identity (see createInvite's claimParticipantId).
// Adds someone the device already knows to another context, reusing their
// participant id so their balances stay one person rather than splitting
// across two same-named records (unified-expense-os-mew). The server rejects
// a second active membership with 409 already_member.
export async function addExistingMember(contextId: string, participantId: string): Promise<void> {
  const joinedAt = new Date().toISOString();
  const membershipId = `m-${randomId()}`;
  const membership = {
    membershipId,
    contextId,
    participantId,
    isGhost: false,
    joinedAt,
    leftAt: null,
    defaultShare: "equal" as const,
    allowSimplifyForMe: true,
  };
  if (!isLocalOnly()) {
    const device = await requireDevice();
    await postJson(
      "/memberships",
      {
        membership_id: membershipId,
        context_id: contextId,
        participant_id: participantId,
        joined_at: joinedAt,
        default_share: "equal",
        allow_simplify_for_me: true,
      },
      device.authToken,
    );
  }
  await upsertMemberships([membership]);
}

export async function addNamedMember(contextId: string, displayName: string): Promise<string> {
  // Local-only mode: ghost members are purely local records.
  if (isLocalOnly()) {
    return addLocalMember(contextId, displayName);
  }
  const device = await requireDevice();
  const body = (await postJson(
    `/contexts/${contextId}/ghost-members`,
    { display_name: displayName },
    device.authToken,
  )) as GhostParticipantApiResponse;
  await upsertParticipants([{ participantId: body.participant_id, displayName: body.display_name }]);
  await upsertMemberships([
    {
      membershipId: body.membership_id,
      contextId,
      participantId: body.participant_id,
      isGhost: true,
      joinedAt: new Date().toISOString(),
      leftAt: null,
      defaultShare: "equal",
      allowSimplifyForMe: true,
    },
  ]);
  return body.participant_id;
}

// --- Capture ----------------------------------------------------------------

export async function classifyCapture(text: string): Promise<CaptureSuggestion> {
  const device = await requireDevice();
  return (await postJson("/capture/classify", { text }, device.authToken)) as CaptureSuggestion;
}

// Opt-in cloud LLM fallback for low-confidence captures (Phase 7). Only
// ever called when classifyCapture() returned confidence "low" and the
// user explicitly asks for a suggestion — the server 503s if the operator
// hasn't configured an LLM key, and the draft returned here is never
// auto-saved; the caller must still review/edit/confirm it.
export type LlmCaptureDraft = {
  description: string | null;
  amount_paise: number | null;
  category: string | null;
  participants: string[];
  // Extended draft fields (unified-expense-os-mi5/kct). Names are plain
  // strings the client resolves against the local membership list — the
  // server never sees or returns participant IDs.
  payer?: string | null;
  split_mode?: "equal" | "shares" | "custom" | null;
  shares?: Record<string, number> | null;
  amounts_paise?: Record<string, number> | null;
  context_hint?: string | null;
  date?: string | null;
  currency?: string | null;
};

export async function draftCaptureViaLlm(text: string): Promise<LlmCaptureDraft> {
  const device = await requireDevice();
  return (await postJson("/capture/parse-nl-fallback", { text }, device.authToken)) as LlmCaptureDraft;
}

// --- Chat assistant intent (opt-in LLM) --------------------------------------
// Stateless: the client sends recent turns + name lists (never ledger rows),
// the server returns one structured intent. The deterministic compilers in
// lib/qa.ts and lib/voiceGrammar.ts always run first; this is the fallback
// for fuzzier phrasing. Responses only ever become drafts/answers the user
// reviews — intent output never writes to the ledger.

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ChatIntentQuery = {
  metric: string | null;
  timeframe: string | null;
  category: string | null;
  person: string | null;
};

export type ChatIntentResponse = {
  intent: "query_ledger" | "draft_expense" | "draft_settlement" | "draft_recurring" | "void_expense" | "clarify" | "none";
  draft: LlmCaptureDraft | null;
  query: ChatIntentQuery | null;
  clarify_question: string | null;
  reply: string | null;
  // void_expense only: the user's words for which entry; resolved and
  // confirmed locally — the model never picks entry ids.
  void_target?: string | null;
};

// --- Per-participant server-side LLM provider config -------------------------
// The key is stored on YOUR self-hosted server and used only server-side;
// the client only ever learns whether one is set, never the key itself.

export type LlmConfigView = {
  configured: boolean;
  base_url: string | null;
  model: string | null;
  has_api_key: boolean;
};

export async function getLlmConfig(): Promise<LlmConfigView> {
  const device = await requireDevice();
  return (await apiFetch("/me/llm-config", {}, device.authToken)) as LlmConfigView;
}

// api_key: undefined/null keeps any already-stored key; "" clears it (keyless
// LAN inference); a value replaces it.
export async function putLlmConfig(input: {
  baseUrl: string;
  model: string;
  apiKey?: string | null;
}): Promise<LlmConfigView> {
  const device = await requireDevice();
  return (await apiFetch(
    "/me/llm-config",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_url: input.baseUrl, model: input.model, api_key: input.apiKey ?? null }),
    },
    device.authToken,
  )) as LlmConfigView;
}

export async function deleteLlmConfig(): Promise<void> {
  const device = await requireDevice();
  await apiFetch("/me/llm-config", { method: "DELETE" }, device.authToken);
}

// Agent-mode relay: the fully-built prompt (ledger digest + action schema)
// goes to the user's configured server-side model; raw text comes back and
// is parsed/validated on this device (lib/agent.ts).
export async function agentTextViaLlm(prompt: string): Promise<string> {
  const device = await requireDevice();
  const body = (await postJson("/capture/agent", { prompt }, device.authToken)) as { text: string };
  return body.text;
}

export async function chatIntentViaLlm(input: {
  messages: ChatMessage[];
  contextNames: string[];
  participantNames: string[];
  categoryNames: string[];
}): Promise<ChatIntentResponse> {
  const device = await requireDevice();
  return (await postJson(
    "/capture/chat-intent",
    {
      messages: input.messages.slice(-12),
      context_names: input.contextNames,
      participant_names: input.participantNames,
      category_names: input.categoryNames,
    },
    device.authToken,
  )) as ChatIntentResponse;
}

// --- Local-first expense capture ---------------------------------------------

// Single choke point for ledger writes: in local-only mode entries are
// stored as committed with no sync-queue item (there is no server to push
// to, and a forever-pending queue would nag); otherwise the normal
// pending+queue outbox path applies.
async function persistEntry(entry: LedgerEntry): Promise<LedgerEntry> {
  if (isLocalOnly()) {
    const committed: LedgerEntry = { ...entry, syncState: "committed" };
    await upsertEntries([committed]);
    return committed;
  }
  await addPendingEntry(entry);
  return entry;
}

export async function queueExpense(input: {
  contextId: string;
  payerId: string;
  description: string;
  category?: string | null;
  // Free-text settlement context ("for the ski trip lift tickets") distinct
  // from category — unified-expense-os-ufz.
  notes?: string | null;
  amountPaise: number;
  participantIds: string[];
  // Explicit per-person shares (paise) for unequal splits — e.g. one person
  // added ice cream nobody else had. Must sum to amountPaise. Falls back to
  // an equal split across participantIds when omitted.
  customShares?: Record<string, number>;
  // Backdated entries: defaults to today when omitted.
  effectiveDate?: string;
  // Entry's native currency (ISO 4217 code). Defaults to INR. Balances and
  // reports only ever sum entries sharing one currency — see currencies.ts.
  currency?: string;
}): Promise<LedgerEntry> {
  const device = await requireDevice();
  const now = new Date();
  let allocations = buildEqualAllocations(input.amountPaise, input.participantIds, input.payerId);
  if (input.customShares) {
    const sum = Object.values(input.customShares).reduce((total, share) => total + share, 0);
    if (sum !== input.amountPaise) {
      throw new Error("custom_shares_must_sum_to_total");
    }
    allocations = Object.entries(input.customShares).map(([participantId, shareAmount]) => ({
      participantId,
      shareAmount,
      isPayer: participantId === input.payerId,
    }));
  }
  const entry: LedgerEntry = {
    entryId: randomId(),
    contextId: input.contextId,
    type: "expense",
    recordedAt: now.toISOString(),
    effectiveDate: input.effectiveDate ?? localDateString(now),
    payerId: input.payerId,
    totalAmount: input.amountPaise,
    currency: input.currency ?? "INR",
    description: input.description,
    category: input.category ?? null,
    notes: input.notes ?? null,
    allocations,
    version: 1,
    hlc: nextHlc(device.participantId),
    syncState: "pending",
    syncError: null,
  };
  return persistEntry(entry);
}

// Opening balances ("Ravi owes me ₹3,200 from before") reuse the settlement
// allocation shape: creditor is payer_id with a zero-share allocation, debtor
// carries the full amount as their (negative) share. That nets into
// deriveBalances identically to a settlement, just in the opposite direction,
// without needing a new validation path on the server.
export async function queueOpeningBalance(input: {
  contextId: string;
  creditorId: string;
  debtorId: string;
  amountPaise: number;
  description?: string;
  effectiveDate?: string;
}): Promise<LedgerEntry> {
  const device = await requireDevice();
  const now = new Date();
  const entry: LedgerEntry = {
    entryId: randomId(),
    contextId: input.contextId,
    type: "adjustment",
    recordedAt: now.toISOString(),
    effectiveDate: input.effectiveDate ?? localDateString(now),
    payerId: input.creditorId,
    totalAmount: input.amountPaise,
    currency: "INR",
    description: input.description?.trim() || "Opening balance",
    category: null,
    allocations: [
      { participantId: input.creditorId, shareAmount: 0, isPayer: true },
      { participantId: input.debtorId, shareAmount: input.amountPaise, isPayer: false },
    ],
    version: 1,
    hlc: nextHlc(device.participantId),
    syncState: "pending",
    syncError: null,
  };
  return persistEntry(entry);
}

// Edits are pushed as a new version of the same entry_id: same optimistic
// local-first + queue path as queueExpense, so the sync engine and conflict
// (LWW) handling need no special-casing for edits vs. creates.
export async function editExpense(
  entry: LedgerEntry,
  updates: {
    description?: string;
    category?: string | null;
    notes?: string | null;
    amountPaise?: number;
    effectiveDate?: string;
    payerId?: string;
  },
): Promise<LedgerEntry> {
  const device = await requireDevice();
  const totalAmount = updates.amountPaise ?? entry.totalAmount;
  const payerId = updates.payerId ?? entry.payerId;
  // Rescale proportionally rather than rebuilding an equal split — a custom
  // split must survive an amount or payer edit, not silently revert to equal
  // shares (unified-expense-os-bbh).
  const allocations =
    totalAmount !== entry.totalAmount || payerId !== entry.payerId
      ? rescaleAllocations(entry.allocations, totalAmount, payerId)
      : entry.allocations;
  const updated: LedgerEntry = {
    ...entry,
    description: updates.description ?? entry.description,
    category: updates.category !== undefined ? updates.category : entry.category,
    notes: updates.notes !== undefined ? updates.notes : entry.notes,
    effectiveDate: updates.effectiveDate ?? entry.effectiveDate,
    payerId,
    totalAmount,
    allocations,
    version: entry.version + 1,
    hlc: nextHlc(device.participantId),
    syncState: "pending",
    syncError: null,
  };
  return persistEntry(updated);
}

// Rewrite an entry's split outright (agent re-split flow). The caller is
// responsible for allocations summing exactly to the entry total — validated
// here too because a mismatch would corrupt balances.
export async function resplitExpense(entry: LedgerEntry, allocations: Allocation[]): Promise<LedgerEntry> {
  const device = await requireDevice();
  const sum = allocations.reduce((total, allocation) => total + allocation.shareAmount, 0);
  if (sum !== entry.totalAmount) {
    throw new Error(`allocations sum ${sum} != entry total ${entry.totalAmount}`);
  }
  // Same rule the server enforces — fail fast instead of syncing a doomed
  // entry that comes back "rejected: The payer must be part of the split."
  if (!allocations.some((allocation) => allocation.participantId === entry.payerId)) {
    throw new Error("The payer must be part of the split.");
  }
  const updated: LedgerEntry = {
    ...entry,
    allocations,
    version: entry.version + 1,
    hlc: nextHlc(device.participantId),
    syncState: "pending",
    syncError: null,
  };
  return persistEntry(updated);
}

export async function voidExpense(entry: LedgerEntry, reason: string): Promise<LedgerEntry> {
  const device = await requireDevice();
  const updated: LedgerEntry = {
    ...entry,
    voidedAt: new Date().toISOString(),
    voidReason: reason,
    version: entry.version + 1,
    hlc: nextHlc(device.participantId),
    syncState: "pending",
    syncError: null,
  };
  return persistEntry(updated);
}

// --- Sync engine ------------------------------------------------------------

// Mutual exclusion belongs here, not in a component: api.ts itself calls
// syncNow() after joins/creates/generates, and a second tab has its own React
// state entirely. Overlapping runs can double-push entries and interleave the
// read-modify-write of the pull cursor (unified-expense-os-6do). A run
// requested while one is in flight is coalesced into exactly one rerun.
let syncInFlight: Promise<{ pushed: number; rejected: number }> | null = null;
let syncRerunRequested = false;

export async function syncNow(): Promise<{ pushed: number; rejected: number }> {
  if (syncInFlight) {
    syncRerunRequested = true;
    return syncInFlight;
  }
  syncInFlight = (async () => {
    try {
      let result = await runSyncPass();
      while (syncRerunRequested) {
        syncRerunRequested = false;
        result = await runSyncPass();
      }
      return result;
    } finally {
      syncInFlight = null;
      syncRerunRequested = false;
    }
  })();
  return syncInFlight;
}

async function runSyncPass(): Promise<{ pushed: number; rejected: number }> {
  // Local-only mode has no server: sync is a no-op by design.
  if (isLocalOnly()) {
    return { pushed: 0, rejected: 0 };
  }
  const device = await requireDevice();

  const contexts = ((await getJson("/contexts", device.authToken)) as ContextApiRecord[]).map(contextFromApi);
  await upsertContexts(contexts);

  for (const context of contexts) {
    const memberships = (await getJson(
      `/contexts/${context.contextId}/memberships`,
      device.authToken,
    )) as MembershipApiRecord[];
    await upsertMemberships(memberships.map(membershipFromApi));
    await upsertParticipants(
      memberships.map((membership) => ({
        participantId: membership.participant_id,
        displayName: membership.display_name,
      })),
    );
    const templates = (await getJson(
      `/contexts/${context.contextId}/recurring-templates`,
      device.authToken,
    )) as RecurringTemplateApiRecord[];
    await upsertTemplates(templates.map(templateFromApi));
  }

  let pushed = 0;
  let rejected = 0;
  const snapshot = await readSnapshot();
  const queuedEntries = snapshot.entries.filter((entry) =>
    snapshot.queue.some((queueItem) => queueItem.entryId === entry.entryId),
  );
  if (queuedEntries.length > 0) {
    const results = (await postJson(
      "/sync/push",
      { entries: queuedEntries.map(entryToApi) },
      device.authToken,
    )) as SyncPushResponseItem[];
    // Remember what we actually sent: the local record may have been edited
    // during the round trip, in which case this response must not be applied
    // (unified-expense-os-4z6).
    const pushedHlcById = new Map(queuedEntries.map((entry) => [entry.entryId, entry.hlc]));
    for (const item of results) {
      if (item.status === "accepted" && item.server_seq !== null && item.version !== null) {
        await markCommitted(item.entry_id, item.server_seq, item.version, pushedHlcById.get(item.entry_id));
        pushed += 1;
      } else {
        await markRejected(item.entry_id, item.error_code ?? "rejected", pushedHlcById.get(item.entry_id));
        rejected += 1;
      }
    }
  }

  for (const context of contexts) {
    let cursor = ((await getMeta<Record<string, number>>("cursorByContext")) ?? {})[context.contextId] ?? 0;
    for (;;) {
      const body = (await getJson(
        // Send the limit explicitly: the loop terminates on a short page, so
        // relying on the server's default matching PULL_PAGE_LIMIT would
        // silently stop after one page if that default ever changed
        // (unified-expense-os-6bv).
        `/sync/pull?context_id=${encodeURIComponent(context.contextId)}&after_seq=${cursor}&limit=${PULL_PAGE_LIMIT}`,
        device.authToken,
      )) as SyncPullResponse;
      if (body.entries.length > 0) {
        await upsertEntries(body.entries.map(entryFromApi));
      }
      cursor = body.max_server_seq;
      await setCursor(context.contextId, cursor);
      if (body.entries.length < PULL_PAGE_LIMIT) {
        break;
      }
    }
  }

  return { pushed, rejected };
}

// --- Entry history ------------------------------------------------------------

export async function fetchEntryHistory(entryId: string): Promise<EntryHistoryRecord[]> {
  const device = await requireDevice();
  const body = (await getJson(`/ledger/entries/${entryId}/history`, device.authToken)) as EntryHistoryApiRecord[];
  return body.map((row) => ({
    version: row.version,
    hlc: row.hlc,
    action: row.action,
    editedBy: row.edited_by,
    description: row.description,
    totalAmount: row.total_amount,
    payerId: row.payer_id,
    notes: row.notes ?? null,
    voidedAt: row.voided_at,
    recordedAt: row.recorded_at,
    allocations: row.allocations.map((allocation) => ({
      participantId: allocation.participant_id,
      shareAmount: allocation.share_amount,
      isPayer: allocation.is_payer,
    })),
  }));
}

// --- Settlements ------------------------------------------------------------

export async function fetchSettlementPlan(contextId: string): Promise<SettlementPlan> {
  const device = await requireDevice();
  const plan = (await getJson(
    `/contexts/${contextId}/settlement-plan`,
    device.authToken,
  )) as SettlementPlanApiResponse;
  return {
    contextId: plan.context_id,
    currency: plan.currency,
    simplificationEnabled: plan.simplification_enabled,
    excludedParticipantIds: plan.excluded_participant_ids,
    recommendations: plan.recommendations.map((recommendation) => ({
      fromParticipantId: recommendation.from_participant_id,
      toParticipantId: recommendation.to_participant_id,
      amountCents: recommendation.amount_cents,
      kind: recommendation.kind,
      currency: recommendation.currency,
    })),
  };
}

export async function recordSettlement(
  contextId: string,
  recommendation: SettlementRecommendation,
): Promise<LedgerEntry> {
  const device = await requireDevice();
  // Local-only mode has no settlements endpoint; build the same entry shape
  // the server would and commit it through the one write chokepoint. The
  // payer is the person paying, carrying a zero share; the recipient's
  // allocation holds the full amount (unified-expense-os-kxb).
  if (isLocalOnly()) {
    const now = new Date();
    return persistEntry({
      entryId: randomId(),
      contextId,
      type: "settlement",
      recordedAt: now.toISOString(),
      effectiveDate: localDateString(now),
      payerId: recommendation.fromParticipantId,
      totalAmount: recommendation.amountCents,
      currency: recommendation.currency,
      description: "Settlement",
      category: null,
      notes: null,
      allocations: [
        { participantId: recommendation.fromParticipantId, shareAmount: 0, isPayer: true },
        { participantId: recommendation.toParticipantId, shareAmount: recommendation.amountCents, isPayer: false },
      ],
      version: 1,
      hlc: nextHlc(device.participantId),
      syncState: "pending",
      syncError: null,
    });
  }
  const response = (await postJson(
    `/contexts/${contextId}/settlements`,
    {
      from_participant_id: recommendation.fromParticipantId,
      to_participant_id: recommendation.toParticipantId,
      amount_cents: recommendation.amountCents,
      kind: recommendation.kind,
    },
    device.authToken,
  )) as LedgerEntryApiRecord;
  const entry = entryFromApi(response);
  await upsertEntries([entry]);
  return entry;
}

// --- Preferences ------------------------------------------------------------

export async function updateContextSimplifyPreference(contextId: string, allowSimplifiedDebts: boolean) {
  const device = await requireDevice();
  const updated = contextFromApi(
    (await patchJson(
      `/contexts/${contextId}/preferences`,
      { allow_simplified_debts: allowSimplifiedDebts },
      device.authToken,
    )) as ContextApiRecord,
  );
  await upsertContexts([updated]);
  return updated;
}

export async function updateMembershipSimplifyPreference(membershipId: string, allowSimplifyForMe: boolean) {
  const device = await requireDevice();
  const updated = membershipFromApi(
    (await patchJson(
      `/memberships/${membershipId}/preferences`,
      { allow_simplify_for_me: allowSimplifyForMe },
      device.authToken,
    )) as MembershipApiRecord,
  );
  await upsertMemberships([updated]);
  return updated;
}

// --- Member lifecycle --------------------------------------------------------

export async function leaveContext(membershipId: string): Promise<Membership> {
  const device = await requireDevice();
  const updated = membershipFromApi(
    (await postJson(`/memberships/${membershipId}/leave`, {}, device.authToken)) as MembershipApiRecord,
  );
  await upsertMemberships([updated]);
  return updated;
}

export async function removeMember(membershipId: string): Promise<Membership> {
  const device = await requireDevice();
  const updated = membershipFromApi(
    (await postJson(`/memberships/${membershipId}/remove`, {}, device.authToken)) as MembershipApiRecord,
  );
  await upsertMemberships([updated]);
  return updated;
}

export async function archiveContext(contextId: string): Promise<ContextRecord> {
  const device = await requireDevice();
  const updated = contextFromApi(
    (await postJson(`/contexts/${contextId}/archive`, {}, device.authToken)) as ContextApiRecord,
  );
  await upsertContexts([updated]);
  return updated;
}

type ContextCloseApiResponse = {
  context_id: string;
  closed_at: string | null;
  outstanding: SettlementPlanApiResponse["recommendations"];
};

// One-way: a closed context (post-final-settlement trip/event) rejects new
// entries, membership changes, and preference writes server-side (35p).
// Distinct from archive, which is purely cosmetic and reversible. The server
// rejects with outstanding balances unless force=true, so a first call
// surfaces what's still owed for the caller to show the user before retrying.
export async function closeContext(
  contextId: string,
  force = false,
): Promise<{ context: ContextRecord | null; outstanding: SettlementRecommendation[] }> {
  const device = await requireDevice();
  const body = (await postJson(
    `/contexts/${contextId}/close${force ? "?force=true" : ""}`,
    {},
    device.authToken,
  )) as ContextCloseApiResponse;
  const outstanding = body.outstanding.map((row) => ({
    fromParticipantId: row.from_participant_id,
    toParticipantId: row.to_participant_id,
    amountCents: row.amount_cents,
    kind: row.kind,
    currency: row.currency,
  }));
  if (!body.closed_at) {
    return { context: null, outstanding };
  }
  const snapshot = await readSnapshot();
  const existing = snapshot.contexts.find((context) => context.contextId === contextId);
  if (!existing) {
    return { context: null, outstanding };
  }
  const updated: ContextRecord = { ...existing, closedAt: body.closed_at };
  await upsertContexts([updated]);
  return { context: updated, outstanding };
}

// --- Recurring --------------------------------------------------------------

export async function createRecurringTemplate(input: {
  contextId: string;
  description: string;
  amountPaise: number;
  anchorDay: number;
}): Promise<RecurringTemplate> {
  const device = await requireDevice();
  const now = new Date();
  // First occurrence is this month's anchor day (clamped to month length), so
  // "Generate due" immediately materializes the current month when the anchor
  // has already passed.
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const day = Math.min(input.anchorDay, lastDayOfMonth);
  const nextDueDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const body = (await postJson(
    "/recurring/templates",
    {
      template_id: `tpl-${randomId()}`,
      context_id: input.contextId,
      description: input.description,
      amount: input.amountPaise,
      split_rule: { type: "equal" },
      cadence: "monthly",
      next_due_date: nextDueDate,
      anchor_day: input.anchorDay,
      active: true,
      created_at: now.toISOString(),
    },
    device.authToken,
  )) as RecurringTemplateApiRecord;
  const template = templateFromApi(body);
  await upsertTemplates([template]);
  return template;
}

export async function updateRecurringTemplate(
  templateId: string,
  updates: { description?: string; amountPaise?: number; anchorDay?: number; active?: boolean },
  expectedVersion?: number,
): Promise<RecurringTemplate> {
  const device = await requireDevice();
  const body = (await patchJson(
    `/recurring/templates/${templateId}`,
    {
      description: updates.description,
      amount: updates.amountPaise,
      anchor_day: updates.anchorDay,
      active: updates.active,
      expected_version: expectedVersion,
    },
    device.authToken,
  )) as RecurringTemplateApiRecord;
  const template = templateFromApi(body);
  await upsertTemplates([template]);
  return template;
}

export async function generateDueEntries(templateId: string, payerId: string): Promise<number> {
  const device = await requireDevice();
  const asOf = new Date().toISOString().slice(0, 10);
  const body = (await postJson(
    `/recurring/templates/${templateId}/generate?payer_id=${encodeURIComponent(payerId)}&as_of=${asOf}`,
    {},
    device.authToken,
  )) as { entries: LedgerEntryApiRecord[] };
  await syncNow();
  return body.entries.length;
}

// --- Push subscriptions -------------------------------------------------

export async function registerPushSubscription(payload: {
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
}): Promise<void> {
  const device = await requireDevice();
  await postNoContent("/push/subscriptions", payload, device.authToken);
}

export async function unregisterPushSubscription(endpoint: string): Promise<void> {
  const device = await requireDevice();
  await deleteNoContent(`/push/subscriptions?endpoint=${encodeURIComponent(endpoint)}`, device.authToken);
}

// --- Device management --------------------------------------------------

// Rotates this device's own token and persists the new one locally — the
// old token stops working the instant the server commits the rotation.
export async function rotateOwnToken(): Promise<void> {
  const device = await requireDevice();
  const body = (await postJson(`/participants/${device.participantId}/rotate-token`, {}, device.authToken)) as {
    participant_id: string;
    auth_token: string | null;
  };
  if (body.auth_token) {
    await setDevice({ ...device, authToken: body.auth_token });
  }
}

// Owner-only: revoke another participant's device access by rotating their
// token without disclosing the new value — an effective forced logout.
export async function revokeParticipantAccess(participantId: string): Promise<void> {
  const device = await requireDevice();
  await postJson(`/participants/${participantId}/rotate-token`, {}, device.authToken);
}

// --- LLM vision receipt parsing (opt-in) --------------------------------

export type VisionReceiptDraft = {
  merchant: string | null;
  date: string | null;
  totalPaise: number | null;
  items: { label: string; amountPaise: number }[];
};

// The photo is sent to the backend, which proxies it to a cloud model — the
// API key stays server-side. This is opt-in per the plan doc's cloud-model
// policy; nothing here writes to the ledger, it only returns a draft for the
// caller to review.
export async function parseReceiptVision(imageBase64: string): Promise<VisionReceiptDraft> {
  const device = await requireDevice();
  const body = (await postJson(
    "/capture/parse-receipt-vision",
    { image_base64: imageBase64 },
    device.authToken,
  )) as { merchant: string | null; date: string | null; total_paise: number | null; items: { label: string; amount_paise: number }[] };
  return {
    merchant: body.merchant,
    date: body.date,
    totalPaise: body.total_paise,
    items: body.items.map((item) => ({ label: item.label, amountPaise: item.amount_paise })),
  };
}

// --- Passkey (WebAuthn) authentication -----------------------------------

export async function beginPasskeyRegistration(): Promise<{ flowId: string; optionsJson: string }> {
  const device = await requireDevice();
  const body = (await postJson("/webauthn/registration/begin", {}, device.authToken)) as {
    flow_id: string;
    options_json: string;
  };
  return { flowId: body.flow_id, optionsJson: body.options_json };
}

export async function finishPasskeyRegistration(flowId: string, credential: unknown): Promise<void> {
  const device = await requireDevice();
  await postNoContent("/webauthn/registration/finish", { flow_id: flowId, credential }, device.authToken);
}

export async function beginPasskeyLogin(participantId: string): Promise<{ flowId: string; optionsJson: string }> {
  const body = (await postJson("/webauthn/login/begin", { participant_id: participantId })) as {
    flow_id: string;
    options_json: string;
  };
  return { flowId: body.flow_id, optionsJson: body.options_json };
}

// Returns the fresh identity so the caller can persist it as this device's
// active identity — this is the one flow that grants a token without the
// caller already possessing one, gated entirely on a verified assertion.
export async function finishPasskeyLogin(
  flowId: string,
  participantId: string,
  credential: unknown,
): Promise<DeviceIdentity> {
  const body = (await postJson("/webauthn/login/finish", {
    flow_id: flowId,
    participant_id: participantId,
    credential,
  })) as { participant_id: string; display_name: string; auth_token: string };
  const identity: DeviceIdentity = {
    participantId: body.participant_id,
    displayName: body.display_name,
    authToken: body.auth_token,
  };
  await setDevice(identity);
  await rememberDevice(identity);
  return identity;
}

export async function renameSelf(displayName: string): Promise<void> {
  const device = await requireDevice();
  const body = (await patchJson("/participants/me", { display_name: displayName }, device.authToken)) as {
    display_name: string;
  };
  const updated = { ...device, displayName: body.display_name };
  await setDevice(updated);
  await rememberDevice(updated);
  await upsertParticipants([{ participantId: updated.participantId, displayName: updated.displayName }]);
}
