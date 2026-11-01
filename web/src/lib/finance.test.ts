import { describe, expect, it } from "vitest";
import {
  buildEqualAllocations,
  buildShareAllocations,
  deriveBalances,
  memberSpendSummary,
  monthOverMonthTrend,
  myNetByContext,
  owedSummary,
  pairwiseBalances,
  parseAmountToPaise,
  personalSpendThisMonth,
  recentPayerIds,
  reportSummary,
  rescaleAllocations,
  timeFrameRange,
} from "./finance";
import { nextHlc } from "./hlc";
import type { ContextRecord, LedgerEntry, Membership, Participant } from "../types";

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
    hlc: "1-0-test",
    syncState: "committed",
    ...overrides,
  };
}

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

describe("parseAmountToPaise", () => {
  it("parses whole rupees", () => {
    expect(parseAmountToPaise("450")).toBe(45000);
  });

  it("parses decimals exactly without float drift", () => {
    expect(parseAmountToPaise("10.55")).toBe(1055);
    expect(parseAmountToPaise("0.01")).toBe(1);
    expect(parseAmountToPaise("10.5")).toBe(1050);
  });

  it("rejects malformed input", () => {
    expect(parseAmountToPaise("")).toBeNull();
    expect(parseAmountToPaise("abc")).toBeNull();
    expect(parseAmountToPaise("10.555")).toBeNull();
    expect(parseAmountToPaise("-5")).toBeNull();
    expect(parseAmountToPaise("1,000")).toBeNull();
  });
});

describe("buildEqualAllocations", () => {
  it("splits equally and gives the remainder to the payer", () => {
    const allocations = buildEqualAllocations(1001, ["alice", "bob", "carol"], "bob");
    const total = allocations.reduce((sum, item) => sum + item.shareAmount, 0);
    expect(total).toBe(1001);
    expect(allocations.find((item) => item.participantId === "bob")?.shareAmount).toBe(335);
    expect(allocations.filter((item) => item.isPayer)).toHaveLength(1);
    expect(allocations.find((item) => item.isPayer)?.participantId).toBe("bob");
  });

  it("deduplicates participants", () => {
    const allocations = buildEqualAllocations(1000, ["alice", "alice", "bob"], "alice");
    expect(allocations).toHaveLength(2);
    expect(allocations.reduce((sum, item) => sum + item.shareAmount, 0)).toBe(1000);
  });

  it("throws when the payer is not part of the split", () => {
    expect(() => buildEqualAllocations(1000, ["alice", "bob"], "mallory")).toThrow();
  });
});

describe("buildShareAllocations", () => {
  it("splits proportionally to share weight (payer 1 share, friend 2 shares)", () => {
    const allocations = buildShareAllocations(900, { alice: 1, bob: 2 }, "alice");
    const total = allocations.reduce((sum, item) => sum + item.shareAmount, 0);
    expect(total).toBe(900);
    expect(allocations.find((item) => item.participantId === "alice")?.shareAmount).toBe(300);
    expect(allocations.find((item) => item.participantId === "bob")?.shareAmount).toBe(600);
  });

  it("subsumes an equal split when every weight is 1", () => {
    const allocations = buildShareAllocations(1001, { alice: 1, bob: 1, carol: 1 }, "bob");
    const total = allocations.reduce((sum, item) => sum + item.shareAmount, 0);
    expect(total).toBe(1001);
  });

  it("assigns the is_payer flag to the payer", () => {
    const allocations = buildShareAllocations(500, { alice: 1, bob: 1 }, "bob");
    expect(allocations.filter((item) => item.isPayer)).toHaveLength(1);
    expect(allocations.find((item) => item.isPayer)?.participantId).toBe("bob");
  });

  it("ignores zero/negative weights", () => {
    const allocations = buildShareAllocations(500, { alice: 1, bob: 0, carol: -1 }, "alice");
    expect(allocations).toHaveLength(1);
    expect(allocations[0].shareAmount).toBe(500);
  });

  it("throws when the payer has no share weight", () => {
    expect(() => buildShareAllocations(500, { bob: 1 }, "alice")).toThrow();
  });
});

