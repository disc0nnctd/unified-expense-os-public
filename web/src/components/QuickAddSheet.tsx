import { useState } from "react";
import { activeMemberIds, recentPayerIds } from "../lib/finance";
import { getLastContextId, setLastContextId } from "../lib/prefs";
import type { AppSnapshot, DeviceIdentity } from "../types";
import AddExpensePanel from "./AddExpensePanel";

// Global quick-add sheet (unified-expense-os-oi8): the bottom-nav "+" opens
// this from anywhere. It hosts the exact same AddExpensePanel (with the voice
// mic and capture helpers) the context screen uses — same queueExpense path,
// same review-before-save posture — just with a context picker on top that
// defaults to wherever the user last worked.

type Props = {
  snapshot: AppSnapshot;
  device: DeviceIdentity;
  online: boolean;
  refresh: () => Promise<void>;
  requestSync: () => void;
  setStatus: (message: string) => void;
  onClose: () => void;
  onOpenContext: (contextId: string) => void;
};

export default function QuickAddSheet({
  snapshot,
  device,
  online,
  refresh,
  requestSync,
  setStatus,
  onClose,
  onOpenContext,
}: Props) {
  const [contextId, setContextId] = useState<string>(() => {
    const last = getLastContextId();
    if (last && snapshot.contexts.some((context) => context.contextId === last)) {
      return last;
    }
    return snapshot.contexts[0]?.contextId ?? "";
  });

  const context = snapshot.contexts.find((item) => item.contextId === contextId);
  const memberIds = context ? activeMemberIds(snapshot.memberships, contextId) : [];
  const contextEntries = snapshot.entries.filter((entry) => entry.contextId === contextId);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Quick add expense"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-header">
          {snapshot.contexts.length > 1 ? (
            <select
              aria-label="Group"
              value={contextId}
              onChange={(event) => {
                setContextId(event.target.value);
                setLastContextId(event.target.value);
              }}
            >
              {snapshot.contexts.map((item) => (
                <option key={item.contextId} value={item.contextId}>
                  {item.name}
                </option>
              ))}
            </select>
          ) : (
            <h2>{context ? `Add to ${context.name}` : "Add expense"}</h2>
          )}
          <div className="sheet-header-actions">
            {context ? (
              <button
                type="button"
                className="secondary compact"
                onClick={() => {
                  onClose();
                  onOpenContext(contextId);
                }}
              >
                Open
              </button>
            ) : null}
            <button type="button" className="secondary compact" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </div>
        <div className="sheet-body">
          {context ? (
            <AddExpensePanel
              key={contextId}
              contextId={contextId}
              memberIds={memberIds}
              recentPayerIdList={recentPayerIds(contextEntries, memberIds)}
              participants={snapshot.participants}
              deviceParticipantId={device.participantId}
              entries={contextEntries}
              online={online}
              refresh={refresh}
              requestSync={requestSync}
              setStatus={setStatus}
            />
          ) : (
            <div className="info-strip">
              <span>No groups yet — create one on the Home screen first.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
