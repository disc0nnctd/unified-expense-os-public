import { useEffect, useState } from "react";
import AddExpensePanel from "../components/AddExpensePanel";
import ChatPanel from "../components/ChatPanel";
import type { NavTarget } from "../lib/assistant";
import { isLocalOnly } from "../lib/localMode";
import { BalancesPanel, PairwiseBalancesPanel, SpendSummaryPanel } from "../components/BalancesPanel";
import LedgerPanel from "../components/LedgerPanel";
import BalancesImportPanel from "../components/BalancesImportPanel";
import ImportCsvPanel from "../components/ImportCsvPanel";
import StatementTriagePanel from "../components/StatementTriagePanel";
import ReceiptCapturePanel from "../components/ReceiptCapturePanel";
import BudgetsPanel from "../components/BudgetsPanel";
import LedgerQaPanel from "../components/LedgerQaPanel";
import MembersPanel from "../components/MembersPanel";
import RecurringPanel from "../components/RecurringPanel";
import ReportsPanel from "../components/ReportsPanel";
import SettleUpPanel from "../components/SettleUpPanel";
import { formatMoneyIn, partitionByCurrency, summarizeOtherCurrencies } from "../lib/currencies";
import { activeMemberIds, deriveBalances, memberSpendSummary, pairwiseBalances, recentPayerIds } from "../lib/finance";
import type { AppSnapshot, DeviceIdentity } from "../types";

type Props = {
  snapshot: AppSnapshot;
  device: DeviceIdentity;
  contextId: string;
  online: boolean;
  initialTab?: Tab;
  back: () => void;
  navigate: (target: NavTarget) => void;
  refresh: () => Promise<void>;
  requestSync: () => void;
  setStatus: (message: string) => void;
};

// Tabbed sections at every viewport width — ~15 panels shown at once made
// desktop a ~4000px-tall wall (unified-expense-os-0fj). CSS handles both.
type Tab = "expenses" | "balances" | "people" | "reports" | "assistant";

const TABS: { id: Tab; label: string }[] = [
  { id: "expenses", label: "Expenses" },
  { id: "balances", label: "Balances" },
  { id: "reports", label: "Reports" },
  { id: "assistant", label: "Assistant" },
  { id: "people", label: "People" },
];

