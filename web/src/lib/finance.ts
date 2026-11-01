import type { Allocation, ContextRecord, LedgerEntry, Membership, Participant, SettlementPlan } from "../types";
import { partitionByCurrency } from "./currencies";

export function formatMoney(amount: number) {
  const hasPaise = amount % 100 !== 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount / 100);
}

// Integer paise from a rupee string. Never multiplies floats: "10.55" must be
// 1055, not 1055.0000000000001, or the backend rejects the whole push.
export function parseAmountToPaise(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const [rupees, fraction = ""] = trimmed.split(".");
  return Number(rupees) * 100 + Number((fraction + "00").slice(0, 2));
}

// Equal split across the given members with the rounding remainder assigned
// to the payer, so sum(shares) always equals the total.
export function buildEqualAllocations(
  totalPaise: number,
  participantIds: string[],
  payerId: string,
): Allocation[] {
  const uniqueIds = [...new Set(participantIds)].sort();
  if (!uniqueIds.includes(payerId)) {
    throw new Error(`Payer ${payerId} is not among the split participants.`);
  }
  const base = Math.floor(totalPaise / uniqueIds.length);
  const remainder = totalPaise - base * uniqueIds.length;
  return uniqueIds.map((participantId) => ({
    participantId,
    shareAmount: base + (participantId === payerId ? remainder : 0),
    isPayer: participantId === payerId,
  }));
}

// Preserves each participant's proportional share of the total when editing
// an entry, instead of silently collapsing a custom split to an equal one —
// an equal split's proportions are already equal, so this subsumes
// buildEqualAllocations for the edit path (unified-expense-os-bbh). Also
// handles reassigning the payer flag to a different existing participant
// without disturbing the share ratios (who fronts the money is independent
// of who owes what).
export function rescaleAllocations(original: Allocation[], newTotalPaise: number, payerId: string): Allocation[] {
  const participantIds = original.map((allocation) => allocation.participantId);
  if (!participantIds.includes(payerId)) {
    return buildEqualAllocations(newTotalPaise, [...participantIds, payerId], payerId);
  }
  const oldTotal = original.reduce((sum, allocation) => sum + allocation.shareAmount, 0);
  if (oldTotal <= 0) {
    return buildEqualAllocations(newTotalPaise, participantIds, payerId);
  }
  const scaled = original.map((allocation) => ({
    participantId: allocation.participantId,
    shareAmount: Math.round((allocation.shareAmount / oldTotal) * newTotalPaise),
    isPayer: allocation.participantId === payerId,
  }));
  const scaledTotal = scaled.reduce((sum, allocation) => sum + allocation.shareAmount, 0);
  const payerAllocation = scaled.find((allocation) => allocation.participantId === payerId)!;
  payerAllocation.shareAmount += newTotalPaise - scaledTotal;
  return scaled;
}

// Converts relative share weights (e.g. payer 1 share, friend 2 shares — "he
// had double") into integer-paise allocations, faster UX than exact amounts
// for the common ratio-split case and subsuming an equal split when every
// weight is 1 — unified-expense-os-58k. Remainder from integer division goes
// to the payer, same convention as buildEqualAllocations, so
// sum(allocations) === totalPaise always holds.
export function buildShareAllocations(
  totalPaise: number,
  shares: Record<string, number>,
  payerId: string,
): Allocation[] {
  const entries = Object.entries(shares).filter(([, weight]) => weight > 0);
  if (!entries.some(([participantId]) => participantId === payerId)) {
    throw new Error(`Payer ${payerId} must have a share weight.`);
  }
  const totalShares = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (totalShares <= 0) {
    throw new Error("Total share weight must be positive.");
  }
  let assigned = 0;
  return entries.map(([participantId, weight], index) => {
    const isLast = index === entries.length - 1;
    const shareAmount = isLast ? totalPaise - assigned : Math.floor((totalPaise * weight) / totalShares);
    assigned += shareAmount;
    return { participantId, shareAmount, isPayer: participantId === payerId };
  });
}

export function activeMemberIds(memberships: Membership[], contextId: string): string[] {
  return memberships
    .filter((membership) => membership.contextId === contextId && !membership.leftAt)
    .map((membership) => membership.participantId);
}

