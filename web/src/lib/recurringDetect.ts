// Detects rows in an imported CSV that look like a recurring monthly charge
// (same payer + description, same amount within a small tolerance, spaced
// roughly a month apart) so the import UI can offer to seed a recurring
// template instead of leaving the user to re-enter it every month by hand.
// Assist-only: this never writes to the ledger or creates a template itself,
// it only returns candidates for the user to confirm (see ImportCsvPanel).

export type RecurringCandidateRow = {
  date: string; // YYYY-MM-DD
  description: string;
  amountPaise: number;
  paidBy: string;
};

export type RecurringCandidate = {
  description: string;
  paidBy: string;
  amountPaise: number; // representative amount (most recent occurrence)
  anchorDay: number; // day-of-month of the most recent occurrence
  occurrences: number;
  dates: string[];
};

const MIN_OCCURRENCES = 2;
const MONTH_GAP_MIN_DAYS = 25;
const MONTH_GAP_MAX_DAYS = 35;
// 1% relative tolerance (rounded up) covers small monthly variation (taxes,
// usage-based utility bills) without matching genuinely different amounts.
const AMOUNT_TOLERANCE_RATIO = 0.01;

function normalizeDescription(description: string): string {
  return description.trim().toLowerCase().replace(/\s+/g, " ");
}

function daysBetween(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / msPerDay);
}

function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10));
}

function amountsMatch(a: number, b: number): boolean {
  const tolerance = Math.max(1, Math.ceil(Math.max(a, b) * AMOUNT_TOLERANCE_RATIO));
  return Math.abs(a - b) <= tolerance;
}

export function detectRecurringCandidates(rows: RecurringCandidateRow[]): RecurringCandidate[] {
  const groups = new Map<string, RecurringCandidateRow[]>();
  for (const row of rows) {
    const key = `${row.paidBy.trim().toLowerCase()}::${normalizeDescription(row.description)}`;
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const candidates: RecurringCandidate[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((left, right) => left.date.localeCompare(right.date));

    // Walk the sorted group and keep only a run of rows that are both
    // amount-consistent (chained tolerance check) and roughly a month apart;
    // a single group can contain more than one such run (e.g. a gap where
    // the subscription lapsed and resumed at a different price).
    let runStart = 0;
    for (let i = 1; i <= sorted.length; i += 1) {
      const brokeRun =
        i === sorted.length ||
        !amountsMatch(sorted[i].amountPaise, sorted[i - 1].amountPaise) ||
        !(
          daysBetween(sorted[i - 1].date, sorted[i].date) >= MONTH_GAP_MIN_DAYS &&
          daysBetween(sorted[i - 1].date, sorted[i].date) <= MONTH_GAP_MAX_DAYS
        );
      if (brokeRun) {
        const run = sorted.slice(runStart, i);
        if (run.length >= MIN_OCCURRENCES) {
          const latest = run[run.length - 1];
          candidates.push({
            description: latest.description.trim(),
            paidBy: latest.paidBy.trim(),
            amountPaise: latest.amountPaise,
            anchorDay: dayOfMonth(latest.date),
            occurrences: run.length,
            dates: run.map((row) => row.date),
          });
        }
        runStart = i;
      }
    }
  }

  return candidates;
}
