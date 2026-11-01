import type {
  AppSnapshot,
  ContextRecord,
  DeviceIdentity,
  LedgerEntry,
  Membership,
  Participant,
  RecurringTemplate,
  SyncQueueItem,
} from "../types";

const DB_NAME = "expense-os-web";
const DB_VERSION = 2;

type Stores = {
  participants: Participant;
  contexts: ContextRecord;
  memberships: Membership;
  entries: LedgerEntry;
  templates: RecurringTemplate;
  queue: SyncQueueItem;
  meta: { key: string; value: unknown };
};

// One cached connection instead of a fresh open() per operation: dozens of
// live connections would block the first DB_VERSION upgrade that reshapes
// records, hanging the app on update. On a versionchange from another tab we
// close ours so that tab's upgrade can proceed (unified-expense-os-6bv).
let dbPromise: Promise<IDBDatabase> | null = null;
// Tied to the factory that produced it, so swapping globalThis.indexedDB
// (tests do this to get a clean database) transparently reopens rather than
// handing back a connection to the previous one.
let dbFactory: IDBFactory | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise && dbFactory === indexedDB) {
    return dbPromise;
  }
  dbFactory = indexedDB;
  dbPromise = openDbConnection().catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

function openDbConnection(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("participants")) {
        db.createObjectStore("participants", { keyPath: "participantId" });
      }
      if (!db.objectStoreNames.contains("contexts")) {
        db.createObjectStore("contexts", { keyPath: "contextId" });
      }
      if (!db.objectStoreNames.contains("memberships")) {
        db.createObjectStore("memberships", { keyPath: "membershipId" });
      }
      if (!db.objectStoreNames.contains("entries")) {
        db.createObjectStore("entries", { keyPath: "entryId" });
      }
      if (!db.objectStoreNames.contains("templates")) {
        db.createObjectStore("templates", { keyPath: "templateId" });
      }
      if (!db.objectStoreNames.contains("queue")) {
        db.createObjectStore("queue", { keyPath: "operationId" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
  });
}

