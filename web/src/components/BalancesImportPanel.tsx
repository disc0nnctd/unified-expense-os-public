import { useState } from "react";
import { addNamedMember, queueOpeningBalance } from "../lib/api";
import { type BalanceMatch, matchNetBalances, parseCsvText, parseSignedRupeeStringToPaise } from "../lib/csv";
import { humanizeError } from "../lib/errors";
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

// Splitwise-style group state is a net balance per person, not a ledger of
// individual expenses — the input contract this wizard supports is the
// explicit, verifiable `name,net_balance` shape (the same one our own CSV
// export's "Balances" section produces), not a reverse-engineered Splitwise
// wide-matrix file. Importing a literal Splitwise export is a follow-up that
// needs a real sample file, not this ticket.
export default function BalancesImportPanel({
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
  const [matches, setMatches] = useState<BalanceMatch[]>([]);
  const [unknownNames, setUnknownNames] = useState<string[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  if (!isOwner) {
    return null;
  }

  function reset() {
    setFileName(null);
    setMatches([]);
    setUnknownNames([]);
    setParseError(null);
    setImportResult(null);
  }

  async function handleFile(file: File) {
    reset();
    setFileName(file.name);
    const text = await file.text();
    const table = parseCsvText(text).filter((row) => !(row[0] ?? "").trim().startsWith("#"));
    if (table.length < 1) {
      setParseError("File is empty.");
      return;
    }
    const header = table[0].map((cell) => cell.trim().toLowerCase());
    const nameIdx = header.indexOf("name") >= 0 ? header.indexOf("name") : header.indexOf("participant");
    const balanceIdx = header.indexOf("net_balance");
    if (nameIdx < 0 || balanceIdx < 0) {
      setParseError("Expected headers 'name,net_balance' (same shape as the Balances section of CSV export).");
      return;
    }
    const rows = table
      .slice(1)
      .map((cells) => {
        const name = (cells[nameIdx] ?? "").trim();
        const netPaise = parseSignedRupeeStringToPaise((cells[balanceIdx] ?? "").trim());
        return { name, netPaise };
      })
      .filter((row) => row.name.length > 0);

    if (rows.some((row) => row.netPaise === null)) {
      setParseError("One or more net_balance values could not be parsed.");
      return;
    }
    const typedRows = rows as { name: string; netPaise: number }[];
    const total = typedRows.reduce((sum, row) => sum + row.netPaise, 0);
    if (Math.abs(total) > 1) {
      setParseError(
        `Balances must sum to zero (off by ${(total / 100).toFixed(2)}). Fix the source file and re-upload.`,
      );
      return;
    }

    const knownNames = new Set(participants.map((participant) => participant.displayName.toLowerCase()));
    const unknown = Array.from(new Set(typedRows.map((row) => row.name))).filter(
      (name) => !knownNames.has(name.toLowerCase()),
    );

    setMatches(matchNetBalances(typedRows));
    setUnknownNames(unknown);
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
      for (const match of matches) {
        const creditorId = nameToId.get(match.creditorName.toLowerCase());
        const debtorId = nameToId.get(match.debtorName.toLowerCase());
        if (!creditorId || !debtorId) {
          failures.push(`${match.creditorName} <-> ${match.debtorName}: could not resolve participants.`);
          continue;
        }
        try {
          await queueOpeningBalance({
            contextId,
            creditorId,
            debtorId,
            amountPaise: match.amountPaise,
            description: "Imported opening balance",
          });
          imported += 1;
        } catch (cause) {
          failures.push(`${match.creditorName} <-> ${match.debtorName}: ${humanizeError(cause)}`);
        }
      }
      await refresh();
      requestSync();
      setImportResult(
        failures.length > 0
          ? `Imported ${imported} of ${matches.length} balances. ${failures.length} failed: ${failures.slice(0, 3).join(" ")}`
          : `Imported ${imported} opening balance${imported === 1 ? "" : "s"}.`,
      );
      setStatus("Opening balances imported.");
    } catch (cause) {
      setImportResult(humanizeError(cause));
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Import group balances</h2>
        <button className="secondary compact" onClick={() => setOpen((current) => !current)}>
          {open ? "Close" : "Open"}
        </button>
      </div>
      {open ? (
        <>
          <div className="info-strip">
            <span>
              Upload a CSV with headers name,net_balance (positive = owed to them) — the same shape as the Balances
              section of CSV export. Good for migrating current standing from Splitwise or a spreadsheet without
              re-entering every historical expense.
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
          {matches.length > 0 ? (
            <>
              {unknownNames.length > 0 ? (
                <p className="status">New members to be created: {unknownNames.join(", ")}</p>
              ) : null}
              <ul className="history-list">
                {matches.map((match, index) => (
                  <li key={index}>
                    {match.debtorName} owes {match.creditorName} · ₹{(match.amountPaise / 100).toFixed(2)}
                  </li>
                ))}
              </ul>
              <div className="form-actions">
                <button className="primary" disabled={importBusy || !online} onClick={handleImport}>
                  {importBusy ? "Importing…" : `Import ${matches.length} opening balance${matches.length === 1 ? "" : "s"}`}
                </button>
              </div>
            </>
          ) : null}
          {importResult ? <p className="status">{importResult}</p> : null}
        </>
      ) : null}
    </article>
  );
}
