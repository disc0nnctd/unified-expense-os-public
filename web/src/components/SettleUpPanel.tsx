import { useEffect, useState } from "react";
import { fetchSettlementPlan, recordSettlement, updateContextSimplifyPreference } from "../lib/api";
import { formatMoneyIn, partitionByCurrency } from "../lib/currencies";
import { humanizeError } from "../lib/errors";
import { localSettlementPlan, participantName } from "../lib/finance";
import { isLocalOnly } from "../lib/localMode";
import type {
  ContextRecord,
  LedgerEntry,
  Participant,
  SettlementPlan,
  SettlementRecommendation,
} from "../types";

type Props = {
  context: ContextRecord;
  entries: LedgerEntry[];
  participants: Participant[];
  isOwner: boolean;
  online: boolean;
  refresh: () => Promise<void>;
  setStatus: (message: string) => void;
};

function settlementKey(recommendation: SettlementRecommendation): string {
  return `${recommendation.fromParticipantId}-${recommendation.toParticipantId}-${recommendation.kind}-${recommendation.amountCents}`;
}

export default function SettleUpPanel({ context, entries, participants, isOwner, online, refresh, setStatus }: Props) {
  const [plan, setPlan] = useState<SettlementPlan | null>(null);
  const [postingSettlementKey, setPostingSettlementKey] = useState<string | null>(null);
  const [settlementMessage, setSettlementMessage] = useState<string | null>(null);

  const contextId = context.contextId;

  useEffect(() => {
    let cancelled = false;
    // Local-only mode has no server to plan against; compute the pairwise
    // plan on-device instead of firing a doomed request
    // (unified-expense-os-kxb).
    if (isLocalOnly()) {
      // Same currency treatment as balances: plan over the primary-currency
      // entries only, never summing across currencies.
      const { primaryEntries, primaryCurrency } = partitionByCurrency(entries);
      setPlan(localSettlementPlan(contextId, primaryEntries, primaryCurrency));
      return;
    }
    if (!online) {
      setPlan(null);
      return;
    }
    fetchSettlementPlan(contextId)
      .then((result) => {
        if (!cancelled) {
          setPlan(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPlan(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [contextId, online, entries]);

  async function handleCopySettlementSummary() {
    if (!plan || plan.recommendations.length === 0) {
      return;
    }
    const lines = plan.recommendations.map((recommendation) => {
      const fromName = participantName(participants, recommendation.fromParticipantId);
      const toName = participantName(participants, recommendation.toParticipantId);
      return `${fromName} owes ${toName} ${formatMoneyIn(recommendation.currency, recommendation.amountCents)}`;
    });
    const text = `Settle up — ${context.name}\n${lines.join("\n")}`;
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Settlement summary copied to clipboard.");
    } catch {
      setSettlementMessage(text);
    }
  }

  async function handleRecordSettlement(recommendation: SettlementRecommendation) {
    const key = settlementKey(recommendation);
    setPostingSettlementKey(key);
    setSettlementMessage(null);
    try {
      const entry = await recordSettlement(contextId, recommendation);
      await refresh();
      const fromName = participantName(participants, recommendation.fromParticipantId);
      const toName = participantName(participants, recommendation.toParticipantId);
      setSettlementMessage(`Recorded ${formatMoneyIn(entry.currency, entry.totalAmount)}: ${fromName} → ${toName}.`);
      setStatus("Settlement recorded.");
    } catch (cause) {
      setSettlementMessage(humanizeError(cause));
    } finally {
      setPostingSettlementKey(null);
    }
  }

  async function handleContextSimplifyToggle(checked: boolean) {
    try {
      await updateContextSimplifyPreference(contextId, checked);
      await refresh();
      setStatus(checked ? "Debt simplification enabled." : "Debt simplification disabled.");
    } catch (cause) {
      setStatus(humanizeError(cause));
    }
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Settle up</h2>
        <label className="toggle-row compact-toggle" title={isOwner ? "" : "Owner controls this"}>
          <input
            type="checkbox"
            checked={context.allowSimplifiedDebts}
            disabled={!isOwner || !online}
            onChange={(event) => handleContextSimplifyToggle(event.target.checked)}
          />
          <span>Simplify debts</span>
        </label>
      </div>
      {!online && !isLocalOnly() ? (
        <div className="info-strip">
          <span>Who-pays-whom is worked out on the server — reconnect and this will fill in.</span>
        </div>
      ) : plan ? (
        <>
          {plan.simplificationEnabled && plan.excludedParticipantIds.length > 0 ? (
            <div className="info-strip">
              <span>
                Kept pairwise:{" "}
                {plan.excludedParticipantIds
                  .map((participantId) => participantName(participants, participantId))
                  .join(", ")}
              </span>
            </div>
          ) : null}
          {plan.recommendations.length > 0 ? (
            <div className="plan-list">
              <div className="row-actions">
                <button className="secondary compact" onClick={handleCopySettlementSummary}>
                  Copy summary
                </button>
              </div>
              {plan.recommendations.map((recommendation) => {
                const key = settlementKey(recommendation);
                return (
                  <div className="plan-row" key={key}>
                    <span>
                      {participantName(participants, recommendation.fromParticipantId)} pays{" "}
                      {participantName(participants, recommendation.toParticipantId)}
                    </span>
                    <strong>{formatMoneyIn(recommendation.currency, recommendation.amountCents)}</strong>
                    <button
                      className="secondary compact"
                      disabled={postingSettlementKey !== null}
                      onClick={() => handleRecordSettlement(recommendation)}
                    >
                      {postingSettlementKey === key ? "Recording…" : "Record"}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="info-strip">
              <span>Nothing to settle — balances are even.</span>
            </div>
          )}
          {settlementMessage ? <span className="settlement-result">{settlementMessage}</span> : null}
        </>
      ) : (
        <div className="info-strip">
          <span>Loading settlement plan…</span>
        </div>
      )}
    </article>
  );
}