describe("rescaleAllocations", () => {
  it("preserves an uneven custom split's proportions when the amount changes", () => {
    // Original: alice 750 (75%), bob 250 (25%) of 1000.
    const original = [
      { participantId: "alice", shareAmount: 750, isPayer: true },
      { participantId: "bob", shareAmount: 250, isPayer: false },
    ];
    const allocations = rescaleAllocations(original, 2000, "alice");
    const total = allocations.reduce((sum, item) => sum + item.shareAmount, 0);
    expect(total).toBe(2000);
    expect(allocations.find((item) => item.participantId === "alice")?.shareAmount).toBe(1500);
    expect(allocations.find((item) => item.participantId === "bob")?.shareAmount).toBe(500);
  });

  it("keeps an equal split equal after rescaling (subsumes buildEqualAllocations)", () => {
    const original = [
      { participantId: "alice", shareAmount: 500, isPayer: true },
      { participantId: "bob", shareAmount: 500, isPayer: false },
    ];
    const allocations = rescaleAllocations(original, 1001, "alice");
    const total = allocations.reduce((sum, item) => sum + item.shareAmount, 0);
    expect(total).toBe(1001);
    expect(Math.abs(allocations[0].shareAmount - allocations[1].shareAmount)).toBeLessThanOrEqual(1);
  });

  it("reassigns the payer flag without disturbing share ratios", () => {
    const original = [
      { participantId: "alice", shareAmount: 750, isPayer: true },
      { participantId: "bob", shareAmount: 250, isPayer: false },
    ];
    const allocations = rescaleAllocations(original, 1000, "bob");
    expect(allocations.find((item) => item.participantId === "bob")).toMatchObject({
      shareAmount: 250,
      isPayer: true,
    });
    expect(allocations.find((item) => item.participantId === "alice")).toMatchObject({
      shareAmount: 750,
      isPayer: false,
    });
  });

  it("falls back to an equal split across old + new payer when the new payer wasn't in the split", () => {
    const original = [
      { participantId: "alice", shareAmount: 500, isPayer: true },
      { participantId: "bob", shareAmount: 500, isPayer: false },
    ];
    const allocations = rescaleAllocations(original, 900, "carol");
    expect(allocations.map((item) => item.participantId).sort()).toEqual(["alice", "bob", "carol"]);
    expect(allocations.reduce((sum, item) => sum + item.shareAmount, 0)).toBe(900);
    expect(allocations.find((item) => item.isPayer)?.participantId).toBe("carol");
  });
});

describe("deriveBalances", () => {
  it("credits the payer and debits shares", () => {
    const balances = deriveBalances([entry({})], participants, memberships);
    expect(balances.find((row) => row.participantId === "alice")?.netBalance).toBe(500);
    expect(balances.find((row) => row.participantId === "bob")?.netBalance).toBe(-500);
  });

  it("ignores rejected entries", () => {
    const balances = deriveBalances([entry({ syncState: "rejected" })], participants, memberships);
    expect(balances.every((row) => row.netBalance === 0)).toBe(true);
  });

  it("ignores voided entries", () => {
    const balances = deriveBalances(
      [entry({ voidedAt: "2026-07-11T08:00:00.000Z", voidReason: "Duplicate" })],
      participants,
      memberships,
    );
    expect(balances.every((row) => row.netBalance === 0)).toBe(true);
  });

  it("nets settlements against expenses", () => {
    const settlement = entry({
      entryId: "s1",
      type: "settlement",
      payerId: "bob",
      totalAmount: 500,
      allocations: [
        { participantId: "bob", shareAmount: 0, isPayer: true },
        { participantId: "alice", shareAmount: 500, isPayer: false },
      ],
    });
    const balances = deriveBalances([entry({}), settlement], participants, memberships);
    expect(balances.every((row) => row.netBalance === 0)).toBe(true);
  });

  // unified-expense-os-dr1: removing a member must not change what anyone
  // else owes, and their own real debt must remain visible until settled —
  // not linger forever unmarked, and not silently vanish either.
  it("keeps a removed member's nonzero balance visible and marked left", () => {
    const leftMemberships: Membership[] = [
      memberships[0],
      { ...memberships[1], leftAt: "2026-07-11T00:00:00.000Z" },
    ];
    const balances = deriveBalances([entry({})], participants, leftMemberships);
    const alice = balances.find((row) => row.participantId === "alice");
    const bob = balances.find((row) => row.participantId === "bob");
    expect(alice).toEqual({ participantId: "alice", netBalance: 500, left: false });
    expect(bob).toEqual({ participantId: "bob", netBalance: -500, left: true });
  });

  it("drops a removed member entirely once their balance settles to zero", () => {
    const leftMemberships: Membership[] = [
      memberships[0],
      { ...memberships[1], leftAt: "2026-07-11T00:00:00.000Z" },
    ];
    const settlement = entry({
      entryId: "s1",
      type: "settlement",
      payerId: "bob",
      totalAmount: 500,
      allocations: [
        { participantId: "bob", shareAmount: 0, isPayer: true },
        { participantId: "alice", shareAmount: 500, isPayer: false },
      ],
    });
    const balances = deriveBalances([entry({}), settlement], participants, leftMemberships);
    expect(balances.find((row) => row.participantId === "bob")).toBeUndefined();
  });

  it("removing a member does not change what remains owed among active members", () => {
    const threeParticipants: Participant[] = [
      ...participants,
      { participantId: "carol", displayName: "Carol" },
    ];
    const threeMemberships: Membership[] = [
      ...memberships,
      {
        membershipId: "m3",
        contextId: "ctx-home",
        participantId: "carol",
        joinedAt: "2026-01-01T00:00:00.000Z",
        defaultShare: "equal",
        allowSimplifyForMe: true,
      },
    ];
    const threeWayEntry = entry({
      totalAmount: 900,
      allocations: [
        { participantId: "alice", shareAmount: 300, isPayer: true },
        { participantId: "bob", shareAmount: 300, isPayer: false },
        { participantId: "carol", shareAmount: 300, isPayer: false },
      ],
    });
    const before = deriveBalances([threeWayEntry], threeParticipants, threeMemberships);
    const aliceBefore = before.find((row) => row.participantId === "alice")?.netBalance;
    const carolBefore = before.find((row) => row.participantId === "carol")?.netBalance;

    const afterRemovingBob = deriveBalances(
      [threeWayEntry],
      threeParticipants,
      threeMemberships.map((m) => (m.participantId === "bob" ? { ...m, leftAt: "2026-07-11T00:00:00.000Z" } : m)),
    );
    expect(afterRemovingBob.find((row) => row.participantId === "alice")?.netBalance).toBe(aliceBefore);
    expect(afterRemovingBob.find((row) => row.participantId === "carol")?.netBalance).toBe(carolBefore);
    expect(afterRemovingBob.find((row) => row.participantId === "bob")?.netBalance).toBe(-300);
    expect(afterRemovingBob.find((row) => row.participantId === "bob")?.left).toBe(true);
  });
});