// A member who left/was removed keeps whatever balance the ledger already
// attributes to them — leaving a context is a lifecycle/UI concern, not a
// ledger event, and must never change what anyone else owes (dr1). Every
// membership (active or left) seeds the map up front so a departed member's
// entry is a deliberate inclusion, not an accidental side effect of the
// entries loop's `?? 0` default; the result is filtered so a left member
// only appears once settled to zero — never silently forever, never
// silently dropped while they still owe/are owed something.
export function deriveBalances(entries: LedgerEntry[], participants: Participant[], memberships: Membership[]) {
  const leftParticipantIds = new Set(
    memberships.filter((membership) => membership.leftAt).map((membership) => membership.participantId),
  );
  const knownParticipantIds = new Set(memberships.map((membership) => membership.participantId));
  const balances = new Map<string, number>();
  participants
    .filter((participant) => knownParticipantIds.has(participant.participantId))
    .forEach((participant) => balances.set(participant.participantId, 0));

  for (const entry of entries) {
    if (entry.syncState === "rejected" || entry.voidedAt) {
      continue;
    }
    balances.set(entry.payerId, (balances.get(entry.payerId) ?? 0) + entry.totalAmount);
    for (const allocation of entry.allocations) {
      balances.set(
        allocation.participantId,
        (balances.get(allocation.participantId) ?? 0) - allocation.shareAmount,
      );
    }
  }

  return Array.from(balances.entries())
    .filter(([participantId, netBalance]) => !leftParticipantIds.has(participantId) || netBalance !== 0)
    .map(([participantId, netBalance]) => ({
      participantId,
      netBalance,
      left: leftParticipantIds.has(participantId),
    }));
}

export type MemberSpend = {
  participantId: string;
  spent: number;
  paid: number;
  left: boolean;
};

// Per-member usage breakdown, distinct from net balance: "spent" is each
// member's share of expenses actually consumed (what they used), "paid" is
// what they fronted. Settlements move money but nobody "used" anything, so
// they're excluded from both totals. A left member is only dropped once
// they have neither spent nor paid anything outstanding — otherwise this
// would silently misattribute their share, the same bug class as dr1.
export function memberSpendSummary(
  entries: LedgerEntry[],
  participants: Participant[],
  memberships: Membership[],
): MemberSpend[] {
  const leftParticipantIds = new Set(
    memberships.filter((membership) => membership.leftAt).map((membership) => membership.participantId),
  );
  const knownParticipantIds = new Set(memberships.map((membership) => membership.participantId));
  const spend = new Map<string, MemberSpend>();
  participants
    .filter((participant) => knownParticipantIds.has(participant.participantId))
    .forEach((participant) =>
      spend.set(participant.participantId, {
        participantId: participant.participantId,
        spent: 0,
        paid: 0,
        left: leftParticipantIds.has(participant.participantId),
      }),
    );

  for (const entry of entries) {
    if (entry.syncState === "rejected" || entry.voidedAt || entry.type !== "expense") {
      continue;
    }
    const payerRow = spend.get(entry.payerId);
    if (payerRow) {
      payerRow.paid += entry.totalAmount;
    }
    for (const allocation of entry.allocations) {
      const row = spend.get(allocation.participantId);
      if (row) {
        row.spent += allocation.shareAmount;
      }
    }
  }

  return Array.from(spend.values()).filter((row) => !row.left || row.spent !== 0 || row.paid !== 0);
}

export type PairwiseBalance = {
  fromId: string; // owes
  toId: string; // is owed
  amount: number;
};

// Literal two-person "A owes B" balances, distinct from deriveBalances' net-
// vs-group view and from the backend's debt-simplification algorithm
// (backend/app/ledger.py) — this is the unsimplified pairwise truth. Every
// entry (expense or settlement) shares the same payer/allocations shape: the
// payer fronted totalAmount, each non-payer allocation participant owes the
// payer their shareAmount. A settlement is just an entry where the "payer"
// is the person who paid the settlement and the allocation participant is
// the person who received it, so the same accumulation applies unchanged.
export function pairwiseBalances(entries: LedgerEntry[]): PairwiseBalance[] {
  const owed = new Map<string, number>(); // key `${owerId}:${owedToId}` -> paise
  for (const entry of entries) {
    if (entry.syncState === "rejected" || entry.voidedAt) {
      continue;
    }
    for (const allocation of entry.allocations) {
      if (allocation.participantId === entry.payerId || allocation.shareAmount === 0) {
        continue;
      }
      const key = `${allocation.participantId}:${entry.payerId}`;
      owed.set(key, (owed.get(key) ?? 0) + allocation.shareAmount);
    }
  }

  const seenPairs = new Set<string>();
  const results: PairwiseBalance[] = [];
  for (const key of owed.keys()) {
    const [owerId, owedToId] = key.split(":");
    const pairKey = [owerId, owedToId].sort().join(":");
    if (seenPairs.has(pairKey)) {
      continue;
    }
    seenPairs.add(pairKey);
    const forward = owed.get(`${owerId}:${owedToId}`) ?? 0;
    const backward = owed.get(`${owedToId}:${owerId}`) ?? 0;
    const net = forward - backward;
    if (net > 0) {
      results.push({ fromId: owerId, toId: owedToId, amount: net });
    } else if (net < 0) {
      results.push({ fromId: owedToId, toId: owerId, amount: -net });
    }
  }
  return results.sort((left, right) => right.amount - left.amount);
}

