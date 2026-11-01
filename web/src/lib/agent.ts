import type { ChatMessage } from "./api";
import { formatMoneyIn, partitionByCurrency } from "./currencies";
import { EXPENSE_CATEGORIES, resolveName, type ExpenseDraft } from "./expenseDraft";
import { emptyDraft } from "./expenseDraft";
import { deriveBalances, localDateString, participantName, reportSummary, timeFrameRange, type TimeFrame } from "./finance";
import { buildLedgerDigest, type LedgerDigest } from "./ledgerDigest";
import type { AssistantDeps, AssistantTurn } from "./assistant";
import type { Allocation, LedgerEntry } from "../types";

// Agent mode (unified-expense-os-5kp): the model SEES a ledger digest and
// returns ONE structured action. This module owns the prompt, the action
// parsing/validation, and turning a validated action into an AssistantTurn.
// Hard rules preserved:
// - every mutating action becomes a confirm card; the user does the write;
// - the model addresses entries by short refs and people/contexts by name —
//   this device resolves them; the model never sees or invents ids;
// - quoted numbers come precomputed in the digest, splits are computed here.

export type AgentAction =
  | { action: "answer"; text: string }
  | {
      action: "add_expense";
      context?: string | null;
      description?: string | null;
      amount_paise?: number | null;
      currency?: string | null;
      category?: string | null;
      payer?: string | null;
      split_mode?: "equal" | "shares" | "custom" | null;
      participants?: string[] | null;
      shares?: Record<string, number> | null;
      amounts_paise?: Record<string, number> | null;
      date?: string | null;
    }
  | { action: "resplit_expense"; entry: string; participants: string[]; mode?: string | null }
  | {
      action: "edit_expense";
      entry: string;
      description?: string | null;
      amount_paise?: number | null;
      category?: string | null;
      payer?: string | null;
      date?: string | null;
    }
  | { action: "void_expense"; entry: string }
  | { action: "create_context"; name: string; type?: "personal" | "shared" | null }
  | { action: "add_member"; context: string; name: string }
  | { action: "show_entries"; context?: string | null; text?: string | null; category?: string | null; limit?: number | null }
  | { action: "clarify"; question: string };

// Read-only ledger lookups the model can request mid-turn. Executed HERE,
// against local data — the model only ever sees the compact text results.
export type AgentToolCall =
  | { tool: "search_entries"; text?: string | null; context?: string | null; category?: string | null; limit?: number | null }
  | { tool: "list_entries"; context: string; limit?: number | null }
  | { tool: "get_balances"; context?: string | null }
  | { tool: "spend_summary"; timeframe?: string | null; category?: string | null; person?: string | null };

export type AgentReply = { type: "tool"; call: AgentToolCall } | { type: "action"; action: AgentAction };

