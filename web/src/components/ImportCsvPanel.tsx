import { useState } from "react";
import { addNamedMember, createRecurringTemplate, queueExpense } from "../lib/api";
import { isSplitwiseWideHeader, parseCsvText, parseSplitwiseWideCsv } from "../lib/csv";
import { humanizeError } from "../lib/errors";
import { parseAmountToPaise } from "../lib/finance";
import { detectRecurringCandidates, type RecurringCandidate } from "../lib/recurringDetect";
import type { Participant } from "../types";

type Props = {
  contextId: string;
  participants: Participant[];
  isOwner: boolean;
  online: boolean;
  refresh: () => Promise<void>;
  requestSync: () => void;
  setStatus: (message: string) => void;
};

// Expected header shape, matching migration-home-51x.md §5.1 (and our own
// CSV export): date,description,amount,paid_by,context,participants,
// split_type,split_values,category[,type]. `context` and `type` are ignored
// on import — a spreadsheet import always lands in the context the wizard is
// opened from, and only plain expense rows are supported for now (settlement/
// adjustment re-import is a separate, deliberately deferred follow-up).
const REQUIRED_HEADERS = ["date", "description", "amount", "paid_by", "participants"];

type ParsedRow = {
  lineNumber: number;
  date: string;
  description: string;
  amountPaise: number;
  paidBy: string;
  participantNames: string[];
  splitValues: string;
  category: string;
  notes: string;
};

type RowError = { lineNumber: number; message: string };

