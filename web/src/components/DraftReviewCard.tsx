import { useMemo, useState } from "react";
import { addExistingMember, addNamedMember, createInvite, queueExpense } from "../lib/api";
import { SUPPORTED_CURRENCIES, isSupportedCurrency } from "../lib/currencies";
import { humanizeError } from "../lib/errors";
import { isLocalOnly } from "../lib/localMode";
import { activeMemberIds, localDateString, parseAmountToPaise, participantName } from "../lib/finance";
import {
  applyDraftToNames,
  describedWith,
  EXPENSE_CATEGORIES,
  findKnownPeople,
  withoutName,
  type ExpenseDraft,
} from "../lib/expenseDraft";
import type { ContextRecord, Membership, Participant } from "../types";
import SplitEditor, {
  computeSplit,
  initSplitState,
  splitStateFromDraft,
  type SplitState,
} from "./SplitEditor";

type Props = {
  draft: ExpenseDraft;
  // Target context. Fixed in a context-scoped chat; in the global assistant
  // the user can retarget via the selector (allowContextChange).
  initialContextId: string | null;
  allowContextChange: boolean;
  contexts: ContextRecord[];
  memberships: Membership[];
  participants: Participant[];
  deviceParticipantId: string;
  online: boolean;
  onSaved: (summary: string) => void;
  onDiscard: () => void;
  refresh: () => Promise<void>;
  requestSync: () => void;
};

type GhostAdded = {
  name: string;
  participantId: string;
  inviteCode: string | null;
  // Set when an existing person was reused rather than a new one created.
  existingName?: string;
};

