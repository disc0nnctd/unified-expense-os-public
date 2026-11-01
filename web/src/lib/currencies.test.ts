import { describe, expect, it } from "vitest";
import { formatMoneyIn, partitionByCurrency, summarizeOtherCurrencies } from "./currencies";
import type { LedgerEntry } from "../types";

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    entryId: "e1",
    contextId: "ctx-home",
    type: "expense",
    recordedAt: "2026-07-10T10:00:00.000Z",
    effectiveDate: "2026-07-10",
    payerId: "alice",
    totalAmount: 1000,
    currency: "INR",
    description: "Test",
    allocations: [
      { participantId: "alice", shareAmount: 500, isPayer: true },
      { participantId: "bob", shareAmount: 500, isPayer: false },
    ],
    version: 1,
    hlc: "1-0-alice",
    syncState: "committed",
    ...overrides,
  };
}

describe("formatMoneyIn", () => {
  it("formats known currencies with their symbol", () => {
    expect(formatMoneyIn("USD", 150000)).toBe("$1,500");
    expect(formatMoneyIn("INR", 150050)).toBe("₹1,500.50");
  });

  it("falls back to the currency code for unknown currencies", () => {
    expect(formatMoneyIn("JPY", 100000)).toBe("JPY 1,000");
  });
});

describe("partitionByCurrency", () => {
  it("picks the dominant currency by entry count and separates the rest", () => {
    const entries = [
      entry({ entryId: "e1", currency: "INR" }),
      entry({ entryId: "e2", currency: "INR" }),
      entry({ entryId: "e3", currency: "USD" }),
    ];
    const partition = partitionByCurrency(entries);
    expect(partition.primaryCurrency).toBe("INR");
    expect(partition.primaryEntries.map((e) => e.entryId)).toEqual(["e1", "e2"]);
    expect(partition.otherEntries.map((e) => e.entryId)).toEqual(["e3"]);
  });

  it("never drops non-primary-currency entries", () => {
    const entries = [entry({ entryId: "e1", currency: "USD" })];
    const partition = partitionByCurrency(entries, "INR");
    expect(partition.otherEntries).toHaveLength(1);
    expect(partition.primaryEntries).toHaveLength(0);
  });
});

describe("summarizeOtherCurrencies", () => {
  it("totals non-primary currency entries per currency, excluding voided/rejected", () => {
    const entries = [
      entry({ entryId: "e1", currency: "USD", totalAmount: 500 }),
      entry({ entryId: "e2", currency: "USD", totalAmount: 300 }),
      entry({ entryId: "e3", currency: "EUR", totalAmount: 200, voidedAt: "2026-07-11T00:00:00.000Z" }),
    ];
    expect(summarizeOtherCurrencies(entries)).toEqual([{ currency: "USD", totalPaise: 800, count: 2 }]);
  });
});
