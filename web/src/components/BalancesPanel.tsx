import { FormEvent, useState } from "react";
import { queueOpeningBalance } from "../lib/api";
import { humanizeError } from "../lib/errors";
import { formatMoneyIn } from "../lib/currencies";
import { parseAmountToPaise, participantName, type MemberSpend, type PairwiseBalance } from "../lib/finance";
import type { LedgerEntry, Participant } from "../types";

type Balance = { participantId: string; netBalance: number; left?: boolean };

type BalancesProps = {
  balances: Balance[];
  participants: Participant[];
  deviceParticipantId: string;
  allSettled: boolean;
  entries: LedgerEntry[];
  contextId: string;
  memberIds: string[];
  isShared: boolean;
  online: boolean;
  currency: string;
  refresh: () => Promise<void>;
  requestSync: () => void;
  setStatus: (message: string) => void;
};

function formatDay(value: string): string {
  return new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

// Contribution of a single entry to one participant's net balance: positive
// when they paid (fronted), negative for their allocated share. Mirrors the
// same accumulation deriveBalances() uses, one entry at a time, so a user can
// see exactly which entries produced the total they're looking at.
function entryContribution(entry: LedgerEntry, participantId: string): number {
  let delta = 0;
  if (entry.payerId === participantId) {
    delta += entry.totalAmount;
  }
  const allocation = entry.allocations.find((row) => row.participantId === participantId);
  if (allocation) {
    delta -= allocation.shareAmount;
  }
  return delta;
}

export function BalancesPanel({
  balances,
  participants,
  deviceParticipantId,
  allSettled,
  entries,
  contextId,
  memberIds,
  isShared,
  online,
  currency,
  refresh,
  requestSync,
  setStatus,
}: BalancesProps) {
  const [expandedParticipantId, setExpandedParticipantId] = useState<string | null>(null);
  const [openingFormOpen, setOpeningFormOpen] = useState(false);
  const [creditorId, setCreditorId] = useState("");
  const [debtorId, setDebtorId] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [openingDescription, setOpeningDescription] = useState("");
  const [openingBusy, setOpeningBusy] = useState(false);
  const [openingError, setOpeningError] = useState<string | null>(null);

  function toggle(participantId: string) {
    setExpandedParticipantId((current) => (current === participantId ? null : participantId));
  }

  async function handleAddOpeningBalance(event: FormEvent) {
    event.preventDefault();
    setOpeningError(null);
    const amountPaise = parseAmountToPaise(amountInput);
    if (!creditorId || !debtorId) {
      setOpeningError("Choose who is owed and who owes.");
      return;
    }
    if (creditorId === debtorId) {
      setOpeningError("Choose two different people.");
      return;
    }
    if (amountPaise === null || amountPaise <= 0) {
      setOpeningError("Enter a valid amount.");
      return;
    }
    setOpeningBusy(true);
    try {
      await queueOpeningBalance({
        contextId,
        creditorId,
        debtorId,
        amountPaise,
        description: openingDescription,
      });
      await refresh();
      requestSync();
      setStatus("Opening balance recorded.");
      setAmountInput("");
      setOpeningDescription("");
      setOpeningFormOpen(false);
    } catch (cause) {
      setOpeningError(humanizeError(cause));
    } finally {
      setOpeningBusy(false);
    }
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Balances</h2>
        <span>{allSettled ? "All settled" : "Derived locally"}</span>
      </div>
      <div className="balance-list">
        {balances.map((row) => {
          const contributingEntries = entries
            .filter((entry) => entry.syncState !== "rejected" && !entry.voidedAt)
            .filter((entry) => entryContribution(entry, row.participantId) !== 0)
            .sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate));
          return (
            <div key={row.participantId}>
              <button
                type="button"
                className="balance-row balance-row-button"
                onClick={() => toggle(row.participantId)}
              >
                <span>
                  {participantName(participants, row.participantId)}
                  {row.participantId === deviceParticipantId ? " (me)" : ""}
                  {row.left ? <em className="badge pending-badge">left — settle up</em> : null}
                </span>
                <strong className={row.netBalance >= 0 ? "positive" : "negative"}>
                  {formatMoneyIn(currency, row.netBalance)}
                </strong>
              </button>
              {expandedParticipantId === row.participantId ? (
                <ul className="history-list">
                  {contributingEntries.length === 0 ? (
                    <li>No entries contribute to this balance.</li>
                  ) : (
                    contributingEntries.map((entry) => {
                      const delta = entryContribution(entry, row.participantId);
                      return (
                        <li key={entry.entryId}>
                          {formatDay(entry.effectiveDate)} · {entry.description} ·{" "}
                          <span className={delta >= 0 ? "positive" : "negative"}>
                            {delta >= 0 ? "+" : ""}
                            {formatMoneyIn(currency, delta)}
                          </span>
                        </li>
                      );
                    })
                  )}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
      {isShared && memberIds.length >= 2 ? (
        <>
          <div className="panel-header preference-header">
            <h2>Opening balance</h2>
          </div>
          {openingFormOpen ? (
            <form className="entry-form" onSubmit={handleAddOpeningBalance}>
              <label>
                Owed to
                <select value={creditorId} onChange={(event) => setCreditorId(event.target.value)}>
                  <option value="">Choose…</option>
                  {memberIds.map((id) => (
                    <option key={id} value={id}>
                      {participantName(participants, id)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Owed by
                <select value={debtorId} onChange={(event) => setDebtorId(event.target.value)}>
                  <option value="">Choose…</option>
                  {memberIds.map((id) => (
                    <option key={id} value={id}>
                      {participantName(participants, id)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Amount
                <input
                  value={amountInput}
                  onChange={(event) => setAmountInput(event.target.value)}
                  placeholder="e.g. 3200"
                  inputMode="decimal"
                />
              </label>
              <label className="wide">
                Note (optional)
                <input
                  value={openingDescription}
                  onChange={(event) => setOpeningDescription(event.target.value)}
                  placeholder="e.g. Carried over from before"
                />
              </label>
              {openingError ? <span className="error-text wide">{openingError}</span> : null}
              <div className="form-actions wide">
                <button type="submit" className="primary" disabled={openingBusy || !online}>
                  {openingBusy ? "Saving…" : "Save opening balance"}
                </button>
                <button type="button" className="secondary compact" onClick={() => setOpeningFormOpen(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="form-actions">
              <button className="secondary compact" disabled={!online} onClick={() => setOpeningFormOpen(true)}>
                Seed a starting balance
              </button>
            </div>
          )}
        </>
      ) : null}
    </article>
  );
}

type SpendProps = {
  spendSummary: MemberSpend[];
  participants: Participant[];
  deviceParticipantId: string;
  currency: string;
};

type PairwiseProps = {
  pairs: PairwiseBalance[];
  participants: Participant[];
  deviceParticipantId: string;
  currency: string;
};

// Literal two-person "A owes B" balances (unified-expense-os-b8o), distinct
// from the net-vs-group Balances panel above and from the simplified
// settlement plan — this is the raw, unsimplified pairwise truth.
export function PairwiseBalancesPanel({ pairs, participants, deviceParticipantId, currency }: PairwiseProps) {
  if (pairs.length === 0) {
    return null;
  }
  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Who owes whom</h2>
        <span>Unsimplified pairwise</span>
      </div>
      <div className="balance-list">
        {pairs.map((pair) => (
          <div className="balance-row" key={`${pair.fromId}-${pair.toId}`}>
            <span>
              {participantName(participants, pair.fromId)}
              {pair.fromId === deviceParticipantId ? " (me)" : ""} owes{" "}
              {participantName(participants, pair.toId)}
              {pair.toId === deviceParticipantId ? " (me)" : ""}
            </span>
            <strong className="negative">{formatMoneyIn(currency, pair.amount)}</strong>
          </div>
        ))}
      </div>
    </article>
  );
}

export function SpendSummaryPanel({ spendSummary, participants, deviceParticipantId, currency }: SpendProps) {
  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Who spent what</h2>
        <span>Share used vs. fronted</span>
      </div>
      <div className="spend-list">
        {spendSummary.map((row) => (
          <div className="balance-row" key={row.participantId}>
            <span>
              {participantName(participants, row.participantId)}
              {row.participantId === deviceParticipantId ? " (me)" : ""}
              {row.left ? <em className="badge pending-badge">left</em> : null}
            </span>
            <span>
              <strong>{formatMoneyIn(currency, row.spent)}</strong> used · {formatMoneyIn(currency, row.paid)} paid
            </span>
          </div>
        ))}
      </div>
    </article>
  );
}
