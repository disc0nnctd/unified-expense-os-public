import { FormEvent, useMemo, useState } from "react";
import { classifyCapture, draftCaptureViaLlm, queueExpense, type LlmCaptureDraft } from "../lib/api";
import {
  coOccurrenceSuggestion,
  extractPayee,
  parseUpiPaste,
  splitShapeMemory,
  suggestExpensesFromSms,
  type SmsExpenseCandidate,
} from "../lib/capture";
import { SUPPORTED_CURRENCIES } from "../lib/currencies";
import { humanizeError } from "../lib/errors";
import { formatMoney, localDateString, parseAmountToPaise, participantName } from "../lib/finance";
import { isSmsAutoReadSupported, readRecentSms } from "../lib/smsReader";
import { draftViaLlmTiers } from "../lib/assistant";
import { applyDraftToNames, EXPENSE_CATEGORIES, type ExpenseDraft } from "../lib/expenseDraft";
import { isLocalOnly } from "../lib/localMode";
import { getServerLlmEnabled } from "../lib/prefs";
import { parseSpokenExpense } from "../lib/voiceGrammar";
import type { CaptureSuggestion, LedgerEntry, Participant } from "../types";
import SplitEditor, {
  computeSplit,
  initSplitState,
  splitStateFromDraft,
  type SplitState,
} from "./SplitEditor";
import VoiceCaptureButton from "./VoiceCaptureButton";

type Props = {
  contextId: string;
  memberIds: string[];
  recentPayerIdList: string[];
  participants: Participant[];
  deviceParticipantId: string;
  entries: LedgerEntry[];
  online: boolean;
  refresh: () => Promise<void>;
  requestSync: () => void;
  setStatus: (message: string) => void;
};

