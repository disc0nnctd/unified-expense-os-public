import { runAgentLoop } from "./agent";
import { agentTextViaLlm, chatIntentViaLlm, draftCaptureViaLlm, type ChatIntentResponse, type ChatMessage, type LlmCaptureDraft } from "./api";
import { formatMoneyIn } from "./currencies";
import { emptyDraft, resolveContextName, type ExpenseDraft } from "./expenseDraft";
import { answerBalanceQuestion, answerQuestion } from "./qa";
import { parseSpokenExpense } from "./voiceGrammar";
import { generateLocal, isLocalModelReady } from "./localLlm";
import { getAssistantLlmFirst, getPhoneEndpoint } from "./prefs";
import type { Allocation, ContextRecord, LedgerEntry, Membership, Participant } from "../types";

// Assistant orchestration (unified-expense-os-kct): one message in, one
// structured turn out. Tiered, strictly in this order:
//
//   1. Deterministic ledger Q&A (lib/qa.ts) — the ONLY thing that computes
//      numbers, ever. Models never do arithmetic over the ledger.
//   2. Deterministic expense grammar (lib/voiceGrammar.ts) — shared with
//      voice capture, so speaking and typing parse identically.
//   3. On-device local model (lib/localLlm.ts), when the user has loaded
//      one — private, works offline, no server round-trip.
//   4. Server LLM (/capture/chat-intent), when the user has opted in.
//
// Tiers 3–4 only ever return an intent: a query for tier 1 to compute, or a
// draft the user reviews. Neither can write to the ledger.

export type NavTarget =
  | { kind: "context"; contextId: string; tab?: "expenses" | "balances" | "reports" | "assistant" | "people" }
  | { kind: "settings" }
  | { kind: "home" };

export type AssistantTurn =
  | { kind: "answer"; text: string }
  | { kind: "draft"; draft: ExpenseDraft; note: string }
  | { kind: "navigate"; target: NavTarget; text: string }
  // Mutations are always confirm cards, never immediate: the assistant
  // proposes, the user taps to apply.
  | { kind: "confirmVoid"; entryId: string; label: string; text: string }
  | { kind: "confirmResplit"; entryId: string; label: string; allocations: Allocation[]; text: string }
  | {
      kind: "confirmEdit";
      entryId: string;
      label: string;
      updates: { description?: string; category?: string | null; amountPaise?: number; effectiveDate?: string; payerId?: string };
      text: string;
    }
  | { kind: "confirmCreateContext"; name: string; contextType: "personal" | "shared"; text: string }
  | { kind: "confirmAddMember"; contextId: string; name: string; text: string }
  // Tappable entry list — the user selects a row to act on it (or voids it
  // directly from the row via the usual confirm card).
  | { kind: "showEntries"; entryIds: string[]; text: string }
  | { kind: "clarify"; text: string }
  | { kind: "none"; text: string };

export type AssistantDeps = {
  entries: LedgerEntry[];
  participants: Participant[];
  memberships: Membership[];
  contexts: ContextRecord[];
  deviceParticipantId: string;
  serverLlmEnabled: boolean;
};

const HELP_TEXT =
  "I can answer questions like “how much did we spend on groceries this month?” or “how much do I owe?”, draft expenses from phrases like “450 dinner in Flat split equally with Isha”, and navigate — try “open Flat balances” or “go to settings”. Drafts are always shown for review — nothing is saved until you confirm.";

const TAB_WORDS: Record<string, NonNullable<Extract<NavTarget, { kind: "context" }>["tab"]>> = {
  expenses: "expenses",
  ledger: "expenses",
  balances: "balances",
  balance: "balances",
  reports: "reports",
  report: "reports",
  assistant: "assistant",
  chat: "assistant",
  people: "people",
  members: "people",
};

// Deterministic navigation grammar: "open <context> [tab]", "go to settings",
// "show <context> balances". Pure UI intent — nothing is written, so no
// review step is needed; navigation stays deterministic-only (models never
// pick the destination).
export function parseNavigation(text: string, contexts: ContextRecord[]): NavTarget | null {
  const match = text
    .trim()
    .toLowerCase()
    .match(/^(?:open|go to|goto|show|take me to|switch to)\s+(.{2,60})$/);
  if (!match) {
    return null;
  }
  let rest = match[1].replace(/[.,!?]+$/, "").replace(/^(?:the|my)\s+/, "").trim();
  if (rest === "settings" || rest === "setting") {
    return { kind: "settings" };
  }
  // "all contexts" stays accepted alongside "all groups": the UI noun
  // changed, but anyone who learned the old phrasing shouldn't be broken.
  if (rest === "home" || rest === "all contexts" || rest === "all groups") {
    return { kind: "home" };
  }
  let tab: Extract<NavTarget, { kind: "context" }>["tab"] | undefined;
  const tabMatch = rest.match(/\s+([a-z]+)$/);
  if (tabMatch && TAB_WORDS[tabMatch[1]]) {
    tab = TAB_WORDS[tabMatch[1]];
    rest = rest.slice(0, tabMatch.index).trim();
  }
  const contextId = resolveContextName(rest, contexts);
  if (contextId) {
    return { kind: "context", contextId, tab };
  }
  // "open balances" with no context name is a tab-only ask; callers scoped to
  // a context can interpret it, global scope cannot.
  if (!rest && tab) {
    return null;
  }
  return null;
}

