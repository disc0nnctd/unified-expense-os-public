// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { readSnapshot } from "./localDb";
import {
  addLocalMember,
  createLocalContext,
  createLocalIdentity,
  disableLocalOnly,
  enableLocalOnly,
  isLocalOnly,
} from "./localMode";

beforeEach(() => {
  indexedDB = new IDBFactory();
  localStorage.clear();
});

describe("local-only flag", () => {
  it("defaults off, toggles on/off", () => {
    expect(isLocalOnly()).toBe(false);
    enableLocalOnly();
    expect(isLocalOnly()).toBe(true);
    disableLocalOnly();
    expect(isLocalOnly()).toBe(false);
  });
});

describe("local records", () => {
  it("creates a device identity purely locally", async () => {
    const identity = await createLocalIdentity("Divyansh");
    expect(identity.participantId.startsWith("p-local-")).toBe(true);
    expect(identity.authToken).toBe("local-only");
    const snapshot = await readSnapshot();
    expect(snapshot.device?.participantId).toBe(identity.participantId);
    expect(snapshot.participants.map((p) => p.displayName)).toContain("Divyansh");
  });

  it("creates a context with a self-membership", async () => {
    const identity = await createLocalIdentity("Divyansh");
    const contextId = await createLocalContext(identity, "Flat", "shared");
    const snapshot = await readSnapshot();
    const context = snapshot.contexts.find((c) => c.contextId === contextId);
    expect(context?.name).toBe("Flat");
    expect(context?.ownerParticipantId).toBe(identity.participantId);
    const membership = snapshot.memberships.find((m) => m.contextId === contextId);
    expect(membership?.participantId).toBe(identity.participantId);
    expect(membership?.leftAt).toBeNull();
  });

  it("adds name-only ghost members", async () => {
    const identity = await createLocalIdentity("Divyansh");
    const contextId = await createLocalContext(identity, "Flat", "shared");
    const memberId = await addLocalMember(contextId, "Gunjan");
    const snapshot = await readSnapshot();
    expect(snapshot.participants.some((p) => p.participantId === memberId && p.displayName === "Gunjan")).toBe(true);
    const membership = snapshot.memberships.find((m) => m.participantId === memberId);
    expect(membership?.contextId).toBe(contextId);
    expect(membership?.isGhost).toBe(true);
  });
});
