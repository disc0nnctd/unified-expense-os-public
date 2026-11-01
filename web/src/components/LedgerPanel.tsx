import { useState } from "react";
import { editExpense, fetchEntryHistory, voidExpense } from "../lib/api";
import { buildContextExportCsv, downloadCsv } from "../lib/csv";
import { humanizeError } from "../lib/errors";
import { formatMoneyIn } from "../lib/currencies";
import { formatMoney, localDateString, parseAmountToPaise, participantName } from "../lib/finance";
import { discardEntry, requeueEntry } from "../lib/localDb";
import type { ContextRecord, EntryHistoryRecord, LedgerEntry, Participant } from "../types";

type Props = {
  entries: LedgerEntry[];
  participants: Participant[];
  context: ContextRecord;
  balances: { participantId: string; netBalance: number }[];
  refresh: () => Promise<void>;
  requestSync: () => void;
  setStatus: (message: string) => void;
};

function formatDay(value: string): string {
  return new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export default function LedgerPanel({ entries, participants, context, balances, refresh, requestSync, setStatus }: Props) {
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
  const [historyByEntry, setHistoryByEntry] = useState<Record<string, EntryHistoryRecord[]>>({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editDescription, setEditDescription] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editPayerId, setEditPayerId] = useState("");
  const [voidingEntryId, setVoidingEntryId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");

  const [searchText, setSearchText] = useState("");
  const [filterPayerId, setFilterPayerId] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterType, setFilterType] = useState<"" | "expense" | "settlement" | "adjustment">("");
  const [filterStartDate, setFilterStartDate] = useState("");
  const [filterEndDate, setFilterEndDate] = useState("");

  const availableCategories = Array.from(
    new Set(entries.map((entry) => entry.category).filter((category): category is string => Boolean(category))),
  ).sort();

  const filteredEntries = entries.filter((entry) => {
    if (searchText.trim() && !entry.description.toLowerCase().includes(searchText.trim().toLowerCase())) {
      return false;
    }
    if (filterPayerId && entry.payerId !== filterPayerId) {
      return false;
    }
    if (filterCategory && entry.category !== filterCategory) {
      return false;
    }
    if (filterType && entry.type !== filterType) {
      return false;
    }
    if (filterStartDate && entry.effectiveDate < filterStartDate) {
      return false;
    }
    if (filterEndDate && entry.effectiveDate > filterEndDate) {
      return false;
    }
    return true;
  });

  const hasActiveFilters = Boolean(
    searchText.trim() || filterPayerId || filterCategory || filterType || filterStartDate || filterEndDate,
  );

  function clearFilters() {
    setSearchText("");
    setFilterPayerId("");
    setFilterCategory("");
    setFilterType("");
    setFilterStartDate("");
    setFilterEndDate("");
  }

  const sortedEntries = [...filteredEntries].sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));

  async function handleToggleHistory(entryId: string) {
    if (expandedEntryId === entryId) {
      setExpandedEntryId(null);
      return;
    }
    setExpandedEntryId(entryId);
    if (!historyByEntry[entryId]) {
      setHistoryLoading(true);
      try {
        const rows = await fetchEntryHistory(entryId);
        setHistoryByEntry((current) => ({ ...current, [entryId]: rows }));
      } catch (cause) {
        setStatus(humanizeError(cause));
      } finally {
        setHistoryLoading(false);
      }
    }
  }

  async function handleDiscard(entryId: string) {
    await discardEntry(entryId);
    await refresh();
    setStatus("Discarded the rejected entry.");
  }

  async function handleRetry(entryId: string) {
    await requeueEntry(entryId);
    await refresh();
    setStatus("Queued the entry for another sync attempt.");
    requestSync();
  }

  function startEdit(entry: LedgerEntry) {
    setVoidingEntryId(null);
    setEditingEntryId(entry.entryId);
    setEditDescription(entry.description);
    setEditCategory(entry.category ?? "");
    setEditNotes(entry.notes ?? "");
    setEditAmount((entry.totalAmount / 100).toString());
    setEditDate(entry.effectiveDate);
    setEditPayerId(entry.payerId);
  }

  function cancelEdit() {
    setEditingEntryId(null);
  }

  async function handleSaveEdit(entry: LedgerEntry) {
    const amountPaise = parseAmountToPaise(editAmount);
    if (amountPaise === null) {
      setStatus("Enter a valid amount before saving.");
      return;
    }
    try {
      await editExpense(entry, {
        description: editDescription.trim() || entry.description,
        category: editCategory.trim() ? editCategory.trim() : null,
        notes: editNotes.trim() ? editNotes.trim() : null,
        amountPaise,
        effectiveDate: editDate || entry.effectiveDate,
        payerId: editPayerId || entry.payerId,
      });
      setEditingEntryId(null);
      await refresh();
      setStatus("Edit queued for sync.");
      requestSync();
    } catch (cause) {
      setStatus(humanizeError(cause));
    }
  }

  function startVoid(entryId: string) {
    setEditingEntryId(null);
    setVoidingEntryId(entryId);
    setVoidReason("");
  }

  function cancelVoid() {
    setVoidingEntryId(null);
  }

  async function handleConfirmVoid(entry: LedgerEntry) {
    if (!voidReason.trim()) {
      setStatus("A void reason is required.");
      return;
    }
    await voidExpense(entry, voidReason.trim());
    setVoidingEntryId(null);
    await refresh();
    setStatus("Void queued for sync.");
    requestSync();
  }

  function handleExportCsv() {
    const csv = buildContextExportCsv(entries, participants, context, balances);
    const datestamp = localDateString(new Date());
    downloadCsv(`${context.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-export-${datestamp}.csv`, csv);
    setStatus("Exported ledger and balances to CSV.");
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Ledger</h2>
        <span>
          {hasActiveFilters ? `${sortedEntries.length} of ${entries.length} entries` : `${entries.length} entries`}
        </span>
      </div>
      <div className="form-actions">
        <button className="secondary compact" onClick={handleExportCsv} disabled={entries.length === 0}>
          Export CSV
        </button>
      </div>
      <div className="entry-form filter-form">
        <label className="wide">
          Search
          <input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Search description…"
          />
        </label>
        <label>
          Paid by
          <select value={filterPayerId} onChange={(event) => setFilterPayerId(event.target.value)}>
            <option value="">Anyone</option>
            {participants.map((participant) => (
              <option key={participant.participantId} value={participant.participantId}>
                {participant.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Category
          <select value={filterCategory} onChange={(event) => setFilterCategory(event.target.value)}>
            <option value="">All categories</option>
            {availableCategories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type
          <select
            value={filterType}
            onChange={(event) => setFilterType(event.target.value as "" | "expense" | "settlement" | "adjustment")}
          >
            <option value="">All types</option>
            <option value="expense">Expense</option>
            <option value="settlement">Settlement</option>
            <option value="adjustment">Opening balance</option>
          </select>
        </label>
        <label>
          From
          <input type="date" value={filterStartDate} onChange={(event) => setFilterStartDate(event.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={filterEndDate} onChange={(event) => setFilterEndDate(event.target.value)} />
        </label>
        {hasActiveFilters ? (
          <div className="form-actions wide">
            <button type="button" className="secondary compact" onClick={clearFilters}>
              Clear filters
            </button>
          </div>
        ) : null}
      </div>
      {sortedEntries.length === 0 ? (
        <div className="info-strip">
          <span>{hasActiveFilters ? "No entries match these filters." : "No entries yet. Add the first expense above."}</span>
        </div>
      ) : (
        <ul className="entry-list">
          {sortedEntries.map((entry) => (
            <li
              key={entry.entryId}
              className={entry.syncState === "rejected" ? "rejected-row" : entry.voidedAt ? "voided-row" : undefined}
            >
              <div>
                <strong className={entry.voidedAt ? "voided-text" : undefined}>
                  {entry.type === "settlement" ? "↔ " : ""}
                  {entry.type === "adjustment" ? "⚖ " : ""}
                  {entry.description}
                </strong>
                <span>
                  {participantName(participants, entry.payerId)} paid · {formatDay(entry.effectiveDate)}
                  {entry.syncState === "pending" ? " · queued" : ""}
                  {entry.syncState === "rejected" ? ` · rejected: ${humanizeError(entry.syncError ?? "rejected")}` : ""}
                  {entry.voidedAt ? ` · voided: ${entry.voidReason ?? "no reason given"}` : ""}
                </span>
                {entry.notes ? <span className="notes-text">{entry.notes}</span> : null}
                {entry.conflictResolvedBy ? (
                  <span className="info-strip conflict-banner">
                    A concurrent edit conflict on this entry was resolved automatically
                    (last-write-wins) — an earlier edit from another device may have been overridden.
                    Check History for the full trail.
                  </span>
                ) : null}
                {entry.syncState === "rejected" ? (
                  <span className="row-actions">
                    <button className="secondary compact" onClick={() => handleRetry(entry.entryId)}>
                      Retry
                    </button>
                    <button className="secondary compact" onClick={() => handleDiscard(entry.entryId)}>
                      Discard
                    </button>
                  </span>
                ) : null}
                {entry.syncState === "committed" ? (
                  <span className="row-actions">
                    <button className="secondary compact" onClick={() => handleToggleHistory(entry.entryId)}>
                      {expandedEntryId === entry.entryId ? "Hide history" : "History"}
                    </button>
                    {!entry.voidedAt ? (
                      <button className="secondary compact" onClick={() => startEdit(entry)}>
                        Edit
                      </button>
                    ) : null}
                    {!entry.voidedAt ? (
                      <button className="secondary compact" onClick={() => startVoid(entry.entryId)}>
                        Void
                      </button>
                    ) : null}
                  </span>
                ) : null}
                {editingEntryId === entry.entryId ? (
                  <div className="inline-edit-form">
                    <label>
                      Description
                      <input value={editDescription} onChange={(event) => setEditDescription(event.target.value)} />
                    </label>
                    <label>
                      Category
                      <input value={editCategory} onChange={(event) => setEditCategory(event.target.value)} />
                    </label>
                    <label>
                      Notes
                      <input value={editNotes} onChange={(event) => setEditNotes(event.target.value)} />
                    </label>
                    <label>
                      Amount (INR)
                      <input value={editAmount} onChange={(event) => setEditAmount(event.target.value)} />
                    </label>
                    <label>
                      Date
                      <input
                        type="date"
                        value={editDate}
                        max={localDateString(new Date())}
                        onChange={(event) => setEditDate(event.target.value)}
                      />
                    </label>
                    <label>
                      Paid by
                      <select value={editPayerId} onChange={(event) => setEditPayerId(event.target.value)}>
                        {entry.allocations.map((allocation) => (
                          <option key={allocation.participantId} value={allocation.participantId}>
                            {participantName(participants, allocation.participantId)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="info-strip">
                      <span>Changing the amount or payer keeps each person's split proportion the same.</span>
                    </div>
                    <span className="row-actions">
                      <button className="primary compact" onClick={() => handleSaveEdit(entry)}>
                        Save
                      </button>
                      <button className="secondary compact" onClick={cancelEdit}>
                        Cancel
                      </button>
                    </span>
                  </div>
                ) : null}
                {voidingEntryId === entry.entryId ? (
                  <div className="inline-edit-form">
                    <label>
                      Void reason
                      <input
                        value={voidReason}
                        onChange={(event) => setVoidReason(event.target.value)}
                        placeholder="Why is this being voided?"
                      />
                    </label>
                    <span className="row-actions">
                      <button className="primary compact" onClick={() => handleConfirmVoid(entry)}>
                        Confirm void
                      </button>
                      <button className="secondary compact" onClick={cancelVoid}>
                        Cancel
                      </button>
                    </span>
                  </div>
                ) : null}
                {expandedEntryId === entry.entryId ? (
                  <ul className="history-list">
                    {historyLoading && !historyByEntry[entry.entryId] ? (
                      <li>Loading history…</li>
                    ) : (historyByEntry[entry.entryId] ?? []).length === 0 ? (
                      <li>No history recorded.</li>
                    ) : (
                      historyByEntry[entry.entryId].map((row) => (
                        <li key={`${row.version}-${row.hlc}`}>
                          v{row.version} · {row.action} by {participantName(participants, row.editedBy)} ·{" "}
                          {new Date(row.recordedAt).toLocaleString("en-IN")}
                          {row.action !== "created" ? ` — "${row.description}", ${formatMoney(row.totalAmount)}` : ""}
                          {` · ${row.allocations.map((allocation) => `${participantName(participants, allocation.participantId)} ${formatMoney(allocation.shareAmount)}`).join(", ")}`}
                          {row.notes ? ` · notes: ${row.notes}` : ""}
                        </li>
                      ))
                    )}
                  </ul>
                ) : null}
              </div>
              <span className="entry-amount">
                {formatMoneyIn(entry.currency, entry.totalAmount)}
                {entry.syncState === "pending" ? <em className="badge pending-badge">queued</em> : null}
                {entry.syncState === "rejected" ? <em className="badge rejected-badge">rejected</em> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
