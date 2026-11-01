import type { ContextRecord, LedgerEntry, Participant } from "../types";
import { parseAmountToPaise, participantName } from "./finance";

// Column order matches migration-home-51x.md §5.1 exactly (the shape the
// Phase 2 CSV importers are built to read), with `type` appended so a
// settlement/adjustment round-trips instead of silently looking like an
// ordinary expense, and `notes` appended after that (unified-expense-os-ufz)
// — both are read by column name on import, so appending is backward
// compatible with older exports/importers that don't know about them.
const LEDGER_COLUMNS = [
  "date",
  "description",
  "amount",
  "paid_by",
  "context",
  "participants",
  "split_type",
  "split_values",
  "category",
  "type",
  "notes",
] as const;

// Integer-safe paise -> rupee string ("3200" paise -> "32.00"), the inverse
// of parseAmountToPaise. Never routes through float division/toFixed, which
// can misround at the boundary (e.g. 1005 paise -> "10.05" not "10.049999").
function paiseToRupeeString(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = Math.trunc(abs / 100);
  const cents = abs % 100;
  return `${sign}${rupees}.${String(cents).padStart(2, "0")}`;
}

// CSV escaping: any field containing a comma, quote, or newline is wrapped in
// quotes with internal quotes doubled, per RFC 4180. Free-text descriptions
// routinely contain commas ("Dinner, the good place"), so this isn't optional.
function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(values: string[]): string {
  return values.map(escapeCsvField).join(",");
}

export function buildLedgerCsv(
  entries: LedgerEntry[],
  participants: Participant[],
  context: ContextRecord,
): string {
  const rows = entries
    .filter((entry) => entry.syncState !== "rejected" && !entry.voidedAt)
    .sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate))
    .map((entry) => {
      const payees = entry.allocations.map((allocation) => participantName(participants, allocation.participantId));
      const splitValues = entry.allocations
        .map(
          (allocation) =>
            `${participantName(participants, allocation.participantId)}:${paiseToRupeeString(allocation.shareAmount)}`,
        )
        .join(";");
      return toCsvRow([
        entry.effectiveDate,
        entry.description,
        paiseToRupeeString(entry.totalAmount),
        participantName(participants, entry.payerId),
        context.name,
        payees.join(";"),
        "custom",
        splitValues,
        entry.category ?? "",
        entry.type,
        entry.notes ?? "",
      ]);
    });
  return [toCsvRow([...LEDGER_COLUMNS]), ...rows].join("\n");
}

export function buildBalancesCsv(
  balances: { participantId: string; netBalance: number }[],
  participants: Participant[],
): string {
  const rows = balances.map((row) =>
    toCsvRow([participantName(participants, row.participantId), paiseToRupeeString(row.netBalance)]),
  );
  return [toCsvRow(["participant", "net_balance"]), ...rows].join("\n");
}

export function buildContextExportCsv(
  entries: LedgerEntry[],
  participants: Participant[],
  context: ContextRecord,
  balances: { participantId: string; netBalance: number }[],
): string {
  return [
    `# ${context.name} — full ledger export`,
    buildLedgerCsv(entries, participants, context),
    "",
    "# Balances (derived, as of export time)",
    buildBalancesCsv(balances, participants),
  ].join("\n");
}

// Integer-safe rupee string -> paise, using the same 2-decimal contract as
// parseAmountToPaise but accepting a leading '-' (needed for exported
// balances; parseAmountToPaise deliberately rejects '-' since ledger amounts
// are never negative).
export function parseSignedRupeeStringToPaise(input: string): number | null {
  const trimmed = input.trim();
  const match = /^(-?)(\d{1,10})(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const [, sign, rupees, fraction = ""] = match;
  const paise = Number(rupees) * 100 + Number((fraction + "00").slice(0, 2));
  return sign === "-" ? -paise : paise;
}

// RFC4180 parser: a naive split(",") shatters on any quoted field containing
// a comma or embedded newline, which our own export (and Splitwise/spreadsheet
// exports in general) produce for free-text descriptions.
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  function endField() {
    row.push(field);
    field = "";
  }
  function endRow() {
    endField();
    rows.push(row);
    row = [];
  }

  while (i < len) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      endField();
      i += 1;
      continue;
    }
    if (char === "\r") {
      i += 1;
      continue;
    }
    if (char === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    endRow();
  }
  return rows.filter((parsedRow) => !(parsedRow.length === 1 && parsedRow[0] === ""));
}

export type NetBalanceRow = { name: string; netPaise: number };

export type BalanceMatch = { creditorName: string; debtorName: string; amountPaise: number };