export default function AddExpensePanel({
  contextId,
  memberIds,
  recentPayerIdList,
  participants,
  deviceParticipantId,
  entries,
  online,
  refresh,
  requestSync,
  setStatus,
}: Props) {
  const CATEGORIES = EXPENSE_CATEGORIES;
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<string>("INR");
  const [payerId, setPayerId] = useState(deviceParticipantId);
  const [effectiveDate, setEffectiveDate] = useState(() => localDateString(new Date()));
  const [suggestion, setSuggestion] = useState<CaptureSuggestion | null>(null);
  // Opt-in LLM fallback state, only ever surfaced when the deterministic
  // classifier above came back "low" confidence — see handleLlmFallback.
  const [llmDraft, setLlmDraft] = useState<LlmCaptureDraft | null>(null);
  const [llmFallbackStatus, setLlmFallbackStatus] = useState<"idle" | "loading" | "unavailable">("idle");
  const [formError, setFormError] = useState<string | null>(null);
  // All split-mode state (equal / shares / custom) lives in the shared
  // SplitEditor component's controlled state — unified-expense-os-4lq.
  const [split, setSplit] = useState<SplitState>(() => initSplitState("equal", memberIds));
  const [notes, setNotes] = useState("");
  const [upiText, setUpiText] = useState("");
  // Android-only opt-in SMS auto-read (see lib/smsReader.ts). Candidates are
  // parsed on-device and only prefill the form when the user taps one.
  const [smsCandidates, setSmsCandidates] = useState<SmsExpenseCandidate[]>([]);
  const [smsBusy, setSmsBusy] = useState(false);
  // What voice prefill understood, shown so the user can see (and fix) the
  // parse before saving — the form itself is the review surface.
  const [voiceSummary, setVoiceSummary] = useState<string | null>(null);

  const payeeHint = useMemo(() => extractPayee(description), [description]);
  const coOccurrence = useMemo(
    () => (description.trim() ? coOccurrenceSuggestion(entries, description, category || null) : null),
    [entries, description, category],
  );
  const splitShape = useMemo(
    () => (description.trim() ? splitShapeMemory(entries, description, category || null) : null),
    [entries, description, category],
  );

  const amountPaise = parseAmountToPaise(amount);

  async function handleAddExpense(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const paise = parseAmountToPaise(amount);
    if (!description.trim()) {
      setFormError("Add a short description.");
      return;
    }
    if (paise === null || paise <= 0) {
      setFormError("Enter a valid amount, e.g. 450 or 450.50.");
      return;
    }
    if (!memberIds.includes(payerId)) {
      setFormError("Pick a payer who is an active member.");
      return;
    }
    const splitResult = computeSplit(split, paise, payerId, memberIds);
    if (!splitResult.ok) {
      setFormError(splitResult.error);
      return;
    }
    try {
      await queueExpense({
        contextId,
        payerId,
        description: description.trim(),
        category: category || suggestion?.category_hint || null,
        notes: notes.trim() || null,
        amountPaise: paise,
        participantIds: memberIds,
        customShares: splitResult.customShares,
        effectiveDate,
        currency,
      });
      await refresh();
      setDescription("");
      setCategory("");
      setAmount("");
      setCurrency("INR");
      setSuggestion(null);
      setSplit(initSplitState("equal", memberIds));
      setNotes("");
      setVoiceSummary(null);
      setEffectiveDate(localDateString(new Date()));
      setStatus(online ? "Saved — syncing now." : "Saved offline — will sync when back online.");
      requestSync();
    } catch (cause) {
      setFormError(humanizeError(cause));
    }
  }

  async function handleSuggest() {
    try {
      setSuggestion(await classifyCapture(description));
      setLlmDraft(null);
      setLlmFallbackStatus("idle");
    } catch {
      setSuggestion(null);
    }
  }

  // User-initiated, opt-in: only offered once the deterministic classifier
  // has already returned "low" confidence. Drafts a suggestion only — never
  // writes to the ledger; the user still reviews and confirms via the form.
  async function handleLlmFallback() {
    setLlmFallbackStatus("loading");
    try {
      setLlmDraft(await draftCaptureViaLlm(description));
      setLlmFallbackStatus("idle");
    } catch {
      setLlmDraft(null);
      setLlmFallbackStatus("unavailable");
    }
  }

  function applyLlmDraft() {
    if (!llmDraft) return;
    if (llmDraft.category) setCategory(llmDraft.category);
    if (llmDraft.amount_paise) setAmount((llmDraft.amount_paise / 100).toFixed(2));
  }

  function applyUpiPaste() {
    const parsed = parseUpiPaste(upiText);
    if (!parsed) {
      setFormError("Couldn't find an amount in that text.");
      return;
    }
    setAmount((parsed.amountPaise / 100).toFixed(2));
    if (parsed.payee && !description.trim()) {
      setDescription(`Paid to ${parsed.payee}`);
    }
    if (parsed.effectiveDate) {
      setEffectiveDate(parsed.effectiveDate);
    }
    setUpiText("");
    setFormError(null);
  }

  // Opt-in, Android-only: pulls recent inbox SMS, filters to money-out payment
  // alerts on-device, and lists them as prefill candidates. Nothing is uploaded
  // and nothing is saved until the user taps a candidate and hits Add.
  async function handleReadSms() {
    setSmsBusy(true);
    setFormError(null);
    try {
      const messages = await readRecentSms(3);
      const candidates = suggestExpensesFromSms(messages);
      setSmsCandidates(candidates.slice(0, 8));
      if (candidates.length === 0) {
        setFormError("No recent payment SMS found to suggest.");
      }
    } catch (cause) {
      setFormError(humanizeError(cause));
    } finally {
      setSmsBusy(false);
    }
  }

  function applySmsCandidate(candidate: SmsExpenseCandidate) {
    setAmount((candidate.amountPaise / 100).toFixed(2));
    if (candidate.payee && !description.trim()) {
      setDescription(`Paid to ${candidate.payee}`);
    }
    if (candidate.effectiveDate) {
      setEffectiveDate(candidate.effectiveDate);
    }
    setSmsCandidates([]);
    setFormError(null);
  }

  // Voice prefill: the transcript is parsed by the deterministic grammar
  // (lib/voiceGrammar.ts) into an ExpenseDraft, names are resolved against
  // the member list, and the result only prefills this form. When the
  // grammar can't find an amount, the same transcript escalates to the
  // model tiers (on-device first, then opt-in server) — identical to chat.
  // The user still reviews everything and taps Save — same assist-only rule
  // as SMS/UPI.
  async function applyVoiceTranscript(transcript: string) {
    const draft = parseSpokenExpense(transcript);
    if (draft && draft.amountPaise !== null) {
      applyVoiceDraft(draft, transcript);
      return;
    }
    setVoiceSummary(`Heard “${transcript}” — asking the AI tiers…`);
    const escalated = await draftViaLlmTiers(
      transcript,
      participants.filter((participant) => memberIds.includes(participant.participantId)).map((p) => p.displayName),
      CATEGORIES,
      getServerLlmEnabled(),
    );
    if (escalated && escalated.amountPaise !== null) {
      applyVoiceDraft(escalated, transcript);
      return;
    }
    setVoiceSummary(null);
    setFormError(
      `Heard “${transcript}” — couldn't find an amount (and no AI tier could help). Try “450 dinner split equally”.`,
    );
  }

  function applyVoiceDraft(draft: ExpenseDraft, transcript: string) {
    const resolved = applyDraftToNames(draft, participants, memberIds, deviceParticipantId);
    if (draft.amountPaise !== null) {
      setAmount((draft.amountPaise / 100).toFixed(2));
    }
    if (draft.description) {
      setDescription(draft.description);
    }
    if (draft.category && CATEGORIES.includes(draft.category)) {
      setCategory(draft.category);
    }
    if (draft.currency && SUPPORTED_CURRENCIES.includes(draft.currency as (typeof SUPPORTED_CURRENCIES)[number])) {
      setCurrency(draft.currency);
    }
    if (draft.effectiveDate) {
      setEffectiveDate(draft.effectiveDate);
    }
    if (resolved.payerId) {
      setPayerId(resolved.payerId);
    }
    if (resolved.split) {
      setSplit(splitStateFromDraft(memberIds, resolved.split));
    }
    const notesParts = [`Heard: “${transcript}”.`];
    if (resolved.warnings.length > 0) {
      notesParts.push(...resolved.warnings);
    }
    notesParts.push("Review the fields below, then Save.");
    setVoiceSummary(notesParts.join(" "));
    setFormError(null);
  }

  function applyCoOccurrence() {
    if (!coOccurrence) return;
    const next = initSplitState("custom", memberIds);
    for (const memberId of memberIds) {
      next.customIncluded[memberId] = coOccurrence.participantIds.includes(memberId);
    }
    setSplit(next);
  }

  function applySplitShape() {
    if (!splitShape || amountPaise === null) return;
    const amountsPaise: Record<string, number> = {};
    const ids = Object.keys(splitShape.ratios);
    let assigned = 0;
    ids.forEach((participantId, index) => {
      const share =
        index === ids.length - 1
          ? amountPaise - assigned
          : Math.round(amountPaise * splitShape.ratios[participantId]);
      assigned += share;
      amountsPaise[participantId] = share;
    });
    setSplit(splitStateFromDraft(memberIds, { mode: "custom", amountsPaise }));
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Add expense</h2>
        <span>{online ? "Syncs instantly" : "Offline — will queue"}</span>
      </div>
      <div className="form-actions wide">
        <input
          className="wide"
          value={upiText}
          onChange={(event) => setUpiText(event.target.value)}
          placeholder="Paste a UPI/SMS payment notification…"
        />
        <button type="button" className="secondary compact" onClick={applyUpiPaste} disabled={!upiText.trim()}>
          Parse
        </button>
        {isSmsAutoReadSupported() ? (
          <button type="button" className="secondary compact" onClick={handleReadSms} disabled={smsBusy}>
            {smsBusy ? "Reading SMS…" : "Read payment SMS"}
          </button>
        ) : null}
        <VoiceCaptureButton onTranscript={(transcript) => void applyVoiceTranscript(transcript)} setError={setFormError} />
      </div>
      {smsCandidates.length > 0 ? (
        <div className="split-list wide">
          <span className="share-hint wide">Tap a recent payment to prefill (nothing is saved until you add it):</span>
          {smsCandidates.map((candidate) => (
            <button
              type="button"
              key={`${candidate.receivedAt}-${candidate.amountPaise}`}
              className="secondary"
              style={{ textAlign: "left", justifyContent: "flex-start" }}
              onClick={() => applySmsCandidate(candidate)}
            >
              {formatMoney(candidate.amountPaise)}
              {candidate.payee ? ` → ${candidate.payee}` : ""}
              {` · ${candidate.sender}`}
            </button>
          ))}
        </div>
      ) : null}
      {voiceSummary ? (
        <div className="hint-card wide" role="status">
          <span>{voiceSummary}</span>
          <button type="button" className="secondary compact" onClick={() => setVoiceSummary(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      <form className="entry-form" onSubmit={handleAddExpense}>
        <label className="wide">
          Description
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="e.g. Groceries"
          />
        </label>
        {payeeHint ? <span className="share-hint wide">Payee detected: {payeeHint}</span> : null}
        <label>
          Category
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">
              {suggestion?.category_hint ? `Suggested: ${suggestion.category_hint}` : "Uncategorized"}
            </option>
            {CATEGORIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          Amount
          <input
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="450.50"
          />
        </label>
        <label>
          Currency
          <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
            {SUPPORTED_CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label>
          Date
          <input
            type="date"
            value={effectiveDate}
            max={localDateString(new Date())}
            onChange={(event) => setEffectiveDate(event.target.value)}
          />
        </label>
        <label>
          Paid by
          <select value={payerId} onChange={(event) => setPayerId(event.target.value)}>
            {memberIds.map((memberId) => (
              <option key={memberId} value={memberId}>
                {participantName(participants, memberId)}
                {memberId === deviceParticipantId ? " (me)" : ""}
              </option>
            ))}
          </select>
        </label>
        {recentPayerIdList.length > 0 ? (
          <div className="chip-row wide">
            {recentPayerIdList.map((memberId) => (
              <button
                key={memberId}
                type="button"
                className={`chip${memberId === payerId ? " chip-active" : ""}`}
                onClick={() => setPayerId(memberId)}
              >
                {participantName(participants, memberId)}
                {memberId === deviceParticipantId ? " (me)" : ""}
              </button>
            ))}
          </div>
        ) : null}
        <SplitEditor
          memberIds={memberIds}
          participants={participants}
          deviceParticipantId={deviceParticipantId}
          payerId={payerId}
          amountPaise={amountPaise}
          state={split}
          onChange={setSplit}
        />
        {coOccurrence ? (
          <div className="hint-card wide">
            <span>{coOccurrence.reason}</span>
            <button type="button" className="secondary compact" onClick={applyCoOccurrence}>
              Apply suggested split
            </button>
          </div>
        ) : null}
        {splitShape ? (
          <div className="hint-card wide">
            <span>{splitShape.reason}</span>
            <button type="button" className="secondary compact" onClick={applySplitShape} disabled={amountPaise === null}>
              Apply
            </button>
          </div>
        ) : null}
        <label className="wide">
          Notes (optional)
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="e.g. for the ski trip lift tickets"
            rows={2}
          />
        </label>
        {formError ? <span className="error-text wide">{formError}</span> : null}
        <div className="form-actions wide">
          {isLocalOnly() ? null : (
            <button type="button" className="secondary" onClick={handleSuggest} disabled={!description || !online}>
              Suggest
            </button>
          )}
          <button type="submit" className="primary">
            Save expense
          </button>
        </div>
      </form>
      {suggestion ? (
        <div className="hint-card">
          {/* Only the category is the user's to act on. The context hint and
              recurring flag are internal routing signals — showing them (and
              their "unknown" fallbacks) turned this card into a debug dump. */}
          {suggestion.category_hint ? (
            <span>
              Looks like <strong>{suggestion.category_hint}</strong>
              {suggestion.confidence === "low" ? ", but it's a rough guess." : "."}
            </span>
          ) : (
            <span>Couldn't work out a category from that description.</span>
          )}
          {suggestion.confidence === "low" ? (
            <div className="llm-fallback">
              <button type="button" className="secondary" onClick={handleLlmFallback} disabled={llmFallbackStatus === "loading"}>
                {llmFallbackStatus === "loading" ? "Asking AI…" : "Try AI suggestion"}
              </button>
              {llmFallbackStatus === "unavailable" ? (
                <span className="hint-text">AI suggestions aren't configured on this server.</span>
              ) : null}
              {llmDraft ? (
                <div className="hint-card">
                  <strong>AI draft</strong>
                  {/* Same rule as above: show what the model actually filled
                      in, not a row of "unknown"s for what it didn't. */}
                  {llmDraft.description ? <span>{llmDraft.description}</span> : null}
                  {llmDraft.category ? <span>Category: {llmDraft.category}</span> : null}
                  {llmDraft.amount_paise != null ? <span>Amount: {formatMoney(llmDraft.amount_paise)}</span> : null}
                  <span className="hint-text">Nothing is saved until you apply this and hit Save expense.</span>
                  <button type="button" className="secondary" onClick={applyLlmDraft}>
                    Apply to form
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
