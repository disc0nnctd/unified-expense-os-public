// Phone-first bottom navigation (unified-expense-os-oi8). Rendered on every
// screen; CSS hides it at desktop widths where the topbar buttons take over.
// The center "+" opens the global quick-add sheet from anywhere.

type Props = {
  active: "home" | "assistant" | "settings" | null;
  onHome: () => void;
  onAdd: () => void;
  onAssistant: () => void;
  onSettings: () => void;
};

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V21h13V9.5" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12Z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09c0-.69-.41-1.3-1.03-1.56a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09c.69 0 1.3-.41 1.56-1.03a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06c.5.5 1.23.63 1.87.34.62-.26 1.03-.87 1.03-1.56V3a2 2 0 1 1 4 0v.09c0 .69.41 1.3 1.03 1.56.64.29 1.37.16 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87c.26.62.87 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09c-.69 0-1.3.41-1.51 1.03Z" />
    </svg>
  );
}

export default function BottomNav({ active, onHome, onAdd, onAssistant, onSettings }: Props) {
  return (
    <nav className="bottomnav" aria-label="Primary">
      <button
        type="button"
        className={active === "home" ? "bottomnav-active" : ""}
        aria-current={active === "home" ? "page" : undefined}
        onClick={onHome}
      >
        <HomeIcon />
        <span>Home</span>
      </button>
      <button type="button" className="bottomnav-add" onClick={onAdd} aria-label="Add expense">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <button
        type="button"
        className={active === "assistant" ? "bottomnav-active" : ""}
        aria-current={active === "assistant" ? "page" : undefined}
        onClick={onAssistant}
      >
        <ChatIcon />
        <span>Assistant</span>
      </button>
      <button
        type="button"
        className={active === "settings" ? "bottomnav-active" : ""}
        aria-current={active === "settings" ? "page" : undefined}
        onClick={onSettings}
      >
        <GearIcon />
        <span>Settings</span>
      </button>
    </nav>
  );
}