// Decomposes a set of per-person net balances (Splitwise-style: {Alice: +3200,
// Bob: -1200, Charlie: -2000}) into pairwise creditor->debtor transfers, since
// the ledger's opening-balance model (queueOpeningBalance) is pairwise, not
// per-person. Greedy match of largest creditor against largest debtor —
// not min-cash-flow-optimal, but that optimality isn't needed here, only that
// the resulting adjustments reproduce the input net positions exactly.
export function matchNetBalances(rows: NetBalanceRow[]): BalanceMatch[] {
  const creditors = rows.filter((row) => row.netPaise > 0).map((row) => ({ ...row, remaining: row.netPaise }));
  const debtors = rows.filter((row) => row.netPaise < 0).map((row) => ({ ...row, remaining: -row.netPaise }));
  const matches: BalanceMatch[] = [];
  let ci = 0;
  let di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci];
    const debtor = debtors[di];
    const amount = Math.min(creditor.remaining, debtor.remaining);
    if (amount > 0) {
      matches.push({ creditorName: creditor.name, debtorName: debtor.name, amountPaise: amount });
      creditor.remaining -= amount;
      debtor.remaining -= amount;
    }
    if (creditor.remaining === 0) {
      ci += 1;
    }
    if (debtor.remaining === 0) {
      di += 1;
    }
  }
  return matches;
}

export type SplitwiseWideRow = {
  lineNumber: number;
  date: string;
  description: string;
  category: string;
  totalAmountPaise: number;
  payerName: string;
  allocations: { name: string; sharePaise: number }[];
};

export type SplitwiseWideError = { lineNumber: number; message: string };

// Splitwise's actual per-expense export is "wide": Date,Description,Category,
// Cost,Currency,<Member1>,<Member2>,...,<MemberN>, one column per group
// member, holding that member's *net* amount for the row (paid minus their
// share; positive = fronted more than their share, negative = owes it,
// blank = not part of that expense). It appends a trailing "Total balance"
// summary row (all-time net per member) that must be skipped, not imported
// as an expense.
//
// The format only gives each member's net, not their paid amount and share
// separately, so an unequal split is indistinguishable from an equal split
// here — we assume an equal split among the row's non-blank members (the
// Splitwise default) and infer the payer as whichever member has the
// largest (most positive) net value, since a single payer fronting the
// full cost nets out to cost - theirShare, strictly more than every other
// participant's -share.
export function isSplitwiseWideHeader(header: string[]): boolean {
  const lower = header.map((cell) => cell.trim().toLowerCase());
  return lower[0] === "date" && lower[1] === "description" && lower.includes("cost") && lower.length > 4;
}

export function parseSplitwiseWideCsv(table: string[][]): {
  rows: SplitwiseWideRow[];
  errors: SplitwiseWideError[];
} {
  const rows: SplitwiseWideRow[] = [];
  const errors: SplitwiseWideError[] = [];
  if (table.length < 1) {
    return { rows, errors };
  }
  const header = table[0].map((cell) => cell.trim());
  const lowerHeader = header.map((cell) => cell.toLowerCase());
  const dateIdx = 0;
  const descriptionIdx = 1;
  const categoryIdx = lowerHeader.indexOf("category");
  const costIdx = lowerHeader.indexOf("cost");
  const currencyIdx = lowerHeader.indexOf("currency");
  const memberStartIdx = (currencyIdx >= 0 ? currencyIdx : costIdx) + 1;
  const memberNames = header.slice(memberStartIdx).filter((name) => name.length > 0);

  table.slice(1).forEach((cells, index) => {
    const lineNumber = index + 2;
    const description = (cells[descriptionIdx] ?? "").trim();
    if (description.toLowerCase() === "total balance" || description.length === 0) {
      // Splitwise's trailing all-time-summary row, not an expense.
      return;
    }
    const costPaise = parseAmountToPaise((cells[costIdx] ?? "").trim());
    if (costPaise === null || costPaise <= 0) {
      errors.push({ lineNumber, message: "Invalid cost." });
      return;
    }
    const memberValues = memberNames.map((_, offset) => {
      const raw = (cells[memberStartIdx + offset] ?? "").trim();
      if (raw.length === 0) {
        return null;
      }
      return parseSignedRupeeStringToPaise(raw);
    });
    const participantIdxs: number[] = [];
    memberValues.forEach((value, i) => {
      if (value !== null) {
        participantIdxs.push(i);
      }
    });
    if (memberValues.some((value, i) => participantIdxs.includes(i) && value === undefined)) {
      errors.push({ lineNumber, message: "Could not parse a member amount." });
      return;
    }
    if (participantIdxs.length < 2) {
      errors.push({ lineNumber, message: "Row must involve at least two members." });
      return;
    }
    const n = participantIdxs.length;
    const share = Math.trunc(costPaise / n);
    const remainder = costPaise - share * n;
    const payerIdx = participantIdxs.reduce((best, i) => {
      const bestValue = memberValues[best] as number;
      const value = memberValues[i] as number;
      return value > bestValue ? i : best;
    }, participantIdxs[0]);
    const allocations = participantIdxs.map((i) => ({
      name: memberNames[i],
      sharePaise: share + (i === payerIdx ? remainder : 0),
    }));
    rows.push({
      lineNumber,
      date: (cells[dateIdx] ?? "").trim(),
      description,
      category: categoryIdx >= 0 ? (cells[categoryIdx] ?? "").trim() : "",
      totalAmountPaise: costPaise,
      payerName: memberNames[payerIdx],
      allocations,
    });
  });

  return { rows, errors };
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
