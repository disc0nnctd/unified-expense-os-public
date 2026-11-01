import { FormEvent, useEffect, useRef, useState } from "react";
import {
  addNamedMember,
  createContext,
  editExpense,
  resplitExpense,
  voidExpense,
  type ChatMessage,
} from "../lib/api";
import type { Allocation } from "../types";
import { formatMoneyIn } from "../lib/currencies";
import { runAssistantTurn, type AssistantTurn, type NavTarget } from "../lib/assistant";
import { humanizeError } from "../lib/errors";
import { isLocalOnly } from "../lib/localMode";
import {
  getAssistantLlmFirst,
  getServerLlmEnabled,
  setAssistantLlmFirst,
  setServerLlmEnabled,
} from "../lib/prefs";
import { resolveContextName, type ExpenseDraft } from "../lib/expenseDraft";
import type { ContextRecord, LedgerEntry, Membership, Participant } from "../types";
import DraftReviewCard from "./DraftReviewCard";
import VoiceCaptureButton from "./VoiceCaptureButton";

type Props = {
  // null = global assistant (whole snapshot); a contextId scopes answers and
  // fixes drafts to that context.
  scopeContextId: string | null;
  participants: Participant[];
  memberships: Membership[];
  contexts: ContextRecord[];
  entries: LedgerEntry[];
  deviceParticipantId: string;
  online: boolean;
  refresh: () => Promise<void>;
  requestSync: () => void;
  onNavigate?: (target: NavTarget) => void;
};

type EditUpdates = {
  description?: string;
  category?: string | null;
  amountPaise?: number;
  effectiveDate?: string;
  payerId?: string;
};

export type Bubble =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; text: string }
  | { id: number; role: "draft"; draft: ExpenseDraft; note: string; initialContextId: string | null; resolved: string | null }
  | { id: number; role: "confirmVoid"; entryId: string; label: string; text: string; resolved: string | null }
  | { id: number; role: "confirmResplit"; entryId: string; allocations: Allocation[]; text: string; resolved: string | null }
  | { id: number; role: "confirmEdit"; entryId: string; updates: EditUpdates; text: string; resolved: string | null }
  | { id: number; role: "confirmCreateContext"; name: string; contextType: "personal" | "shared"; text: string; resolved: string | null }
  | { id: number; role: "confirmAddMember"; contextId: string; name: string; text: string; resolved: string | null }
  | { id: number; role: "entryList"; entryIds: string[]; text: string };

const CONFIRM_ROLES = ["confirmVoid", "confirmResplit", "confirmEdit", "confirmCreateContext", "confirmAddMember"];

// Conversations persist per scope (global / each context) in localStorage —
// device-local like every preference, never server-side. Capped so an old
// chat can't crowd the storage quota.
const CHAT_HISTORY_LIMIT = 80;

function chatStorageKey(scopeContextId: string | null): string {
  return `expense-os-chat-${scopeContextId ?? "global"}`;
}

function loadBubbles(key: string): Bubble[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (bubble): bubble is Bubble =>
        bubble && typeof bubble.id === "number" && ["user", "assistant", "draft", "entryList", ...CONFIRM_ROLES].includes(bubble.role),
    );
  } catch {
    return [];
  }
}

function draftSummary(draft: ExpenseDraft): string {
  const amount = draft.amountPaise === null ? "(no amount)" : formatMoneyIn(draft.currency ?? "INR", draft.amountPaise);
  const who = draft.participantNames.length > 0 ? ` between ${draft.participantNames.join(", ")}` : "";
  const mode = draft.splitMode ? ` split ${draft.splitMode}` : "";
  return `“${draft.description ?? "expense"}” ${amount}${mode}${who}`;
}

