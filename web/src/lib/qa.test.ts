import { describe, expect, it } from "vitest";
import { answerBalanceQuestion, answerQuestion } from "./qa";
import type { ContextRecord, LedgerEntry, Membership, Participant } from "../types";

const participants: Participant[] = [
  { participantId: "alice", displayName: "Alice" },
  { participantId: "bob", displayName: "Bob" },
];

const memberships: Membership[] = [
  {
    membershipId: "m1",
    contextId: "ctx-home",
    participantId: "alice",
    joinedAt: "2026-01-01T00:00:00.000Z",
    defaultShare: "equal",
    allowSimplifyForMe: true,
  },
  {
    membershipId: "m2",
    contextId: "ctx-home",
    participantId: "bob",
    joinedAt: "2026-01-01T00:00:00.000Z",
    defaultShare: "equal",
    allowSimplifyForMe: true,
  },
];

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

const now = new Date(2026, 6, 15);

describe("answerQuestion", () => {
  it("answers a total-spend question for the default month window", () => {
    const answer = answerQuestion("How much did we spend this month?", [entry({ totalAmount: 2000 })], participants, memberships, now);
    expect(answer?.text).toContain("₹20");
  });

  it("answers a category-spend question, matching only that category", () => {
    const entries = [
      entry({ entryId: "e1", category: "groceries", totalAmount: 1000 }),
      entry({ entryId: "e2", category: "rent", totalAmount: 20000 }),
    ];
    const answer = answerQuestion("How much did we spend on groceries this month?", entries, participants, memberships, now);
    expect(answer?.text).toContain("₹10");
    expect(answer?.text).not.toContain("₹200");
  });

  it("answers a per-member spend question", () => {
    const answer = answerQuestion("How much did Bob spend this month?", [entry({ totalAmount: 1000 })], participants, memberships, now);
    expect(answer?.text).toContain("Bob spent");
    expect(answer?.text).toContain("₹5");
  });

  it("returns null for unrecognized phrasing rather than guessing", () => {
    expect(answerQuestion("What's the weather like?", [], participants, memberships, now)).toBeNull();
  });
});

describe("answerBalanceQuestion", () => {
  const context: ContextRecord = {
    contextId: "ctx-home",
    name: "Home",
    type: "shared",
    ownerParticipantId: "alice",
    createdAt: "2026-01-01T00:00:00.000Z",
    defaultSplit: "equal",
    allowSimplifiedDebts: false,
  };

  it("answers 'how much am I owed' from derived balances, not a time range", () => {
    const entries = [entry({ payerId: "alice", totalAmount: 1000, allocations: [
      { participantId: "alice", shareAmount: 0, isPayer: true },
      { participantId: "bob", shareAmount: 1000, isPayer: false },
    ] })];
    const answer = answerBalanceQuestion("How much am I owed?", [context], memberships, entries, participants, "alice");
    expect(answer?.text).toContain("owed ₹10");
  });

  it("returns null for phrasing that isn't a balance question", () => {
    expect(answerBalanceQuestion("How much did we spend?", [context], memberships, [], participants, "alice")).toBeNull();
  });

  it("answers 'who owes how much' with a per-person breakdown", () => {
    const entries = [entry({ payerId: "alice", totalAmount: 1000, allocations: [
      { participantId: "alice", shareAmount: 0, isPayer: true },
      { participantId: "bob", shareAmount: 1000, isPayer: false },
    ] })];
    const answer = answerBalanceQuestion("Who owes how much?", [context], memberships, entries, participants, "alice");
    expect(answer?.text).toContain("Home:");
    expect(answer?.text).toContain("Bob owes ₹10");
    expect(answer?.text).toContain("you are owed ₹10");
  });

  it("reports a settled shared context as settled in the breakdown", () => {
    // Payer covers their own full share — nobody owes anyone.
    const settled = [entry({ allocations: [{ participantId: "alice", shareAmount: 1000, isPayer: true }] })];
    const answer = answerBalanceQuestion("who owes whom", [context], memberships, settled, participants, "alice");
    expect(answer?.text).toContain("all settled");
  });
});
