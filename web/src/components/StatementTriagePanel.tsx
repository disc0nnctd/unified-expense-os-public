import { useMemo, useState } from "react";
import { addNamedMember, editExpense, queueExpense, voidExpense } from "../lib/api";
import { parseCsvText, parseSignedRupeeStringToPaise } from "../lib/csv";
import { humanizeError } from "../lib/errors";
import { buildShareAllocations, formatMoney, localDateString, parseAmountToPaise, participantName } from "../lib/finance";
import type { LedgerEntry, Participant } from "../types";

type Props = {
  contextId: string;
  participants: Participant[];
  deviceParticipantId: string;
  isOwner: boolean;
  online: boolean;
  refresh: () => Promise<void>;
  requestSync: () => void;
  setStatus: (message: string) => void;
};

// One row from a raw, unshaped bank export (any headers) — distinct from
// ImportCsvPanel's pre-shaped CSV (date,description,amount,paid_by,
// participants) where splits are already decided. Ports the old_statement_app
// reference tool's triage workflow: walk one transaction at a time, assign a
// payer, split it (or mark it personal), flag it for a later look, and only
// then it becomes a real ledger entry — unified-expense-os-0sj.
type RawTx = {
  txId: string;
  date: string; // YYYY-MM-DD
  description: string;
  amountPaise: number; // signed: negative = money out (purchase), positive = money in (return/credit)
  category: string;
  sourceFile: string;
};

type Decision = {
  entryId: string;
  flagged: boolean;
};

const DATE_HEADER_CANDIDATES = ["transaction date", "date", "posting date", "trans date"];
const DESCRIPTION_HEADER_CANDIDATES = ["description", "merchant", "payee", "name"];
const AMOUNT_HEADER_CANDIDATES = ["amount", "debit", "credit"];
const CATEGORY_HEADER_CANDIDATES = ["category", "type"];

function findColumn(header: string[], candidates: string[]): number {
  const lower = header.map((cell) => cell.trim().toLowerCase());
  for (const candidate of candidates) {
    const index = lower.indexOf(candidate);
    if (index >= 0) return index;
  }
  return -1;
}

// Bank exports are inconsistent about date shape; YYYY-MM-DD passes through,
// MM/DD/YYYY (Chase et al.) is the common case, anything else falls back to
// the platform date parser rather than rejecting the row outright.
function parseStatementDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (mdy) {
    const [, month, day, year] = mdy;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : localDateString(parsed);
}

function parseStatementAmount(raw: string): number | null {
  const cleaned = raw.trim().replace(/[$,]/g, "");
  return parseSignedRupeeStringToPaise(cleaned);
}

function buildRawTxs(table: string[][], columns: { date: number; description: number; amount: number; category: number }, sourceFile: string): { rows: RawTx[]; skipped: number } {
  const parsed: { date: string; description: string; amountPaise: number; category: string }[] = [];
  let skipped = 0;
  for (const cells of table) {
    const date = parseStatementDate(cells[columns.date] ?? "");
    const description = (cells[columns.description] ?? "").trim();
    const amountPaise = parseStatementAmount(cells[columns.amount] ?? "");
    if (!date || !description || amountPaise === null || amountPaise === 0) {
      skipped += 1;
      continue;
    }
    const category = columns.category >= 0 ? (cells[columns.category] ?? "").trim() || "Uncategorized" : "Uncategorized";
    parsed.push({ date, description, amountPaise, category });
  }
  // Duplicate same-day/description/amount charges (a coffee shop charged
  // twice) need distinct IDs or the second occurrence would silently
  // overwrite the first's triage decision — same base_id + occurrence
  // counter scheme as the reference app.
  parsed.sort((left, right) => left.date.localeCompare(right.date) || left.description.localeCompare(right.description) || left.amountPaise - right.amountPaise);
  const occurrenceCounts = new Map<string, number>();
  const rows: RawTx[] = parsed.map((row) => {
    const baseId = `${row.date}_${row.description}_${row.amountPaise}`;
    const occurrence = occurrenceCounts.get(baseId) ?? 0;
    occurrenceCounts.set(baseId, occurrence + 1);
    return {
      txId: occurrence === 0 ? baseId : `${baseId}_${occurrence}`,
      date: row.date,
      description: row.description,
      amountPaise: row.amountPaise,
      category: row.category,
      sourceFile,
    };
  });
  return { rows, skipped };
}

