import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addPendingEntry,
  discardEntry,
  getDevice,
  markCommitted,
  markRejected,
  readSnapshot,
  requeueEntry,
  setCursor,
  setDevice,
  upsertEntries,
} from "./localDb";
import type { LedgerEntry } from "../types";

function pendingEntry(entryId: string): LedgerEntry {
  return {
    entryId,
    contextId: "ctx-home",
    type: "expense",
    recordedAt: new Date().toISOString(),
    effectiveDate: "2026-07-10",
    payerId: "alice",
    totalAmount: 1000,
    currency: "INR",
    description: "Chai",
    allocations: [{ participantId: "alice", shareAmount: 1000, isPayer: true }],
    version: 1,
    hlc: "1-0-alice",
    syncState: "pending",
    syncError: null,
  };
}

beforeEach(() => {
  // Fresh IndexedDB per test.
  globalThis.indexedDB = new IDBFactory();
});

describe("device identity", () => {
  it("stores exactly one identity for this device", async () => {
    expect(await getDevice()).toBeNull();
    await setDevice({ participantId: "p-1", displayName: "Alice", authToken: "pt_secret" });
    expect(await getDevice()).toEqual({ participantId: "p-1", displayName: "Alice", authToken: "pt_secret" });
  });
});

describe("sync queue state machine", () => {
  it("queues a pending entry", async () => {
    await addPendingEntry(pendingEntry("e1"));
    const snapshot = await readSnapshot();
    expect(snapshot.queue).toHaveLength(1);
    expect(snapshot.entries[0].syncState).toBe("pending");
  });

  it("commits an accepted entry and clears the queue", async () => {
    await addPendingEntry(pendingEntry("e1"));
    await markCommitted("e1", 7, 1);
    const snapshot = await readSnapshot();
    expect(snapshot.queue).toHaveLength(0);
    expect(snapshot.entries[0]).toMatchObject({ syncState: "committed", serverSeq: 7, version: 1 });
  });

  it("marks a rejected entry with its error and unblocks the queue", async () => {
    await addPendingEntry(pendingEntry("e1"));
    await markRejected("e1", "entry_participant_forbidden");
    const snapshot = await readSnapshot();
    expect(snapshot.queue).toHaveLength(0);
    expect(snapshot.entries[0]).toMatchObject({
      syncState: "rejected",
      syncError: "entry_participant_forbidden",
    });
  });

  it("requeues a rejected entry for retry", async () => {
    await addPendingEntry(pendingEntry("e1"));
    await markRejected("e1", "entry_participant_forbidden");
    await requeueEntry("e1");
    const snapshot = await readSnapshot();
    expect(snapshot.queue).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({ syncState: "pending", syncError: null });
  });

  it("discards a rejected entry entirely", async () => {
    await addPendingEntry(pendingEntry("e1"));
    await markRejected("e1", "allocation_sum_mismatch");
    await discardEntry("e1");
    const snapshot = await readSnapshot();
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.queue).toHaveLength(0);
  });
});

describe("pull never clobbers unresolved local edits", () => {
  it("does not overwrite a pending entry with a pulled server record", async () => {
    await addPendingEntry(pendingEntry("e1"));
    await upsertEntries([{ ...pendingEntry("e1"), description: "Server version", syncState: "committed", syncError: null }]);
    const snapshot = await readSnapshot();
    expect(snapshot.entries[0]).toMatchObject({ description: "Chai", syncState: "pending" });
  });

  it("does not overwrite a rejected entry with a pulled server record", async () => {
    await addPendingEntry(pendingEntry("e1"));
    await markRejected("e1", "entry_participant_forbidden");
    await upsertEntries([{ ...pendingEntry("e1"), description: "Server version", syncState: "committed", syncError: null }]);
    const snapshot = await readSnapshot();
    expect(snapshot.entries[0]).toMatchObject({
      description: "Chai",
      syncState: "rejected",
      syncError: "entry_participant_forbidden",
    });
  });

  it("still applies a pulled record once the local entry is committed", async () => {
    await addPendingEntry(pendingEntry("e1"));
    await markCommitted("e1", 7, 1);
    await upsertEntries([{ ...pendingEntry("e1"), description: "Server version", syncState: "committed", syncError: null }]);
    const snapshot = await readSnapshot();
    expect(snapshot.entries[0]).toMatchObject({ description: "Server version" });
  });

  it("applies pulled records for entries with no local counterpart", async () => {
    await upsertEntries([pendingEntry("e-new")]);
    const snapshot = await readSnapshot();
    expect(snapshot.entries).toHaveLength(1);
  });
});

describe("sync cursors", () => {
  it("tracks per-context pull cursors", async () => {
    await setCursor("ctx-home", 42);
    await setCursor("ctx-trip", 7);
    const snapshot = await readSnapshot();
    expect(snapshot.cursorByContext).toEqual({ "ctx-home": 42, "ctx-trip": 7 });
  });
});

describe("push results never clobber a concurrent local edit", () => {
  it("ignores a commit for a version the user has since edited", async () => {
    // The push is in flight when the user edits the entry: the response
    // describes the old version and must not overwrite the new one, nor drop
    // its queue row (unified-expense-os-4z6).
    await addPendingEntry(pendingEntry("e1"));
    const edited = { ...pendingEntry("e1"), description: "Chai + samosa", hlc: "2-0-alice", version: 2 };
    await addPendingEntry(edited);

    await markCommitted("e1", 7, 1, "1-0-alice");

    const snapshot = await readSnapshot();
    expect(snapshot.entries[0]).toMatchObject({
      description: "Chai + samosa",
      syncState: "pending",
      version: 2,
    });
    // Still queued, so the edit actually gets pushed.
    expect(snapshot.queue).toHaveLength(1);
  });

  it("ignores a rejection for a version the user has since edited", async () => {
    await addPendingEntry(pendingEntry("e1"));
    await addPendingEntry({ ...pendingEntry("e1"), description: "Fixed", hlc: "2-0-alice", version: 2 });

    await markRejected("e1", "allocation_sum_mismatch", "1-0-alice");

    const snapshot = await readSnapshot();
    expect(snapshot.entries[0]).toMatchObject({ description: "Fixed", syncState: "pending" });
    expect(snapshot.queue).toHaveLength(1);
  });

  it("applies the result when the entry is untouched during the push", async () => {
    await addPendingEntry(pendingEntry("e1"));
    await markCommitted("e1", 7, 1, "1-0-alice");
    const snapshot = await readSnapshot();
    expect(snapshot.entries[0]).toMatchObject({ syncState: "committed", serverSeq: 7 });
    expect(snapshot.queue).toHaveLength(0);
  });
});

describe("discarding an entry that exists on the server", () => {
  it("rewinds the context cursor so the server version is re-pulled", async () => {
    // Pull skips entries with unresolved local state but advances the cursor
    // past them, so discarding would otherwise hide the server's copy forever
    // (unified-expense-os-6lz).
    await addPendingEntry(pendingEntry("e1"));
    await markCommitted("e1", 42, 1, "1-0-alice");
    await setCursor("ctx-home", 99);

    await discardEntry("e1");

    const snapshot = await readSnapshot();
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.cursorByContext["ctx-home"]).toBe(41);
  });

  it("leaves the cursor alone for an entry that never reached the server", async () => {
    await addPendingEntry(pendingEntry("e1"));
    await setCursor("ctx-home", 99);

    await discardEntry("e1");

    const snapshot = await readSnapshot();
    expect(snapshot.cursorByContext["ctx-home"]).toBe(99);
  });
});