// Deterministic void/delete request: "delete last pizza expense", "remove
// the cab entry", "undo that". Resolves against the (already scope-filtered)
// entries; a description fragment narrows the match, otherwise the most
// recent expense wins. Only ever RETURNS a candidate — the caller renders a
// confirm card and the user does the voiding.
export function parseVoidRequest(
  text: string,
  entries: LedgerEntry[],
): { entryId: string; label: string } | null {
  const match = text
    .trim()
    .toLowerCase()
    .match(/^(?:delete|remove|void|undo)\s+(?:the\s+|my\s+|that\s+)?(?:last|latest|previous|recent)?\s*(.*?)\s*(?:expense|entry|transaction)?\s*[.,!?]*$/);
  if (!match) {
    return null;
  }
  let fragment = (match[1] ?? "").trim();
  if (fragment === "it" || fragment === "that" || fragment === "this") {
    fragment = "";
  }
  const candidates = entries
    .filter((entry) => entry.type === "expense" && !entry.voidedAt && entry.syncState !== "rejected")
    .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));
  const found = fragment
    ? candidates.find(
        (entry) =>
          (entry.description ?? "").toLowerCase().includes(fragment) ||
          (entry.category ?? "").toLowerCase().includes(fragment),
      )
    : candidates[0];
  if (!found) {
    return null;
  }
  const label = `“${found.description ?? "expense"}” (${formatMoneyIn(found.currency ?? "INR", found.totalAmount)}, ${found.effectiveDate})`;
  return { entryId: found.entryId, label };
}

export function draftFromLlm(payload: LlmCaptureDraft): ExpenseDraft {
  return {
    ...emptyDraft(),
    description: payload.description ?? null,
    amountPaise: payload.amount_paise ?? null,
    category: payload.category ?? null,
    payerName: payload.payer ?? null,
    splitMode: payload.split_mode ?? null,
    participantNames: payload.participants ?? [],
    shares: payload.shares ?? null,
    amountsPaise: payload.amounts_paise ?? null,
    contextHint: payload.context_hint ?? null,
    effectiveDate: payload.date ?? null,
    currency: payload.currency ?? null,
    confidence: "medium",
  };
}

// The local model reuses the server's contract: same closed intent
// vocabulary, same JSON shape, so parseIntentJson handles both.
export function buildLocalIntentPrompt(
  messages: ChatMessage[],
  participantNames: string[],
  categoryNames: string[],
): string {
  const transcript = messages
    .slice(-6)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n");
  return (
    "You convert a chat about shared expenses into ONE minified JSON object and nothing else.\n" +
    'Schema: {"intent":"query_ledger|draft_expense|void_expense|clarify|none","draft":{"description":str|null,"amount_paise":int|null,"category":str|null,"payer":str|null,"split_mode":"equal|shares|custom"|null,"shares":{name:num}|null,"amounts_paise":{name:int}|null,"currency":"INR|USD|EUR|GBP"|null}|null,"query":{"metric":"total_spend|category_spend|member_spend|owed_to_me|i_owe|balances_breakdown"|null,"timeframe":"week|month|year"|null,"category":str|null,"person":str|null}|null,"void_target":str|null,"clarify_question":str|null}\n' +
    "Rules: never compute totals or balances yourself — use intent query_ledger and let the app compute. " +
    "void_expense = user wants to delete/remove/undo a saved expense; put their words for which one in void_target. " +
    "Use only these people names: " +
    (participantNames.join(", ") || "(none)") +
    ". Categories: " +
    (categoryNames.join(", ") || "(none)") +
    ". Amounts are integer paise (₹1 = 100). If unsure, use intent clarify.\n" +
    transcript +
    "\nJSON:"
  );
}

