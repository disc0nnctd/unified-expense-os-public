import type { LedgerEntry } from "../types";

// All of this module is deterministic, on-device statistics over the local
// ledger snapshot — no ML, no network calls, no writes. Every function here
// only ever *suggests*; the caller decides whether to apply it, and the user
// still has to hit "Save" for anything to reach the ledger.

// --- Payee extraction --------------------------------------------------
//
// Payee is a landlord/merchant named in free text ("rent to Sharma"), which is
// conceptually distinct from split *participants* (context members). This is
// parsed at display/prefill time from the description string rather than
// stored as its own ledger field — adding a stored column would mean a
// backend schema + sync round-trip for a value we can already recover
// losslessly from the text whenever we need it.
const PAYEE_PATTERNS = [/\bpaid to\s+([a-z][a-z .]{1,40})$/i, /\bto\s+([a-z][a-z .]{1,40})$/i, /\bfor\s+([a-z][a-z .]{1,40})$/i];

export function extractPayee(description: string): string | null {
  const trimmed = description.trim();
  for (const pattern of PAYEE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      const name = match[1].trim().replace(/\s+/g, " ");
      if (name.length > 0) {
        return name;
      }
    }
  }
  return null;
}

// --- UPI / SMS paste parsing --------------------------------------------
//
// Scoped to a handful of common Indian bank/UPI notification shapes seen in
// practice: "Rs.500.00 debited ... to VPA john@okhdfcbank ...", "You have
// paid Rs 500 to John via UPI", "INR 500.00 sent to John on 12-07-26". The
// long tail of bank-specific SMS formats is a follow-up, not this pass.
export type UpiParseResult = {
  amountPaise: number;
  payee: string | null;
  effectiveDate: string | null;
};

