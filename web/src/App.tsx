import { useCallback, useEffect, useRef, useState } from "react";
import { logout, syncNow } from "./lib/api";
import { humanizeError } from "./lib/errors";
import { readSnapshot } from "./lib/localDb";
import { hideSplash, registerBackButton, registerResume } from "./lib/native";
import { enableLocalOnly, isLocalOnly } from "./lib/localMode";
import { applyTheme, setLastContextId } from "./lib/prefs";
import { isNativePlatform, isServerConfigured } from "./lib/serverConfig";
import BottomNav from "./components/BottomNav";
import ChatPanel from "./components/ChatPanel";
import QuickAddSheet from "./components/QuickAddSheet";
import SmsAccessPrompt from "./components/SmsAccessPrompt";
import type { NavTarget } from "./lib/assistant";
import ContextScreen from "./screens/ContextScreen";
import HomeScreen from "./screens/HomeScreen";
import OnboardScreen from "./screens/OnboardScreen";
import ServerSetupScreen from "./screens/ServerSetupScreen";
import SettingsScreen from "./screens/SettingsScreen";
import type { AppSnapshot } from "./types";

// Apply any saved manual theme before first paint.
applyTheme();

const emptySnapshot: AppSnapshot = {
  device: null,
  participants: [],
  contexts: [],
  memberships: [],
  entries: [],
  templates: [],
  queue: [],
  cursorByContext: {},
};

const STATUS_DISMISS_MS = 6000;

type View =
  | { kind: "home" }
  | { kind: "context"; contextId: string; tab?: "expenses" | "balances" | "reports" | "assistant" | "people" }
  | { kind: "settings" }
  | { kind: "assistant" };