// The review card silently blanks any category outside this vocabulary, so a
// model left to invent one ("food") loses the prefill. Offer the real list.
const CATEGORY_ENUM = `"${EXPENSE_CATEGORIES.join("|")}"`;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function buildAgentPrompt(messages: ChatMessage[], digest: LedgerDigest, today: Date = new Date()): string {
  const transcript = messages
    .slice(-8)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n");
  return (
    "You are the in-app assistant of a self-hosted shared-expense tracker. You can SEE the ledger " +
    "below and PROPOSE actions; the app shows every change to the user for confirmation before " +
    "anything is saved. Reply with ONE minified JSON object and nothing else.\n" +
    "Actions:\n" +
    '{"action":"answer","text":str} — answer a question. Quote balances/amounts ONLY as they appear in the ledger below; never calculate new numbers.\n' +
    '{"action":"add_expense","context":str|null,"description":str,"amount_paise":int,"currency":"INR|USD|EUR|GBP"|null,"category":' +
    CATEGORY_ENUM +
    '|null,"payer":str|null,"split_mode":"equal|shares|custom"|null,"participants":[str],"shares":{name:num}|null,"amounts_paise":{name:int}|null,"date":"YYYY-MM-DD"|null} — record a new expense.\n' +
    '{"action":"resplit_expense","entry":"e1","participants":[str],"mode":"equal"} — change who OWES shares of an entry that ALREADY EXISTS in the ledger below, split equally among them. participants ["You","X"] splits it between you and X; ["X"] means X owes the whole amount (the payer keeps a zero share).\n' +
    '{"action":"edit_expense","entry":"e1","description":str|null,"amount_paise":int|null,"category":' +
    CATEGORY_ENUM +
    '|null,"payer":str|null,"date":str|null} — change fields of an existing entry (only the ones to change).\n' +
    '{"action":"void_expense","entry":"e1"} — delete/remove/undo an existing entry.\n' +
    '{"action":"create_context","name":str,"type":"personal|shared"} — new expense context (group).\n' +
    '{"action":"add_member","context":str,"name":str} — add a person to a context.\n' +
    '{"action":"show_entries","context":str|null,"text":str|null,"category":str|null,"limit":int} — show the user a tappable list of matching entries so THEY pick one (use when several entries could match, or when they ask to see transactions).\n' +
    '{"action":"clarify","question":str} — ask ONE short question when the request is ambiguous.\n' +
    "Tools — when the ledger below isn't enough (older entries, totals, full balances), request a lookup " +
    "instead of an action; the app replies with TOOL RESULT and you continue (max 3 lookups):\n" +
    '{"tool":"search_entries","text":str|null,"context":str|null,"category":str|null,"limit":int}\n' +
    '{"tool":"list_entries","context":str,"limit":int}\n' +
    '{"tool":"get_balances","context":str|null}\n' +
    '{"tool":"spend_summary","timeframe":"week|month|year","category":str|null,"person":str|null}\n' +
    "Rules: refer to entries by their [eN] refs and to people/contexts by the exact names in the ledger. " +
    'amount_paise is the integer smallest currency unit (₹1 = 100). "me"/"I" is You. ' +
    "A person not yet in the context may still be listed in participants — the app offers to add them.\n" +
    "NEW vs EXISTING: a message that states an amount (“split ₹200 with Ara”, “200 pizza with Ara”) is a NEW " +
    "expense → add_expense with participants [\"You\",\"Ara\"], unless it clearly points at an entry listed above " +
    "(“that pizza”, “the ₹200 one from yesterday”). resplit_expense/edit_expense/void_expense are ONLY for an " +
    "[eN] ref that appears in the ledger below or in a TOOL RESULT — never invent a ref. If you think an entry " +
    "exists but can't see it, use search_entries first.\n\n" +
    // Without this the model has no clock: it was being asked for YYYY-MM-DD
    // dates and told about "yesterday" with nothing to resolve them against.
    `TODAY: ${localDateString(today)} (${WEEKDAYS[today.getDay()]}). Resolve “yesterday”, “last Friday” and the like against it; ` +
    "omit date entirely when the user didn't say one.\n\n" +
    "LEDGER:\n" +
    digest.text +
    "\n\nCONVERSATION:\n" +
    transcript +
    "\nJSON:"
  );
}

const ACTIONS = new Set([
  "answer",
  "add_expense",
  "resplit_expense",
  "edit_expense",
  "void_expense",
  "create_context",
  "add_member",
  "show_entries",
  "clarify",
]);

const TOOLS = new Set(["search_entries", "list_entries", "get_balances", "spend_summary"]);

// Total parser for a model reply: a tool request, an action, or (for any
// malformed output) clarify. Never throws.
export function parseAgentReply(raw: string): AgentReply {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      if (typeof parsed.tool === "string" && TOOLS.has(parsed.tool)) {
        if (parsed.tool === "list_entries" && typeof parsed.context !== "string") {
          return { type: "action", action: { action: "clarify", question: "Which group should I look at?" } };
        }
        return { type: "tool", call: parsed as unknown as AgentToolCall };
      }
    } catch {
      // fall through to action parsing (which degrades to clarify)
    }
  }
  return { type: "action", action: parseAgentAction(raw) };
}

