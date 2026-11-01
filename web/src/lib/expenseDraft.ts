import type { ContextRecord, Membership, Participant } from "../types";

// A proposed expense from an assistive source (voice grammar, chat intent,
// server LLM draft). Names are always plain strings here — resolution to
// participant IDs happens deterministically on-device in applyDraftToNames,
// never in a model (docs/upgrade-review-2026-07-22.md §3). A draft only ever
// prefills a form the user reviews; it cannot reach the ledger by itself.

export type DraftSplitMode = "equal" | "shares" | "custom";

// The category vocabulary offered by every entry surface. Shared so the
// manual form and the assistant's review card offer the same choices.
export const EXPENSE_CATEGORIES = [
  "groceries",
  "rent",
  "utilities",
  "dining",
  "transport",
  "entertainment",
  "other",
];

export type ExpenseDraft = {
  description: string | null;
  amountPaise: number | null;
  category: string | null;
  payerName: string | null;
  splitMode: DraftSplitMode | null;
  // Names mentioned as split participants (subset of the context, possibly
  // including the speaker as "me"). Empty = everyone.
  participantNames: string[];
  // name -> relative weight, for "2 to 1" style splits.
  shares: Record<string, number> | null;
  // name -> exact paise, for "I pay 300, Isha pays 150" style splits.
  amountsPaise: Record<string, number> | null;
  contextHint: string | null;
  effectiveDate: string | null;
  // ISO 4217 code when the source text identified one; null means "not
  // identified" and the review UI must surface the choice, never guess.
  currency: string | null;
  confidence: "high" | "medium" | "low";
};

export function emptyDraft(): ExpenseDraft {
  return {
    description: null,
    amountPaise: null,
    category: null,
    payerName: null,
    splitMode: null,
    participantNames: [],
    shares: null,
    amountsPaise: null,
    contextHint: null,
    effectiveDate: null,
    currency: null,
    confidence: "low",
  };
}

// A name in a draft that matches nobody in this context may still be someone
// the device already knows from another one. Adding them blind mints a second
// participant with the same name and silently splits their balances, so the
// review card offers the existing person instead of guessing which it is.
export type KnownPersonMatch = {
  participantId: string;
  displayName: string;
  contextNames: string[];
};

export function findKnownPeople(
  name: string,
  participants: Participant[],
  memberIds: string[],
  memberships: Membership[],
  contexts: ContextRecord[],
): KnownPersonMatch[] {
  const needle = name.trim().toLowerCase();
  if (!needle) {
    return [];
  }
  const outsiders = participants.filter((participant) => !memberIds.includes(participant.participantId));
  const exact = outsiders.filter((participant) => participant.displayName.trim().toLowerCase() === needle);
  const matches = exact.length > 0
    ? exact
    : outsiders.filter((participant) => participant.displayName.trim().toLowerCase().startsWith(needle));
  return matches.map((participant) => ({
    participantId: participant.participantId,
    displayName: participant.displayName,
    contextNames: memberships
      .filter((membership) => membership.participantId === participant.participantId && !membership.leftAt)
      .map((membership) => contexts.find((context) => context.contextId === membership.contextId)?.name)
      .filter((contextName): contextName is string => !!contextName),
  }));
}

// Drop a name from every place a draft can mention it — the split, the
// weights, the payer — for "that's not a person, it's part of the
// description". Returns a new draft; the caller folds the name into the
// description text itself.
export function withoutName(draft: ExpenseDraft, name: string): ExpenseDraft {
  const needle = name.trim().toLowerCase();
  const drop = <T,>(map: Record<string, T> | null): Record<string, T> | null => {
    if (!map) {
      return null;
    }
    const kept = Object.fromEntries(Object.entries(map).filter(([key]) => key.trim().toLowerCase() !== needle));
    return Object.keys(kept).length > 0 ? kept : null;
  };
  const participantNames = draft.participantNames.filter((existing) => existing.trim().toLowerCase() !== needle);
  const shares = drop(draft.shares);
  const amountsPaise = drop(draft.amountsPaise);
  return {
    ...draft,
    participantNames,
    shares,
    amountsPaise,
    payerName: draft.payerName?.trim().toLowerCase() === needle ? null : draft.payerName,
    // A split mode whose operand list is now empty would resolve to "everyone",
    // which is not what dropping a name meant.
    splitMode:
      (draft.splitMode === "shares" && !shares) || (draft.splitMode === "custom" && !amountsPaise)
        ? "equal"
        : draft.splitMode,
  };
}

// Fold a name the user identified as part of the description into the
// description text, if it isn't already in there.
export function describedWith(description: string, name: string): string {
  const trimmed = description.trim();
  if (trimmed.toLowerCase().includes(name.trim().toLowerCase())) {
    return trimmed;
  }
  return trimmed ? `${trimmed} — ${name.trim()}` : name.trim();
}

const SELF_WORDS = new Set(["me", "i", "myself", "mine", "my"]);

