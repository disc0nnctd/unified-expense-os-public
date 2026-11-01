import { describe, expect, it } from "vitest";
import {
  buildBalancesCsv,
  buildLedgerCsv,
  isSplitwiseWideHeader,
  matchNetBalances,
  parseCsvText,
  parseSignedRupeeStringToPaise,
  parseSplitwiseWideCsv,
} from "./csv";
import type { ContextRecord, LedgerEntry, Participant } from "../types";

const participants: Participant[] = [
  { participantId: "alice", displayName: "Alice" },
  { participantId: "bob", displayName: "Bob" },
];

const context: ContextRecord = {
  contextId: "ctx-home",
  name: "Home",
  type: "shared",
  ownerParticipantId: "alice",
  createdAt: "2026-07-01T00:00:00.000Z",
  defaultSplit: "equal",
  allowSimplifiedDebts: false,
};

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

describe("buildLedgerCsv", () => {
  it("formats paise as a rupee decimal string parseable by parseAmountToPaise", () => {
    const csv = buildLedgerCsv([entry({ totalAmount: 1005 })], participants, context);
    const dataRow = csv.split("\n")[1];
    expect(dataRow).toContain("10.05");
  });

  it("escapes descriptions containing commas and quotes without shifting columns", () => {
    const csv = buildLedgerCsv(
      [entry({ description: 'Dinner, "the good place"' })],
      participants,
      context,
    );
    const rows = csv.split("\n");
    expect(rows[1]).toContain('"Dinner, ""the good place"""');
    // Column count preserved: 10 commas separating 11 top-level fields, with
    // the embedded comma safely inside quotes.
    const topLevelFieldCount = rows[1].match(/(?:^|,)(?:"(?:[^"]|"")*"|[^,]*)/g)?.length;
    expect(topLevelFieldCount).toBe(11);
  });

  it("excludes rejected and voided entries", () => {
    const csv = buildLedgerCsv(
      [entry({ entryId: "e1", syncState: "rejected" }), entry({ entryId: "e2", voidedAt: "2026-07-10T00:00:00.000Z" })],
      participants,
      context,
    );
    expect(csv.split("\n").length).toBe(1);
  });

  it("carries the entry type through as the second-to-last column, followed by notes", () => {
    const csv = buildLedgerCsv(
      [entry({ type: "adjustment", payerId: "alice", allocations: [
        { participantId: "alice", shareAmount: 0, isPayer: true },
        { participantId: "bob", shareAmount: 320000, isPayer: false },
      ] })],
      participants,
      context,
    );
    const dataRow = csv.split("\n")[1];
    expect(dataRow.endsWith(",adjustment,")).toBe(true);
  });

  it("carries notes through as the last column", () => {
    const csv = buildLedgerCsv([entry({ notes: "for the ski trip" })], participants, context);
    const dataRow = csv.split("\n")[1];
    expect(dataRow.endsWith(",for the ski trip")).toBe(true);
  });
});