describe("dashboard summaries", () => {
  const contexts: ContextRecord[] = [
    {
      contextId: "ctx-home",
      name: "Home",
      type: "shared",
      ownerParticipantId: "alice",
      createdAt: "2026-01-01T00:00:00.000Z",
      defaultSplit: "equal",
      allowSimplifiedDebts: false,
    },
  ];

  it("sums my share for the current month only", () => {
    const entries = [
      entry({ entryId: "this-month", effectiveDate: "2026-07-05" }),
      entry({ entryId: "last-month", effectiveDate: "2026-06-05" }),
      entry({ entryId: "rejected", effectiveDate: "2026-07-06", syncState: "rejected" }),
      entry({ entryId: "voided", effectiveDate: "2026-07-07", voidedAt: "2026-07-08T00:00:00.000Z" }),
    ];
    const spend = personalSpendThisMonth(entries, "alice", new Date("2026-07-10T12:00:00Z"));
    expect(spend).toBe(500);
  });

  it("summarizes owed and owing across shared contexts", () => {
    const nets = myNetByContext(contexts, memberships, [entry({})], participants, "alice");
    expect(nets).toEqual([{ contextId: "ctx-home", netBalance: 500 }]);
    expect(owedSummary(nets)).toEqual({ owedToMe: 500, iOwe: 0 });
    const bobNets = myNetByContext(contexts, memberships, [entry({})], participants, "bob");
    expect(owedSummary(bobNets)).toEqual({ owedToMe: 0, iOwe: 500 });
  });
});

