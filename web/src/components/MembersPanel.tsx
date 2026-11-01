import { FormEvent, useEffect, useState } from "react";
import {
  addNamedMember,
  archiveContext,
  closeContext,
  createInvite,
  leaveContext,
  listOpenInvites,
  removeMember,
  revokeParticipantAccess,
  updateMembershipSimplifyPreference,
} from "../lib/api";
import { formatMoneyIn } from "../lib/currencies";
import { humanizeError } from "../lib/errors";
import { isLocalOnly } from "../lib/localMode";
import { participantName } from "../lib/finance";
import type { ContextRecord, Invite, Membership, Participant, SettlementRecommendation } from "../types";

type Props = {
  context: ContextRecord;
  memberships: Membership[];
  participants: Participant[];
  deviceParticipantId: string;
  isShared: boolean;
  isOwner: boolean;
  online: boolean;
  refresh: () => Promise<void>;
  setStatus: (message: string) => void;
  back: () => void;
};

function formatDay(value: string): string {
  return new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function displayInviteCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export default function MembersPanel({
  context,
  memberships,
  participants,
  deviceParticipantId,
  isShared,
  isOwner,
  online,
  refresh,
  setStatus,
  back,
}: Props) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteBusy, setInviteBusy] = useState<string | null>(null);
  const [namedMemberInput, setNamedMemberInput] = useState("");
  const [namedMemberBusy, setNamedMemberBusy] = useState(false);
  const [namedMemberError, setNamedMemberError] = useState<string | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState<string | null>(null);
  const [archiveConfirming, setArchiveConfirming] = useState(false);
  const [closeOutstanding, setCloseOutstanding] = useState<SettlementRecommendation[] | null>(null);
  // Local-only mode: invites, lifecycle, and device ops need a server — hidden.
  const localOnly = isLocalOnly();

  const contextId = context.contextId;
  const activeMemberships = memberships.filter((membership) => !membership.leftAt);

  useEffect(() => {
    let cancelled = false;
    if (!isShared || !isOwner || !online || localOnly) {
      setInvites([]);
      return;
    }
    listOpenInvites(contextId)
      .then((result) => {
        if (!cancelled) {
          setInvites(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setInvites([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [contextId, online, isShared, isOwner, localOnly]);

  async function handleCreateInvite(claimParticipantId?: string) {
    setInviteBusy(claimParticipantId ?? "__general__");
    try {
      const invite = await createInvite(contextId, claimParticipantId);
      setInvites((current) => [...current, invite]);
      setStatus(
        claimParticipantId
          ? `Invite code ${displayInviteCode(invite.inviteCode)} created for ${invite.claimDisplayName ?? "them"} — valid for 7 days.`
          : `Invite code ${displayInviteCode(invite.inviteCode)} created — valid for 7 days.`,
      );
    } catch (cause) {
      setStatus(humanizeError(cause));
    } finally {
      setInviteBusy(null);
    }
  }

  async function handleCopyInvite(invite: Invite) {
    const text = `Join "${context.name}" on Expense OS with invite code ${displayInviteCode(invite.inviteCode)}`;
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Invite copied to clipboard.");
    } catch {
      setStatus(`Invite code: ${displayInviteCode(invite.inviteCode)}`);
    }
  }

  async function handleAddNamedMember(event: FormEvent) {
    event.preventDefault();
    setNamedMemberError(null);
    if (!namedMemberInput.trim()) {
      return;
    }
    setNamedMemberBusy(true);
    try {
      await addNamedMember(contextId, namedMemberInput.trim());
      await refresh();
      setNamedMemberInput("");
      setStatus(
        localOnly
          ? `Added ${namedMemberInput.trim()} — a name-only member on this device.`
          : `Added ${namedMemberInput.trim()} — they can join later with an invite code.`,
      );
    } catch (cause) {
      setNamedMemberError(humanizeError(cause));
    } finally {
      setNamedMemberBusy(false);
    }
  }

  async function handleMembershipSimplifyToggle(membershipId: string, checked: boolean) {
    try {
      await updateMembershipSimplifyPreference(membershipId, checked);
      await refresh();
    } catch (cause) {
      setStatus(humanizeError(cause));
    }
  }

  async function handleLeave(membershipId: string) {
    if (!window.confirm(`Leave "${context.name}"? You can rejoin later with a new invite.`)) {
      return;
    }
    setLifecycleBusy(membershipId);
    try {
      await leaveContext(membershipId);
      await refresh();
      setStatus(`Left "${context.name}".`);
      back();
    } catch (cause) {
      setStatus(humanizeError(cause));
    } finally {
      setLifecycleBusy(null);
    }
  }

  async function handleRemove(membershipId: string, name: string) {
    if (!window.confirm(`Remove ${name} from "${context.name}"? Their past entries stay in the ledger.`)) {
      return;
    }
    setLifecycleBusy(membershipId);
    try {
      await removeMember(membershipId);
      await refresh();
      setStatus(`Removed ${name} from the group.`);
    } catch (cause) {
      setStatus(humanizeError(cause));
    } finally {
      setLifecycleBusy(null);
    }
  }

  async function handleRevokeAccess(participantId: string, name: string) {
    if (
      !window.confirm(
        `Revoke ${name}'s device access? Their current session stops working immediately; they'd need to rejoin with a new invite to regain access.`,
      )
    ) {
      return;
    }
    setLifecycleBusy(participantId);
    try {
      await revokeParticipantAccess(participantId);
      setStatus(`Revoked ${name}'s device access.`);
    } catch (cause) {
      setStatus(humanizeError(cause));
    } finally {
      setLifecycleBusy(null);
    }
  }

  async function handleArchive() {
    setLifecycleBusy("__archive__");
    try {
      await archiveContext(contextId);
      await refresh();
      setStatus(`Archived "${context.name}".`);
      back();
    } catch (cause) {
      setStatus(humanizeError(cause));
    } finally {
      setLifecycleBusy(null);
      setArchiveConfirming(false);
    }
  }

  async function handleClose(force: boolean) {
    setLifecycleBusy("__close__");
    try {
      const result = await closeContext(contextId, force);
      if (!result.context) {
        setCloseOutstanding(result.outstanding);
        return;
      }
      await refresh();
      setCloseOutstanding(null);
      setStatus(`Closed "${context.name}" after final settlement.`);
      back();
    } catch (cause) {
      setStatus(humanizeError(cause));
    } finally {
      setLifecycleBusy(null);
    }
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Members</h2>
        <span>{activeMemberships.length} active</span>
      </div>
      <div className="preference-list">
        {activeMemberships.map((membership) => (
          <div className="toggle-row" key={membership.membershipId}>
            <span>
              {participantName(participants, membership.participantId)}
              {membership.participantId === deviceParticipantId ? " (me)" : ""}
              {membership.participantId === context.ownerParticipantId ? " · owner" : ""}
              {membership.isGhost ? <em className="badge pending-badge">not joined yet</em> : null}
            </span>
            {isShared && isOwner && membership.isGhost && !localOnly ? (
              <button
                className="secondary compact"
                disabled={inviteBusy !== null || !online}
                onClick={() => handleCreateInvite(membership.participantId)}
              >
                {inviteBusy === membership.participantId ? "Creating…" : "Invite"}
              </button>
            ) : null}
            {isShared && !membership.isGhost ? (
              <label className="toggle-inline" title="Include in simplified settlements">
                <input
                  type="checkbox"
                  checked={membership.allowSimplifyForMe}
                  disabled={
                    !context.allowSimplifiedDebts ||
                    localOnly ||
                    !online ||
                    (!isOwner && membership.participantId !== deviceParticipantId)
                  }
                  onChange={(event) => handleMembershipSimplifyToggle(membership.membershipId, event.target.checked)}
                />
                <span>simplify</span>
              </label>
            ) : null}
            {membership.participantId === deviceParticipantId && membership.participantId !== context.ownerParticipantId && !localOnly ? (
              <button
                className="secondary compact"
                disabled={lifecycleBusy !== null || !online}
                onClick={() => handleLeave(membership.membershipId)}
              >
                {lifecycleBusy === membership.membershipId ? "Leaving…" : "Leave"}
              </button>
            ) : null}
            {isOwner && membership.participantId !== deviceParticipantId && !localOnly ? (
              <button
                className="secondary compact"
                disabled={lifecycleBusy !== null || !online}
                onClick={() => handleRemove(membership.membershipId, participantName(participants, membership.participantId))}
              >
                {lifecycleBusy === membership.membershipId ? "Removing…" : "Remove"}
              </button>
            ) : null}
            {isOwner && !membership.isGhost && membership.participantId !== deviceParticipantId && !localOnly ? (
              <button
                className="secondary compact"
                disabled={lifecycleBusy !== null || !online}
                onClick={() =>
                  handleRevokeAccess(membership.participantId, participantName(participants, membership.participantId))
                }
              >
                {lifecycleBusy === membership.participantId ? "Revoking…" : "Revoke device"}
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {isOwner ? (
        <form className="entry-form" onSubmit={handleAddNamedMember}>
          <label className="wide">
            {localOnly ? "Add a person by name" : "Add a person by name (no invite yet)"}
            <input
              value={namedMemberInput}
              onChange={(event) => setNamedMemberInput(event.target.value)}
              placeholder="e.g. Priya"
            />
          </label>
          {namedMemberError ? <span className="error-text wide">{namedMemberError}</span> : null}
          <div className="form-actions wide">
            <button type="submit" className="secondary" disabled={namedMemberBusy || (!online && !localOnly)}>
              {namedMemberBusy ? "Adding…" : "Add to group"}
            </button>
          </div>
        </form>
      ) : null}

      {isShared && isOwner && !localOnly ? (
        <>
          <div className="panel-header preference-header">
            <h2>Invites</h2>
            <button
              className="secondary compact"
              onClick={() => handleCreateInvite()}
              disabled={inviteBusy !== null || !online}
            >
              {inviteBusy === "__general__" ? "Creating…" : "New invite code"}
            </button>
          </div>
          {invites.length > 0 ? (
            <div className="plan-list">
              {invites.map((invite) => (
                <div className="plan-row" key={invite.inviteCode}>
                  <span className="invite-code">{displayInviteCode(invite.inviteCode)}</span>
                  <span>
                    {invite.claimDisplayName ? `for ${invite.claimDisplayName} · ` : ""}
                    expires {formatDay(invite.expiresAt)}
                  </span>
                  <button className="secondary compact" onClick={() => handleCopyInvite(invite)}>
                    Copy
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="info-strip">
              <span>Create a code and share it — the other device joins with its own key.</span>
            </div>
          )}
        </>
      ) : null}

      {isOwner && !localOnly ? (
        <>
          <div className="panel-header preference-header">
            <h2>Archive group</h2>
          </div>
          <div className="info-strip">
            <span>Archiving hides "{context.name}" from active use. Past entries and balances are preserved.</span>
          </div>
          <div className="form-actions">
            {archiveConfirming ? (
              <>
                <button
                  className="primary compact"
                  disabled={lifecycleBusy !== null || !online}
                  onClick={handleArchive}
                >
                  {lifecycleBusy === "__archive__" ? "Archiving…" : "Confirm archive"}
                </button>
                <button className="secondary compact" onClick={() => setArchiveConfirming(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="secondary compact" disabled={!online} onClick={() => setArchiveConfirming(true)}>
                Archive group
              </button>
            )}
          </div>

          {!context.closedAt ? (
            <>
              <div className="panel-header preference-header">
                <h2>Close group</h2>
              </div>
              <div className="info-strip">
                <span>
                  Closing "{context.name}" after final settlement is one-way — no new entries, membership, or
                  preference changes afterward. Use this for trips/events that have wrapped up.
                </span>
              </div>
              {closeOutstanding && closeOutstanding.length > 0 ? (
                <>
                  <ul className="history-list">
                    {closeOutstanding.map((row, index) => (
                      <li key={index}>
                        {participantName(participants, row.fromParticipantId)} owes{" "}
                        {participantName(participants, row.toParticipantId)}{" "}
                        {formatMoneyIn(row.currency, row.amountCents)}
                      </li>
                    ))}
                  </ul>
                  <div className="form-actions">
                    <button
                      className="primary compact"
                      disabled={lifecycleBusy !== null || !online}
                      onClick={() => void handleClose(true)}
                    >
                      {lifecycleBusy === "__close__" ? "Closing…" : "Close anyway"}
                    </button>
                    <button className="secondary compact" onClick={() => setCloseOutstanding(null)}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <div className="form-actions">
                  <button
                    className="secondary compact"
                    disabled={lifecycleBusy !== null || !online}
                    onClick={() => void handleClose(false)}
                  >
                    {lifecycleBusy === "__close__" ? "Closing…" : "Close group"}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="info-strip">
              <span>This group was closed on {formatDay(context.closedAt)} and is read-only.</span>
            </div>
          )}
        </>
      ) : null}
    </article>
  );
}
