import { describe, expect, it } from "vitest";
import { detectRecurringCandidates } from "./recurringDetect";

describe("detectRecurringCandidates", () => {
  it("detects an exact monthly repeat", () => {
    const candidates = detectRecurringCandidates([
      { date: "2026-01-01", description: "Rent", amountPaise: 5000000, paidBy: "Alice" },
      { date: "2026-02-01", description: "Rent", amountPaise: 5000000, paidBy: "Alice" },
      { date: "2026-03-01", description: "Rent", amountPaise: 5000000, paidBy: "Alice" },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      description: "Rent",
      paidBy: "Alice",
      amountPaise: 5000000,
      anchorDay: 1,
      occurrences: 3,
    });
  });

  it("does not detect a weekly repeat as monthly (spacing outside window)", () => {
    const candidates = detectRecurringCandidates([
      { date: "2026-01-01", description: "Coffee club", amountPaise: 40000, paidBy: "Bob" },
      { date: "2026-01-08", description: "Coffee club", amountPaise: 40000, paidBy: "Bob" },
      { date: "2026-01-15", description: "Coffee club", amountPaise: 40000, paidBy: "Bob" },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it("does not flag a genuinely one-off item even if similarly priced", () => {
    const candidates = detectRecurringCandidates([
      { date: "2026-01-05", description: "Concert tickets", amountPaise: 250000, paidBy: "Cara" },
      { date: "2026-04-12", description: "Flight upgrade", amountPaise: 250000, paidBy: "Cara" },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it("tolerates small amount variation across occurrences", () => {
    const candidates = detectRecurringCandidates([
      { date: "2026-01-10", description: "Electricity", amountPaise: 120000, paidBy: "Dev" },
      { date: "2026-02-10", description: "Electricity", amountPaise: 120800, paidBy: "Dev" },
      { date: "2026-03-10", description: "Electricity", amountPaise: 120200, paidBy: "Dev" },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].occurrences).toBe(3);
  });

  it("rejects amount variation beyond tolerance", () => {
    const candidates = detectRecurringCandidates([
      { date: "2026-01-10", description: "Groceries", amountPaise: 100000, paidBy: "Eve" },
      { date: "2026-02-10", description: "Groceries", amountPaise: 300000, paidBy: "Eve" },
      { date: "2026-03-10", description: "Groceries", amountPaise: 500000, paidBy: "Eve" },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it("requires at least two occurrences", () => {
    const candidates = detectRecurringCandidates([
      { date: "2026-01-10", description: "One time thing", amountPaise: 10000, paidBy: "Fay" },
    ]);
    expect(candidates).toHaveLength(0);
  });
});