// Total parser: malformed output degrades to clarify, never throws.
export function parseAgentAction(raw: string): AgentAction {
  const clarify: AgentAction = { action: "clarify", question: "Could you rephrase that?" };
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return clarify;
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const action = parsed.action;
    if (typeof action !== "string" || !ACTIONS.has(action)) {
      return clarify;
    }
    if (action === "answer" && typeof parsed.text !== "string") {
      return clarify;
    }
    if ((action === "resplit_expense" || action === "edit_expense" || action === "void_expense") && typeof parsed.entry !== "string") {
      return clarify;
    }
    if (action === "resplit_expense" && !Array.isArray(parsed.participants)) {
      return clarify;
    }
    if (action === "create_context" && typeof parsed.name !== "string") {
      return clarify;
    }
    if (action === "add_member" && (typeof parsed.context !== "string" || typeof parsed.name !== "string")) {
      return clarify;
    }
    if (action === "clarify" && typeof parsed.question !== "string") {
      return clarify;
    }
    return parsed as unknown as AgentAction;
  } catch {
    return clarify;
  }
}

// The digest names the user "You", so the model echoes it back; resolveName
// treats only me/I/my as self (correct for speech input), so map it here.
function resolveAgentName(
  name: string,
  deps: AssistantDeps,
  memberIds: string[],
): string | null {
  if (/^you(?:rself)?$/i.test(name.trim())) {
    return deps.deviceParticipantId;
  }
  return resolveName(name, deps.participants, memberIds, deps.deviceParticipantId);
}

function entryLabel(entry: LedgerEntry): string {
  return `“${entry.description ?? "expense"}” (${formatMoneyIn(entry.currency ?? "INR", entry.totalAmount)}, ${entry.effectiveDate})`;
}

function liveEntries(deps: AssistantDeps): LedgerEntry[] {
  return deps.entries.filter(
    (entry) => entry.type === "expense" && !entry.voidedAt && entry.syncState !== "rejected",
  );
}

// Models quote the ref the way the digest prints it ("[e1]"), upper-case it,
// or hand back the description instead. Normalize before giving up.
function findEntry(ref: string, digest: LedgerDigest, deps: AssistantDeps): LedgerEntry | null {
  const cleaned = ref.trim().replace(/^[["'“]+|[\]"'”]+$/g, "").trim().toLowerCase();
  const entryId = digest.refToEntryId[cleaned];
  if (entryId) {
    return deps.entries.find((entry) => entry.entryId === entryId) ?? null;
  }
  if (/^e\d+$/.test(cleaned) || !cleaned) {
    // A ref-shaped string that isn't in the map is invented — don't guess.
    return null;
  }
  const matches = liveEntries(deps).filter((entry) => (entry.description ?? "").toLowerCase().includes(cleaned));
  return matches.length === 1 ? matches[0] : null;
}

// Dead end for an entry-addressing action. When there are entries to choose
// from, hand the user a tappable list instead of a question they already
// answered — repeating the request verbatim otherwise repeats this reply.
function entryNotFound(deps: AssistantDeps): AssistantTurn {
  const candidates = liveEntries(deps)
    .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))
    .slice(0, 8);
  if (candidates.length === 0) {
    return {
      kind: "clarify",
      text: "There are no entries yet to change. Tell me the expense and I'll draft it — e.g. “200 pizza split with Ara”.",
    };
  }
  return {
    kind: "showEntries",
    entryIds: candidates.map((entry) => entry.entryId),
    text: "I couldn't tell which entry you meant — pick one:",
  };
}

// Equal split that sums exactly: floor + spread the remainder from the front.
export function equalAllocations(totalPaise: number, participantIds: string[], payerId: string): Allocation[] {
  const base = Math.floor(totalPaise / participantIds.length);
  let remainder = totalPaise - base * participantIds.length;
  return participantIds.map((participantId) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { participantId, shareAmount: base + extra, isPayer: participantId === payerId };
  });
}

// The ref an entry-addressing action names, when this device can't resolve it
// (usually invented by the model). Null when the action resolves or doesn't
// address an entry at all.
function unresolvedEntryRef(action: AgentAction, deps: AssistantDeps, digest: LedgerDigest): string | null {
  if (action.action !== "resplit_expense" && action.action !== "edit_expense" && action.action !== "void_expense") {
    return null;
  }
  return findEntry(action.entry, digest, deps) ? null : action.entry;
}

