import type { LedgerEntry } from "../types";

// Scoped multi-currency slice: entries can be recorded in any supported
// currency (LedgerEntry.currency already exists server-side), but balances,
// spend summaries, and reports only ever sum entries that share one
// currency — mixing currencies into a single balance would silently
// misrepresent what's owed, which is worse than not supporting the feature.
// Entries in a non-primary currency are surfaced separately (never hidden)
// rather than converted automatically; "manual/locked rates" from the plan
// doc are represented as an informational-only conversion for display, not
// as something balances/settlement math depends on.
export const SUPPORTED_CURRENCIES = ["INR", "USD", "EUR", "GBP"] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

const SYMBOLS: Record<string, string> = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };

// Deterministic currency identification for capture text (voice, chat, UPI
// paste). Symbols/codes/words only — ambiguous slang ("bucks") deliberately
// maps to nothing so the review UI asks instead of guessing.
const CURRENCY_MARKERS: [RegExp, CurrencyCode][] = [
  [/₹|\brs\.?(?=\s|\d|$)|\binr\b|\brupees?\b/i, "INR"],
  [/\$|\busd\b|\bdollars?\b/i, "USD"],
  [/€|\beur\b|\beuros?\b/i, "EUR"],
  [/£|\bgbp\b|\bpounds?\b|\bquid\b/i, "GBP"],
];

export function detectCurrency(text: string): CurrencyCode | null {
  for (const [pattern, code] of CURRENCY_MARKERS) {
    if (pattern.test(text)) {
      return code;
    }
  }
  return null;
}

export function isSupportedCurrency(code: string | null | undefined): code is CurrencyCode {
  return !!code && (SUPPORTED_CURRENCIES as readonly string[]).includes(code);
}

export function formatMoneyIn(currency: string, paise: number): string {
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  const hasFraction = paise % 100 !== 0;
  const amount = (paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `${symbol}${amount}`;
}

export type CurrencyPartition = {
  primaryCurrency: string;
  primaryEntries: LedgerEntry[];
  otherEntries: LedgerEntry[]; // never dropped, just excluded from primary-currency totals
};

// Splits entries into the dominant currency (by entry count) and everything
// else, so balance/spend/report math only ever runs over a single currency.
export function partitionByCurrency(entries: LedgerEntry[], preferredCurrency?: string): CurrencyPartition {
  if (entries.length === 0) {
    return { primaryCurrency: preferredCurrency ?? "INR", primaryEntries: [], otherEntries: [] };
  }
  let primaryCurrency = preferredCurrency;
  if (!primaryCurrency) {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      counts.set(entry.currency, (counts.get(entry.currency) ?? 0) + 1);
    }
    primaryCurrency = [...counts.entries()].sort((left, right) => right[1] - left[1])[0][0];
  }
  const primaryEntries = entries.filter((entry) => entry.currency === primaryCurrency);
  const otherEntries = entries.filter((entry) => entry.currency !== primaryCurrency);
  return { primaryCurrency, primaryEntries, otherEntries };
}

export type OtherCurrencyTotal = {
  currency: string;
  totalPaise: number;
  count: number;
};

export function summarizeOtherCurrencies(otherEntries: LedgerEntry[]): OtherCurrencyTotal[] {
  const totals = new Map<string, OtherCurrencyTotal>();
  for (const entry of otherEntries) {
    if (entry.syncState === "rejected" || entry.voidedAt) {
      continue;
    }
    const row = totals.get(entry.currency) ?? { currency: entry.currency, totalPaise: 0, count: 0 };
    row.totalPaise += entry.totalAmount;
    row.count += 1;
    totals.set(entry.currency, row);
  }
  return Array.from(totals.values());
}
