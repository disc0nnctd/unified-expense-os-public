import { FormEvent, useState } from "react";
import { createContext, joinWithInvite } from "../lib/api";
import { humanizeError } from "../lib/errors";
import { isLocalOnly } from "../lib/localMode";
import {
  activeMemberIds,
  formatMoney,
  myNetByContext,
  owedSummary,
  personalSpendThisMonth,
} from "../lib/finance";
import type { AppSnapshot, DeviceIdentity } from "../types";

type Props = {
  snapshot: AppSnapshot;
  device: DeviceIdentity;
  online: boolean;
  openContext: (contextId: string) => void;
  refresh: () => Promise<void>;
  setStatus: (message: string) => void;
};

export default function HomeScreen({ snapshot, device, online, openContext, refresh, setStatus }: Props) {
  const [contextName, setContextName] = useState("");
  const [contextType, setContextType] = useState<"shared" | "personal">("shared");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const localOnly = isLocalOnly();
  const activeContexts = snapshot.contexts.filter((context) => !context.archivedAt);
  const spendThisMonth = personalSpendThisMonth(snapshot.entries, device.participantId);
  const nets = myNetByContext(
    snapshot.contexts,
    snapshot.memberships,
    snapshot.entries,
    snapshot.participants,
    device.participantId,
  );
  const { owedToMe, iOwe } = owedSummary(nets);
  const rejectedEntries = snapshot.entries.filter((entry) => entry.syncState === "rejected");

  async function handleCreateContext(event: FormEvent) {
    event.preventDefault();
    if (!contextName.trim()) {
      return;
    }
    setBusy("create");
    setError(null);
    try {
      const contextId = await createContext(contextName.trim(), contextType);
      await refresh();
      setContextName("");
      setStatus(`Created ${contextType} group "${contextName.trim()}".`);
      openContext(contextId);
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function handleJoin(event: FormEvent) {
    event.preventDefault();
    if (!inviteCode.trim()) {
      return;
    }
    setBusy("join");
    setError(null);
    try {
      await joinWithInvite(inviteCode.trim());
      await refresh();
      setInviteCode("");
      setStatus("Joined the group.");
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <header className="page-intro">
        <div>
          <h1>Overview</h1>
          <p>Your personal and shared spending, all on this device.</p>
        </div>
      </header>
      {/* Three confident zeroes above an empty state read as "nothing is
          broken" rather than "you haven't started yet". Once there's a
          context to total up, the numbers mean something. */}
      {activeContexts.length === 0 ? null : (
      <section className="summary-row">
        <article className="stat-card">
          <span className="stat-label">My share this month</span>
          <strong className="stat-value">{formatMoney(spendThisMonth)}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">Owed to me</span>
          <strong className="stat-value positive">{formatMoney(owedToMe)}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">I owe</span>
          <strong className="stat-value negative">{formatMoney(iOwe)}</strong>
        </article>
      </section>
      )}

      {rejectedEntries.length > 0 ? (
        <section className="alert-strip">
          <span>
            {rejectedEntries.length} {rejectedEntries.length === 1 ? "entry was" : "entries were"} rejected by the
            server and {rejectedEntries.length === 1 ? "needs" : "need"} review.
          </span>
          <button className="secondary compact" onClick={() => openContext(rejectedEntries[0].contextId)}>
            Review
          </button>
        </section>
      ) : null}

      <section className="grid">
        <article className="panel">
          <div className="panel-header">
            <h2>Your groups</h2>
            <span>{activeContexts.length} total</span>
          </div>
          {activeContexts.length === 0 ? (
            <div className="info-strip">
              <span>Nothing here yet — make a group for a household or trip, or a personal one just for you.</span>
            </div>
          ) : (
            <div className="context-list">
              {activeContexts.map((context) => {
                const memberCount = activeMemberIds(snapshot.memberships, context.contextId).length;
                const net = nets.find((row) => row.contextId === context.contextId)?.netBalance;
                return (
                  <button
                    key={context.contextId}
                    className="context-card"
                    onClick={() => openContext(context.contextId)}
                  >
                    <div>
                      <strong>{context.name}</strong>
                      <span>
                        {context.type === "shared" ? `Shared · ${memberCount} member${memberCount === 1 ? "" : "s"}` : "Personal"}
                      </span>
                    </div>
                    {context.type === "shared" && net !== undefined ? (
                      <strong className={net >= 0 ? "positive" : "negative"}>
                        {net === 0 ? "Settled" : net > 0 ? `+${formatMoney(net)}` : formatMoney(net)}
                      </strong>
                    ) : (
                      <span className="context-open">Open →</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </article>

        <article className="panel">
          <div className="panel-header">
            <h2>New group</h2>
            <span>{localOnly ? "Stays on this device" : online ? "" : "Requires connection"}</span>
          </div>
          {error ? <p className="status error-text">{error}</p> : null}
          <form className="entry-form" onSubmit={handleCreateContext}>
            <label>
              Name
              <input
                value={contextName}
                onChange={(event) => setContextName(event.target.value)}
                placeholder="e.g. Home 2026"
              />
            </label>
            <label>
              Type
              <select
                value={contextType}
                onChange={(event) => setContextType(event.target.value as "shared" | "personal")}
              >
                <option value="shared">Shared</option>
                <option value="personal">Personal</option>
              </select>
            </label>
            <div className="form-actions wide">
              <button
                type="submit"
                className="primary"
                disabled={busy !== null || (!online && !localOnly) || !contextName.trim()}
              >
                {busy === "create" ? "Creating…" : "Create group"}
              </button>
            </div>
          </form>

          {localOnly ? null : (<>
          <div className="panel-header preference-header">
            <h2>Join with a code</h2>
          </div>
          <form className="entry-form" onSubmit={handleJoin}>
            <label className="wide">
              Invite code
              <input
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                placeholder="XXXX-XXXX"
                autoCapitalize="characters"
                autoComplete="off"
              />
            </label>
            <div className="form-actions wide">
              <button
                type="submit"
                className="secondary"
                disabled={busy !== null || !online || !inviteCode.trim()}
              >
                {busy === "join" ? "Joining…" : "Join group"}
              </button>
            </div>
          </form>
          </>)}
        </article>
      </section>

    </>
  );
}
