import { formatMoneyIn, partitionByCurrency } from "./currencies";
import {
  deriveBalances,
  memberSpendSummary,
  myNetByContext,
  owedSummary,
  participantName,
  reportSummary,
  timeFrameRange,
  type TimeFrame,
} from "./finance";
import type { ContextRecord, LedgerEntry, Membership, Participant } from "../types";

// Q&A over the ledger is intentionally NOT an LLM doing arithmetic: this
// module parses a small set of question shapes into a deterministic query
// (metric + timeframe + optional category/person filter) and answers it by
// calling the same finance.ts functions the Reports UI already uses. If a
// future pass adds an LLM, its only job may be turning fuzzier phrasing into
// one of these same structured intents — it must never compute the number
// itself. This keeps the model out of ledger authority, per the plan doc.

type Metric = "total_spend" | "member_spend" | "owed_to_me" | "i_owe" | "category_spend";

type QueryIntent = {
  metric: Metric;
  timeFrame: TimeFrame;
  category?: string;
  memberName?: string;
};

const TIMEFRAME_PATTERNS: { pattern: RegExp; frame: TimeFrame }[] = [
  { pattern: /\bthis week\b/i, frame: "week" },
  { pattern: /\blast 7 days\b/i, frame: "week" },
  { pattern: /\bthis month\b/i, frame: "month" },
  { pattern: /\blast 30 days\b/i, frame: "month" },
  { pattern: /\bthis year\b/i, frame: "year" },
  { pattern: /\blast 12 months\b/i, frame: "year" },
];

function detectTimeFrame(text: string): TimeFrame {
  for (const { pattern, frame } of TIMEFRAME_PATTERNS) {
    if (pattern.test(text)) {
      return frame;
    }
  }
  return "month"; // default window when unspecified
}

function detectCategory(text: string, knownCategories: string[]): string | undefined {
  const match = text.match(/\bon\s+([a-z][a-z ]{1,30}?)(?:\s+this\b|\s+last\b|\?|$)/i);
  const candidate = match?.[1]?.trim().toLowerCase();
  if (candidate && knownCategories.includes(candidate)) {
    return candidate;
  }
  return undefined;
}

function detectMemberName(text: string, participants: Participant[]): string | undefined {
  const match = text.match(/how much did\s+([a-z][a-z]{1,20})\s+(?:spend|pay)/i);
  const candidate = match?.[1]?.trim().toLowerCase();
  if (!candidate || ["i", "we"].includes(candidate)) {
    return undefined;
  }
  const found = participants.find((participant) => participant.displayName.toLowerCase() === candidate);
  return found?.displayName;
}

export function parseQuestion(
  text: string,
  participants: Participant[],
  knownCategories: string[],
): QueryIntent | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const timeFrame = detectTimeFrame(normalized);

  if (/\bowed to me\b|\bam i owed\b/.test(normalized)) {
    return { metric: "owed_to_me", timeFrame };
  }
  if (/\bdo i owe\b|\bi owe\b/.test(normalized)) {
    return { metric: "i_owe", timeFrame };
  }

  const category = detectCategory(normalized, knownCategories);
  if (category) {
    return { metric: "category_spend", timeFrame, category };
  }

  const memberName = detectMemberName(normalized, participants);
  if (memberName) {
    return { metric: "member_spend", timeFrame, memberName };
  }

  if (/how much (did we|have we) spen[dt]|total spend/.test(normalized)) {
    return { metric: "total_spend", timeFrame };
  }

  return null;
}

export type QaAnswer = {
  text: string;
  timeFrame: TimeFrame;
};

const FRAME_LABEL: Record<TimeFrame, string> = {
  week: "the last 7 days",
  month: "the last 30 days",
  year: "the last 12 months",
  custom: "the selected range",
};