export function agentActionToTurn(action: AgentAction, deps: AssistantDeps, digest: LedgerDigest): AssistantTurn {
  if (action.action === "answer") {
    return { kind: "answer", text: action.text };
  }
  if (action.action === "clarify") {
    return { kind: "clarify", text: action.question };
  }

  if (action.action === "add_expense") {
    const draft: ExpenseDraft = {
      ...emptyDraft(),
      description: action.description ?? null,
      amountPaise: typeof action.amount_paise === "number" ? Math.round(action.amount_paise) : null,
      category: action.category ?? null,
      payerName: action.payer ?? null,
      splitMode: action.split_mode ?? null,
      participantNames: action.participants ?? [],
      shares: action.shares ?? null,
      amountsPaise: action.amounts_paise ?? null,
      contextHint: action.context ?? null,
      effectiveDate: action.date ?? null,
      currency: action.currency ?? null,
      confidence: "medium",
    };
    return { kind: "draft", draft, note: "Drafted by the assistant — review before saving." };
  }

  if (action.action === "void_expense") {
    const entry = findEntry(action.entry, digest, deps);
    if (!entry) {
      return entryNotFound(deps);
    }
    return {
      kind: "confirmVoid",
      entryId: entry.entryId,
      label: entryLabel(entry),
      text: `Void ${entryLabel(entry)}? It stays in history but stops counting toward balances.`,
    };
  }

  if (action.action === "resplit_expense") {
    const entry = findEntry(action.entry, digest, deps);
    if (!entry) {
      return entryNotFound(deps);
    }
    const memberIds = deps.memberships
      .filter((membership) => membership.contextId === entry.contextId && !membership.leftAt)
      .map((membership) => membership.participantId);
    const resolved: string[] = [];
    for (const name of action.participants) {
      const participantId = resolveAgentName(name, deps, memberIds);
      if (!participantId) {
        return {
          kind: "clarify",
          text: `${name} isn't a member of that context yet — add them first (People tab, or tell me “add ${name} to ${
            deps.contexts.find((context) => context.contextId === entry.contextId)?.name ?? "the context"
          }”).`,
        };
      }
      if (!resolved.includes(participantId)) {
        resolved.push(participantId);
      }
    }
    if (resolved.length === 0) {
      return { kind: "clarify", text: "Who should share that entry?" };
    }
    // participants = who OWES a share. The ledger requires the payer to be
    // present in the allocations, but a zero share is legitimate — "Gunjan
    // owes me the whole pizza" is payer share 0, Gunjan share 100%.
    const allocations = equalAllocations(entry.totalAmount, resolved, entry.payerId);
    const payerHasShare = resolved.includes(entry.payerId);
    if (!payerHasShare) {
      allocations.push({ participantId: entry.payerId, shareAmount: 0, isPayer: true });
    }
    const nameFor = (participantId: string) =>
      participantId === deps.deviceParticipantId
        ? "you"
        : deps.participants.find((participant) => participant.participantId === participantId)?.displayName ?? "?";
    const shareParts = allocations
      .filter((allocation) => allocation.shareAmount > 0)
      .map((allocation) => `${nameFor(allocation.participantId)} ${formatMoneyIn(entry.currency ?? "INR", allocation.shareAmount)}`);
    const payerNote = payerHasShare ? "" : ` (${nameFor(entry.payerId)} paid, no share)`;
    return {
      kind: "confirmResplit",
      entryId: entry.entryId,
      label: entryLabel(entry),
      allocations,
      text: `Re-split ${entryLabel(entry)} — new shares: ${shareParts.join(", ")}${payerNote}?`,
    };
  }

  if (action.action === "edit_expense") {
    const entry = findEntry(action.entry, digest, deps);
    if (!entry) {
      return entryNotFound(deps);
    }
    const updates: {
      description?: string;
      category?: string | null;
      amountPaise?: number;
      effectiveDate?: string;
      payerId?: string;
    } = {};
    const changes: string[] = [];
    if (typeof action.description === "string" && action.description.trim()) {
      updates.description = action.description.trim();
      changes.push(`description → “${updates.description}”`);
    }
    if (typeof action.amount_paise === "number" && action.amount_paise > 0) {
      updates.amountPaise = Math.round(action.amount_paise);
      changes.push(`amount → ${formatMoneyIn(entry.currency ?? "INR", updates.amountPaise)}`);
    }
    if (typeof action.category === "string" && action.category.trim()) {
      updates.category = action.category.trim().toLowerCase();
      changes.push(`category → ${updates.category}`);
    }
    if (typeof action.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(action.date)) {
      updates.effectiveDate = action.date;
      changes.push(`date → ${action.date}`);
    }
    if (typeof action.payer === "string" && action.payer.trim()) {
      const memberIds = deps.memberships
        .filter((membership) => membership.contextId === entry.contextId && !membership.leftAt)
        .map((membership) => membership.participantId);
      const payerId = resolveAgentName(action.payer, deps, memberIds);
      if (!payerId) {
        return { kind: "clarify", text: `I don't know ${action.payer} in that context — who paid?` };
      }
      updates.payerId = payerId;
      changes.push(`payer → ${action.payer}`);
    }
    if (changes.length === 0) {
      return { kind: "clarify", text: "What should change on that entry?" };
    }
    return {
      kind: "confirmEdit",
      entryId: entry.entryId,
      label: entryLabel(entry),
      updates,
      text: `Update ${entryLabel(entry)}: ${changes.join(", ")}?`,
    };
  }

  if (action.action === "show_entries") {
    const contextId = resolveContextId(action.context, deps, digest);
    if (action.context && !contextId) {
      return { kind: "clarify", text: `I couldn't find a context called “${action.context}”.` };
    }
    const text = action.text?.trim().toLowerCase();
    const category = action.category?.trim().toLowerCase();
    const limit = Math.min(Math.max(action.limit ?? 8, 1), 12);
    const rows = deps.entries
      .filter((entry) => entry.type === "expense" && !entry.voidedAt && entry.syncState !== "rejected")
      .filter((entry) => !contextId || entry.contextId === contextId)
      .filter((entry) => !category || (entry.category ?? "").toLowerCase() === category)
      .filter((entry) => !text || (entry.description ?? "").toLowerCase().includes(text))
      .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))
      .slice(0, limit);
    if (rows.length === 0) {
      return { kind: "answer", text: "No matching entries." };
    }
    return {
      kind: "showEntries",
      entryIds: rows.map((entry) => entry.entryId),
      text: "Here's what I found — Select one to act on it, or Void directly:",
    };
  }

  if (action.action === "create_context") {
    const name = action.name.trim();
    if (!name) {
      return { kind: "clarify", text: "What should the new context be called?" };
    }
    const type = action.type === "personal" ? "personal" : "shared";
    return { kind: "confirmCreateContext", name, contextType: type, text: `Create a new ${type} context “${name}”?` };
  }

  // add_member
  const contextId =
    digest.contextIdByName[action.context.trim().toLowerCase()] ??
    deps.contexts.find((context) => context.name.toLowerCase() === action.context.trim().toLowerCase())?.contextId ??
    null;
  if (!contextId) {
    return { kind: "clarify", text: `I couldn't find a context called “${action.context}”.` };
  }
  const memberName = action.name.trim();
  if (!memberName) {
    return { kind: "clarify", text: "Who should I add?" };
  }
  const contextName = deps.contexts.find((context) => context.contextId === contextId)?.name ?? action.context;
  return {
    kind: "confirmAddMember",
    contextId,
    name: memberName,
    text: `Add ${memberName} to “${contextName}” (name-only member; you can invite their device later)?`,
  };
}