describe("recentPayerIds", () => {
  it("orders active payers by most recent, deduped", () => {
    const entries = [
      entry({ entryId: "e1", payerId: "alice", recordedAt: "2026-07-01T00:00:00.000Z" }),
      entry({ entryId: "e2", payerId: "bob", recordedAt: "2026-07-02T00:00:00.000Z" }),
      entry({ entryId: "e3", payerId: "alice", recordedAt: "2026-07-03T00:00:00.000Z" }),
    ];
    expect(recentPayerIds(entries, ["alice", "bob"])).toEqual(["alice", "bob"]);
  });

  it("excludes settlements and members who are no longer active", () => {
    const entries = [
      entry({ entryId: "e1", payerId: "alice", recordedAt: "2026-07-01T00:00:00.000Z" }),
      entry({
        entryId: "s1",
        type: "settlement",
        payerId: "bob",
        recordedAt: "2026-07-02T00:00:00.000Z",
      }),
      entry({ entryId: "e2", payerId: "carol", recordedAt: "2026-07-03T00:00:00.000Z" }),
    ];
    expect(recentPayerIds(entries, ["alice"])).toEqual(["alice"]);
  });

  it("caps at the given limit", () => {
    const entries = [
      entry({ entryId: "e1", payerId: "alice", recordedAt: "2026-07-01T00:00:00.000Z" }),
      entry({ entryId: "e2", payerId: "bob", recordedAt: "2026-07-02T00:00:00.000Z" }),
      entry({ entryId: "e3", payerId: "carol", recordedAt: "2026-07-03T00:00:00.000Z" }),
    ];
    expect(recentPayerIds(entries, ["alice", "bob", "carol"], 2)).toEqual(["carol", "bob"]);
  });
});

describe("memberSpendSummary", () => {
  it("splits spent (share used) from paid (fronted), excluding settlements", () => {
    const settlement = entry({
      entryId: "s1",
      type: "settlement",
      payerId: "bob",
      totalAmount: 500,
      allocations: [
        { participantId: "bob", shareAmount: 0, isPayer: true },
        { participantId: "alice", shareAmount: 500, isPayer: false },
      ],
    });
    const summary = memberSpendSummary([entry({}), settlement], participants, memberships);
    expect(summary).toEqual(
      expect.arrayContaining([
        { participantId: "alice", spent: 500, paid: 1000, left: false },
        { participantId: "bob", spent: 500, paid: 0, left: false },
      ]),
    );
  });

  it("ignores rejected entries", () => {
    const summary = memberSpendSummary([entry({ syncState: "rejected" })], participants, memberships);
    expect(summary.every((row) => row.spent === 0 && row.paid === 0)).toBe(true);
  });

  it("ignores voided entries", () => {
    const summary = memberSpendSummary(
      [entry({ voidedAt: "2026-07-11T08:00:00.000Z", voidReason: "Duplicate" })],
      participants,
      memberships,
    );
    expect(summary.every((row) => row.spent === 0 && row.paid === 0)).toBe(true);
  });
});

describe("timeFrameRange", () => {
  it("includes the custom end date (inclusive from the caller's view)", () => {
    const range = timeFrameRange("custom", new Date(), { start: "2026-07-01", end: "2026-07-11" });
    expect(range.start).toBe("2026-07-01");
    expect(range.end).toBe("2026-07-12");
  });
});

describe("reportSummary", () => {
  it("includes an expense dated exactly on the custom range's end date", () => {
    const range = timeFrameRange("custom", new Date(), { start: "2026-07-01", end: "2026-07-11" });
    const summary = reportSummary(
      [entry({ effectiveDate: "2026-07-11", category: "groceries" })],
      participants,
      memberships,
      range,
    );
    expect(summary.entryCount).toBe(1);
    expect(summary.totalSpent).toBe(1000);
  });

  it("excludes expenses outside the range and buckets missing category as uncategorized", () => {
    const summary = reportSummary(
      [
        entry({ entryId: "in", effectiveDate: "2026-07-05" }),
        entry({ entryId: "out", effectiveDate: "2026-06-01" }),
      ],
      participants,
      memberships,
      { start: "2026-07-01", end: "2026-07-12" },
    );
    expect(summary.entryCount).toBe(1);
    expect(summary.byCategory).toEqual([{ category: "uncategorized", total: 1000, count: 1 }]);
  });

  it("ranks the top 5 largest entries and totals settlements separately from expenses", () => {
    const summary = reportSummary(
      [
        entry({ entryId: "big", effectiveDate: "2026-07-05", totalAmount: 5000, description: "Big one" }),
        entry({ entryId: "small", effectiveDate: "2026-07-06", totalAmount: 200, description: "Small one" }),
        entry({
          entryId: "settle",
          type: "settlement",
          effectiveDate: "2026-07-07",
          totalAmount: 3000,
        }),
      ],
      participants,
      memberships,
      { start: "2026-07-01", end: "2026-07-12" },
    );
    expect(summary.largestEntries[0].entryId).toBe("big");
    expect(summary.totalSpent).toBe(5200); // settlements excluded from spend total
    expect(summary.settlementTotal).toBe(3000);
  });
});