// A user-configured OpenAI-compatible endpoint the device reaches directly
// (Termux+Ollama, llama.cpp server, LAN box). Same closed-intent contract as
// every other tier: one prompt in, strict JSON out, parsed by parseIntentJson.
export async function generateViaPhoneEndpoint(prompt: string): Promise<string | null> {
  const endpoint = getPhoneEndpoint();
  if (!endpoint?.enabled) {
    return null;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (endpoint.apiKey) {
    headers.Authorization = `Bearer ${endpoint.apiKey}`;
  }
  const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: endpoint.model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      max_tokens: 400,
    }),
  });
  if (!response.ok) {
    throw new Error(`endpoint_${response.status}`);
  }
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? null;
}

export function phoneEndpointEnabled(): boolean {
  return !!getPhoneEndpoint()?.enabled;
}

// Total parser: any malformed model output degrades to clarify, never throws.
export function parseIntentJson(raw: string): ChatIntentResponse {
  const clarify: ChatIntentResponse = {
    intent: "clarify",
    draft: null,
    query: null,
    clarify_question: "Could you rephrase that? For example: “450 dinner split equally with Isha”.",
    reply: null,
  };
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return clarify;
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<ChatIntentResponse>;
    const intents = ["query_ledger", "draft_expense", "draft_settlement", "draft_recurring", "void_expense", "clarify", "none"];
    if (!parsed.intent || !intents.includes(parsed.intent)) {
      return clarify;
    }
    return {
      intent: parsed.intent,
      draft: parsed.intent.startsWith("draft_") ? (parsed.draft ?? null) : null,
      query: parsed.intent === "query_ledger" ? (parsed.query ?? null) : null,
      clarify_question: parsed.clarify_question ?? clarify.clarify_question,
      reply: parsed.reply ?? null,
      void_target: parsed.intent === "void_expense" ? (parsed.void_target ?? null) : null,
    };
  } catch {
    return clarify;
  }
}

// Turn a structured query intent back into a question the deterministic
// engine already parses — the model routes, qa.ts computes.
function questionFromQuery(query: NonNullable<ChatIntentResponse["query"]>): string {
  const frame = query.timeframe === "week" ? "this week" : query.timeframe === "year" ? "this year" : "this month";
  // The server tier copies the user's own words into metric, so match
  // loosely; the local tiers emit the exact vocabulary.
  const metric = (query.metric ?? "").toLowerCase();
  if (metric === "balances_breakdown" || /who owes|breakdown|everyone/.test(metric)) {
    return "who owes how much";
  }
  if (query.metric === "owed_to_me") {
    return "how much am i owed";
  }
  if (query.metric === "i_owe") {
    return "how much do i owe";
  }
  if (query.metric === "category_spend" && query.category) {
    return `how much did we spend on ${query.category} ${frame}`;
  }
  if (query.metric === "member_spend" && query.person) {
    return `how much did ${query.person} spend ${frame}`;
  }
  return `how much did we spend ${frame}`;
}

function tryDeterministicAnswer(text: string, deps: AssistantDeps): AssistantTurn | null {
  const balance = answerBalanceQuestion(
    text,
    deps.contexts,
    deps.memberships,
    deps.entries,
    deps.participants,
    deps.deviceParticipantId,
  );
  if (balance) {
    return { kind: "answer", text: balance.text };
  }
  const answer = answerQuestion(text, deps.entries, deps.participants, deps.memberships);
  if (answer) {
    return { kind: "answer", text: answer.text };
  }
  return null;
}

function intentToTurn(response: ChatIntentResponse, deps: AssistantDeps, via: string): AssistantTurn {
  if (response.intent === "query_ledger" && response.query) {
    const rewritten = tryDeterministicAnswer(questionFromQuery(response.query), deps);
    if (rewritten) {
      return rewritten;
    }
    return { kind: "clarify", text: "I couldn't compute that from the ledger — try asking about spend, or who owes whom." };
  }
  if (response.intent === "draft_expense" && response.draft) {
    return { kind: "draft", draft: draftFromLlm(response.draft), note: `Drafted ${via} — review before saving.` };
  }
  if (response.intent === "void_expense") {
    // The model only names the entry in words; resolution happens here
    // against the local ledger and the user still confirms.
    const request = parseVoidRequest(`delete ${response.void_target ?? ""}`, deps.entries);
    if (request) {
      return {
        kind: "confirmVoid",
        entryId: request.entryId,
        label: request.label,
        text: `Void ${request.label}? It stays in history but stops counting toward balances.`,
      };
    }
    return { kind: "clarify", text: "I couldn't find a matching expense to remove — which one did you mean?" };
  }
  if (response.intent === "clarify") {
    return { kind: "clarify", text: response.clarify_question ?? "Could you rephrase that?" };
  }
  if (response.reply) {
    return { kind: "none", text: response.reply };
  }
  return { kind: "none", text: HELP_TEXT };
}