describe("parseCsvText", () => {
  it("round-trips a quoted field containing a comma and doubled quotes", () => {
    const csv = buildLedgerCsv([entry({ description: 'Dinner, "the good place"' })], participants, context);
    const rows = parseCsvText(csv);
    expect(rows[1][1]).toBe('Dinner, "the good place"');
    expect(rows[1].length).toBe(11);
  });

  it("handles a quoted field spanning a newline", () => {
    const rows = parseCsvText('a,"line1\nline2",c\n');
    expect(rows).toEqual([["a", "line1\nline2", "c"]]);
  });

  it("drops trailing blank lines", () => {
    const rows = parseCsvText("a,b\n1,2\n\n");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseSignedRupeeStringToPaise", () => {
  it("parses negative balances", () => {
    expect(parseSignedRupeeStringToPaise("-3200.00")).toBe(-320000);
    expect(parseSignedRupeeStringToPaise("3200.00")).toBe(320000);
  });
});

describe("matchNetBalances", () => {
  function netBalanceOf(matches: { creditorName: string; debtorName: string; amountPaise: number }[], name: string) {
    return matches.reduce((total, match) => {
      if (match.creditorName === name) return total + match.amountPaise;
      if (match.debtorName === name) return total - match.amountPaise;
      return total;
    }, 0);
  }

  it("decomposes multi-way net balances into pairwise transfers that reproduce the input", () => {
    const rows = [
      { name: "Alice", netPaise: 320000 },
      { name: "Bob", netPaise: -120000 },
      { name: "Charlie", netPaise: -200000 },
    ];
    const matches = matchNetBalances(rows);
    for (const row of rows) {
      expect(netBalanceOf(matches, row.name)).toBe(row.netPaise);
    }
  });

  it("handles a simple two-person balance as a single transfer", () => {
    const matches = matchNetBalances([
      { name: "Alice", netPaise: 100000 },
      { name: "Bob", netPaise: -100000 },
    ]);
    expect(matches).toEqual([{ creditorName: "Alice", debtorName: "Bob", amountPaise: 100000 }]);
  });

  it("ignores participants already at zero", () => {
    const matches = matchNetBalances([
      { name: "Alice", netPaise: 0 },
      { name: "Bob", netPaise: 5000 },
      { name: "Charlie", netPaise: -5000 },
    ]);
    expect(matches).toEqual([{ creditorName: "Bob", debtorName: "Charlie", amountPaise: 5000 }]);
  });
});

describe("buildBalancesCsv", () => {
  it("renders participant names and rupee balances", () => {
    const csv = buildBalancesCsv(
      [
        { participantId: "alice", netBalance: 320000 },
        { participantId: "bob", netBalance: -320000 },
      ],
      participants,
    );
    expect(csv).toContain("Alice,3200.00");
    expect(csv).toContain("Bob,-3200.00");
  });
});

describe("isSplitwiseWideHeader", () => {
  it("recognizes the real Splitwise per-expense export shape", () => {
    expect(isSplitwiseWideHeader(["Date", "Description", "Category", "Cost", "Currency", "Alice", "Bob", "Charlie"])).toBe(
      true,
    );
  });

  it("rejects our own ledger export header", () => {
    expect(isSplitwiseWideHeader(["date", "description", "amount", "paid_by", "context"])).toBe(false);
  });
});

describe("parseSplitwiseWideCsv", () => {
  it("reconstructs payer and equal-split allocations from signed net columns, skipping the trailing summary row", () => {
    const table = [
      ["Date", "Description", "Category", "Cost", "Currency", "Alice", "Bob", "Charlie"],
      // Alice paid the full 300.00, split equally 3 ways (100.00 each):
      // her net is +200.00 (fronted 200 more than her own share).
      ["2026-01-05", "Groceries", "Food", "300.00", "INR", "200.00", "-100.00", "-100.00"],
      // Bob paid the full 150.00, split only between Alice and Bob (75.00
      // each); Charlie is blank, meaning not part of this expense.
      ["2026-01-10", "Movie tickets", "Entertainment", "150.00", "INR", "-75.00", "75.00", ""],
      // Splitwise's trailing all-time summary row must be skipped.
      ["", "Total balance", "", "", "", "125.00", "-25.00", "-100.00"],
    ];

    const { rows, errors } = parseSplitwiseWideCsv(table);

    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);

    const [groceries, movie] = rows;
    expect(groceries.payerName).toBe("Alice");
    expect(groceries.totalAmountPaise).toBe(30000);
    expect(groceries.allocations).toEqual([
      { name: "Alice", sharePaise: 10000 },
      { name: "Bob", sharePaise: 10000 },
      { name: "Charlie", sharePaise: 10000 },
    ]);
    expect(groceries.allocations.reduce((sum, allocation) => sum + allocation.sharePaise, 0)).toBe(
      groceries.totalAmountPaise,
    );

    expect(movie.payerName).toBe("Bob");
    expect(movie.totalAmountPaise).toBe(15000);
    expect(movie.allocations).toEqual([
      { name: "Alice", sharePaise: 7500 },
      { name: "Bob", sharePaise: 7500 },
    ]);
  });

  it("assigns the paise remainder from an uneven split to the payer", () => {
    const table = [
      ["Date", "Description", "Category", "Cost", "Currency", "Alice", "Bob", "Charlie"],
      // 100.01 split 3 ways: 33.33 each with 0.02 left over, all to the payer.
      ["2026-02-01", "Snacks", "Food", "100.01", "INR", "66.68", "-33.33", "-33.33"],
    ];
    const { rows, errors } = parseSplitwiseWideCsv(table);
    expect(errors).toEqual([]);
    expect(rows[0].allocations).toEqual([
      { name: "Alice", sharePaise: 3335 },
      { name: "Bob", sharePaise: 3333 },
      { name: "Charlie", sharePaise: 3333 },
    ]);
    expect(rows[0].allocations.reduce((sum, allocation) => sum + allocation.sharePaise, 0)).toBe(10001);
  });

  it("flags a row with fewer than two involved members", () => {
    const table = [
      ["Date", "Description", "Category", "Cost", "Currency", "Alice", "Bob"],
      ["2026-01-05", "Solo expense", "Food", "50.00", "INR", "0.00", ""],
    ];
    const { rows, errors } = parseSplitwiseWideCsv(table);
    expect(rows).toHaveLength(0);
    expect(errors).toEqual([{ lineNumber: 2, message: "Row must involve at least two members." }]);
  });
});
