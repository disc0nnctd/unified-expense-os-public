import type { LineItem } from "./lineItems";

// Deterministic parsing over raw OCR text — no ML beyond the OCR step
// itself, which only turns pixels into text; everything below is regex/
// heuristics the user can see and correct before saving anything.
export type ParsedReceipt = {
  merchant: string | null;
  totalPaise: number | null;
  date: string | null;
  items: LineItem[];
};

const MONEY_PATTERN = /(\d{1,6}(?:[.,]\d{2})?)\s*$/;
const DATE_PATTERN = /(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/;

function toPaise(value: string): number {
  const normalized = value.replace(/,/g, "");
  const [rupees, fraction = ""] = normalized.split(".");
  return Number(rupees) * 100 + Number((fraction + "00").slice(0, 2));
}

export function parseReceiptText(rawText: string): ParsedReceipt {
  const lines = rawText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const merchant = lines.find((line) => !/^\d/.test(line) && line.length > 2) ?? null;

  let totalPaise: number | null = null;
  const totalLine = lines.find((line) => /\btotal\b/i.test(line) && MONEY_PATTERN.test(line));
  if (totalLine) {
    const match = totalLine.match(MONEY_PATTERN);
    if (match) {
      totalPaise = toPaise(match[1]);
    }
  }

  let date: string | null = null;
  for (const line of lines) {
    const match = line.match(DATE_PATTERN);
    if (match) {
      const [, day, month, yearRaw] = match;
      const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
      date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
      break;
    }
  }

  const items: LineItem[] = [];
  let index = 0;
  for (const line of lines) {
    if (line === totalLine || /\btotal\b|\bsubtotal\b|\btax\b|\bgst\b/i.test(line) || DATE_PATTERN.test(line)) {
      continue;
    }
    const match = line.match(MONEY_PATTERN);
    if (!match) {
      continue;
    }
    const label = line.slice(0, match.index).trim().replace(/[.\s]+$/, "");
    if (!label) {
      continue;
    }
    const amountPaise = toPaise(match[1]);
    if (amountPaise <= 0) {
      continue;
    }
    items.push({ id: `line-${index}`, label, amountPaise, assignedTo: [] });
    index += 1;
  }

  return { merchant, totalPaise, date, items };
}