export default function StatementTriagePanel({
  contextId,
  participants,
  deviceParticipantId,
  isOwner,
  online,
  refresh,
  requestSync,
  setStatus,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pendingTable, setPendingTable] = useState<{ header: string[]; rows: string[][]; sourceFile: string } | null>(null);
  const [mapDate, setMapDate] = useState("");
  const [mapDescription, setMapDescription] = useState("");
  const [mapAmount, setMapAmount] = useState("");
  const [mapCategory, setMapCategory] = useState("");
  const [txs, setTxs] = useState<RawTx[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [extraParticipants, setExtraParticipants] = useState<Participant[]>([]);
  const [newFriendName, setNewFriendName] = useState("");

  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [savedEntries, setSavedEntries] = useState<Record<string, LedgerEntry>>({});
  const [lastSavedTxId, setLastSavedTxId] = useState<string | null>(null);
  const [pointer, setPointer] = useState(0);

  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [focusMode, setFocusMode] = useState(true);
  const [showOnlyFlagged, setShowOnlyFlagged] = useState(false);

  const [payerId, setPayerId] = useState(deviceParticipantId);
  const [onMe, setOnMe] = useState(false);
  const [splitMethod, setSplitMethod] = useState<"shares" | "exact">("shares");
  const [splitWith, setSplitWith] = useState<string[]>([]);
  const [shareWeightInputs, setShareWeightInputs] = useState<Record<string, string>>({});
  const [exactAmountInputs, setExactAmountInputs] = useState<Record<string, string>>({});
  const [flagged, setFlagged] = useState(false);
  const [rowNotes, setRowNotes] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadedForTxId, setLoadedForTxId] = useState<string | null>(null);

  const allParticipants = useMemo(() => [...participants, ...extraParticipants], [participants, extraParticipants]);

  if (!isOwner) {
    return null;
  }

  function resetImport() {
    setPendingTable(null);
    setTxs([]);
    setSkippedCount(0);
    setLoadError(null);
    setDecisions({});
    setSavedEntries({});
    setLastSavedTxId(null);
    setPointer(0);
  }

  async function handleFiles(files: FileList) {
    setLoadError(null);
    const collected: { header: string[]; rows: string[][]; sourceFile: string }[] = [];
    for (const file of Array.from(files)) {
      const text = await file.text();
      const table = parseCsvText(text).filter((row) => row.some((cell) => cell.trim().length > 0));
      if (table.length < 2) continue;
      collected.push({ header: table[0], rows: table.slice(1), sourceFile: file.name });
    }
    if (collected.length === 0) {
      setLoadError("No rows found in the uploaded file(s).");
      return;
    }
    const header = collected[0].header;
    const dateCol = findColumn(header, DATE_HEADER_CANDIDATES);
    const descriptionCol = findColumn(header, DESCRIPTION_HEADER_CANDIDATES);
    const amountCol = findColumn(header, AMOUNT_HEADER_CANDIDATES);
    const categoryCol = findColumn(header, CATEGORY_HEADER_CANDIDATES);

    if (dateCol >= 0 && descriptionCol >= 0 && amountCol >= 0) {
      finishLoad(collected, { date: dateCol, description: descriptionCol, amount: amountCol, category: categoryCol });
      return;
    }
    // Couldn't auto-detect the shape — ask the user to map columns instead of
    // guessing wrong and silently mis-triaging every row.
    setPendingTable({ header, rows: collected.flatMap((file) => file.rows), sourceFile: collected.map((file) => file.sourceFile).join(", ") });
    setMapDate("");
    setMapDescription("");
    setMapAmount("");
    setMapCategory("");
  }

  function finishLoad(
    files: { header: string[]; rows: string[][]; sourceFile: string }[],
    columns: { date: number; description: number; amount: number; category: number },
  ) {
    resetImport();
    let allRows: RawTx[] = [];
    let allSkipped = 0;
    for (const file of files) {
      const { rows, skipped } = buildRawTxs(file.rows, columns, file.sourceFile);
      allRows = allRows.concat(rows);
      allSkipped += skipped;
    }
    setTxs(allRows);
    setSkippedCount(allSkipped);
    setPendingTable(null);
  }

  function handleConfirmMapping() {
    if (!pendingTable || !mapDate || !mapDescription || !mapAmount) {
      setLoadError("Pick at least date, description, and amount columns.");
      return;
    }
    const columns = {
      date: pendingTable.header.indexOf(mapDate),
      description: pendingTable.header.indexOf(mapDescription),
      amount: pendingTable.header.indexOf(mapAmount),
      category: mapCategory ? pendingTable.header.indexOf(mapCategory) : -1,
    };
    finishLoad([{ header: pendingTable.header, rows: pendingTable.rows, sourceFile: pendingTable.sourceFile }], columns);
  }

  async function handleAddFriend() {
    const name = newFriendName.trim();
    if (!name) return;
    try {
      const participantId = await addNamedMember(contextId, name);
      setExtraParticipants((current) => [...current, { participantId, displayName: name }]);
      setNewFriendName("");
    } catch (cause) {
      setLoadError(humanizeError(cause));
    }
  }

  const reviewedIds = new Set(Object.keys(decisions));
  const flaggedIds = new Set(Object.entries(decisions).filter(([, decision]) => decision.flagged).map(([txId]) => txId));

  const filteredQueue = useMemo(() => {
    let list = [...txs];
    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      list = list.filter((tx) => tx.description.toLowerCase().includes(query));
    }
    list.sort((left, right) => (sortOrder === "newest" ? right.date.localeCompare(left.date) : left.date.localeCompare(right.date)));
    if (showOnlyFlagged) {
      list = list.filter((tx) => flaggedIds.has(tx.txId));
    } else if (focusMode) {
      list = list.filter((tx) => !reviewedIds.has(tx.txId));
    }
    return list;
    // reviewedIds/flaggedIds are derived from `decisions` each render, which is
    // already a dependency via the surrounding closure re-running on state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txs, searchQuery, sortOrder, showOnlyFlagged, focusMode, decisions]);

  const clampedPointer = filteredQueue.length === 0 ? 0 : Math.min(pointer, filteredQueue.length - 1);
  const currentTx = filteredQueue[clampedPointer] ?? null;

  const otherParticipantIds = allParticipants.map((participant) => participant.participantId).filter((id) => id !== payerId);

  function loadRowFormState(tx: RawTx) {
    const previouslySaved = savedEntries[tx.txId];
    if (previouslySaved) {
      setPayerId(previouslySaved.payerId);
      const isPersonal = previouslySaved.allocations.length === 1;
      setOnMe(isPersonal);
      const withoutPayer = previouslySaved.allocations.filter((allocation) => allocation.participantId !== previouslySaved.payerId);
      setSplitWith(withoutPayer.map((allocation) => allocation.participantId));
      setSplitMethod("exact");
      const inputs: Record<string, string> = {};
      for (const allocation of withoutPayer) {
        inputs[allocation.participantId] = (allocation.shareAmount / 100).toFixed(2);
      }
      setExactAmountInputs(inputs);
      setShareWeightInputs({});
      setFlagged(decisions[tx.txId]?.flagged ?? false);
      setRowNotes(previouslySaved.notes ?? "");
    } else {
      setPayerId(deviceParticipantId);
      setOnMe(false);
      setSplitMethod("shares");
      const others = allParticipants.map((participant) => participant.participantId).filter((id) => id !== deviceParticipantId);
      setSplitWith(others);
      const weights: Record<string, string> = { [deviceParticipantId]: "1" };
      others.forEach((id) => (weights[id] = "1"));
      setShareWeightInputs(weights);
      setExactAmountInputs({});
      setFlagged(false);
      setRowNotes("");
    }
    setSaveError(null);
  }

  const activeRowKey = currentTx?.txId ?? null;
  if (currentTx && loadedForTxId !== activeRowKey) {
    loadRowFormState(currentTx);
    setLoadedForTxId(activeRowKey);
  }

  function computeAllocations(tx: RawTx): { participantId: string; shareAmount: number; isPayer: boolean }[] | null {
    const totalPaise = Math.abs(tx.amountPaise);
    if (onMe) {
      return [{ participantId: payerId, shareAmount: totalPaise, isPayer: true }];
    }
    if (splitWith.length === 0) {
      return null;
    }
    if (splitMethod === "shares") {
      const weights: Record<string, number> = {};
      const payerWeight = Number(shareWeightInputs[payerId] ?? "");
      if (Number.isFinite(payerWeight) && payerWeight > 0) {
        weights[payerId] = payerWeight;
      }
      for (const id of splitWith) {
        const weight = Number(shareWeightInputs[id] ?? "");
        if (Number.isFinite(weight) && weight > 0) {
          weights[id] = weight;
        }
      }
      if (!(payerId in weights)) return null;
      return buildShareAllocations(totalPaise, weights, payerId);
    }
    let sum = 0;
    const allocations: { participantId: string; shareAmount: number; isPayer: boolean }[] = [];
    for (const id of splitWith) {
      const paise = parseAmountToPaise(exactAmountInputs[id] ?? "");
      if (paise === null) return null;
      allocations.push({ participantId: id, shareAmount: paise, isPayer: false });
      sum += paise;
    }
    if (sum > totalPaise) return null;
    allocations.push({ participantId: payerId, shareAmount: totalPaise - sum, isPayer: true });
    return allocations;
  }

  const previewAllocations = currentTx ? computeAllocations(currentTx) : null;

  async function handleSaveAndNext() {
    if (!currentTx) return;
    setSaveError(null);
    // A return/credit row is money coming back. Booking it through the
    // expense path (as Math.abs of the amount) recorded it as another
    // purchase, inflating spend and balances in the wrong direction
    // (unified-expense-os-2ui). The ledger has no reversal shape yet — the
    // server requires total_amount > 0 — so refuse rather than book it
    // wrongly; skipping leaves the row untouched.
    if (currentTx.amountPaise > 0) {
      setSaveError(
        "This is a refund/credit, not a purchase. Recording it as an expense would increase spend instead of reducing it, so skip it for now and adjust manually.",
      );
      return;
    }
    const allocations = computeAllocations(currentTx);
    if (!allocations) {
      setSaveError(onMe ? "Pick a payer." : "Assign a payer share and cover the full amount.");
      return;
    }
    const customShares = Object.fromEntries(allocations.map((allocation) => [allocation.participantId, allocation.shareAmount]));
    setBusy(true);
    try {
      const existing = savedEntries[currentTx.txId];
      const saved = existing
        ? await editExpense(existing, {
            description: currentTx.description,
            category: currentTx.category,
            notes: rowNotes.trim() || null,
            amountPaise: Math.abs(currentTx.amountPaise),
            payerId,
          })
        : await queueExpense({
            contextId,
            payerId,
            description: currentTx.description,
            category: currentTx.category,
            notes: rowNotes.trim() || null,
            amountPaise: Math.abs(currentTx.amountPaise),
            participantIds: allocations.map((allocation) => allocation.participantId),
            customShares,
            effectiveDate: currentTx.date,
          });
      setSavedEntries((current) => ({ ...current, [currentTx.txId]: saved }));
      setDecisions((current) => ({ ...current, [currentTx.txId]: { entryId: saved.entryId, flagged } }));
      setLastSavedTxId(currentTx.txId);
      await refresh();
      requestSync();
      if (!focusMode) {
        setPointer((current) => current + 1);
      }
      setLoadedForTxId(null);
    } catch (cause) {
      setSaveError(humanizeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleUndoLastSave() {
    if (!lastSavedTxId) return;
    const entry = savedEntries[lastSavedTxId];
    if (!entry) return;
    setBusy(true);
    try {
      await voidExpense(entry, "Undone from statement triage");
      await refresh();
      requestSync();
      setDecisions((current) => {
        const next = { ...current };
        delete next[lastSavedTxId];
        return next;
      });
      setSavedEntries((current) => {
        const next = { ...current };
        delete next[lastSavedTxId];
        return next;
      });
      setLastSavedTxId(null);
      setLoadedForTxId(null);
      setStatus(`Reverted "${entry.description}".`);
    } catch (cause) {
      setStatus(humanizeError(cause));
    } finally {
      setBusy(false);
    }
  }

  function handleSkip() {
    setPointer((current) => current + 1);
    setLoadedForTxId(null);
  }

  function handlePrevious() {
    setPointer((current) => Math.max(0, current - 1));
    setLoadedForTxId(null);
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Import raw bank statement</h2>
        <button className="secondary compact" onClick={() => setOpen((current) => !current)}>
          {open ? "Close" : "Open"}
        </button>
      </div>
      {open ? (
        <>
          <div className="info-strip">
            <span>
              Upload raw bank/card CSV exports (any headers — date, description, amount, and optionally category).
              Walk each transaction one at a time: assign who paid, split it or mark it personal, flag anything
              unsure for later, and it becomes a real ledger entry as you go.
            </span>
          </div>
          {txs.length === 0 && !pendingTable ? (
            <div className="form-actions">
              <input
                type="file"
                accept=".csv,text/csv"
                multiple
                disabled={!online}
                onChange={(event) => {
                  if (event.target.files && event.target.files.length > 0) {
                    void handleFiles(event.target.files);
                  }
                  event.target.value = "";
                }}
              />
            </div>
          ) : null}
          {loadError ? <p className="status error-text">{loadError}</p> : null}
          {pendingTable ? (
            <div className="entry-form">
              <p className="status wide">Couldn't auto-detect columns — pick them from "{pendingTable.sourceFile}":</p>
              <label>
                Date column
                <select value={mapDate} onChange={(event) => setMapDate(event.target.value)}>
                  <option value="">Select…</option>
                  {pendingTable.header.map((column) => (
                    <option key={column} value={column}>
                      {column}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Description column
                <select value={mapDescription} onChange={(event) => setMapDescription(event.target.value)}>
                  <option value="">Select…</option>
                  {pendingTable.header.map((column) => (
                    <option key={column} value={column}>
                      {column}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Amount column
                <select value={mapAmount} onChange={(event) => setMapAmount(event.target.value)}>
                  <option value="">Select…</option>
                  {pendingTable.header.map((column) => (
                    <option key={column} value={column}>
                      {column}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Category column (optional)
                <select value={mapCategory} onChange={(event) => setMapCategory(event.target.value)}>
                  <option value="">None</option>
                  {pendingTable.header.map((column) => (
                    <option key={column} value={column}>
                      {column}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-actions wide">
                <button type="button" className="primary" onClick={handleConfirmMapping}>
                  Continue
                </button>
                <button type="button" className="secondary" onClick={() => setPendingTable(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {txs.length > 0 ? (
            <>
              <div className="form-actions wide">
                <span className="status">
                  {reviewedIds.size} / {txs.length} reviewed{skippedCount > 0 ? ` · ${skippedCount} row(s) skipped (unparseable)` : ""}
                </span>
                <button type="button" className="secondary compact" onClick={resetImport}>
                  Start over
                </button>
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${txs.length === 0 ? 0 : Math.round((reviewedIds.size / txs.length) * 100)}%` }}
                />
              </div>
              <div className="entry-form filter-form">
                <label className="wide">
                  Search description
                  <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Merchant…" />
                </label>
                <label>
                  Sort
                  <select value={sortOrder} onChange={(event) => setSortOrder(event.target.value as "newest" | "oldest")}>
                    <option value="newest">Newest first</option>
                    <option value="oldest">Oldest first</option>
                  </select>
                </label>
                <label className="toggle-inline">
                  <input type="checkbox" checked={focusMode} onChange={(event) => setFocusMode(event.target.checked)} />
                  <span>Focus mode: hide reviewed</span>
                </label>
                <label className="toggle-inline">
                  <input type="checkbox" checked={showOnlyFlagged} onChange={(event) => setShowOnlyFlagged(event.target.checked)} />
                  <span>Show only flagged</span>
                </label>
              </div>
              <div className="form-actions wide">
                <input
                  value={newFriendName}
                  onChange={(event) => setNewFriendName(event.target.value)}
                  placeholder="Add a new person…"
                />
                <button type="button" className="secondary compact" onClick={handleAddFriend} disabled={!newFriendName.trim() || !online}>
                  Add
                </button>
              </div>
              {lastSavedTxId ? (
                <div className="form-actions wide">
                  <button type="button" className="secondary compact" onClick={handleUndoLastSave} disabled={busy}>
                    Undo last save
                  </button>
                </div>
              ) : null}
              {currentTx ? (
                <div className="entry-form">
                  <p className="status wide">
                    Entry {clampedPointer + 1} of {filteredQueue.length} · {currentTx.sourceFile}
                  </p>
                  <p className="status wide">
                    <strong>{currentTx.amountPaise > 0 ? "↩ Return" : "🛒 Purchase"}: {formatMoney(Math.abs(currentTx.amountPaise))}</strong>
                    {" · "}
                    {currentTx.date} · {currentTx.category}
                  </p>
                  <p className="status wide">{currentTx.description}</p>
                  {currentTx.amountPaise > 0 ? (
                    <div className="info-strip wide">
                      <span>
                        Refund/credit — recording it as an expense would count it as spending. Skip this
                        row and adjust manually until refunds are modelled properly.
                      </span>
                    </div>
                  ) : null}
                  <label>
                    Who paid?
                    <select value={payerId} onChange={(event) => setPayerId(event.target.value)}>
                      {allParticipants.map((participant) => (
                        <option key={participant.participantId} value={participant.participantId}>
                          {participant.displayName}
                          {participant.participantId === deviceParticipantId ? " (me)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="toggle-inline">
                    <input type="checkbox" checked={onMe} onChange={(event) => setOnMe(event.target.checked)} />
                    <span>No split — payer's own expense</span>
                  </label>
                  <label className="toggle-inline">
                    <input type="checkbox" checked={flagged} onChange={(event) => setFlagged(event.target.checked)} />
                    <span>🚩 Flag for review</span>
                  </label>
                  {!onMe ? (
                    <>
                      <div className="chip-row wide">
                        <button
                          type="button"
                          className={`chip${splitMethod === "shares" ? " chip-active" : ""}`}
                          onClick={() => setSplitMethod("shares")}
                        >
                          By shares
                        </button>
                        <button
                          type="button"
                          className={`chip${splitMethod === "exact" ? " chip-active" : ""}`}
                          onClick={() => setSplitMethod("exact")}
                        >
                          Exact amounts
                        </button>
                      </div>
                      <div className="split-list wide">
                        <p className="status wide">Split with:</p>
                        {otherParticipantIds.map((participantId) => {
                          const preview = previewAllocations?.find((allocation) => allocation.participantId === participantId);
                          return (
                            <div className="split-row" key={participantId}>
                              <label className="toggle-inline">
                                <input
                                  type="checkbox"
                                  checked={splitWith.includes(participantId)}
                                  onChange={(event) =>
                                    setSplitWith((current) =>
                                      event.target.checked
                                        ? [...current, participantId]
                                        : current.filter((id) => id !== participantId),
                                    )
                                  }
                                />
                                <span>{participantName(allParticipants, participantId)}</span>
                              </label>
                              {splitMethod === "shares" ? (
                                <input
                                  className="split-amount"
                                  inputMode="numeric"
                                  placeholder="1"
                                  disabled={!splitWith.includes(participantId)}
                                  value={shareWeightInputs[participantId] ?? ""}
                                  onChange={(event) =>
                                    setShareWeightInputs((current) => ({ ...current, [participantId]: event.target.value }))
                                  }
                                />
                              ) : (
                                <input
                                  className="split-amount"
                                  inputMode="decimal"
                                  placeholder="0.00"
                                  disabled={!splitWith.includes(participantId)}
                                  value={exactAmountInputs[participantId] ?? ""}
                                  onChange={(event) =>
                                    setExactAmountInputs((current) => ({ ...current, [participantId]: event.target.value }))
                                  }
                                />
                              )}
                              {preview ? <span className="share-hint">{formatMoney(preview.shareAmount)}</span> : null}
                            </div>
                          );
                        })}
                        {splitMethod === "shares" ? (
                          <div className="split-row">
                            <span>{participantName(allParticipants, payerId)}'s own shares</span>
                            <input
                              className="split-amount"
                              inputMode="numeric"
                              placeholder="1"
                              value={shareWeightInputs[payerId] ?? ""}
                              onChange={(event) => setShareWeightInputs((current) => ({ ...current, [payerId]: event.target.value }))}
                            />
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : null}
                  <label className="wide">
                    Notes
                    <textarea value={rowNotes} onChange={(event) => setRowNotes(event.target.value)} rows={2} />
                  </label>
                  {saveError ? <span className="error-text wide">{saveError}</span> : null}
                  <div className="form-actions wide">
                    <button type="button" className="secondary" onClick={handlePrevious} disabled={clampedPointer === 0 || busy}>
                      ← Previous
                    </button>
                    <button type="button" className="secondary" onClick={handleSkip} disabled={busy}>
                      Skip →
                    </button>
                    <button
                      type="button"
                      className="primary"
                      onClick={handleSaveAndNext}
                      disabled={busy || !online || currentTx.amountPaise > 0}
                      title={
                        currentTx.amountPaise > 0
                          ? "Refunds can't be recorded as expenses yet — skip this row."
                          : undefined
                      }
                    >
                      {busy ? "Saving…" : "Save & Next"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="info-strip">
                  <span>All items processed, or nothing matches the current filters.</span>
                </div>
              )}
            </>
          ) : null}
        </>
      ) : null}
    </article>
  );
}
