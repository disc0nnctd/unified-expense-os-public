import { useEffect, useState } from "react";
import { getSmsPreGrantEnabled, setSmsPreGrantEnabled } from "../lib/prefs";
import { checkSmsPermission, isSmsAutoReadSupported, requestSmsPermission } from "../lib/smsReader";

// Android-only control for payment-SMS access. Renders nothing elsewhere
// (iOS forbids inbox access; the web build has no SMS at all).
//
// This grants the OS permission ahead of time — it does not start any
// background reading. SMS is only ever read when the user taps "Read payment
// SMS" while adding an expense, and the suggestions stay assist-only: nothing
// is uploaded and nothing reaches the ledger unreviewed.
//
// The OS grant and the local pref are tracked separately on purpose. The pref
// records that the user chose this deliberately; the grant is the real gate.
// So a permission revoked in Android settings shows as "needs permission"
// rather than quietly clearing their choice — and, just as deliberately, an
// OS grant obtained some other way (the one-off add-expense button) never
// flips this on by itself. A single manual read is not consent to more.
export default function SmsAccessPanel() {
  const supported = isSmsAutoReadSupported();
  const [enabled, setEnabled] = useState(() => getSmsPreGrantEnabled());
  const [granted, setGranted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) {
      return;
    }
    let cancelled = false;
    void checkSmsPermission().then((state) => {
      if (!cancelled) {
        setGranted(state === "granted");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [supported]);

  if (!supported) {
    return null;
  }

  async function handleToggle(next: boolean) {
    if (!next) {
      setSmsPreGrantEnabled(false);
      setEnabled(false);
      return;
    }
    setBusy(true);
    try {
      const ok = await requestSmsPermission();
      setGranted(ok);
      setSmsPreGrantEnabled(ok);
      setEnabled(ok);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Payment SMS</h2>
        <span>Read bank and UPI alerts on this device</span>
      </div>
      <div className="info-strip">
        <span>
          Answers Android's SMS permission now, so "Read payment SMS" in the add-expense form works without
          interrupting you. Nothing is read in the background — only when you tap that button. Alerts are
          parsed on this device into suggestions you tap to prefill; nothing is uploaded, and nothing is saved
          to the ledger until you review and add it.
        </span>
      </div>
      <label className="toggle-row">
        <span>Allow SMS access up front</span>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(event) => void handleToggle(event.target.checked)}
        />
      </label>
      {!enabled && granted ? (
        <p className="status">
          Android still has SMS access granted for this app; only Android Settings → Apps → Expense OS →
          Permissions can revoke it.
        </p>
      ) : null}
      {enabled && granted === false ? (
        // Android reports "denied" the same way whether the user tapped Deny
        // once or picked "Don't ask again", and a second request after a hard
        // denial silently no-ops. Hence the pointer to system settings rather
        // than a retry button that might do nothing.
        <p className="status error-text">
          Android has SMS access turned off for this app. Enable it in Android Settings → Apps → Expense OS →
          Permissions, then flip this back on.
        </p>
      ) : null}
    </article>
  );
}