// Local-only mode has no server to ask for a settlement plan, so build the
// unsimplified pairwise plan on-device from the same entries the balances use
// (unified-expense-os-kxb). Debt simplification stays a server feature; the
// pairwise plan is the honest subset, and it is what an unsimplified context
// would get from the server anyway.
export function localSettlementPlan(
  contextId: string,
  entries: LedgerEntry[],
  currency: string,
): SettlementPlan {
  return {
    contextId,
    currency,
    simplificationEnabled: false,
    excludedParticipantIds: [],
    recommendations: pairwiseBalances(entries).map((balance) => ({
      fromParticipantId: balance.fromId,
      toParticipantId: balance.toId,
      amountCents: balance.amount,
      kind: "pairwise" as const,
      currency,
    })),
  };
}

export function personalSpendThisMonth(entries: LedgerEntry[], participantId: string, now = new Date()): number {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return entries
    .filter(
      (entry) =>
        entry.type === "expense" &&
        entry.syncState !== "rejected" &&
        !entry.voidedAt &&
        entry.effectiveDate.startsWith(month),
    )
    .reduce(
      (sum, entry) =>
        sum + (entry.allocations.find((allocation) => allocation.participantId === participantId)?.shareAmount ?? 0),
      0,
    );
}

export type ContextNet = {
  contextId: string;
  netBalance: number;
};

// My net position per shared context I'm an active member of; positive means
// the context owes me.
export function myNetByContext(
  contexts: ContextRecord[],
  memberships: Membership[],
  entries: LedgerEntry[],
  participants: Participant[],
  participantId: string,
): ContextNet[] {
  return contexts
    .filter(
      (context) =>
        context.type === "shared" &&
        memberships.some(
          (membership) =>
            membership.contextId === context.contextId &&
            membership.participantId === participantId &&
            !membership.leftAt,
        ),
    )
    .map((context) => {
      const contextEntries = entries.filter((entry) => entry.contextId === context.contextId);
      const contextMemberships = memberships.filter((membership) => membership.contextId === context.contextId);
      // Balances only ever sum one currency, same rule the context balance
      // views apply (unified-expense-os-crh). Note the cross-context roll-up
      // in owedSummary still adds these nets together regardless of each
      // context's currency — a known limitation, not fixed here.
      const { primaryEntries } = partitionByCurrency(contextEntries);
      const balances = deriveBalances(primaryEntries, participants, contextMemberships);
      return {
        contextId: context.contextId,
        netBalance: balances.find((row) => row.participantId === participantId)?.netBalance ?? 0,
      };
    });
}

export function owedSummary(nets: ContextNet[]): { owedToMe: number; iOwe: number } {
  let owedToMe = 0;
  let iOwe = 0;
  for (const net of nets) {
    if (net.netBalance > 0) {
      owedToMe += net.netBalance;
    } else {
      iOwe += -net.netBalance;
    }
  }
  return { owedToMe, iOwe };
}

// Most recently used payers within a context, newest first, capped and
// restricted to currently active members (a payer may have left since).
export function recentPayerIds(entries: LedgerEntry[], memberIds: string[], limit = 3): string[] {
  const activeIds = new Set(memberIds);
  const sorted = [...entries].sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const entry of sorted) {
    if (entry.type !== "expense" || !activeIds.has(entry.payerId) || seen.has(entry.payerId)) {
      continue;
    }
    seen.add(entry.payerId);
    ordered.push(entry.payerId);
  }
  return ordered.slice(0, limit);
}

export function participantName(participants: Participant[], participantId: string) {
  return participants.find((participant) => participant.participantId === participantId)?.displayName ?? participantId;
}

export type TimeFrame = "week" | "month" | "year" | "custom";

// Formats a YYYY-MM-DD string purely from local date components, never
// through toISOString() — that converts to UTC first and silently shifts
// the date in any non-zero-offset timezone (e.g. IST, UTC+5:30).
export function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Adds `days` to a YYYY-MM-DD string, returning YYYY-MM-DD. Parsed/formatted
// as local dates throughout so no UTC conversion can shift the result.
function addDays(dateString: string, days: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return localDateString(date);
}

