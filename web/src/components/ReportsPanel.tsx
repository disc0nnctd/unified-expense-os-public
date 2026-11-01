import { useMemo, useState } from "react";
import { formatMoneyIn } from "../lib/currencies";
import {
  participantName,
  reportSummary,
  timeFrameRange,
  type TimeFrame,
} from "../lib/finance";
import type { LedgerEntry, Membership, Participant } from "../types";

type Props = {
  entries: LedgerEntry[];
  participants: Participant[];
  memberships: Membership[];
  deviceParticipantId: string;
  currency: string;
};

const FRAMES: { id: TimeFrame; label: string }[] = [
  { id: "week", label: "Last 7 days" },
  { id: "month", label: "Last 30 days" },
  { id: "year", label: "Last 12 months" },
  { id: "custom", label: "Custom range" },
];

export default function ReportsPanel({ entries, participants, memberships, deviceParticipantId, currency }: Props) {
  const [frame, setFrame] = useState<TimeFrame>("month");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const range = useMemo(() => {
    if (frame === "custom") {
      if (!customStart || !customEnd) {
        return null;
      }
      return timeFrameRange("custom", new Date(), { start: customStart, end: customEnd });
    }
    return timeFrameRange(frame);
  }, [frame, customStart, customEnd]);

  const summary = useMemo(
    () => (range ? reportSummary(entries, participants, memberships, range) : null),
    [entries, participants, memberships, range],
  );

  const maxCategoryTotal = summary?.byCategory[0]?.total ?? 0;

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Reports</h2>
        <span>{summary ? `${summary.entryCount} expenses` : "Pick a range"}</span>
      </div>

      <div className="entry-form" style={{ marginBottom: 12 }}>
        <label>
          Time frame
          <select value={frame} onChange={(event) => setFrame(event.target.value as TimeFrame)}>
            {FRAMES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {frame === "custom" ? (
          <>
            <label>
              From
              <input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} />
            </label>
            <label>
              To
              <input type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} />
            </label>
          </>
        ) : null}
      </div>

      {!summary ? (
        <div className="info-strip">
          <span>Choose a start and end date for the custom range.</span>
        </div>
      ) : summary.entryCount === 0 ? (
        <div className="info-strip">
          <span>No expenses in this range.</span>
        </div>
      ) : (
        <>
          <div className="balance-row">
            <span>Total spent</span>
            <strong>{formatMoneyIn(currency, summary.totalSpent)}</strong>
          </div>

          <h3 style={{ marginTop: 16, marginBottom: 8 }}>By category</h3>
          <div className="balance-list">
            {summary.byCategory.map((row) => (
              <div className="balance-row" key={row.category}>
                <span style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                  {row.category} <span style={{ opacity: 0.6 }}>({row.count})</span>
                  <span
                    style={{
                      display: "block",
                      height: 6,
                      borderRadius: 3,
                      background: "currentColor",
                      opacity: 0.35,
                      width: maxCategoryTotal ? `${Math.max(4, (row.total / maxCategoryTotal) * 100)}%` : "0%",
                    }}
                  />
                </span>
                <strong>{formatMoneyIn(currency, row.total)}</strong>
              </div>
            ))}
          </div>

          <h3 style={{ marginTop: 16, marginBottom: 8 }}>By member</h3>
          <div className="balance-list">
            {summary.byMember.map((row) => (
              <div className="balance-row" key={row.participantId}>
                <span>
                  {participantName(participants, row.participantId)}
                  {row.participantId === deviceParticipantId ? " (me)" : ""}
                </span>
                <strong>{formatMoneyIn(currency, row.spent)}</strong>
              </div>
            ))}
          </div>

          <h3 style={{ marginTop: 16, marginBottom: 8 }}>Month over month</h3>
          <div className="balance-list">
            {summary.monthOverMonth.map((row) => (
              <div className="balance-row" key={row.month}>
                <span>{row.month}</span>
                <strong>{formatMoneyIn(currency, row.total)}</strong>
              </div>
            ))}
          </div>

          {summary.largestEntries.length > 0 ? (
            <>
              <h3 style={{ marginTop: 16, marginBottom: 8 }}>Largest entries</h3>
              <ul className="history-list">
                {summary.largestEntries.map((entry) => (
                  <li key={entry.entryId}>
                    {entry.description} ({entry.category ?? "uncategorized"}) · {formatMoneyIn(currency, entry.totalAmount)} ·{" "}
                    {entry.effectiveDate}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <div className="balance-row" style={{ marginTop: 16 }}>
            <span>Settled in this range</span>
            <strong>{formatMoneyIn(currency, summary.settlementTotal)}</strong>
          </div>
        </>
      )}
    </article>
  );
}