// Inline review card for assistant-proposed expenses (chat + voice drafts).
// The assist-only boundary in UI form: everything is editable, nothing is
// saved until the user taps Save, and saving goes through the exact same
// queueExpense() path as the manual form. Names the draft mentioned that
// aren't members yet get an explicit "add as ghost + invite" offer (owner
// only) instead of a silent guess or a dead end.
export default function DraftReviewCard({
  draft,
  initialContextId,
  allowContextChange,
  contexts,
  memberships,
  participants,
  deviceParticipantId,
  online,
  onSaved,
  onDiscard,
  refresh,
  requestSync,
}: Props) {
  const openContexts = contexts.filter((context) => !context.archivedAt && !context.closedAt);
  const [contextId, setContextId] = useState<string | null>(
    initialContextId ?? openContexts[0]?.contextId ?? null,
  );

  if (!contextId) {
    return (
      <div className="hint-card draft-card">
        <span>No open group to add this expense to — create one from Home first.</span>
        <div className="form-actions">
          <button type="button" className="secondary compact" onClick={onDiscard}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="hint-card draft-card" role="group" aria-label="Proposed expense — review before saving">
      {allowContextChange ? (
        <label className="draft-context-row">
          Context
          <select value={contextId} onChange={(event) => setContextId(event.target.value)}>
            {openContexts.map((context) => (
              <option key={context.contextId} value={context.contextId}>
                {context.name}
              </option>
            ))}
          </select>
          {draft.contextHint && initialContextId === null ? (
            <span className="share-hint">Couldn't match “{draft.contextHint}” — pick the group.</span>
          ) : null}
        </label>
      ) : null}
      {/* Keyed by context so payer/split state re-seeds when retargeted. */}
      <DraftReviewForm
        key={contextId}
        draft={draft}
        contextId={contextId}
        contexts={contexts}
        memberships={memberships}
        participants={participants}
        deviceParticipantId={deviceParticipantId}
        online={online}
        onSaved={onSaved}
        onDiscard={onDiscard}
        refresh={refresh}
        requestSync={requestSync}
      />
    </div>
  );
}

function DraftReviewForm({
  draft,
  contextId,
  contexts,
  memberships,
  participants,
  deviceParticipantId,
  online,
  onSaved,
  onDiscard,
  refresh,
  requestSync,
}: Omit<Props, "initialContextId" | "allowContextChange"> & { contextId: string }) {
  const memberIds = useMemo(() => activeMemberIds(memberships, contextId), [memberships, contextId]);
  const isOwner =
    contexts.find((context) => context.contextId === contextId)?.ownerParticipantId === deviceParticipantId;
  // The draft as the user has reinterpreted it: naming a "participant" that
  // was really part of the description removes it from the split here, without
  // touching the original proposal.
  const [workingDraft, setWorkingDraft] = useState(draft);
  const resolved = useMemo(
    () => applyDraftToNames(workingDraft, participants, memberIds, deviceParticipantId),
    [workingDraft, participants, memberIds, deviceParticipantId],
  );
  const [description, setDescription] = useState(draft.description ?? "");
  // The model's category suggestion is shown and editable rather than written
  // through silently — it was the one AI-chosen field that reached the ledger
  // without review (unified-expense-os-cwm).
  const [category, setCategory] = useState(
    draft.category && EXPENSE_CATEGORIES.includes(draft.category) ? draft.category : "",
  );
  const [amount, setAmount] = useState(draft.amountPaise !== null ? (draft.amountPaise / 100).toFixed(2) : "");
  const [currency, setCurrency] = useState<string>(isSupportedCurrency(draft.currency) ? draft.currency : "INR");
  const [effectiveDate, setEffectiveDate] = useState(draft.effectiveDate ?? localDateString(new Date()));
  const [payerId, setPayerId] = useState(
    resolved.payerId && memberIds.includes(resolved.payerId)
      ? resolved.payerId
      : memberIds.includes(deviceParticipantId)
        ? deviceParticipantId
        : memberIds[0] ?? deviceParticipantId,
  );
  const [split, setSplit] = useState<SplitState>(() =>
    resolved.split ? splitStateFromDraft(memberIds, resolved.split) : initSplitState("equal", memberIds),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [ghostBusy, setGhostBusy] = useState<string | null>(null);
  const [ghostsAdded, setGhostsAdded] = useState<GhostAdded[]>([]);

  const amountPaise = parseAmountToPaise(amount);
  const pendingNames = resolved.unresolvedNames.filter(
    (name) => !ghostsAdded.some((added) => added.name.toLowerCase() === name.toLowerCase()),
  );

  if (memberIds.length === 0) {
    return <span className="error-text">You're not an active member of this context.</span>;
  }

  // Re-resolve against the membership as it will look after refresh, so
  // payer/split pick the new member up as originally spoken.
  function reseedFrom(
    nextDraft: ExpenseDraft,
    augmentedParticipants: Participant[],
    augmentedMemberIds: string[],
  ) {
    const reResolved = applyDraftToNames(
      nextDraft,
      augmentedParticipants,
      augmentedMemberIds,
      deviceParticipantId,
    );
    if (reResolved.payerId) {
      setPayerId(reResolved.payerId);
    }
    if (reResolved.split) {
      setSplit(splitStateFromDraft(augmentedMemberIds, reResolved.split));
    }
  }

  // Add the named person as a ghost member and mint a claim invite for them.
  async function handleAddGhost(name: string) {
    setGhostBusy(name);
    setError(null);
    try {
      const displayName = name.charAt(0).toUpperCase() + name.slice(1);
      const participantId = await addNamedMember(contextId, displayName);
      // Local-only mode has no invites — the member is a name-only record.
      const invite = isLocalOnly() ? null : await createInvite(contextId, participantId);
      await refresh();
      reseedFrom(workingDraft, [...participants, { participantId, displayName }], [...memberIds, participantId]);
      setGhostsAdded((current) => [...current, { name, participantId, inviteCode: invite?.inviteCode ?? null }]);
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setGhostBusy(null);
    }
  }

  // "Same Ara as the one in Trip" — reuse the existing participant so their
  // balances stay one person instead of forking into two same-named records.
  async function handleUseExisting(name: string, participantId: string, displayName: string) {
    setGhostBusy(name);
    setError(null);
    try {
      await addExistingMember(contextId, participantId);
      await refresh();
      reseedFrom(workingDraft, participants, [...memberIds, participantId]);
      setGhostsAdded((current) => [...current, { name, participantId, inviteCode: null, existingName: displayName }]);
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setGhostBusy(null);
    }
  }

  // "Ara is the restaurant, not a person" — drop the name from the split and
  // fold it into the description the user is about to save.
  function handleNameIsDescription(name: string) {
    const nextDraft = withoutName(workingDraft, name);
    setWorkingDraft(nextDraft);
    setDescription((current) => describedWith(current, name));
    reseedFrom(nextDraft, participants, memberIds);
  }

  async function handleSave() {
    setError(null);
    const paise = parseAmountToPaise(amount);
    if (!description.trim()) {
      setError("Add a short description.");
      return;
    }
    if (paise === null || paise <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    if (!memberIds.includes(payerId)) {
      setError("Pick a payer who is an active member.");
      return;
    }
    const result = computeSplit(split, paise, payerId, memberIds);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaving(true);
    try {
      await queueExpense({
        contextId,
        payerId,
        description: description.trim(),
        category: category || null,
        amountPaise: paise,
        participantIds: memberIds,
        customShares: result.customShares,
        effectiveDate,
        currency,
      });
      await refresh();
      requestSync();
      const contextName = contexts.find((context) => context.contextId === contextId)?.name ?? "context";
      onSaved(
        online
          ? `Saved “${description.trim()}” to ${contextName} — syncing now.`
          : `Saved “${description.trim()}” to ${contextName} offline — will sync when back online.`,
      );
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {pendingNames.map((name) => {
        const known = findKnownPeople(name, participants, memberIds, memberships, contexts);
        const knownHere = known.filter((match) => match.contextNames.length > 0);
        return (
          <div key={name} className="info-strip">
            <span>
              “{name}” isn't a member of this context yet.
              {knownHere.length > 0
                ? ` You already know ${knownHere
                    .map((match) => `${match.displayName} (${match.contextNames.join(", ")})`)
                    .join(" and ")} — the same person, or someone new?`
                : isOwner
                  ? isLocalOnly()
                    ? " Add them by name — they'll be a name-only member on this device."
                    : " Add them by name now — they can claim this identity later with an invite code."
                  : " Ask the group's owner to add them, or adjust the split below."}
            </span>
            <div className="form-actions">
              {isOwner
                ? knownHere.map((match) => (
                    <button
                      key={match.participantId}
                      type="button"
                      className="secondary compact"
                      disabled={ghostBusy !== null || (!online && !isLocalOnly())}
                      onClick={() => void handleUseExisting(name, match.participantId, match.displayName)}
                    >
                      {ghostBusy === name ? "Adding…" : `Same ${match.displayName}`}
                    </button>
                  ))
                : null}
              {isOwner ? (
                <button
                  type="button"
                  className="secondary compact"
                  disabled={ghostBusy !== null || (!online && !isLocalOnly())}
                  onClick={() => void handleAddGhost(name)}
                >
                  {ghostBusy === name
                    ? "Adding…"
                    : knownHere.length > 0
                      ? `Add a new ${name}`
                      : isLocalOnly()
                        ? `Add ${name}`
                        : `Add ${name} + create invite`}
                </button>
              ) : null}
              <button
                type="button"
                className="secondary compact"
                disabled={ghostBusy !== null}
                onClick={() => handleNameIsDescription(name)}
              >
                Not a person — part of the description
              </button>
            </div>
          </div>
        );
      })}
      {ghostsAdded.map((added) => (
        <span key={added.participantId} className="share-hint">
          {added.existingName ? (
            <>
              Added the existing {added.existingName} to this group — their balances stay one person.
            </>
          ) : added.inviteCode ? (
            <>
              Added {added.name} to the group. Invite code{" "}
              <strong className="invite-code">{added.inviteCode}</strong> (valid 7 days) — share it so they can
              claim this identity and see the split.
            </>
          ) : (
            <>Added {added.name} to the group as a name-only member on this device.</>
          )}
        </span>
      ))}
      {resolved.warnings
        // Unresolved-name warnings are already covered by the add-member offer
        // strip (or the "added" confirmation); only surface the rest.
        .filter(
          (warning) =>
            !resolved.unresolvedNames.some((name) => warning.toLowerCase().includes(name.toLowerCase())),
        )
        .map((warning) => (
          <span key={warning} className="error-text">
            {warning}
          </span>
        ))}
      <div className="entry-form">
        <label className="wide">
          Description
          <input value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label>
          Amount
          <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
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
          {draft.currency === null && draft.amountPaise !== null ? (
            <span className="share-hint">Currency wasn't identified — defaulted to INR, change if needed.</span>
          ) : null}
        </label>
        <label>
          Category
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">Uncategorized</option>
            {EXPENSE_CATEGORIES.map((option) => (
              <option key={option} value={option}>
                {option}
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
        <SplitEditor
          memberIds={memberIds}
          participants={participants}
          deviceParticipantId={deviceParticipantId}
          payerId={payerId}
          amountPaise={amountPaise}
          state={split}
          onChange={setSplit}
        />
        {error ? <span className="error-text wide">{error}</span> : null}
        <div className="form-actions wide">
          <button type="button" className="secondary" onClick={onDiscard} disabled={saving}>
            Discard
          </button>
          <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving…" : "Save expense"}
          </button>
        </div>
      </div>
    </>
  );
}