// [start, end) in YYYY-MM-DD, comparable directly against entry.effectiveDate.
export function timeFrameRange(frame: TimeFrame, now = new Date(), custom?: { start: string; end: string }) {
  if (frame === "custom" && custom) {
    // custom.end is inclusive from the caller's perspective (a date picker's
    // "to" field); bump it by a day to match the exclusive-end filter below.
    return { start: custom.start, end: addDays(custom.end, 1) };
  }
  const today = localDateString(now);
  const end = addDays(today, 1);
  let start: string;
  if (frame === "week") {
    start = addDays(today, -7);
  } else if (frame === "month") {
    start = addDays(today, -30);
  } else {
    start = addDays(today, -365);
  }
  return { start, end };
}

export type CategoryBreakdown = {
  category: string;
  total: number;
  count: number;
};

export type ReportSummary = {
  totalSpent: number;
  entryCount: number;
  byCategory: CategoryBreakdown[];
  byMember: MemberSpend[];
  monthOverMonth: MonthTotal[];
  largestEntries: LargestEntry[];
  settlementTotal: number;
};

export type MonthTotal = {
  month: string; // YYYY-MM
  total: number;
};

export type LargestEntry = {
  entryId: string;
  description: string;
  category: string | null;
  totalAmount: number;
  effectiveDate: string;
};

// Trailing 6 calendar months of expense totals ending at `now`'s month, so a
// short custom range still shows the surrounding trend rather than just the
// selected window.
export function monthOverMonthTrend(entries: LedgerEntry[], now = new Date(), months = 6): MonthTotal[] {
  const buckets = new Map<string, number>();
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    keys.push(key);
    buckets.set(key, 0);
  }
  for (const entry of entries) {
    if (entry.type !== "expense" || entry.syncState === "rejected" || entry.voidedAt) {
      continue;
    }
    const key = entry.effectiveDate.slice(0, 7);
    if (buckets.has(key)) {
      buckets.set(key, (buckets.get(key) ?? 0) + entry.totalAmount);
    }
  }
  const trend = keys.map((month) => ({ month, total: buckets.get(month) ?? 0 }));
  // Drop leading zero months before the context's first spend — a young
  // context otherwise shows a wall of "0" rows with no useful trend to read
  // (unified-expense-os-0fj). A context with no spend at all still gets one
  // row (the current month) rather than an empty list.
  const firstActiveIndex = trend.findIndex((row) => row.total > 0);
  return firstActiveIndex === -1 ? trend.slice(-1) : trend.slice(firstActiveIndex);
}

// Time-boxed spend/share breakdown for a context: total, per-category, and
// per-member (reusing memberSpendSummary's spent/paid semantics), restricted
// to entries whose effective_date falls in [start, end).
export function reportSummary(
  entries: LedgerEntry[],
  participants: Participant[],
  memberships: Membership[],
  range: { start: string; end: string },
): ReportSummary {
  const inRange = entries.filter(
    (entry) =>
      entry.type === "expense" &&
      entry.syncState !== "rejected" &&
      !entry.voidedAt &&
      entry.effectiveDate >= range.start &&
      entry.effectiveDate < range.end,
  );

  const byCategory = new Map<string, CategoryBreakdown>();
  let totalSpent = 0;
  for (const entry of inRange) {
    const key = entry.category?.trim() || "uncategorized";
    const row = byCategory.get(key) ?? { category: key, total: 0, count: 0 };
    row.total += entry.totalAmount;
    row.count += 1;
    byCategory.set(key, row);
    totalSpent += entry.totalAmount;
  }

  const largestEntries: LargestEntry[] = [...inRange]
    .sort((left, right) => right.totalAmount - left.totalAmount)
    .slice(0, 5)
    .map((entry) => ({
      entryId: entry.entryId,
      description: entry.description,
      category: entry.category ?? null,
      totalAmount: entry.totalAmount,
      effectiveDate: entry.effectiveDate,
    }));

  const settlementTotal = entries
    .filter(
      (entry) =>
        entry.type === "settlement" &&
        entry.syncState !== "rejected" &&
        !entry.voidedAt &&
        entry.effectiveDate >= range.start &&
        entry.effectiveDate < range.end,
    )
    .reduce((sum, entry) => sum + entry.totalAmount, 0);

  return {
    totalSpent,
    entryCount: inRange.length,
    byCategory: Array.from(byCategory.values()).sort((left, right) => right.total - left.total),
    byMember: memberSpendSummary(inRange, participants, memberships),
    monthOverMonth: monthOverMonthTrend(entries),
    largestEntries,
    settlementTotal,
  };
}