export default function ImportCsvPanel({
  contextId,
  participants,
  isOwner,
  online,
  refresh,
  requestSync,
  setStatus,
}: Props) {
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [rowErrors, setRowErrors] = useState<RowError[]>([]);
  const [unknownNames, setUnknownNames] = useState<string[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [recurringCandidates, setRecurringCandidates] = useState<RecurringCandidate[]>([]);
  const [addedTemplateKeys, setAddedTemplateKeys] = useState<Set<string>>(new Set());

  if (!isOwner) {
    return null;
  }

  function reset() {
    setFileName(null);
    setRows([]);
    setRowErrors([]);
    setUnknownNames([]);
    setParseError(null);
    setImportResult(null);
    setRecurringCandidates([]);
    setAddedTemplateKeys(new Set());
  }

  async function handleFile(file: File) {
    reset();
    setFileName(file.name);
    const text = await file.text();
    // Our own export appends a `# Balances` comment section after a blank
    // line — comment lines and anything after that marker are not ledger rows.
    const ledgerText = text.split(/\n#\s*Balances/i)[0];
    const table = parseCsvText(ledgerText).filter((row) => !(row[0] ?? "").trim().startsWith("#"));
    if (table.length < 1) {
      setParseError("File is empty.");
      return;
    }
    if (isSplitwiseWideHeader(table[0])) {
      const { rows: wideRows, errors: wideErrors } = parseSplitwiseWideCsv(table);
      const parsedRows: ParsedRow[] = wideRows.map((row) => ({
        lineNumber: row.lineNumber,
        date: row.date,
        description: row.description || "Imported expense",
        amountPaise: row.totalAmountPaise,
        paidBy: row.payerName,
        participantNames: row.allocations.map((allocation) => allocation.name),
        // Equal-split assumption inherent to Splitwise's wide export (see
        // parseSplitwiseWideCsv doc comment) — routed through the same
        // split_values mechanism as a spreadsheet import's custom split so
        // handleImport doesn't need a second code path.
        splitValues: row.allocations.map((allocation) => `${allocation.name}:${(allocation.sharePaise / 100).toFixed(2)}`).join(";"),
        category: row.category,
        notes: "",
      }));
      const namesSeen = new Set<string>();
      parsedRows.forEach((row) => {
        namesSeen.add(row.paidBy);
        row.participantNames.forEach((name) => namesSeen.add(name));
      });
      const knownNames = new Set(participants.map((participant) => participant.displayName.toLowerCase()));
      const unknown = Array.from(namesSeen).filter((name) => !knownNames.has(name.toLowerCase()));
      setRows(parsedRows);
      setRowErrors(wideErrors);
      setUnknownNames(unknown);
      setRecurringCandidates(
        detectRecurringCandidates(
          parsedRows.map((row) => ({
            date: row.date,
            description: row.description,
            amountPaise: row.amountPaise,
            paidBy: row.paidBy,
          })),
        ),
      );
      return;
    }
    const header = table[0].map((cell) => cell.trim().toLowerCase());
    const missing = REQUIRED_HEADERS.filter((column) => !header.includes(column));
    if (missing.length > 0) {
      setParseError(`Missing required column(s): ${missing.join(", ")}. Expected the same headers as CSV export.`);
      return;
    }
    const columnIndex = (name: string) => header.indexOf(name);
    const dateIdx = columnIndex("date");
    const descriptionIdx = columnIndex("description");
    const amountIdx = columnIndex("amount");
    const paidByIdx = columnIndex("paid_by");
    const participantsIdx = columnIndex("participants");
    const splitValuesIdx = columnIndex("split_values");
    const categoryIdx = columnIndex("category");
    const typeIdx = columnIndex("type");
    const notesIdx = columnIndex("notes");

    const parsedRows: ParsedRow[] = [];
    const errors: RowError[] = [];
    const namesSeen = new Set<string>();

    table.slice(1).forEach((cells, index) => {
      const lineNumber = index + 2;
      if (typeIdx >= 0 && cells[typeIdx] && cells[typeIdx].trim() !== "expense") {
        // Deliberately out of scope for this wizard; see module comment.
        return;
      }
      const amountPaise = parseAmountToPaise((cells[amountIdx] ?? "").trim());
      const paidBy = (cells[paidByIdx] ?? "").trim();
      const participantNames = (cells[participantsIdx] ?? "")
        .split(";")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      const date = (cells[dateIdx] ?? "").trim();
      if (amountPaise === null || amountPaise <= 0) {
        errors.push({ lineNumber, message: "Invalid amount." });
        return;
      }
      if (!paidBy) {
        errors.push({ lineNumber, message: "Missing paid_by." });
        return;
      }
      if (participantNames.length === 0) {
        errors.push({ lineNumber, message: "Missing participants." });
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        errors.push({ lineNumber, message: "Date must be YYYY-MM-DD." });
        return;
      }
      namesSeen.add(paidBy);
      participantNames.forEach((name) => namesSeen.add(name));
      parsedRows.push({
        lineNumber,
        date,
        description: (cells[descriptionIdx] ?? "").trim() || "Imported expense",
        amountPaise,
        paidBy,
        participantNames,
        splitValues: (cells[splitValuesIdx] ?? "").trim(),
        category: (cells[categoryIdx] ?? "").trim(),
        notes: notesIdx >= 0 ? (cells[notesIdx] ?? "").trim() : "",
      });
    });

    const knownNames = new Set(participants.map((participant) => participant.displayName.toLowerCase()));
    const unknown = Array.from(namesSeen).filter((name) => !knownNames.has(name.toLowerCase()));

    setRows(parsedRows);
    setRowErrors(errors);
    setUnknownNames(unknown);
    setRecurringCandidates(
      detectRecurringCandidates(
        parsedRows.map((row) => ({
          date: row.date,
          description: row.description,
          amountPaise: row.amountPaise,
          paidBy: row.paidBy,
        })),
      ),
    );
  }

  function candidateKey(candidate: RecurringCandidate): string {
    return `${candidate.paidBy.toLowerCase()}::${candidate.description.toLowerCase()}`;
  }

  async function handleAddRecurring(candidate: RecurringCandidate) {
    try {
      await createRecurringTemplate({
        contextId,
        description: candidate.description,
        amountPaise: candidate.amountPaise,
        anchorDay: candidate.anchorDay,
      });
      setAddedTemplateKeys((current) => new Set(current).add(candidateKey(candidate)));
      setStatus(`Added "${candidate.description}" as a recurring template.`);
    } catch (cause) {
      setStatus(humanizeError(cause));
    }
  }

  // Splitwise/spreadsheet split_values rarely sum exactly to the total after
  // rounding — the remainder is folded into the payer's share so
  // sum(allocations) === total always holds, same rule buildEqualAllocations
  // uses for equal splits, so the server never rejects the push.
  function customSharesFor(row: ParsedRow, nameToId: Map<string, string>): Record<string, number> | undefined {
    if (!row.splitValues) {
      return undefined;
    }
    const pairs = row.splitValues.split(";").map((pair) => pair.split(":"));
    const shares: Record<string, number> = {};
    let sum = 0;
    for (const [name, amountText] of pairs) {
      const participantId = nameToId.get((name ?? "").trim().toLowerCase());
      const amountPaise = parseAmountToPaise((amountText ?? "").trim());
      if (!participantId || amountPaise === null) {
        return undefined;
      }
      shares[participantId] = amountPaise;
      sum += amountPaise;
    }
    const payerId = nameToId.get(row.paidBy.trim().toLowerCase());
    if (payerId && sum !== row.amountPaise) {
      shares[payerId] = (shares[payerId] ?? 0) + (row.amountPaise - sum);
    }
    return shares;
  }

  async function handleImport() {
    setImportBusy(true);
    setImportResult(null);
    try {
      const nameToId = new Map<string, string>(
        participants.map((participant) => [participant.displayName.toLowerCase(), participant.participantId]),
      );
      for (const name of unknownNames) {
        const participantId = await addNamedMember(contextId, name);
        nameToId.set(name.toLowerCase(), participantId);
      }
      let imported = 0;
      const failures: string[] = [];
      for (const row of rows) {
        const payerId = nameToId.get(row.paidBy.trim().toLowerCase());
        const participantIds = row.participantNames
          .map((name) => nameToId.get(name.trim().toLowerCase()))
          .filter((id): id is string => Boolean(id));
        if (!payerId || participantIds.length === 0) {
          failures.push(`Line ${row.lineNumber}: could not resolve participants.`);
          continue;
        }
        try {
          await queueExpense({
            contextId,
            payerId,
            description: row.description,
            category: row.category || null,
            notes: row.notes || null,
            amountPaise: row.amountPaise,
            participantIds,
            customShares: customSharesFor(row, nameToId),
            effectiveDate: row.date,
          });
          imported += 1;
        } catch (cause) {
          failures.push(`Line ${row.lineNumber}: ${humanizeError(cause)}`);
        }
      }
      await refresh();
      requestSync();
      setImportResult(
        failures.length > 0
          ? `Imported ${imported} of ${rows.length} rows. ${failures.length} failed: ${failures.slice(0, 3).join(" ")}`
          : `Imported ${imported} rows.`,
      );
      setStatus(`CSV import complete: ${imported} entries added.`);
    } catch (cause) {
      setImportResult(humanizeError(cause));
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Import from spreadsheet</h2>
        <button className="secondary compact" onClick={() => setOpen((current) => !current)}>
          {open ? "Close" : "Open"}
        </button>
      </div>
      {open ? (
        <>
          <div className="info-strip">
            <span>
              Upload a CSV with headers date,description,amount,paid_by,participants (same shape as CSV export), or a
              real Splitwise export (Date,Description,Category,Cost,Currency,&lt;member columns&gt;) — both are
              detected automatically. Unrecognized names become new members.
            </span>
          </div>
          <div className="form-actions">
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={!online}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void handleFile(file);
                }
                event.target.value = "";
              }}
            />
          </div>
          {fileName ? <p className="status">{fileName}</p> : null}
          {parseError ? <p className="status error-text">{parseError}</p> : null}
          {rows.length > 0 ? (
            <>
              <p className="status">
                Parsed {rows.length} row{rows.length === 1 ? "" : "s"}
                {rowErrors.length > 0 ? `, skipped ${rowErrors.length} invalid row(s)` : ""}.
              </p>
              {unknownNames.length > 0 ? (
                <p className="status">New members to be created: {unknownNames.join(", ")}</p>
              ) : null}
              <ul className="history-list">
                {rows.slice(0, 5).map((row) => (
                  <li key={row.lineNumber}>
                    {row.date} · {row.description} · {row.paidBy} → {row.participantNames.join(", ")}
                  </li>
                ))}
              </ul>
              {rowErrors.length > 0 ? (
                <ul className="history-list">
                  {rowErrors.slice(0, 5).map((error) => (
                    <li key={error.lineNumber} className="error-text">
                      Line {error.lineNumber}: {error.message}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="form-actions">
                <button className="primary" disabled={importBusy || !online} onClick={handleImport}>
                  {importBusy ? "Importing…" : `Import ${rows.length} row${rows.length === 1 ? "" : "s"}`}
                </button>
              </div>
              {recurringCandidates.length > 0 ? (
                <>
                  <p className="status">
                    Looks recurring — same payer, amount, and roughly monthly spacing. Add as a template instead of
                    re-entering it by hand each month?
                  </p>
                  <ul className="history-list">
                    {recurringCandidates.map((candidate) => {
                      const key = candidateKey(candidate);
                      const added = addedTemplateKeys.has(key);
                      return (
                        <li key={key}>
                          {candidate.description} · {candidate.paidBy} · {candidate.occurrences} occurrences (anchor
                          day {candidate.anchorDay})
                          <button
                            className="secondary compact"
                            style={{ marginLeft: 8 }}
                            disabled={added || !online}
                            onClick={() => void handleAddRecurring(candidate)}
                          >
                            {added ? "Added" : "Add as recurring"}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}
            </>
          ) : null}
          {importResult ? <p className="status">{importResult}</p> : null}
        </>
      ) : null}
    </article>
  );
}