// Question-shaped messages must never reach the expense grammar, which would
// happily turn "how much did the pizza cost" into a ₹-something draft. Shared
// by the normal tier ordering and the AI-first fallback — the fallback used to
// omit it, so with the network down a spoken question became a draft card
// (unified-expense-os-evb). Voice transcripts rarely carry a "?", so the
// leading-word list is what actually does the work there.
export function isQuestionShaped(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^(?:who|whom|whose|what|how|when|where|which|why|did|do|does|am|are|is|was|were|can|could|should)\b/i.test(
      trimmed,
    ) || /\?\s*$/.test(trimmed)
  );
}

export async function runAssistantTurn(
  messages: ChatMessage[],
  deps: AssistantDeps,
): Promise<AssistantTurn> {
  const latest = messages[messages.length - 1]?.content ?? "";
  if (!latest.trim()) {
    return { kind: "none", text: HELP_TEXT };
  }

  // Tier 0: deterministic navigation ("open Flat balances", "go to settings").
  const nav = parseNavigation(latest, deps.contexts);
  if (nav) {
    const label =
      nav.kind === "context"
        ? `Opening ${deps.contexts.find((context) => context.contextId === nav.contextId)?.name ?? "context"}${nav.tab ? ` → ${nav.tab}` : ""}…`
        : nav.kind === "settings"
          ? "Opening settings…"
          : "Going home…";
    return { kind: "navigate", target: nav, text: label };
  }

  // Tier 0.4: "show/list recent transactions" — a browse command; renders a
  // tappable list the user selects from (unified-expense-os-5kp follow-up).
  if (/^(?:show|list)\b.*\b(?:transactions?|expenses?|entries)\b/i.test(latest.trim())) {
    const recent = deps.entries
      .filter((entry) => entry.type === "expense" && !entry.voidedAt && entry.syncState !== "rejected")
      .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))
      .slice(0, 8);
    if (recent.length === 0) {
      return { kind: "none", text: "No expenses yet." };
    }
    return {
      kind: "showEntries",
      entryIds: recent.map((entry) => entry.entryId),
      text: "Recent expenses — Select one to act on it, or Void directly:",
    };
  }

  // Tier 0.5: deterministic delete/void — a precise command shape, always
  // active (like navigation). Only ever proposes; the user confirms.
  const voidRequest = parseVoidRequest(latest, deps.entries);
  if (voidRequest) {
    return {
      kind: "confirmVoid",
      entryId: voidRequest.entryId,
      label: voidRequest.label,
      text: `Void ${voidRequest.label}? It stays in history but stops counting toward balances.`,
    };
  }

  // AI-first / agent mode (unified-expense-os-5kp): the model sees a ledger
  // digest and returns one structured action; the app resolves refs/names,
  // computes any split arithmetic, and renders confirm cards for mutations.
  // Deterministic parsing becomes the fallback, not the gatekeeper.
  const llmFirst =
    getAssistantLlmFirst() &&
    (phoneEndpointEnabled() || deps.serverLlmEnabled || (await isLocalModelReady()));
  if (llmFirst) {
    // Tier cascade of text-in/text-out generators; the agent loop (with
    // ledger lookup tools) runs on the first one that works.
    // `remote` marks tiers whose prompt leaves this device, so the agent loop
    // can narrow what the model sees (unified-expense-os-84x). The phone
    // endpoint is the user's own machine on their own network, so it is
    // treated as local.
    const generators: { generate: (prompt: string) => Promise<string | null>; remote: boolean }[] = [];
    if (phoneEndpointEnabled()) {
      generators.push({ generate: (prompt) => generateViaPhoneEndpoint(prompt), remote: false });
    }
    if (await isLocalModelReady()) {
      generators.push({ generate: (prompt) => generateLocal(prompt, 512), remote: false });
    }
    if (deps.serverLlmEnabled) {
      generators.push({ generate: (prompt) => agentTextViaLlm(prompt), remote: true });
    }
    for (const { generate, remote } of generators) {
      try {
        const turn = await runAgentLoop(generate, messages, deps, { remote });
        if (turn) {
          return turn;
        }
      } catch {
        // This tier is down mid-loop — restart the turn on the next tier.
      }
    }
    // Every agent tier failed: deterministic fallback rather than silence.
    const fallbackAnswer = tryDeterministicAnswer(latest, deps);
    if (fallbackAnswer) {
      return fallbackAnswer;
    }
    const fallbackParsed = isQuestionShaped(latest) ? null : parseSpokenExpense(latest);
    if (fallbackParsed && fallbackParsed.amountPaise !== null) {
      return { kind: "draft", draft: fallbackParsed, note: "Drafted from your message — review before saving." };
    }
    return {
      kind: "none",
      text: "The AI tier isn't reachable right now, and I couldn't parse that deterministically. Try again, or use a set phrasing like “450 dinner split equally”.",
    };
  }

  // Tier 1: deterministic Q&A — the only calculator.
  const answered = tryDeterministicAnswer(latest, deps);
  if (answered) {
    return answered;
  }

  // Question-shaped messages tier 1 couldn't answer should reach the LLM
  // router (which maps fuzzier phrasings back onto tier 1's calculators) —
  // never the expense grammar.
  const questionShaped = isQuestionShaped(latest);

  // Tier 2: deterministic expense grammar (same one voice uses).
  const parsed = questionShaped ? null : parseSpokenExpense(latest);
  if (parsed && parsed.amountPaise !== null) {
    return { kind: "draft", draft: parsed, note: "Drafted from your message — review before saving." };
  }

  const participantNames = deps.participants.map((participant) => participant.displayName);
  const categoryNames = Array.from(
    new Set(deps.entries.map((entry) => entry.category?.trim().toLowerCase()).filter((value): value is string => !!value)),
  );

  // Tier 3a: an endpoint the device reaches directly (Termux Ollama etc.) —
  // explicit user configuration, so it outranks the embedded model.
  if (phoneEndpointEnabled()) {
    try {
      const raw = await generateViaPhoneEndpoint(buildLocalIntentPrompt(messages, participantNames, categoryNames));
      if (raw !== null) {
        return intentToTurn(parseIntentJson(raw), deps, "by your local endpoint");
      }
    } catch {
      // Endpoint down — fall through to the embedded model / server tiers.
    }
  }

  // Tier 3b: the embedded on-device model, if the user has loaded one.
  if (await isLocalModelReady()) {
    try {
      const raw = await generateLocal(buildLocalIntentPrompt(messages, participantNames, categoryNames));
      return intentToTurn(parseIntentJson(raw), deps, "on-device");
    } catch {
      // Local inference failed — fall through to the server tier (if enabled).
    }
  }

  // Tier 4: opt-in server LLM.
  if (deps.serverLlmEnabled) {
    try {
      const response = await chatIntentViaLlm({
        messages,
        contextNames: deps.contexts.map((context) => context.name),
        participantNames,
        categoryNames,
      });
      return intentToTurn(response, deps, "by the server model");
    } catch {
      return {
        kind: "none",
        text: "The server AI isn't reachable right now. Deterministic answers still work — try “how much did we spend this month?”",
      };
    }
  }

  if (parsed) {
    return { kind: "clarify", text: "I caught part of that but no amount. Try including one, e.g. “450 dinner split equally”." };
  }
  if (questionShaped) {
    return {
      kind: "none",
      text:
        "I can answer that kind of question with an AI tier enabled — Settings → AI & assist (on-device model, local endpoint, or server AI). " +
        "Without one I handle set phrasings like “how much do I owe?”, “who owes how much?”, or “how much did we spend on groceries this month?”.",
    };
  }
  return { kind: "none", text: HELP_TEXT };
}