export function buildAgentDigest(deps: AssistantDeps): LedgerDigest {
  return buildLedgerDigest({
    contexts: deps.contexts,
    memberships: deps.memberships,
    participants: deps.participants,
    entries: deps.entries,
    deviceParticipantId: deps.deviceParticipantId,
  });
}

// Personal contexts are nobody else's business: when the turn will be relayed
// to a remote provider, drop them (and their entries) from what the model can
// see or look up. On-device tiers keep the full picture — the whole point of
// running locally is that the data never leaves (unified-expense-os-84x).
export function withoutPersonalContexts(deps: AssistantDeps): AssistantDeps {
  const sharedContexts = deps.contexts.filter((context) => context.type !== "personal");
  const sharedContextIds = new Set(sharedContexts.map((context) => context.contextId));
  const sharedMemberships = deps.memberships.filter((membership) => sharedContextIds.has(membership.contextId));
  // The digest names everyone this device knows, so the participant list has
  // to be narrowed too — otherwise someone who only appears in a personal
  // context would still be sent by name to a remote provider.
  const visibleParticipantIds = new Set([
    deps.deviceParticipantId,
    ...sharedMemberships.map((membership) => membership.participantId),
  ]);
  return {
    ...deps,
    contexts: sharedContexts,
    entries: deps.entries.filter((entry) => sharedContextIds.has(entry.contextId)),
    memberships: sharedMemberships,
    participants: deps.participants.filter((participant) =>
      visibleParticipantIds.has(participant.participantId),
    ),
  };
}