export default function ContextScreen({
  snapshot,
  device,
  contextId,
  online,
  initialTab,
  back,
  navigate,
  refresh,
  requestSync,
  setStatus,
}: Props) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab ?? "expenses");
  // "Do I owe Priya?" is answered by net balances alone. Pairwise and
  // spend-summary answer different questions with different mental models,
  // and stacking all three left the user to work out which one they wanted.
  const [showBalanceDetail, setShowBalanceDetail] = useState(false);

  // Assistant navigation can retarget this screen (other context, or a tab
  // here) without remounting it.
  useEffect(() => {
    setActiveTab(initialTab ?? "expenses");
  }, [contextId, initialTab]);

  const context = snapshot.contexts.find((item) => item.contextId === contextId);

  if (!context) {
    return (
      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-header">
          <h2>Group not found</h2>
          <button className="secondary compact" onClick={back}>
            ← Back
          </button>
        </div>
        <div className="info-strip">
          <span>This group hasn't synced to this device yet — sync and try again.</span>
        </div>
      </section>
    );
  }

  const localOnly = isLocalOnly();
  const isShared = context.type === "shared";
  const isOwner = context.ownerParticipantId === device.participantId;

  const contextMemberships = snapshot.memberships.filter((membership) => membership.contextId === contextId);
  const memberIds = activeMemberIds(snapshot.memberships, contextId);
  const contextEntries = snapshot.entries.filter((entry) => entry.contextId === contextId);
  // Balances/spend/reports only ever sum entries in one currency — mixing
  // currencies into a single net balance would misrepresent what's owed.
  // Entries in other currencies are surfaced via otherCurrencyTotals, never
  // silently dropped. See lib/currencies.ts.
  const currencyPartition = partitionByCurrency(contextEntries);
  const primaryEntries = currencyPartition.primaryEntries;
  const otherCurrencyTotals = summarizeOtherCurrencies(currencyPartition.otherEntries);
  const recentPayerIdList = recentPayerIds(primaryEntries, memberIds);
  const balances = deriveBalances(primaryEntries, snapshot.participants, contextMemberships);
  const spendSummary = memberSpendSummary(primaryEntries, snapshot.participants, contextMemberships);
  const pairwise = pairwiseBalances(primaryEntries);
  const allSettled = primaryEntries.length > 0 && balances.every((row) => row.netBalance === 0);
  const templates = snapshot.templates.filter((template) => template.contextId === contextId);

  return (
    <>
      <section className="context-header">
        <button className="secondary compact" onClick={back}>
          ← All groups
        </button>
        <h1>{context.name}</h1>
        <span className="type-chip">{context.type}</span>
      </section>

      <nav className="tabbar" role="tablist" aria-label="Group sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <section className={`grid tabbed active-${activeTab}`}>
        <div className="column">
          <div className="tab-panel tab-expenses">
            <AddExpensePanel
              contextId={contextId}
              memberIds={memberIds}
              recentPayerIdList={recentPayerIdList}
              participants={snapshot.participants}
              deviceParticipantId={device.participantId}
              entries={contextEntries}
              online={online}
              refresh={refresh}
              requestSync={requestSync}
              setStatus={setStatus}
            />
          </div>
          <div className="tab-panel tab-expenses">
            <LedgerPanel
              entries={contextEntries}
              participants={snapshot.participants}
              context={context}
              balances={balances}
              refresh={refresh}
              requestSync={requestSync}
              setStatus={setStatus}
            />
          </div>
          <div className="tab-panel tab-expenses">
            <ReceiptCapturePanel
              contextId={contextId}
              memberIds={memberIds}
              participants={snapshot.participants}
              deviceParticipantId={device.participantId}
              online={online}
              refresh={refresh}
              requestSync={requestSync}
              setStatus={setStatus}
            />
          </div>
          {localOnly ? null : (
          <div className="tab-panel tab-expenses">
            <RecurringPanel
              contextId={contextId}
              templates={templates}
              entries={contextEntries}
              memberIds={memberIds}
              participants={snapshot.participants}
              deviceParticipantId={device.participantId}
              online={online}
              refresh={refresh}
              setStatus={setStatus}
            />
          </div>
          )}
        </div>

        <div className="column">
          <div className="tab-panel tab-assistant">
            <ChatPanel
              scopeContextId={contextId}
              participants={snapshot.participants}
              memberships={snapshot.memberships}
              contexts={snapshot.contexts}
              entries={contextEntries}
              deviceParticipantId={device.participantId}
              online={online}
              refresh={refresh}
              requestSync={requestSync}
              onNavigate={(target) => {
                if (target.kind === "context" && target.contextId === contextId) {
                  setActiveTab(target.tab ?? "expenses");
                } else {
                  navigate(target);
                }
              }}
            />
          </div>
          <div className="tab-panel tab-balances">
            <BalancesPanel
              balances={balances}
              participants={snapshot.participants}
              deviceParticipantId={device.participantId}
              allSettled={allSettled}
              entries={contextEntries}
              contextId={contextId}
              memberIds={memberIds}
              isShared={isShared}
              online={online}
              currency={currencyPartition.primaryCurrency}
              refresh={refresh}
              requestSync={requestSync}
              setStatus={setStatus}
            />
            {otherCurrencyTotals.length > 0 ? (
              <div className="info-strip">
                <span>
                  Not reflected in the balances above ({currencyPartition.primaryCurrency} only) — real debts, just
                  in a different currency:{" "}
                  {otherCurrencyTotals
                    .map((row) => `${formatMoneyIn(row.currency, row.totalPaise)} across ${row.count} ${row.count === 1 ? "entry" : "entries"}`)
                    .join(", ")}
                  .
                </span>
              </div>
            ) : null}
          </div>
          <div className="tab-panel tab-balances">
            <button
              type="button"
              className="link-button"
              aria-expanded={showBalanceDetail}
              onClick={() => setShowBalanceDetail((open) => !open)}
            >
              {showBalanceDetail ? "Hide the detail" : "Show who owes whom, and who spent what"}
            </button>
          </div>
          {showBalanceDetail && isShared ? (
            <div className="tab-panel tab-balances">
              <PairwiseBalancesPanel
                pairs={pairwise}
                participants={snapshot.participants}
                deviceParticipantId={device.participantId}
                currency={currencyPartition.primaryCurrency}
              />
            </div>
          ) : null}
          {showBalanceDetail ? (
            <div className="tab-panel tab-balances">
              <SpendSummaryPanel
                spendSummary={spendSummary}
                participants={snapshot.participants}
                deviceParticipantId={device.participantId}
                currency={currencyPartition.primaryCurrency}
              />
            </div>
          ) : null}
          <div className="tab-panel tab-reports">
            <BudgetsPanel contextId={contextId} entries={primaryEntries} currency={currencyPartition.primaryCurrency} />
          </div>
          <div className="tab-panel tab-reports">
            <ReportsPanel
              entries={primaryEntries}
              participants={snapshot.participants}
              memberships={contextMemberships}
              deviceParticipantId={device.participantId}
              currency={currencyPartition.primaryCurrency}
            />
            {otherCurrencyTotals.length > 0 ? (
              <div className="info-strip">
                <span>
                  Not included above ({currencyPartition.primaryCurrency} only):{" "}
                  {otherCurrencyTotals
                    .map((row) => `${formatMoneyIn(row.currency, row.totalPaise)} across ${row.count} ${row.count === 1 ? "entry" : "entries"}`)
                    .join(", ")}
                  .
                </span>
              </div>
            ) : null}
          </div>
          {isShared && !localOnly ? (
            <div className="tab-panel tab-balances">
              <SettleUpPanel
                context={context}
                entries={contextEntries}
                participants={snapshot.participants}
                isOwner={isOwner}
                online={online}
                refresh={refresh}
                setStatus={setStatus}
              />
            </div>
          ) : null}
          <div className="tab-panel tab-reports">
            <LedgerQaPanel
              entries={contextEntries}
              participants={snapshot.participants}
              memberships={contextMemberships}
              contexts={snapshot.contexts}
              deviceParticipantId={device.participantId}
            />
          </div>
          <div className="tab-panel tab-people">
            <ImportCsvPanel
              contextId={contextId}
              participants={snapshot.participants}
              isOwner={isOwner}
              online={online}
              refresh={refresh}
              requestSync={requestSync}
              setStatus={setStatus}
            />
            <StatementTriagePanel
              contextId={contextId}
              participants={snapshot.participants}
              deviceParticipantId={device.participantId}
              isOwner={isOwner}
              online={online}
              refresh={refresh}
              requestSync={requestSync}
              setStatus={setStatus}
            />
          </div>
          {isShared ? (
            <div className="tab-panel tab-people">
              <BalancesImportPanel
                contextId={contextId}
                participants={snapshot.participants}
                isOwner={isOwner}
                online={online}
                refresh={refresh}
                requestSync={requestSync}
                setStatus={setStatus}
              />
            </div>
          ) : null}
          <div className="tab-panel tab-people">
            <MembersPanel
              context={context}
              memberships={contextMemberships}
              participants={snapshot.participants}
              deviceParticipantId={device.participantId}
              isShared={isShared}
              isOwner={isOwner}
              online={online}
              refresh={refresh}
              setStatus={setStatus}
              back={back}
            />
          </div>
        </div>
      </section>
    </>
  );
}
