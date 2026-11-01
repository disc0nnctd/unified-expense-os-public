import { buildShareAllocations, formatMoney, parseAmountToPaise, participantName } from "../lib/finance";
import type { Participant } from "../types";

// Shared split editor for every surface that proposes or edits a split —
// AddExpensePanel, the chat assistant's draft review cards, and voice
// prefill (unified-expense-os-4lq). The duplicated shares/exact editors in
// StatementTriagePanel predate this and migrate in a follow-up.
//
// The component is fully controlled: all inputs live in SplitState owned by
// the caller, and the pure helpers below (initSplitState / computeSplit) are
// the single source of validation truth, so voice/chat drafts and the manual
// form can't drift apart on split semantics.

export type SplitMode = "equal" | "shares" | "custom";

export type SplitState = {
  mode: SplitMode;
  // "By shares": relative weights (2 : 1 style) per included member.
  shareIncluded: Record<string, boolean>;
  shareWeightInputs: Record<string, string>;
  // "Custom": exact paise amounts per included member.
  customIncluded: Record<string, boolean>;
  customShareInputs: Record<string, string>;
};

export function initSplitState(mode: SplitMode, memberIds: string[]): SplitState {
  const allIncluded: Record<string, boolean> = {};
  const emptyInputs: Record<string, string> = {};
  const unitWeights: Record<string, string> = {};
  for (const memberId of memberIds) {
    allIncluded[memberId] = true;
    emptyInputs[memberId] = "";
    unitWeights[memberId] = "1";
  }
  return {
    mode,
    shareIncluded: { ...allIncluded },
    shareWeightInputs: unitWeights,
    customIncluded: { ...allIncluded },
    customShareInputs: emptyInputs,
  };
}

// Build a SplitState from a draft proposal (voice/chat/split-shape memory).
// Members not mentioned are excluded but stay listed for the user to re-add.
export function splitStateFromDraft(
  memberIds: string[],
  draft:
    | { mode: "equal" }
    | { mode: "shares"; weights: Record<string, number> }
    | { mode: "custom"; amountsPaise: Record<string, number> },
): SplitState {
  const state = initSplitState(draft.mode, memberIds);
  if (draft.mode === "shares") {
    for (const memberId of memberIds) {
      const weight = draft.weights[memberId];
      state.shareIncluded[memberId] = weight !== undefined;
      state.shareWeightInputs[memberId] = weight !== undefined ? String(weight) : "1";
    }
  }
  if (draft.mode === "custom") {
    for (const memberId of memberIds) {
      const paise = draft.amountsPaise[memberId];
      state.customIncluded[memberId] = paise !== undefined;
      state.customShareInputs[memberId] = paise !== undefined ? (paise / 100).toFixed(2) : "";
    }
  }
  return state;
}

export function shareWeightsOf(state: SplitState, memberIds: string[]): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const memberId of memberIds) {
    if (!state.shareIncluded[memberId]) {
      continue;
    }
    const weight = Number(state.shareWeightInputs[memberId] ?? "");
    if (Number.isFinite(weight) && weight > 0) {
      weights[memberId] = weight;
    }
  }
  return weights;
}

export function customSharesOf(state: SplitState, memberIds: string[]): { shares: Record<string, number>; total: number } {
  const shares: Record<string, number> = {};
  let total = 0;
  for (const memberId of memberIds) {
    if (!state.customIncluded[memberId]) {
      continue;
    }
    const paise = parseAmountToPaise(state.customShareInputs[memberId] ?? "") ?? 0;
    shares[memberId] = paise;
    total += paise;
  }
  return { shares, total };
}

export type SplitResult =
  | { ok: true; customShares?: Record<string, number> }
  | { ok: false; error: string };

// Validate the state and produce the customShares map queueExpense expects
// (undefined for a plain equal split). Mirrors the server's
// sum(allocations) == total invariant so rejects happen before a queue write.
export function computeSplit(
  state: SplitState,
  amountPaise: number,
  payerId: string,
  memberIds: string[],
): SplitResult {
  if (state.mode === "equal") {
    return { ok: true };
  }
  if (state.mode === "shares") {
    const weights = shareWeightsOf(state, memberIds);
    if (Object.keys(weights).length === 0) {
      return { ok: false, error: "Give at least one person a share weight." };
    }
    if (!(payerId in weights)) {
      return { ok: false, error: "The payer must have a share weight." };
    }
    const customShares = Object.fromEntries(
      buildShareAllocations(amountPaise, weights, payerId).map((allocation) => [
        allocation.participantId,
        allocation.shareAmount,
      ]),
    );
    return { ok: true, customShares };
  }
  const { shares, total } = customSharesOf(state, memberIds);
  if (Object.keys(shares).length === 0) {
    return { ok: false, error: "Include at least one person in the custom split." };
  }
  if (!(payerId in shares)) {
    return { ok: false, error: "The payer must be included in the split." };
  }
  if (total !== amountPaise) {
    const remaining = amountPaise - total;
    return {
      ok: false,
      error:
        remaining > 0
          ? `Shares are short by ${formatMoney(remaining)}.`
          : `Shares are over by ${formatMoney(Math.abs(remaining))}.`,
    };
  }
  return { ok: true, customShares: shares };
}