function tx<T extends keyof Stores>(db: IDBDatabase, storeName: T, mode: IDBTransactionMode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

/** Run a read-write transaction spanning several stores, so related writes
 *  (an entry and its queue row) either both land or neither does. */
async function writeTx<T>(
  storeNames: (keyof Stores)[],
  work: (stores: { [K in keyof Stores]?: IDBObjectStore }) => T,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeNames as string[], "readwrite");
    const stores: { [K in keyof Stores]?: IDBObjectStore } = {};
    for (const name of storeNames) {
      stores[name] = transaction.objectStore(name as string);
    }
    let result: T;
    try {
      result = work(stores);
    } catch (error) {
      transaction.abort();
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function readInTx<T>(request: IDBRequest<T>): Promise<T> {
  return requestToPromise(request);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putMany<T extends keyof Stores>(storeName: T, values: Stores[T][]) {
  const db = await openDb();
  await Promise.all(
    values.map(
      (value) =>
        new Promise<void>((resolve, reject) => {
          const request = tx(db, storeName, "readwrite").put(value);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        }),
    ),
  );
}

async function getAll<T extends keyof Stores>(storeName: T): Promise<Stores[T][]> {
  const db = await openDb();
  return requestToPromise(tx(db, storeName, "readonly").getAll());
}

async function getByKey<T extends keyof Stores>(storeName: T, key: string): Promise<Stores[T] | undefined> {
  const db = await openDb();
  return requestToPromise(tx(db, storeName, "readonly").get(key)) as Promise<Stores[T] | undefined>;
}

async function deleteByKey<T extends keyof Stores>(storeName: T, key: string) {
  const db = await openDb();
  await requestToPromise(tx(db, storeName, "readwrite").delete(key));
}

export async function setMeta(key: string, value: unknown) {
  const db = await openDb();
  await requestToPromise(tx(db, "meta", "readwrite").put({ key, value }));
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const result = await requestToPromise(tx(db, "meta", "readonly").get(key));
  return (result as { key: string; value: T } | undefined)?.value;
}

export async function getDevice(): Promise<DeviceIdentity | null> {
  return (await getMeta<DeviceIdentity>("device")) ?? null;
}

export async function setDevice(device: DeviceIdentity) {
  await setMeta("device", device);
}

// Lightweight "remember this device identity" list so a browser can switch
// between identities without re-onboarding. Not real auth — anyone with
// access to this browser profile can pick any remembered identity. Real
// authentication is tracked as follow-up work.
export async function getDeviceHistory(): Promise<DeviceIdentity[]> {
  return (await getMeta<DeviceIdentity[]>("deviceHistory")) ?? [];
}

export async function rememberDevice(device: DeviceIdentity) {
  const history = await getDeviceHistory();
  const withoutCurrent = history.filter((entry) => entry.participantId !== device.participantId);
  await setMeta("deviceHistory", [device, ...withoutCurrent].slice(0, 10));
}

export async function forgetDevice(participantId: string) {
  const history = await getDeviceHistory();
  await setMeta(
    "deviceHistory",
    history.filter((entry) => entry.participantId !== participantId),
  );
}

// Clears the active identity and every locally cached record so a fresh
// login/onboard doesn't leak the previous identity's data. Remembered
// device history (for logging back in) is preserved.
export async function clearDevice() {
  const db = await openDb();
  await Promise.all(
    (["participants", "contexts", "memberships", "entries", "templates", "queue"] as const).map(
      (storeName) =>
        new Promise<void>((resolve, reject) => {
          const request = tx(db, storeName, "readwrite").clear();
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        }),
    ),
  );
  await requestToPromise(tx(db, "meta", "readwrite").delete("device"));
  await requestToPromise(tx(db, "meta", "readwrite").delete("cursorByContext"));
}

export async function readSnapshot(): Promise<AppSnapshot> {
  const [device, participants, contexts, memberships, entries, templates, queue, cursorValue] = await Promise.all([
    getDevice(),
    getAll("participants"),
    getAll("contexts"),
    getAll("memberships"),
    getAll("entries"),
    getAll("templates"),
    getAll("queue"),
    getMeta<Record<string, number>>("cursorByContext"),
  ]);
  return {
    device,
    participants,
    contexts,
    memberships,
    entries,
    templates,
    queue,
    cursorByContext: cursorValue ?? {},
  };
}

export async function addPendingEntry(entry: LedgerEntry) {
  // Entry and queue row in one transaction: a crash between two separate
  // writes used to leave a "pending" entry with no queue row, which sync
  // never pushes and no UI offers to retry (unified-expense-os-4z6).
  await writeTx(["entries", "queue"], (stores) => {
    stores.entries!.put(entry);
    stores.queue!.put({
      operationId: `queue-${entry.entryId}`,
      entryId: entry.entryId,
      createdAt: entry.recordedAt,
    });
  });
}

export async function upsertEntries(entries: LedgerEntry[]) {
  const existing = await getAll("entries");
  const existingById = new Map(existing.map((entry) => [entry.entryId, entry]));
  // A locally pending (queued, not yet pushed) or rejected (kept for the
  // per-entry Retry/Discard UI) edit must never be silently overwritten by a
  // pull returning an older server-side version of the same entry_id —
  // unified-expense-os-rwn. Once the local edit resolves (push succeeds,
  // fails cleanly, or is discarded) its syncState moves off pending/rejected
  // and subsequent pulls apply normally.
  const toApply = entries.filter((entry) => {
    const local = existingById.get(entry.entryId);
    return !local || (local.syncState !== "pending" && local.syncState !== "rejected");
  });
  if (toApply.length > 0) {
    await putMany("entries", toApply);
  }
}

export async function upsertParticipants(participants: Participant[]) {
  await putMany("participants", participants);
}

export async function upsertContexts(contexts: ContextRecord[]) {
  await putMany("contexts", contexts);
}

export async function upsertMemberships(memberships: Membership[]) {
  await putMany("memberships", memberships);
}

export async function upsertTemplates(templates: RecurringTemplate[]) {
  await putMany("templates", templates);
}

// The push response describes the entry as it was *when pushed*. If the user
// edited it during the round trip, the local record now carries a newer HLC
// and a fresh queue row; applying the stale result would overwrite that edit
// and drop it from the queue, so it would never be pushed while still looking
// synced. Guarding on the pushed HLC makes the late response a no-op
// (unified-expense-os-4z6). pushedHlc is optional so callers that genuinely
// have no HLC to compare keep the old unconditional behavior.
async function applyPushResult(
  entryId: string,
  pushedHlc: string | undefined,
  update: (entry: LedgerEntry) => LedgerEntry,
) {
  const db = await openDb();
  const current = (await requestToPromise(
    tx(db, "entries", "readonly").get(entryId),
  )) as LedgerEntry | undefined;
  if (current && pushedHlc !== undefined && current.hlc !== pushedHlc) {
    return;
  }
  await writeTx(["entries", "queue"], (stores) => {
    if (current) {
      stores.entries!.put(update(current));
    }
    stores.queue!.delete(`queue-${entryId}`);
  });
}

export async function markCommitted(
  entryId: string,
  serverSeq: number,
  version: number,
  pushedHlc?: string,
) {
  await applyPushResult(entryId, pushedHlc, (entry) => ({
    ...entry,
    serverSeq,
    version,
    syncState: "committed",
    syncError: null,
  }));
}

export async function markRejected(entryId: string, errorCode: string, pushedHlc?: string) {
  await applyPushResult(entryId, pushedHlc, (entry) => ({
    ...entry,
    syncState: "rejected",
    syncError: errorCode,
  }));
}

export async function discardEntry(entryId: string) {
  // Pulls skip entries with unresolved local state but still advance the
  // cursor past them, so an entry that already exists server-side would become
  // invisible on this device once discarded. Rewind this context's cursor to
  // just before its server_seq so the next pull re-delivers the server's
  // version (unified-expense-os-6lz).
  const entry = await getByKey("entries", entryId);
  await writeTx(["entries", "queue"], (stores) => {
    stores.entries!.delete(entryId);
    stores.queue!.delete(`queue-${entryId}`);
  });
  if (entry?.serverSeq && entry.serverSeq > 0) {
    const cursors = (await getMeta<Record<string, number>>("cursorByContext")) ?? {};
    const current = cursors[entry.contextId] ?? 0;
    const rewound = entry.serverSeq - 1;
    if (current > rewound) {
      cursors[entry.contextId] = rewound;
      await setMeta("cursorByContext", cursors);
    }
  }
}

export async function requeueEntry(entryId: string) {
  const entry = await getByKey("entries", entryId);
  if (!entry) {
    return;
  }
  await writeTx(["entries", "queue"], (stores) => {
    stores.entries!.put({ ...entry, syncState: "pending", syncError: null });
    stores.queue!.put({ operationId: `queue-${entryId}`, entryId, createdAt: new Date().toISOString() });
  });
}

export async function setCursor(contextId: string, value: number) {
  const current = (await getMeta<Record<string, number>>("cursorByContext")) ?? {};
  current[contextId] = value;
  await setMeta("cursorByContext", current);
}