export function answerQuestion(
  question: string,
  entries: LedgerEntry[],
  participants: Participant[],
  memberships: Membership[],
  now = new Date(),
): QaAnswer | null {
  const knownCategories = Array.from(
    new Set(entries.map((entry) => entry.category?.trim().toLowerCase()).filter((value): value is string => !!value)),
  );
  const intent = parseQuestion(question, participants, knownCategories);
  if (!intent) {
    return null;
  }
  const range = timeFrameRange(intent.timeFrame, now);
  const frameLabel = FRAME_LABEL[intent.timeFrame];

  if (intent.metric === "owed_to_me" || intent.metric === "i_owe") {
    // Net position is a point-in-time derived balance, not time-boxed —
    // deliberately ignores the parsed timeframe.
    return null; // requires per-context balances the caller must supply; see ContextScreen wiring
  }

  // Spend answers must not sum across currencies — a USD entry would inflate
  // a total quoted with a ₹ sign. Report on the primary-currency entries and
  // say so when others were left out, exactly as the balance path does
  // (unified-expense-os-crh).
  const { primaryEntries, primaryCurrency, otherEntries } = partitionByCurrency(entries);
  const summary = reportSummary(primaryEntries, participants, memberships, range);
  const otherNote =
    otherEntries.length > 0
      ? ` (excludes ${otherEntries.length} ${otherEntries.length === 1 ? "entry" : "entries"} in other currencies)`
      : "";
  const money = (amount: number) => formatMoneyIn(primaryCurrency, amount);

  if (intent.metric === "total_spend") {
    return {
      text: `You spent ${money(summary.totalSpent)} in total over ${frameLabel}${otherNote}.`,
      timeFrame: intent.timeFrame,
    };
  }

  if (intent.metric === "category_spend" && intent.category) {
    const row = summary.byCategory.find((entry) => entry.category === intent.category);
    const amount = row?.total ?? 0;
    return {
      text: `You spent ${money(amount)} on ${intent.category} over ${frameLabel} (${row?.count ?? 0} ${row?.count === 1 ? "entry" : "entries"})${otherNote}.`,
      timeFrame: intent.timeFrame,
    };
  }

  if (intent.metric === "member_spend" && intent.memberName) {
    const member = participants.find((participant) => participant.displayName === intent.memberName);
    const row = member ? summary.byMember.find((entry) => entry.participantId === member.participantId) : undefined;
    return {
      text: `${intent.memberName} spent ${money(row?.spent ?? 0)} over ${frameLabel}${otherNote}.`,
      timeFrame: intent.timeFrame,
    };
  }

  return null;
}

// Balance-position questions ("how much do I owe") need per-context
// balances, not a time-boxed report, so they're answered separately here
// rather than forcing reportSummary to compute something it doesn't model.
export function answerBalanceQuestion(
  question: string,
  contexts: ContextRecord[],
  memberships: Membership[],
  entries: LedgerEntry[],
  participants: Participant[],
  participantId: string,
): QaAnswer | null {
  const normalized = question.trim().toLowerCase();
  // Full breakdown ("who owes how much", "who owes whom", "everyone's
  // balances") — per shared context, per person, same deriveBalances the
  // Balances tab uses. Checked before the personal net so "who owes…"
  // doesn't get swallowed by the `\bi owe\b` substring.
  if (/\bwho owes\b|\bowes (?:whom|who|how much|what)\b|\bbalances? breakdown\b|\beveryone'?s balances?\b/.test(normalized)) {
    const parts: string[] = [];
    for (const context of contexts) {
      if (context.type !== "shared" || context.archivedAt || context.closedAt) {
        continue;
      }
      const contextEntries = entries.filter((entry) => entry.contextId === context.contextId);
      if (contextEntries.length === 0) {
        continue;
      }
      const contextMemberships = memberships.filter((membership) => membership.contextId === context.contextId);
      // Balances only ever sum one currency (lib/currencies.ts invariant).
      const { primaryEntries, primaryCurrency } = partitionByCurrency(contextEntries);
      const rows = deriveBalances(primaryEntries, participants, contextMemberships).filter(
        (row) => row.netBalance !== 0,
      );
      if (rows.length === 0) {
        parts.push(`${context.name}: all settled`);
        continue;
      }
      const fragments = rows.map((row) => {
        const isMe = row.participantId === participantId;
        const name = isMe ? "you" : participantName(participants, row.participantId);
        return row.netBalance < 0
          ? `${name} owe${isMe ? "" : "s"} ${formatMoneyIn(primaryCurrency, -row.netBalance)}`
          : `${name} ${isMe ? "are" : "is"} owed ${formatMoneyIn(primaryCurrency, row.netBalance)}`;
      });
      parts.push(`${context.name}: ${fragments.join(", ")}`);
    }
    if (parts.length === 0) {
      return { text: "No shared balances yet — nothing is owed in any direction.", timeFrame: "custom" };
    }
    return { text: `${parts.join(". ")}.`, timeFrame: "custom" };
  }
  const asksOwedToMe = /\bowed to me\b|\bam i owed\b/.test(normalized);
  const asksIOwe = /\bdo i owe\b|\bi owe\b/.test(normalized);
  if (!asksOwedToMe && !asksIOwe) {
    return null;
  }
  const nets = myNetByContext(contexts, memberships, entries, participants, participantId);
  const { owedToMe, iOwe } = owedSummary(nets);
  if (asksOwedToMe) {
    return { text: `You are owed ${formatRupees(owedToMe)} across your shared contexts right now.`, timeFrame: "custom" };
  }
  return { text: `You owe ${formatRupees(iOwe)} across your shared contexts right now.`, timeFrame: "custom" };
}

function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// Exported for callers that want the participant name resolved defensively.
export function resolveParticipantName(participants: Participant[], participantId: string): string {
  return participantName(participants, participantId);
}