// What the assistant proposed is part of the conversation. Only the plain
// text bubbles used to reach the model, so a draft, a confirm card or a
// pick-list vanished from the next turn's history and follow-ups like
// "make it 300" or "the second one" arrived with no antecedent. Every
// bubble now contributes one line, including how it was resolved.
export function bubbleToMessage(bubble: Bubble, entries: LedgerEntry[]): ChatMessage | null {
  if (bubble.role === "user" || bubble.role === "assistant") {
    return { role: bubble.role, content: bubble.text };
  }
  if (bubble.role === "entryList") {
    const labels = bubble.entryIds
      .map((entryId) => entries.find((entry) => entry.entryId === entryId))
      .filter((entry): entry is LedgerEntry => !!entry)
      .map((entry) => `“${entry.description ?? "expense"}” ${formatMoneyIn(entry.currency ?? "INR", entry.totalAmount)} (${entry.effectiveDate})`);
    if (labels.length === 0) {
      return null;
    }
    return { role: "assistant", content: `Showed these entries to pick from: ${labels.join("; ")}.` };
  }
  const outcome = bubble.resolved ?? "Awaiting the user's decision.";
  if (bubble.role === "draft") {
    return { role: "assistant", content: `Proposed a new expense: ${draftSummary(bubble.draft)}. ${outcome}` };
  }
  return { role: "assistant", content: `${bubble.text} ${outcome}` };
}