describe("monthOverMonthTrend", () => {
  it("buckets expense totals into the trailing N calendar months", () => {
    const now = new Date(2026, 6, 15); // July 2026
    const trend = monthOverMonthTrend(
      [
        entry({ entryId: "e1", effectiveDate: "2026-07-01", totalAmount: 1000 }),
        entry({ entryId: "e2", effectiveDate: "2026-06-01", totalAmount: 500 }),
        entry({ entryId: "e0", effectiveDate: "2026-05-01", totalAmount: 200 }),
        entry({ entryId: "e3", effectiveDate: "2025-01-01", totalAmount: 999 }), // outside window
      ],
      now,
      3,
    );
    expect(trend).toEqual([
      { month: "2026-05", total: 200 },
      { month: "2026-06", total: 500 },
      { month: "2026-07", total: 1000 },
    ]);
  });

  // unified-expense-os-0fj: a context created this month showed 5 leading
  // "0" rows of noise before its one real month of spend.
  it("trims leading zero months before the context's first spend", () => {
    const now = new Date(2026, 6, 15); // July 2026
    const trend = monthOverMonthTrend(
      [entry({ entryId: "e1", effectiveDate: "2026-07-01", totalAmount: 1000 })],
      now,
      6,
    );
    expect(trend).toEqual([{ month: "2026-07", total: 1000 }]);
  });

  it("still returns exactly one row (the current month) for a context with no spend at all", () => {
    const now = new Date(2026, 6, 15); // July 2026
    const trend = monthOverMonthTrend([], now, 6);
    expect(trend).toEqual([{ month: "2026-07", total: 0 }]);
  });
});

describe("pairwiseBalances", () => {
  it("shows a two-person split as a single direct debt", () => {
    const pairs = pairwiseBalances([entry({})]);
    expect(pairs).toEqual([{ fromId: "bob", toId: "alice", amount: 500 }]);
  });

  it("nets a three-person split with multiple payers into per-pair debts", () => {
    const trip = entry({
      entryId: "e2",
      payerId: "bob",
      totalAmount: 900,
      allocations: [
        { participantId: "alice", shareAmount: 300, isPayer: false },
        { participantId: "bob", shareAmount: 300, isPayer: true },
        { participantId: "carol", shareAmount: 300, isPayer: false },
      ],
    });
    const pairs = pairwiseBalances([entry({}), trip]);
    // dinner: bob owes alice 500. trip: alice owes bob 300, carol owes bob 300.
    // Net alice/bob: bob owes alice 500 - 300 = 200. Carol still owes bob 300.
    expect(pairs).toEqual(
      expect.arrayContaining([
        { fromId: "bob", toId: "alice", amount: 200 },
        { fromId: "carol", toId: "bob", amount: 300 },
      ]),
    );
    expect(pairs).toHaveLength(2);
  });

  it("zeroes out a pair once a settlement covers the full debt", () => {
    const settlement = entry({
      entryId: "s1",
      type: "settlement",
      payerId: "bob",
      totalAmount: 500,
      allocations: [
        { participantId: "bob", shareAmount: 0, isPayer: true },
        { participantId: "alice", shareAmount: 500, isPayer: false },
      ],
    });
    const pairs = pairwiseBalances([entry({}), settlement]);
    expect(pairs).toEqual([]);
  });

  it("collapses reciprocal debts between the same pair to a single net direction", () => {
    const aliceOwesBob = entry({ entryId: "e1", payerId: "bob", totalAmount: 1000, allocations: [
      { participantId: "bob", shareAmount: 0, isPayer: true },
      { participantId: "alice", shareAmount: 500, isPayer: false },
    ] });
    const bobOwesAlice = entry({ entryId: "e2", payerId: "alice", totalAmount: 400, allocations: [
      { participantId: "alice", shareAmount: 0, isPayer: true },
      { participantId: "bob", shareAmount: 200, isPayer: false },
    ] });
    const pairs = pairwiseBalances([aliceOwesBob, bobOwesAlice]);
    expect(pairs).toEqual([{ fromId: "alice", toId: "bob", amount: 300 }]);
  });
});

describe("nextHlc", () => {
  it("is monotonic even within one millisecond", () => {
    const first = nextHlc("node");
    const second = nextHlc("node");
    const parse = (value: string) => value.split("-").slice(0, 2).map(Number) as [number, number];
    const [ms1, c1] = parse(first);
    const [ms2, c2] = parse(second);
    expect(ms2 > ms1 || (ms2 === ms1 && c2 > c1)).toBe(true);
  });
});