// ---- Tool execution ---------------------------------------------------------

function nameOf(deps: AssistantDeps, participantId: string): string {
  return participantId === deps.deviceParticipantId ? "You" : participantName(deps.participants, participantId);
}

// Stable refs: an entry surfaced by a tool keeps any ref it already has;
// new ones continue the eN sequence, extending the same digest map so a
// follow-up action can address them.
function refFor(entry: LedgerEntry, digest: LedgerDigest): string {
  for (const [ref, entryId] of Object.entries(digest.refToEntryId)) {
    if (entryId === entry.entryId) {
      return ref;
    }
  }
  const ref = `e${Object.keys(digest.refToEntryId).length + 1}`;
  digest.refToEntryId[ref] = entry.entryId;
  return ref;
}

function entryLine(entry: LedgerEntry, deps: AssistantDeps, digest: LedgerDigest): string {
  const contextName = deps.contexts.find((context) => context.contextId === entry.contextId)?.name ?? "?";
  return (
    `[${refFor(entry, digest)}] ${entry.effectiveDate} “${entry.description ?? "(no description)"}” ` +
    `${formatMoneyIn(entry.currency ?? "INR", entry.totalAmount)} in ${contextName} · paid by ${nameOf(deps, entry.payerId)}`
  );
}

function resolveContextId(name: string | null | undefined, deps: AssistantDeps, digest: LedgerDigest): string | null {
  if (!name?.trim()) {
    return null;
  }
  return (
    digest.contextIdByName[name.trim().toLowerCase()] ??
    deps.contexts.find((context) => context.name.toLowerCase() === name.trim().toLowerCase())?.contextId ??
    null
  );
}