// Multi-turn assistant (unified-expense-os-kct/n23). Conversation state is
// device-local; nothing is stored server-side. The deterministic tiers in
// lib/assistant.ts answer most turns; models (local or opt-in server) only
// route intents. Drafts render as inline review cards — saving one goes
// through queueExpense like any manual entry. In global scope, drafts
// resolve their "in <context>" hint to a target the user can still change.
export default function ChatPanel({
  scopeContextId,
  participants,
  memberships,
  contexts,
  entries,
  deviceParticipantId,
  online,
  refresh,
  requestSync,
  onNavigate,
}: Props) {
  const storageKey = chatStorageKey(scopeContextId);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // Mirrors the Settings consent pref so toggling in either place stays in
  // sync; read fresh per turn in send() regardless.
  const [serverLlm, setServerLlm] = useState(() => getServerLlmEnabled());
  // AI-first: the model tiers interpret messages before the built-in
  // parsers (which remain the fallback and always do the arithmetic).
  const [llmFirst, setLlmFirst] = useState(() => getAssistantLlmFirst());
  // The AI toggles live in a header disclosure rather than in the thread.
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Which scope's history the current bubbles belong to — guards the save
  // effect from writing the old scope's bubbles into a new scope's key when
  // the panel is retargeted without remounting (context → context).
  const hydratedKey = useRef<string | null>(null);

  useEffect(() => {
    const loaded = loadBubbles(storageKey);
    hydratedKey.current = storageKey;
    setBubbles(loaded);
    nextId.current = loaded.length > 0 ? Math.max(...loaded.map((bubble) => bubble.id)) + 1 : 1;
  }, [storageKey]);

  useEffect(() => {
    if (hydratedKey.current !== storageKey) {
      return;
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(bubbles.slice(-CHAT_HISTORY_LIMIT)));
    } catch {
      // Quota exceeded — chat keeps working, just without persistence.
    }
  }, [bubbles, storageKey]);

  function clearChat() {
    setBubbles([]);
    localStorage.removeItem(storageKey);
  }

  // Stick to the bottom as the conversation grows — but only if the user is
  // already there. Scrolling someone back down while they're reading history
  // is worse than not following at all.
  //
  // Keyed on the whole bubble list, not its length: a draft or confirm card
  // resolving in place changes a bubble's height without adding one, and the
  // old length-only dependency left those replies scrolled out of view. The
  // busy flag is here for the same reason — "Thinking…" renders outside the
  // list, so nothing else would follow it.
  const stickToBottom = useRef(true);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  useEffect(() => {
    if (!stickToBottom.current) {
      return;
    }
    const el = scrollRef.current;
    el?.scrollTo({ top: el.scrollHeight });
  }, [bubbles, busy]);

  type BubbleInput = Omit<Extract<Bubble, { role: "user" }>, "id">
    | Omit<Extract<Bubble, { role: "assistant" }>, "id">
    | Omit<Extract<Bubble, { role: "draft" }>, "id">
    | Omit<Extract<Bubble, { role: "confirmVoid" }>, "id">
    | Omit<Extract<Bubble, { role: "confirmResplit" }>, "id">
    | Omit<Extract<Bubble, { role: "confirmEdit" }>, "id">
    | Omit<Extract<Bubble, { role: "confirmCreateContext" }>, "id">
    | Omit<Extract<Bubble, { role: "confirmAddMember" }>, "id">
    | Omit<Extract<Bubble, { role: "entryList" }>, "id">;

  function pushBubble(bubble: BubbleInput) {
    setBubbles((current) => [...current, { ...bubble, id: nextId.current++ }]);
  }

  // Most recently used context as the draft fallback in global scope.
  function recentContextId(): string | null {
    const open = new Set(
      contexts.filter((context) => !context.archivedAt && !context.closedAt).map((context) => context.contextId),
    );
    const sorted = [...entries].sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));
    for (const entry of sorted) {
      if (open.has(entry.contextId)) {
        return entry.contextId;
      }
    }
    return null;
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) {
      return;
    }
    setInput("");
    setVoiceError(null);
    pushBubble({ role: "user", text: trimmed });
    setBusy(true);
    try {
      const history: ChatMessage[] = [
        ...bubbles
          .map((bubble) => bubbleToMessage(bubble, entries))
          .filter((message): message is ChatMessage => message !== null),
        { role: "user" as const, content: trimmed },
      ];
      const turn: AssistantTurn = await runAssistantTurn(history, {
        entries,
        participants,
        memberships,
        contexts,
        deviceParticipantId,
        serverLlmEnabled: getServerLlmEnabled(),
      });
      if (turn.kind === "draft") {
        const hinted = turn.draft.contextHint ? resolveContextName(turn.draft.contextHint, contexts) : null;
        pushBubble({
          role: "draft",
          draft: turn.draft,
          note: turn.note,
          initialContextId: scopeContextId ?? hinted ?? recentContextId(),
          resolved: null,
        });
      } else if (turn.kind === "confirmVoid") {
        pushBubble({ role: "confirmVoid", entryId: turn.entryId, label: turn.label, text: turn.text, resolved: null });
      } else if (turn.kind === "confirmResplit") {
        pushBubble({ role: "confirmResplit", entryId: turn.entryId, allocations: turn.allocations, text: turn.text, resolved: null });
      } else if (turn.kind === "confirmEdit") {
        pushBubble({ role: "confirmEdit", entryId: turn.entryId, updates: turn.updates, text: turn.text, resolved: null });
      } else if (turn.kind === "confirmCreateContext") {
        pushBubble({ role: "confirmCreateContext", name: turn.name, contextType: turn.contextType, text: turn.text, resolved: null });
      } else if (turn.kind === "confirmAddMember") {
        pushBubble({ role: "confirmAddMember", contextId: turn.contextId, name: turn.name, text: turn.text, resolved: null });
      } else if (turn.kind === "showEntries") {
        pushBubble({ role: "entryList", entryIds: turn.entryIds, text: turn.text });
      } else if (turn.kind === "navigate") {
        pushBubble({ role: "assistant", text: turn.text });
        onNavigate?.(turn.target);
      } else {
        pushBubble({ role: "assistant", text: turn.text });
      }
    } finally {
      setBusy(false);
    }
  }

  function resolveDraftBubble(id: number, summary: string) {
    setBubbles((current) =>
      current.map((bubble) =>
        bubble.id === id && (bubble.role === "draft" || CONFIRM_ROLES.includes(bubble.role))
          ? { ...bubble, resolved: summary }
          : bubble,
      ),
    );
  }

  // Shared executor wrapper: run the confirmed action, refresh, and stamp
  // the bubble with the outcome (success or a readable failure).
  async function runConfirmed(id: number, doIt: () => Promise<void>, success: string) {
    try {
      await doIt();
      await refresh();
      requestSync();
      resolveDraftBubble(id, success);
    } catch (cause) {
      resolveDraftBubble(id, `Couldn't apply that: ${humanizeError(cause)}`);
    }
  }

  function entryById(entryId: string) {
    return entries.find((candidate) => candidate.entryId === entryId && !candidate.voidedAt) ?? null;
  }

  async function handleConfirmVoid(id: number, entryId: string) {
    const entry = entryById(entryId);
    if (!entry) {
      resolveDraftBubble(id, "That entry is already gone.");
      return;
    }
    await runConfirmed(id, async () => void (await voidExpense(entry, "voided via assistant")), "Voided — balances updated.");
  }

  async function handleConfirmResplit(id: number, entryId: string, allocations: Allocation[]) {
    const entry = entryById(entryId);
    if (!entry) {
      resolveDraftBubble(id, "That entry is already gone.");
      return;
    }
    await runConfirmed(id, async () => void (await resplitExpense(entry, allocations)), "Re-split — balances updated.");
  }

  async function handleConfirmEdit(id: number, entryId: string, updates: EditUpdates) {
    const entry = entryById(entryId);
    if (!entry) {
      resolveDraftBubble(id, "That entry is already gone.");
      return;
    }
    await runConfirmed(id, async () => void (await editExpense(entry, updates)), "Updated.");
  }

  async function handleConfirmCreateContext(id: number, name: string, type: "personal" | "shared") {
    await runConfirmed(id, async () => void (await createContext(name, type)), `Created “${name}”.`);
  }

  async function handleConfirmAddMember(id: number, contextId: string, name: string) {
    await runConfirmed(id, async () => void (await addNamedMember(contextId, name)), `Added ${name}.`);
  }

  function entryRowLabel(entry: LedgerEntry): string {
    return `“${entry.description ?? "expense"}” (${formatMoneyIn(entry.currency ?? "INR", entry.totalAmount)}, ${entry.effectiveDate})`;
  }

  // Selecting a row targets it unambiguously by its own words (description +
  // amount + date), so the model — or a human reading back — can't confuse
  // entries. The user finishes the sentence: "…: split with Gunjan".
  function handleSelectEntry(entry: LedgerEntry) {
    setInput(`For ${entryRowLabel(entry)}: `);
    inputRef.current?.focus();
  }

  function handleVoidFromRow(entry: LedgerEntry) {
    pushBubble({
      role: "confirmVoid",
      entryId: entry.entryId,
      label: entryRowLabel(entry),
      text: `Void ${entryRowLabel(entry)}? It stays in history but stops counting toward balances.`,
      resolved: null,
    });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void send(input);
  }

  const suggestions =
    scopeContextId === null
      ? ["Show recent transactions", "How much do I owe?", "Who owes how much?"]
      : ["Show recent transactions", "How much did we spend this month?", "450 dinner split equally"];

  return (
    <article className="panel chat-panel">
      <div className="panel-header">
        <h2>Assistant</h2>
        <div className="chat-header-side">
          <span className="chat-header-note">Answers are computed locally; drafts always need your review</span>
          <button
            type="button"
            className={`secondary compact${aiSettingsOpen ? " is-open" : ""}`}
            aria-expanded={aiSettingsOpen}
            onClick={() => setAiSettingsOpen((open) => !open)}
          >
            AI settings
          </button>
          {bubbles.length > 0 ? (
            <button type="button" className="secondary compact" onClick={clearChat}>
              Clear
            </button>
          ) : null}
        </div>
      </div>
      {/* The two AI toggles used to sit between the thread and the compose
          box, permanently pushing the input down and interrupting the
          conversation with configuration. They live here now — opened
          deliberately, and with room for the full explanation inline rather
          than behind an ⓘ that shifted the layout when expanded. */}
      {aiSettingsOpen ? (
        <div className="chat-settings">
          {isLocalOnly() ? null : (
            <label className="toggle-row">
              <span>
                Use server AI
                <span className="chat-settings-hint">
                  Sends messages the local parsing can't handle to your own configured server or provider —
                  message text and member names, plus (in AI-first mode) a compact summary of your shared
                  groups and any entries the model looks up. Personal groups are never included. Off means
                  nothing ever leaves this device.
                </span>
              </span>
              <input
                type="checkbox"
                checked={serverLlm}
                onChange={(event) => {
                  setServerLlmEnabled(event.target.checked);
                  setServerLlm(event.target.checked);
                }}
              />
            </label>
          )}
          <label className="toggle-row">
            <span>
              AI-first mode
              <span className="chat-settings-hint">
                The model sees a ledger summary, can look up entries, balances and spend on demand, and
                proposes changes — add, edit, re-split, remove, groups and members. Every change still needs
                your confirmation here; numbers always come from the app, never the model.
              </span>
            </span>
            <input
              type="checkbox"
              checked={llmFirst}
              onChange={(event) => {
                setAssistantLlmFirst(event.target.checked);
                setLlmFirst(event.target.checked);
              }}
            />
          </label>
        </div>
      ) : null}
      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {bubbles.length === 0 ? (
          <div className="chat-empty">
            <p>
              {scopeContextId === null
                ? "Ask across all your groups, draft an expense (“450 dinner in Flat split equally”), or navigate (“open Flat balances”)."
                : "Ask about your ledger, or describe an expense — by typing or speaking."}
            </p>
            <div className="chip-row">
              {suggestions.map((suggestion) => (
                <button key={suggestion} type="button" className="chip" onClick={() => void send(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {bubbles.map((bubble) => {
          if (bubble.role === "entryList") {
            return (
              <div key={bubble.id} className="chat-bubble assistant has-card">
                <span>{bubble.text}</span>
                <div className="plan-list">
                  {bubble.entryIds.map((entryId) => {
                    const entry = entries.find((candidate) => candidate.entryId === entryId);
                    if (!entry) {
                      return null;
                    }
                    if (entry.voidedAt) {
                      return (
                        <div className="plan-row" key={entryId}>
                          <span className="voided-text">{entryRowLabel(entry)}</span>
                        </div>
                      );
                    }
                    return (
                      <div className="plan-row" key={entryId}>
                        <span>{entryRowLabel(entry)}</span>
                        <button type="button" className="secondary compact" onClick={() => handleSelectEntry(entry)}>
                          Select
                        </button>
                        <button type="button" className="secondary compact" onClick={() => handleVoidFromRow(entry)}>
                          Void
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          }
          if (CONFIRM_ROLES.includes(bubble.role)) {
            const confirm = bubble as Extract<
              Bubble,
              { role: "confirmVoid" | "confirmResplit" | "confirmEdit" | "confirmCreateContext" | "confirmAddMember" }
            >;
            const apply = () => {
              if (confirm.role === "confirmVoid") {
                void handleConfirmVoid(confirm.id, confirm.entryId);
              } else if (confirm.role === "confirmResplit") {
                void handleConfirmResplit(confirm.id, confirm.entryId, confirm.allocations);
              } else if (confirm.role === "confirmEdit") {
                void handleConfirmEdit(confirm.id, confirm.entryId, confirm.updates);
              } else if (confirm.role === "confirmCreateContext") {
                void handleConfirmCreateContext(confirm.id, confirm.name, confirm.contextType);
              } else {
                void handleConfirmAddMember(confirm.id, confirm.contextId, confirm.name);
              }
            };
            return (
              <div key={confirm.id} className="chat-bubble assistant has-card">
                <span>{confirm.text}</span>
                {confirm.resolved ? (
                  <span className="share-hint">{confirm.resolved}</span>
                ) : (
                  <div className="form-actions">
                    <button type="button" className="secondary compact" onClick={apply}>
                      {confirm.role === "confirmVoid" ? "Void it" : "Apply"}
                    </button>
                    <button
                      type="button"
                      className="secondary compact"
                      onClick={() => resolveDraftBubble(confirm.id, "Cancelled.")}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          }
          if (bubble.role === "draft") {
            return (
              <div key={bubble.id} className="chat-bubble assistant has-card">
                <span>{bubble.note}</span>
                {bubble.resolved ? (
                  <span className="share-hint">{bubble.resolved}</span>
                ) : (
                  <DraftReviewCard
                    draft={bubble.draft}
                    initialContextId={bubble.initialContextId}
                    allowContextChange={scopeContextId === null}
                    contexts={contexts}
                    memberships={memberships}
                    participants={participants}
                    deviceParticipantId={deviceParticipantId}
                    online={online}
                    refresh={refresh}
                    requestSync={requestSync}
                    onSaved={(summary) => resolveDraftBubble(bubble.id, summary)}
                    onDiscard={() => resolveDraftBubble(bubble.id, "Draft discarded.")}
                  />
                )}
              </div>
            );
          }
          return (
            <div key={bubble.id} className={`chat-bubble ${bubble.role}`}>
              <span>{bubble.text}</span>
            </div>
          );
        })}
        {busy ? (
          <div className="chat-bubble assistant" aria-live="polite">
            <span>Thinking…</span>
          </div>
        ) : null}
      </div>
      {voiceError ? <span className="error-text">{voiceError}</span> : null}
      <form className="chat-input-row" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask, or say “450 dinner split equally”…"
          aria-label="Message the assistant"
          disabled={busy}
        />
        <VoiceCaptureButton onTranscript={(transcript) => void send(transcript)} setError={setVoiceError} />
        <button type="submit" className="primary compact" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </article>
  );
}
