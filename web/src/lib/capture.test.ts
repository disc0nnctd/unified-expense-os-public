import { describe, expect, it } from "vitest";
import {
  classifyPaymentSms,
  coOccurrenceSuggestion,
  detectRecurringCandidates,
  extractPayee,
  parseUpiPaste,
  splitShapeMemory,
  suggestExpensesFromSms,
} from "./capture";
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
    description: "Groceries",
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

describe("extractPayee", () => {
  it("extracts a name after 'to'", () => {
    expect(extractPayee("rent to Sharma")).toBe("Sharma");
  });

  it("extracts a name after 'paid to'", () => {
    expect(extractPayee("paid to Landlord Kumar")).toBe("Landlord Kumar");
  });

  it("returns null when there is no payee phrase", () => {
    expect(extractPayee("Groceries")).toBeNull();
  });
});

describe("parseUpiPaste", () => {
  it("parses a typical debit SMS", () => {
    const result = parseUpiPaste("Rs.500.00 debited from A/c XX1234 to VPA john@okhdfcbank on 12-07-26");
    expect(result?.amountPaise).toBe(50000);
    expect(result?.payee).toBe("john@okhdfcbank");
    expect(result?.effectiveDate).toBe("2026-07-12");
  });

  it("parses 'you have paid' phrasing", () => {
    const result = parseUpiPaste("You have paid Rs 500 to John via UPI");
    expect(result?.amountPaise).toBe(50000);
    expect(result?.payee).toBe("John");
  });

  it("returns null when no amount is present", () => {
    expect(parseUpiPaste("Hello there")).toBeNull();
  });
});

describe("classifyPaymentSms", () => {
  it("classifies a debit alert as debit", () => {
    expect(classifyPaymentSms("Rs.500.00 debited from A/c XX1234 to VPA john@okhdfcbank on 12-07-26")).toBe("debit");
  });

  it("classifies a credit alert as credit", () => {
    expect(classifyPaymentSms("INR 1200 credited to your A/c XX1234 by NEFT")).toBe("credit");
  });

  it("prefers debit when both words appear (outflow is the txn)", () => {
    expect(classifyPaymentSms("Rs 200 debited; avl bal after last credited is Rs 1000")).toBe("debit");
  });

  it("ignores OTP messages even if they mention Rs", () => {
    expect(classifyPaymentSms("123456 is your OTP to pay Rs 500. Do not share it with anyone.")).toBeNull();
  });

  it("ignores future-dated mandate / collect requests", () => {
    expect(classifyPaymentSms("Rs 500 will be debited tomorrow for your SIP mandate")).toBeNull();
    expect(classifyPaymentSms("John is requesting Rs 500 via UPI collect request")).toBeNull();
  });

  it("returns null when there is no amount", () => {
    expect(classifyPaymentSms("Your account was debited")).toBeNull();
  });
});

describe("suggestExpensesFromSms", () => {
  it("keeps only debit messages and parses each into a candidate", () => {
    const candidates = suggestExpensesFromSms([
      { sender: "VM-HDFCBK", body: "Rs.500.00 debited from A/c XX1234 to VPA cafe@okhdfcbank on 12-07-26", receivedAt: 2000 },
      { sender: "AD-SBIINB", body: "INR 1200 credited to your A/c XX9999 by NEFT", receivedAt: 3000 },
      { sender: "TM-PROMO", body: "Big sale! Flat Rs 500 off today only", receivedAt: 1000 },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].amountPaise).toBe(50000);
    expect(candidates[0].payee).toBe("cafe@okhdfcbank");
    expect(candidates[0].sender).toBe("VM-HDFCBK");
  });

  it("sorts most-recent-first and de-dupes on amount+payee", () => {
    const candidates = suggestExpensesFromSms([
      { sender: "VM-HDFCBK", body: "Rs 300 debited to VPA shop@okaxis", receivedAt: 1000 },
      { sender: "VM-HDFCBK", body: "Rs 900 spent to VPA fuel@okicici", receivedAt: 5000 },
      { sender: "VM-HDFCBK", body: "Rs 300 paid to shop@okaxis via UPI", receivedAt: 1500 },
    ]);
    expect(candidates.map((candidate) => candidate.amountPaise)).toEqual([90000, 30000]);
  });
});

describe("coOccurrenceSuggestion", () => {
  it("suggests the dominant participant set once minSamples is met", () => {
    const entries = [
      entry({ entryId: "e1" }),
      entry({ entryId: "e2" }),
      entry({ entryId: "e3" }),
      entry({
        entryId: "e4",
        allocations: [
          { participantId: "alice", shareAmount: 1000, isPayer: true },
          { participantId: "charlie", shareAmount: 0, isPayer: false },
        ],
      }),
    ];
    const suggestion = coOccurrenceSuggestion(entries, "Groceries", "groceries");
    expect(suggestion?.participantIds.sort()).toEqual(["alice", "bob"]);
    expect(suggestion?.occurrences).toBe(3);
  });

  it("returns null with too little history", () => {
    expect(coOccurrenceSuggestion([entry({}), entry({})], "Groceries", "groceries")).toBeNull();
  });
});

describe("splitShapeMemory", () => {
  it("remembers a non-equal ratio from the most recent matching entry", () => {
    const entries = [
      entry({
        entryId: "e1",
        description: "Biryani",
        category: null,
        recordedAt: "2026-07-01T00:00:00.000Z",
        totalAmount: 1000,
        allocations: [
          { participantId: "alice", shareAmount: 600, isPayer: true },
          { participantId: "bob", shareAmount: 400, isPayer: false },
        ],
      }),
    ];
    const memory = splitShapeMemory(entries, "Biryani", null);
    expect(memory?.ratios.alice).toBeCloseTo(0.6);
    expect(memory?.ratios.bob).toBeCloseTo(0.4);
  });

  it("returns null when the last split was equal", () => {
    const memory = splitShapeMemory([entry({ description: "Biryani", category: null })], "Biryani", null);
    expect(memory).toBeNull();
  });
});

describe("detectRecurringCandidates", () => {
  it("detects a stable monthly amount on a stable day", () => {
    const entries = [
      entry({ entryId: "e1", description: "Rent", effectiveDate: "2026-04-01", totalAmount: 20000 }),
      entry({ entryId: "e2", description: "Rent", effectiveDate: "2026-05-01", totalAmount: 20100 }),
      entry({ entryId: "e3", description: "Rent", effectiveDate: "2026-06-02", totalAmount: 19900 }),
    ];
    const candidates = detectRecurringCandidates(entries);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].description).toBe("Rent");
    expect(candidates[0].occurrences).toBe(3);
  });

  it("ignores entries with unstable amounts", () => {
    const entries = [
      entry({ entryId: "e1", description: "Misc", effectiveDate: "2026-04-01", totalAmount: 1000 }),
      entry({ entryId: "e2", description: "Misc", effectiveDate: "2026-05-01", totalAmount: 5000 }),
      entry({ entryId: "e3", description: "Misc", effectiveDate: "2026-06-01", totalAmount: 9000 }),
    ];
    expect(detectRecurringCandidates(entries)).toHaveLength(0);
  });
});
