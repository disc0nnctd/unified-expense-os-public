import { setDevice, upsertContexts, upsertMemberships, upsertParticipants } from "./localDb";
import type { ContextRecord, DeviceIdentity, Membership } from "../types";

// Local-only ("ghost household") mode — unified-expense-os-1r4.
//
// The client is already local-first: the full ledger lives in IndexedDB and
// balances are derived locally. In local-only mode the app simply never
// talks to a backend: identity, contexts, and members are generated
// client-side, every other member is a name-only ghost (exactly like
// server-side ghost members), entries are written as committed with no sync
// queue, and all sync/invite/passkey affordances are hidden. Combined with
// the on-device model, this is a fully offline, fully private tracker.
//
// The trade: one device of record. Real multi-device splitting needs a
// server (or the future P2P sync, unified-expense-os-6ke). "Connect this
// data to a server later" is the planned v2 migration; until then leaving
// local mode means starting fresh on a server.

const LOCAL_MODE_KEY = "expense-os-local-mode";

export function isLocalOnly(): boolean {
  return localStorage.getItem(LOCAL_MODE_KEY) === "1";
}

export function enableLocalOnly(): void {
  localStorage.setItem(LOCAL_MODE_KEY, "1");
}

export function disableLocalOnly(): void {
  localStorage.removeItem(LOCAL_MODE_KEY);
}

function localId(prefix: string): string {
  return `${prefix}-local-${crypto.randomUUID()}`;
}

// Creates the device's identity purely on-device. The auth token is a
// placeholder that never leaves the device and matches no server token.
export async function createLocalIdentity(displayName: string): Promise<DeviceIdentity> {
  const identity: DeviceIdentity = {
    participantId: localId("p"),
    displayName: displayName.trim(),
    authToken: "local-only",
  };
  await upsertParticipants([{ participantId: identity.participantId, displayName: identity.displayName }]);
  await setDevice(identity);
  return identity;
}

export async function createLocalContext(
  device: DeviceIdentity,
  name: string,
  type: "personal" | "shared",
): Promise<string> {
  const now = new Date().toISOString();
  const context: ContextRecord = {
    contextId: localId("c"),
    name: name.trim(),
    type,
    ownerParticipantId: device.participantId,
    createdAt: now,
    archivedAt: null,
    closedAt: null,
    defaultSplit: "equal",
    allowSimplifiedDebts: true,
  };
  const membership: Membership = {
    membershipId: localId("m"),
    contextId: context.contextId,
    participantId: device.participantId,
    isGhost: false,
    joinedAt: now,
    leftAt: null,
    defaultShare: "equal",
    allowSimplifyForMe: true,
  };
  await upsertContexts([context]);
  await upsertMemberships([membership]);
  return context.contextId;
}

// Adds a name-only member to a local context — the local twin of the server
// ghost-member endpoint. They can be a payer or split participant like
// anyone else; there is no invite to hand over (nothing to claim without a
// server).
export async function addLocalMember(contextId: string, displayName: string): Promise<string> {
  const participantId = localId("p");
  await upsertParticipants([{ participantId, displayName: displayName.trim() }]);
  await upsertMemberships([
    {
      membershipId: localId("m"),
      contextId,
      participantId,
      isGhost: true,
      joinedAt: new Date().toISOString(),
      leftAt: null,
      defaultShare: "equal",
      allowSimplifyForMe: true,
    },
  ]);
  return participantId;
}
