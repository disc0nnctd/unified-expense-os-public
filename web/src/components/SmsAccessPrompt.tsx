import { useEffect, useState } from "react";
import {
  getSmsPreGrantEnabled,
  hasAskedSmsAccess,
  markAskedSmsAccess,
  setSmsPreGrantEnabled,
} from "../lib/prefs";
import { checkSmsPermission, isSmsAutoReadSupported, requestSmsPermission } from "../lib/smsReader";

// One-time, first-load opt-in for payment-SMS auto-read (Android only).
//
// The OS dialog is deliberately fronted by our own explanation: SMS is a
// sensitive permission, and Android only ever shows its dialog once, so a
// cold prompt with no context buys a permanent denial. "Not now" is recorded
// too — we never ask again from here; Settings → Payment SMS is the way back.
export default function SmsAccessPrompt() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isSmsAutoReadSupported() || hasAskedSmsAccess() || getSmsPreGrantEnabled()) {
      return;
    }
    let cancelled = false;
    void checkSmsPermission().then((state) => {
      // Nothing to ask for if Android already answered on our behalf.
      if (cancelled || state === "granted") {
        return;
      }
      setVisible(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) {
    return null;
  }

  function dismiss() {
    markAskedSmsAccess();
    setVisible(false);
  }

  async function handleAllow() {
    setBusy(true);
    try {
      const ok = await requestSmsPermission();
      setSmsPreGrantEnabled(ok);
    } finally {
      setBusy(false);
      dismiss();
    }
  }

  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Read payment SMS">
        <div className="sheet-header">
          <h2>Read payment SMS?</h2>
        </div>
        <div className="sheet-body">
          <div className="info-strip">
            <span>
              When you tap "Read payment SMS" while adding an expense, Expense OS turns recent bank and UPI
              alerts into suggestions you tap to prefill. Nothing is read in the background. Messages are
              parsed on this device — nothing is uploaded, and nothing reaches your ledger until you review
              and add it.
            </span>
          </div>
          <div className="form-actions wide">
            <button type="button" className="secondary" onClick={dismiss} disabled={busy}>
              Not now
            </button>
            <button type="button" onClick={() => void handleAllow()} disabled={busy}>
              {busy ? "Asking…" : "Allow SMS access"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