// Deterministic fuzzy name → participantId. Exact (case-insensitive) first,
// then unique prefix, then unique substring. Ambiguity or no match → null;
// the caller surfaces a warning instead of guessing.
export function resolveName(
  name: string,
  participants: Participant[],
  memberIds: string[],
  deviceParticipantId: string,
): string | null {
  const needle = name.trim().toLowerCase();
  if (!needle) {
    return null;
  }
  if (SELF_WORDS.has(needle)) {
    return deviceParticipantId;
  }
  const members = participants.filter((participant) => memberIds.includes(participant.participantId));
  const exact = members.filter((participant) => participant.displayName.trim().toLowerCase() === needle);
  if (exact.length === 1) {
    return exact[0].participantId;
  }
  if (exact.length > 1) {
    return null;
  }
  const prefixed = members.filter((participant) => participant.displayName.trim().toLowerCase().startsWith(needle));
  if (prefixed.length === 1) {
    return prefixed[0].participantId;
  }
  if (prefixed.length > 1) {
    return null;
  }
  const contained = members.filter((participant) =>
    participant.displayName.trim().toLowerCase().includes(needle),
  );
  return contained.length === 1 ? contained[0].participantId : null;
}

// Deterministic fuzzy context-name → contextId, same policy as resolveName:
// exact, then unique prefix, then unique substring; ambiguity → null so the
// UI asks instead of guessing. Archived/closed contexts never match.
export function resolveContextName(hint: string, contexts: ContextRecord[]): string | null {
  const needle = hint.trim().toLowerCase();
  if (!needle) {
    return null;
  }
  const open = contexts.filter((context) => !context.archivedAt && !context.closedAt);
  const exact = open.filter((context) => context.name.trim().toLowerCase() === needle);
  if (exact.length === 1) {
    return exact[0].contextId;
  }
  if (exact.length > 1) {
    return null;
  }
  const prefixed = open.filter((context) => context.name.trim().toLowerCase().startsWith(needle));
  if (prefixed.length === 1) {
    return prefixed[0].contextId;
  }
  if (prefixed.length > 1) {
    return null;
  }
  const contained = open.filter((context) => context.name.trim().toLowerCase().includes(needle));
  return contained.length === 1 ? contained[0].contextId : null;
}

export type ResolvedDraft = {
  payerId: string | null;
  split:
    | { mode: "equal" }
    | { mode: "shares"; weights: Record<string, number> }
    | { mode: "custom"; amountsPaise: Record<string, number> }
    | null;
  warnings: string[];
  // Names the draft mentioned that match no active member — surfaced so the
  // review UI can offer "add as ghost member + invite" instead of failing.
  unresolvedNames: string[];
};

// Resolve a draft's names against the active member list and produce the
// split proposal the SplitEditor understands. "Equal among a subset" becomes
// shares mode with weight 1 each, because plain equal mode always spans the
// whole context.
export function applyDraftToNames(
  draft: ExpenseDraft,
  participants: Participant[],
  memberIds: string[],
  deviceParticipantId: string,
): ResolvedDraft {
  const warnings: string[] = [];
  const unresolvedNames: string[] = [];

  function noteUnresolved(name: string) {
    if (!unresolvedNames.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      unresolvedNames.push(name);
    }
  }

  const payerId = draft.payerName
    ? resolveName(draft.payerName, participants, memberIds, deviceParticipantId)
    : null;
  if (draft.payerName && !payerId) {
    warnings.push(`Couldn't match “${draft.payerName}” to a member — check the payer.`);
    noteUnresolved(draft.payerName);
  }

  function resolveMap(map: Record<string, number>): Record<string, number> | null {
    const resolved: Record<string, number> = {};
    let failed = false;
    for (const [name, value] of Object.entries(map)) {
      const id = resolveName(name, participants, memberIds, deviceParticipantId);
      if (!id) {
        warnings.push(`Couldn't match “${name}” to a member — check the split.`);
        noteUnresolved(name);
        failed = true;
        continue;
      }
      resolved[id] = (resolved[id] ?? 0) + value;
    }
    return failed ? null : resolved;
  }

  let split: ResolvedDraft["split"] = null;
  if (draft.splitMode === "custom" && draft.amountsPaise) {
    const resolved = resolveMap(draft.amountsPaise);
    if (resolved) {
      split = { mode: "custom", amountsPaise: resolved };
    }
  } else if (draft.splitMode === "shares" && draft.shares) {
    const resolved = resolveMap(draft.shares);
    if (resolved) {
      split = { mode: "shares", weights: resolved };
    }
  } else if (draft.splitMode === "equal") {
    if (draft.participantNames.length > 0) {
      const ids: string[] = [];
      for (const name of draft.participantNames) {
        const id = resolveName(name, participants, memberIds, deviceParticipantId);
        if (id) {
          if (!ids.includes(id)) {
            ids.push(id);
          }
        } else {
          warnings.push(`Couldn't match “${name}” to a member — check the split.`);
          noteUnresolved(name);
        }
      }
      if (ids.length > 0 && ids.length < memberIds.length) {
        split = { mode: "shares", weights: Object.fromEntries(ids.map((id) => [id, 1])) };
      } else {
        split = { mode: "equal" };
      }
    } else {
      split = { mode: "equal" };
    }
  }

  return { payerId, split, warnings, unresolvedNames };
}