// Execute a read-only lookup against the local ledger and return compact
// text for the model. Total: bad arguments produce a readable message the
// model can react to, never a throw.
export function executeAgentTool(call: AgentToolCall, deps: AssistantDeps, digest: LedgerDigest): string {
  const live = deps.entries.filter(
    (entry) => entry.type === "expense" && !entry.voidedAt && entry.syncState !== "rejected",
  );

  if (call.tool === "search_entries" || call.tool === "list_entries") {
    const contextId = resolveContextId("context" in call ? call.context : null, deps, digest);
    if ("context" in call && call.context && !contextId) {
      return `No context named “${call.context}”.`;
    }
    const text = call.tool === "search_entries" ? call.text?.trim().toLowerCase() : undefined;
    const category = call.tool === "search_entries" ? call.category?.trim().toLowerCase() : undefined;
    const limit = Math.min(Math.max(call.limit ?? 10, 1), 15);
    const rows = live
      .filter((entry) => !contextId || entry.contextId === contextId)
      .filter((entry) => !category || (entry.category ?? "").toLowerCase() === category)
      .filter((entry) => !text || (entry.description ?? "").toLowerCase().includes(text))
      .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))
      .slice(0, limit);
    if (rows.length === 0) {
      return "No matching entries.";
    }
    return rows.map((entry) => entryLine(entry, deps, digest)).join("\n");
  }

  if (call.tool === "get_balances") {
    const onlyContextId = resolveContextId(call.context, deps, digest);
    const lines: string[] = [];
    for (const context of deps.contexts) {
      if (context.type !== "shared" || context.archivedAt || context.closedAt) {
        continue;
      }
      if (onlyContextId && context.contextId !== onlyContextId) {
        continue;
      }
      const contextEntries = live.filter((entry) => entry.contextId === context.contextId);
      const { primaryEntries, primaryCurrency } = partitionByCurrency(contextEntries);
      const rows = deriveBalances(
        primaryEntries,
        deps.participants,
        deps.memberships.filter((membership) => membership.contextId === context.contextId),
      ).filter((row) => row.netBalance !== 0);
      lines.push(
        rows.length === 0
          ? `${context.name}: all settled`
          : `${context.name}: ${rows
              .map((row) =>
                row.netBalance < 0
                  ? `${nameOf(deps, row.participantId)} owes ${formatMoneyIn(primaryCurrency, -row.netBalance)}`
                  : `${nameOf(deps, row.participantId)} is owed ${formatMoneyIn(primaryCurrency, row.netBalance)}`,
              )
              .join(", ")}`,
      );
    }
    return lines.length > 0 ? lines.join("\n") : "No shared contexts with entries.";
  }

  // spend_summary — report in the ledger's primary currency rather than
  // labelling every total as rupees, and never sum across currencies
  // (unified-expense-os-crh).
  const frame: TimeFrame = call.timeframe === "week" ? "week" : call.timeframe === "year" ? "year" : "month";
  const range = timeFrameRange(frame);
  const { primaryEntries, primaryCurrency, otherEntries } = partitionByCurrency(live);
  const summary = reportSummary(primaryEntries, deps.participants, deps.memberships, range);
  const money = (amount: number) => formatMoneyIn(primaryCurrency, amount);
  const lines = [`Total spend (${frame}): ${money(summary.totalSpent)}`];
  if (otherEntries.length > 0) {
    lines.push(`(excludes ${otherEntries.length} entries in other currencies)`);
  }
  const category = call.category?.trim().toLowerCase();
  for (const row of summary.byCategory) {
    if (!category || row.category === category) {
      lines.push(`- ${row.category}: ${money(row.total)} (${row.count})`);
    }
  }
  const person = call.person?.trim().toLowerCase();
  if (person) {
    for (const row of summary.byMember) {
      const rowName = nameOf(deps, row.participantId).toLowerCase();
      if (rowName === person || rowName.startsWith(person)) {
        lines.push(`- ${nameOf(deps, row.participantId)} paid ${money(row.spent)}`);
      }
    }
  }
  return lines.join("\n");
}

// ---- The agent loop ---------------------------------------------------------

const MAX_TOOL_ROUNDS = 3;

// Drive one assistant turn against a text-in/text-out generator (any tier):
// model may look things up a few times, then must produce an action. The
// generator throwing propagates so the caller can fall to the next tier.
export async function runAgentLoop(
  generate: (prompt: string) => Promise<string | null>,
  messages: ChatMessage[],
  deps: AssistantDeps,
  options: { remote?: boolean } = {},
): Promise<AssistantTurn | null> {
  // What the model may see and look up. A remote tier gets the shared-context
  // subset; resolution of the resulting action still runs against the full
  // deps on-device.
  const visible = options.remote ? withoutPersonalContexts(deps) : deps;
  const digest = buildAgentDigest(visible);
  let prompt = buildAgentPrompt(messages, digest);
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const raw = await generate(prompt);
    if (raw === null) {
      return null;
    }
    const reply = parseAgentReply(raw);
    if (reply.type === "action") {
      // An action naming an entry this device can't resolve used to dead-end
      // the turn, so rephrasing produced the identical reply. Tell the model
      // what went wrong and let it correct itself (search, or add_expense if
      // the expense is new) before we fall back to asking the user.
      const badRef = unresolvedEntryRef(reply.action, deps, digest);
      if (badRef !== null && round < MAX_TOOL_ROUNDS) {
        prompt +=
          `\n${JSON.stringify(reply.action)}\nERROR: there is no entry “${badRef}” in this ledger. ` +
          "Use an [eN] ref shown above, call search_entries to find the entry, or — if the user is " +
          "describing a new expense — use add_expense instead.\nJSON:";
        continue;
      }
      return agentActionToTurn(reply.action, deps, digest);
    }
    if (round === MAX_TOOL_ROUNDS) {
      break;
    }
    const result = executeAgentTool(reply.call, visible, digest);
    prompt += `\n${JSON.stringify(reply.call)}\nTOOL RESULT:\n${result}\nJSON:`;
  }
  return { kind: "clarify", text: "I couldn't settle on an answer — could you rephrase?" };
}
