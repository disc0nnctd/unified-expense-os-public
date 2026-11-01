import { describe, expect, it } from "vitest";
import { computeBudgetProgress } from "./budgets";
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
    category: "groceries",
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

describe("computeBudgetProgress", () => {
  const now = new Date(2026, 6, 15);

  it("computes spend fraction against target for the current month only", () => {
    const entries = [
      entry({ entryId: "e1", totalAmount: 6000 }),
      entry({ entryId: "e2", effectiveDate: "2026-06-01", totalAmount: 9000 }), // different month
    ];
    const progress = computeBudgetProgress(entries, { groceries: 10000 }, now);
    expect(progress).toEqual([{ category: "groceries", targetPaise: 10000, spentPaise: 6000, fraction: 0.6 }]);
  });

  it("ignores categories with no target set", () => {
    const entries = [entry({ category: "rent" })];
    expect(computeBudgetProgress(entries, {}, now)).toEqual([]);
  });

  it("shows overage when spend exceeds target", () => {
    const entries = [entry({ totalAmount: 15000 })];
    const progress = computeBudgetProgress(entries, { groceries: 10000 }, now);
    expect(progress[0].fraction).toBeGreaterThan(1);
  });
});