type Props = {
  memberIds: string[];
  participants: Participant[];
  deviceParticipantId: string;
  payerId: string;
  amountPaise: number | null;
  state: SplitState;
  onChange: (state: SplitState) => void;
};

export default function SplitEditor({
  memberIds,
  participants,
  deviceParticipantId,
  payerId,
  amountPaise,
  state,
  onChange,
}: Props) {
  const shareWeights = shareWeightsOf(state, memberIds);
  const sharesPreview =
    state.mode === "shares" && amountPaise !== null && payerId in shareWeights
      ? buildShareAllocations(amountPaise, shareWeights, payerId)
      : null;
  const customTotal = customSharesOf(state, memberIds).total;
  const customRemaining = amountPaise !== null ? amountPaise - customTotal : null;

  const shareHint =
    amountPaise !== null && memberIds.length > 0
      ? `Split equally: ${formatMoney(Math.floor(amountPaise / memberIds.length))} each across ${memberIds.length}`
      : null;

  function setMode(mode: SplitMode) {
    if (mode === state.mode) {
      return;
    }
    // Re-seed the target mode's inputs so switching always starts predictable.
    const seeded = initSplitState(mode, memberIds);
    onChange({
      ...seeded,
      // Keep the other mode's inputs so toggling back doesn't lose work.
      ...(mode === "shares"
        ? { customIncluded: state.customIncluded, customShareInputs: state.customShareInputs }
        : {}),
      ...(mode === "custom"
        ? { shareIncluded: state.shareIncluded, shareWeightInputs: state.shareWeightInputs }
        : {}),
    });
  }

  function memberLabel(memberId: string) {
    return `${participantName(participants, memberId)}${memberId === deviceParticipantId ? " (me)" : ""}`;
  }

  return (
    <>
      <div className="chip-row wide" role="radiogroup" aria-label="Split mode">
        {(
          [
            ["equal", "Split equally"],
            ["shares", "By shares"],
            ["custom", "Custom split"],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={state.mode === mode}
            className={`chip${state.mode === mode ? " chip-active" : ""}`}
            onClick={() => setMode(mode)}
          >
            {label}
          </button>
        ))}
      </div>
      {state.mode === "equal" && shareHint ? <span className="share-hint wide">{shareHint}</span> : null}
      {state.mode === "shares" ? (
        <div className="split-list wide">
          {memberIds.map((memberId) => {
            const preview = sharesPreview?.find((allocation) => allocation.participantId === memberId);
            return (
              <div className="split-row" key={memberId}>
                <label className="toggle-inline">
                  <input
                    type="checkbox"
                    checked={state.shareIncluded[memberId] ?? false}
                    onChange={(event) =>
                      onChange({
                        ...state,
                        shareIncluded: { ...state.shareIncluded, [memberId]: event.target.checked },
                      })
                    }
                  />
                  <span>{memberLabel(memberId)}</span>
                </label>
                <input
                  className="split-amount"
                  inputMode="numeric"
                  placeholder="1"
                  aria-label={`Share weight for ${participantName(participants, memberId)}`}
                  disabled={!state.shareIncluded[memberId]}
                  value={state.shareWeightInputs[memberId] ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...state,
                      shareWeightInputs: { ...state.shareWeightInputs, [memberId]: event.target.value },
                    })
                  }
                />
                {preview ? <span className="share-hint">{formatMoney(preview.shareAmount)}</span> : null}
              </div>
            );
          })}
          {!(payerId in shareWeights) ? (
            <span className="share-hint">The payer needs a share weight too.</span>
          ) : null}
        </div>
      ) : null}
      {state.mode === "custom" ? (
        <div className="split-list wide">
          {memberIds.map((memberId) => (
            <div className="split-row" key={memberId}>
              <label className="toggle-inline">
                <input
                  type="checkbox"
                  checked={state.customIncluded[memberId] ?? false}
                  onChange={(event) =>
                    onChange({
                      ...state,
                      customIncluded: { ...state.customIncluded, [memberId]: event.target.checked },
                    })
                  }
                />
                <span>{memberLabel(memberId)}</span>
              </label>
              <input
                className="split-amount"
                inputMode="decimal"
                placeholder="0"
                aria-label={`Share for ${participantName(participants, memberId)}`}
                disabled={!state.customIncluded[memberId]}
                value={state.customShareInputs[memberId] ?? ""}
                onChange={(event) =>
                  onChange({
                    ...state,
                    customShareInputs: { ...state.customShareInputs, [memberId]: event.target.value },
                  })
                }
              />
            </div>
          ))}
          {customRemaining !== null ? (
            <span className="share-hint">
              {customRemaining === 0
                ? "Shares match the total."
                : customRemaining > 0
                  ? `${formatMoney(customRemaining)} left to assign.`
                  : `${formatMoney(Math.abs(customRemaining))} over the total.`}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