const UPI_AMOUNT_PATTERNS = [/(?:rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i];
const UPI_PAYEE_PATTERNS = [
  /(?:to|paid to)\s+(?:vpa\s+)?([a-z0-9][a-z0-9 .@_-]{1,60}?)(?:\s+(?:on|via|from)\b|[.,]|$)/i,
];
const UPI_DATE_PATTERN = /\bon\s+(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/i;

export function parseUpiPaste(text: string): UpiParseResult | null {
  const amountMatch = text.match(UPI_AMOUNT_PATTERNS[0]);
  if (!amountMatch) {
    return null;
  }
  const numeric = amountMatch[1].replace(/,/g, "");
  const [rupees, fraction = ""] = numeric.split(".");
  const amountPaise = Number(rupees) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
    return null;
  }

  let payee: string | null = null;
  for (const pattern of UPI_PAYEE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      payee = match[1].trim().replace(/\s+/g, " ");
      break;
    }
  }

  let effectiveDate: string | null = null;
  const dateMatch = text.match(UPI_DATE_PATTERN);
  if (dateMatch) {
    const [, day, month, yearRaw] = dateMatch;
    const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
    effectiveDate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  return { amountPaise, payee, effectiveDate };
}

// --- Payment-SMS auto-read classification ---------------------------------
//
// Native Android can hand us the recent inbox (see lib/smsReader.ts). This
// layer is pure, deterministic, and testable: it decides which messages look
// like a *money-out* payment notification, then reuses parseUpiPaste to pull
// amount/payee/date. It only ever produces a *candidate* the user reviews and
// taps to prefill the form — nothing here writes to the ledger, matching the
// assist-only rule in docs/capture-foundation-home-dup.md.
export type SmsMessage = {
  sender: string;
  body: string;
  receivedAt: number; // epoch millis
};

// Money-out language across common Indian bank/UPI alert shapes. We only
// suggest debits as expenses; credits/refunds are income and skipped so we
// don't nag the user to "split" money they received.
const SMS_DEBIT_KEYWORDS = /\b(debited|spent|paid|sent|withdrawn|purchase|deducted)\b/i;
const SMS_CREDIT_KEYWORDS = /\b(credited|received|deposited|refund(?:ed)?|cashback)\b/i;
// OTP / promotional noise that happens to contain "Rs" but is not a txn.
const SMS_NON_TXN_KEYWORDS = /\b(otp|one[\s-]?time\s+password|do not share|offer|sale|discount|reward points|emi due|will be debited|has been requested|requesting|collect request)\b/i;

export type SmsDirection = "debit" | "credit";

// Returns the money direction of a transactional SMS, or null when the body
// doesn't look like a real payment alert (no amount, OTP/promo, or a future
// "will be debited" mandate rather than a completed txn).
export function classifyPaymentSms(body: string): SmsDirection | null {
  if (SMS_NON_TXN_KEYWORDS.test(body)) {
    return null;
  }
  if (!UPI_AMOUNT_PATTERNS[0].test(body)) {
    return null;
  }
  // A debit keyword wins even if a credit word also appears (e.g. "debited ...
  // avl bal credited"), because the txn itself is the outflow.
  if (SMS_DEBIT_KEYWORDS.test(body)) {
    return "debit";
  }
  if (SMS_CREDIT_KEYWORDS.test(body)) {
    return "credit";
  }
  return null;
}

export type SmsExpenseCandidate = UpiParseResult & {
  sender: string;
  receivedAt: number;
  body: string;
};

// Filters an inbox snapshot to debit-only payment SMS and parses each into a
// prefill candidate. Sorted most-recent-first and de-duplicated on
// amount+payee so a bank's "debit" + "e-statement" pair doesn't show twice.
export function suggestExpensesFromSms(messages: SmsMessage[]): SmsExpenseCandidate[] {
  const candidates: SmsExpenseCandidate[] = [];
  for (const message of messages) {
    if (classifyPaymentSms(message.body) !== "debit") {
      continue;
    }
    const parsed = parseUpiPaste(message.body);
    if (!parsed) {
      continue;
    }
    candidates.push({ ...parsed, sender: message.sender, receivedAt: message.receivedAt, body: message.body });
  }
  candidates.sort((left, right) => right.receivedAt - left.receivedAt);
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.amountPaise}|${(candidate.payee ?? "").toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// --- Shared history-lookup key --------------------------------------------

function historyKey(entry: Pick<LedgerEntry, "description" | "category">): string {
  const category = entry.category?.trim().toLowerCase();
  if (category) {
    return `cat:${category}`;
  }
  return `desc:${entry.description.trim().toLowerCase()}`;
}

function matchingHistory(entries: LedgerEntry[], description: string, category: string | null): LedgerEntry[] {
  const key = category?.trim() ? `cat:${category.trim().toLowerCase()}` : `desc:${description.trim().toLowerCase()}`;
  return entries.filter(
    (entry) => entry.type === "expense" && entry.syncState !== "rejected" && !entry.voidedAt && historyKey(entry) === key,
  );
}

// --- Participant co-occurrence profiles ---------------------------------
//
// For a given category (or, lacking one, exact description match), find who
// has historically been included in the split, e.g. "groceries -> you+Ravi
// 14/15 times". Only surfaces a suggestion when there's enough history and
// one participant set clearly dominates, so it doesn't nag on noise.
export type CoOccurrenceSuggestion = {
  participantIds: string[];
  occurrences: number;
  total: number;
  reason: string;
};

export function coOccurrenceSuggestion(
  entries: LedgerEntry[],
  description: string,
  category: string | null,
  minSamples = 3,
): CoOccurrenceSuggestion | null {
  const history = matchingHistory(entries, description, category);
  if (history.length < minSamples) {
    return null;
  }
  const counts = new Map<string, number>();
  for (const entry of history) {
    const ids = [...new Set(entry.allocations.map((allocation) => allocation.participantId))].sort();
    const key = ids.join(",");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [bestKey, bestCount] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  if (bestCount < minSamples || bestCount / history.length < 0.5) {
    return null;
  }
  const participantIds = bestKey.split(",").filter(Boolean);
  const label = category?.trim() || description.trim();
  return {
    participantIds,
    occurrences: bestCount,
    total: history.length,
    reason: `"${label}" split this way ${bestCount}/${history.length} times`,
  };
}

// --- Split-shape memory ---------------------------------------------------
//
// Remembers the last-used *ratio* of shares (not absolute amounts) for a
// description/category, so a new amount still gets a sensible split, e.g.
// "biryani -> 60/40" applied to a different total.
export type SplitShapeSuggestion = {
  ratios: Record<string, number>; // participantId -> fraction of total, sums to ~1
  reason: string;
};

export function splitShapeMemory(
  entries: LedgerEntry[],
  description: string,
  category: string | null,
): SplitShapeSuggestion | null {
  const history = matchingHistory(entries, description, category)
    .filter((entry) => entry.totalAmount > 0)
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
  const last = history[0];
  if (!last) {
    return null;
  }
  // Only worth remembering if the split wasn't a plain equal split.
  const shareAmounts = last.allocations.map((allocation) => allocation.shareAmount);
  const allEqual = shareAmounts.every((amount) => amount === shareAmounts[0]);
  if (allEqual) {
    return null;
  }
  const ratios: Record<string, number> = {};
  for (const allocation of last.allocations) {
    ratios[allocation.participantId] = allocation.shareAmount / last.totalAmount;
  }
  const label = category?.trim() || description.trim();
  const parts = last.allocations
    .map((allocation) => `${Math.round((allocation.shareAmount / last.totalAmount) * 100)}%`)
    .join("/");
  return { ratios, reason: `Last "${label}" split ${parts} — apply the same ratio?` };
}

// --- Recurring auto-detection ---------------------------------------------
//
// Same payer + description, amount within +-5%, on a day-of-month that
// stays within +-3 days across 3+ occurrences -> offer a one-tap template.
// The "tap" is the user confirmation; nothing here writes a template itself.
export type RecurringCandidate = {
  description: string;
  category: string | null;
  payerId: string;
  amountPaise: number;
  anchorDay: number;
  occurrences: number;
};

export function detectRecurringCandidates(entries: LedgerEntry[], minOccurrences = 3): RecurringCandidate[] {
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    if (entry.type !== "expense" || entry.syncState === "rejected" || entry.voidedAt) {
      continue;
    }
    const key = `${entry.payerId}|${entry.description.trim().toLowerCase()}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(entry);
    groups.set(key, bucket);
  }

  const candidates: RecurringCandidate[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length < minOccurrences) {
      continue;
    }
    const sorted = [...bucket].sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate));
    const days = sorted.map((entry) => Number(entry.effectiveDate.split("-")[2]));
    const anchorDay = Math.round(days.reduce((sum, day) => sum + day, 0) / days.length);
    const stableDay = days.every((day) => Math.abs(day - anchorDay) <= 3);
    if (!stableDay) {
      continue;
    }
    const amounts = sorted.map((entry) => entry.totalAmount);
    const avgAmount = amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length;
    const stableAmount = amounts.every((amount) => Math.abs(amount - avgAmount) / avgAmount <= 0.05);
    if (!stableAmount) {
      continue;
    }
    const last = sorted[sorted.length - 1];
    candidates.push({
      description: last.description,
      category: last.category ?? null,
      payerId: last.payerId,
      amountPaise: Math.round(avgAmount),
      anchorDay,
      occurrences: sorted.length,
    });
  }
  return candidates;
}