export default function App() {
  const [booted, setBooted] = useState(false);
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot);
  const [view, setView] = useState<View>({ kind: "home" });
  const [online, setOnline] = useState(() => navigator.onLine);
  const [syncBusy, setSyncBusy] = useState(false);
  const [status, setStatus] = useState("");
  // Native-only: whether a backend URL has been chosen, and whether the user is
  // actively re-pointing the app at a different server. On web the server is
  // always resolved from the serving origin, so these stay effectively inert.
  const [serverReady, setServerReady] = useState(() => isServerConfigured());
  const [editingServer, setEditingServer] = useState(false);
  // Local-only mode (unified-expense-os-1r4): no server, no sync; identity,
  // contexts, and members live purely on this device.
  const [localMode, setLocalMode] = useState(() => isLocalOnly());
  // Global quick-add sheet, opened by the bottom nav's "+" from any screen.
  const [quickAdd, setQuickAdd] = useState(false);
  const syncingRef = useRef(false);
  const rerunRef = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const quickAddRef = useRef(quickAdd);
  quickAddRef.current = quickAdd;

  // Remember where the user last worked so quick-add can default there.
  const openContext = useCallback((contextId: string, tab?: "expenses" | "balances" | "reports" | "assistant" | "people") => {
    setLastContextId(contextId);
    setView({ kind: "context", contextId, tab });
  }, []);

  const refresh = useCallback(async () => {
    setSnapshot(await readSnapshot());
  }, []);

  const requestSync = useCallback(() => {
    if (isLocalOnly() || !navigator.onLine) {
      return;
    }
    if (syncingRef.current) {
      rerunRef.current = true;
      return;
    }
    syncingRef.current = true;
    setSyncBusy(true);
    void (async () => {
      try {
        do {
          rerunRef.current = false;
          const result = await syncNow();
          await refresh();
          if (result.rejected > 0) {
            setStatus(
              `Synced. ${result.rejected} ${result.rejected === 1 ? "entry was" : "entries were"} rejected — see the ledger.`,
            );
          } else if (result.pushed > 0) {
            setStatus(`Synced ${result.pushed} ${result.pushed === 1 ? "entry" : "entries"}.`);
          } else {
            setStatus("Up to date.");
          }
        } while (rerunRef.current);
      } catch (cause) {
        setStatus(`Sync failed — local data is safe. ${humanizeError(cause)}`);
      } finally {
        syncingRef.current = false;
        setSyncBusy(false);
        await refresh();
      }
    })();
  }, [refresh]);

  useEffect(() => {
    void (async () => {
      const initial = await readSnapshot();
      setSnapshot(initial);
      setBooted(true);
      if (initial.device && navigator.onLine) {
        requestSync();
      }
    })();
  }, [requestSync]);

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true);
      setStatus("Back online.");
      requestSync();
    };
    const handleOffline = () => {
      setOnline(false);
      setStatus("Offline — changes are queued locally.");
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [requestSync]);

  useEffect(() => {
    if (!status) {
      return;
    }
    const timer = window.setTimeout(() => setStatus(""), STATUS_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  // Dismiss the native splash once the app has booted its local snapshot.
  useEffect(() => {
    if (booted) {
      void hideSplash();
    }
  }, [booted]);

  // Android hardware back: close the quick-add sheet first, then step out of
  // a context to home; from home, let the OS close the app. Refs keep the
  // handler reading latest state without re-registering per navigation.
  useEffect(() => {
    return registerBackButton(() => {
      if (quickAddRef.current) {
        setQuickAdd(false);
        return true;
      }
      if (viewRef.current.kind !== "home") {
        setView({ kind: "home" });
        return true;
      }
      return false;
    });
  }, []);

  // Re-sync when the app returns to the foreground on native.
  useEffect(() => {
    return registerResume(() => {
      if (navigator.onLine) {
        requestSync();
      }
    });
  }, [requestSync]);

  const handleOnboarded = useCallback(async () => {
    await refresh();
    setView({ kind: "home" });
    setStatus("Device ready.");
  }, [refresh]);

  // Assistant navigation intents ("open Flat balances") land here.
  const handleNavigate = useCallback(
    (target: NavTarget) => {
      if (target.kind === "context") {
        openContext(target.contextId, target.tab);
      } else if (target.kind === "settings") {
        setView({ kind: "settings" });
      } else {
        setView({ kind: "home" });
      }
    },
    [openContext],
  );

  const handleLogout = useCallback(async () => {
    await logout();
    await refresh();
    setView({ kind: "home" });
    setStatus("Logged out on this device.");
  }, [refresh]);

  if (!booted) {
    return null;
  }

  // Native shells must know their backend before anything else can talk to it.
  // Also shown when the user chooses to re-point the app at another server.
  // Local-only mode skips this entirely — there is no backend.
  if (isNativePlatform() && !localMode && (!serverReady || editingServer)) {
    return (
      <ServerSetupScreen
        onComplete={() => {
          setServerReady(true);
          setEditingServer(false);
          setStatus("Server updated.");
        }}
        onCancel={serverReady ? () => setEditingServer(false) : undefined}
        onLocalOnly={
          serverReady
            ? undefined
            : () => {
                enableLocalOnly();
                setLocalMode(true);
                setStatus("Local-only mode — everything stays on this device.");
              }
        }
      />
    );
  }

  if (!snapshot.device) {
    return <OnboardScreen onComplete={handleOnboarded} />;
  }

  const device = snapshot.device;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">₹</span>
          <span>Expense OS</span>
        </div>
        <div className="topbar-right">
          {localMode ? (
            <span className="chip chip-online">Local-only</span>
          ) : (
            <span className={`chip ${online ? "chip-online" : "chip-offline"}`}>{online ? "Online" : "Offline"}</span>
          )}
          {!localMode && snapshot.queue.length > 0 ? (
            <span className="chip chip-pending">{snapshot.queue.length} queued</span>
          ) : null}
          <span className="device-name">{device.displayName}</span>
          {!localMode ? (
            <button className="secondary compact" onClick={requestSync} disabled={!online || syncBusy}>
              {syncBusy ? "Syncing…" : "Sync"}
            </button>
          ) : null}
          {/* On phones the bottom nav owns these destinations — CSS hides
              the duplicates (unified-expense-os-oi8). */}
          <button className="secondary compact topbar-wide-only" onClick={() => setView({ kind: "assistant" })}>
            Assistant
          </button>
          <button className="secondary compact topbar-wide-only" onClick={() => setView({ kind: "settings" })}>
            Settings
          </button>
          {!localMode ? (
            <button className="secondary compact" onClick={handleLogout}>
              Log out
            </button>
          ) : null}
        </div>
      </header>

      {view.kind === "home" ? (
        <HomeScreen
          snapshot={snapshot}
          device={device}
          online={online}
          openContext={(contextId) => openContext(contextId)}
          refresh={refresh}
          setStatus={setStatus}
        />
      ) : view.kind === "settings" ? (
        <SettingsScreen
          device={device}
          online={online}
          back={() => setView({ kind: "home" })}
          refresh={refresh}
          onEditServer={() => setEditingServer(true)}
          setStatus={setStatus}
        />
      ) : view.kind === "assistant" ? (
        <>
          <section className="context-header">
            <button className="secondary compact" onClick={() => setView({ kind: "home" })}>
              ← Home
            </button>
            <h1>Assistant</h1>
          </section>
          <section className="grid tabbed active-assistant">
            <div className="column">
              <div className="tab-panel tab-assistant">
                <ChatPanel
                  scopeContextId={null}
                  participants={snapshot.participants}
                  memberships={snapshot.memberships}
                  contexts={snapshot.contexts}
                  entries={snapshot.entries}
                  deviceParticipantId={device.participantId}
                  online={online}
                  refresh={refresh}
                  requestSync={requestSync}
                  onNavigate={handleNavigate}
                />
              </div>
            </div>
          </section>
        </>
      ) : (
        <ContextScreen
          snapshot={snapshot}
          device={device}
          contextId={view.contextId}
          initialTab={view.tab}
          online={online}
          back={() => setView({ kind: "home" })}
          navigate={handleNavigate}
          refresh={refresh}
          requestSync={requestSync}
          setStatus={setStatus}
        />
      )}

      {quickAdd ? (
        <QuickAddSheet
          snapshot={snapshot}
          device={device}
          online={online}
          refresh={refresh}
          requestSync={requestSync}
          setStatus={setStatus}
          onClose={() => setQuickAdd(false)}
          onOpenContext={(contextId) => openContext(contextId)}
        />
      ) : null}

      {/* One-time Android SMS opt-in, offered once the device is onboarded. */}
      <SmsAccessPrompt />

      <BottomNav
        active={view.kind === "home" ? "home" : view.kind === "assistant" ? "assistant" : view.kind === "settings" ? "settings" : null}
        onHome={() => setView({ kind: "home" })}
        onAdd={() => setQuickAdd(true)}
        onAssistant={() => setView({ kind: "assistant" })}
        onSettings={() => setView({ kind: "settings" })}
      />

      {status ? (
        <div className="toast" role="status" aria-live="polite">
          <span>{status}</span>
          <button className="toast-dismiss" onClick={() => setStatus("")} aria-label="Dismiss message">
            ×
          </button>
        </div>
      ) : null}
    </main>
  );
}