// One-shot draft via the model tiers only (local first, then opt-in server),
// for callers that already ran the deterministic grammar themselves — e.g.
// the Add Expense mic escalating a transcript the grammar couldn't parse.
// Returns null when no tier is available/able; never throws.
export async function draftViaLlmTiers(
  text: string,
  participantNames: string[],
  categoryNames: string[],
  serverLlmEnabled: boolean,
): Promise<ExpenseDraft | null> {
  const prompt = buildLocalIntentPrompt([{ role: "user", content: text }], participantNames, categoryNames);
  if (phoneEndpointEnabled()) {
    try {
      const raw = await generateViaPhoneEndpoint(prompt);
      if (raw !== null) {
        const parsed = parseIntentJson(raw);
        if (parsed.intent === "draft_expense" && parsed.draft) {
          return draftFromLlm(parsed.draft);
        }
      }
    } catch {
      // Endpoint down — fall through.
    }
  }
  if (await isLocalModelReady()) {
    try {
      const raw = await generateLocal(prompt);
      const parsed = parseIntentJson(raw);
      if (parsed.intent === "draft_expense" && parsed.draft) {
        return draftFromLlm(parsed.draft);
      }
    } catch {
      // Local inference failed — fall through to the server tier.
    }
  }
  if (serverLlmEnabled) {
    try {
      return draftFromLlm(await draftCaptureViaLlm(text));
    } catch {
      return null;
    }
  }
  return null;
}
