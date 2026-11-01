import { getMeta, setMeta } from "./localDb";

// Line items are an ephemeral capture-time construct: the user assigns
// receipt lines to members, and only the resulting per-member totals get
// synced (as the existing customShares map on queueExpense) — no new
// backend field or sync round-trip. What's stored locally (IndexedDB meta,
// never synced) is a small per-label assignment history used to derive
// item-preference profiles.

export type LineItem = {
  id: string;
  label: string;
  amountPaise: number;
  assignedTo: string[]; // empty = unassigned, falls back to full member set
};

// Splits each item's amount equally among its assignees (or all members, if
// unassigned), folding each item's rounding remainder onto its first
// assignee — never a float, and the grand total always equals sum(items).
export function computeLineItemShares(items: LineItem[], memberIds: string[]): Record<string, number> {
  const shares: Record<string, number> = {};
  for (const memberId of memberIds) {
    shares[memberId] = 0;
  }
  for (const item of items) {
    const assignees = item.assignedTo.length > 0 ? item.assignedTo : memberIds;
    const uniqueAssignees = [...new Set(assignees)].sort();
    if (uniqueAssignees.length === 0) {
      continue;
    }
    const base = Math.floor(item.amountPaise / uniqueAssignees.length);
    const remainder = item.amountPaise - base * uniqueAssignees.length;
    uniqueAssignees.forEach((participantId, index) => {
      shares[participantId] = (shares[participantId] ?? 0) + base + (index === 0 ? remainder : 0);
    });
  }
  return shares;
}

export function lineItemTotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.amountPaise, 0);
}

// --- Item preference profiles ---------------------------------------------
//
// On-device-only history: for each item label, how many times each member
// was included in the assignment. Never synced, never sent anywhere.
type PreferenceHistoryEntry = { label: string; participantId: string; count: number };
const HISTORY_KEY = "itemPreferenceHistory";

export async function recordLineItemAssignment(items: LineItem[]): Promise<void> {
  const history = (await getMeta<PreferenceHistoryEntry[]>(HISTORY_KEY)) ?? [];
  const index = new Map(history.map((row) => [`${row.label}|${row.participantId}`, row]));
  for (const item of items) {
    const label = item.label.trim().toLowerCase();
    if (!label || item.assignedTo.length === 0) {
      continue;
    }
    for (const participantId of item.assignedTo) {
      const key = `${label}|${participantId}`;
      const existing = index.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        const row = { label, participantId, count: 1 };
        index.set(key, row);
        history.push(row);
      }
    }
  }
  await setMeta(HISTORY_KEY, history);
}

export type ItemPreferenceSuggestion = {
  participantIds: string[];
  reason: string;
};

// Suggests who to pre-assign a line to, based on on-device history for that
// exact label. Only surfaces once there's at least one prior observation and
// only for members whose inclusion rate for this label is >=50%.
export function suggestAssigneesForLabel(
  history: PreferenceHistoryEntry[],
  label: string,
  memberIds: string[],
): ItemPreferenceSuggestion | null {
  const normalized = label.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const rows = history.filter((row) => row.label === normalized && memberIds.includes(row.participantId));
  if (rows.length === 0) {
    return null;
  }
  const maxCount = Math.max(...rows.map((row) => row.count));
  const included = rows.filter((row) => row.count >= Math.max(1, Math.ceil(maxCount * 0.5))).map((row) => row.participantId);
  if (included.length === 0) {
    return null;
  }
  return {
    participantIds: included,
    reason: `"${label.trim()}" has historically been split with ${included.length} of ${memberIds.length} members`,
  };
}

export async function loadItemPreferenceHistory(): Promise<PreferenceHistoryEntry[]> {
  return (await getMeta<PreferenceHistoryEntry[]>(HISTORY_KEY)) ?? [];
}
