import { useState } from "react";
import { registerPushSubscription, unregisterPushSubscription } from "../lib/api";
import { humanizeError } from "../lib/errors";
import { isPushSupported, subscribeToPush, subscriptionToPayload, unsubscribeFromPush } from "../lib/push";

// Push notifications are scaffolded, not fully wired: this panel can
// register a device's subscription with the backend (real, tested), but
// there is no server-side sender job yet (needs VAPID private key +
// pywebpush), so enabling this today stores a subscription that nothing
// currently uses. Kept honest in the UI copy rather than implying delivery
// works end-to-end.
export default function NotificationsPanel() {
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY?.trim();

  if (!isPushSupported()) {
    return null;
  }

  async function handleEnable() {
    setBusy(true);
    setError(null);
    try {
      if (!vapidPublicKey) {
        throw new Error("push_not_configured_on_this_deployment");
      }
      const subscription = await subscribeToPush(vapidPublicKey);
      if (!subscription) {
        throw new Error("notification_permission_denied");
      }
      await registerPushSubscription(subscriptionToPayload(subscription));
      setEnabled(true);
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setBusy(true);
    try {
      await unsubscribeFromPush();
      setEnabled(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Notifications</h2>
        <span>Experimental</span>
      </div>
      <div className="info-strip">
        <span>
          Activity, settle-up, and rent-due reminders. This registers your device for push, but no server currently
          sends notifications — subscribing is safe but won't produce alerts yet.
        </span>
      </div>
      {error ? <p className="status error-text">{error}</p> : null}
      <div className="form-actions">
        {enabled ? (
          <button className="secondary compact" disabled={busy} onClick={handleDisable}>
            Disable
          </button>
        ) : (
          <button className="secondary compact" disabled={busy} onClick={handleEnable}>
            {busy ? "Enabling…" : "Enable notifications"}
          </button>
        )}
      </div>
    </article>
  );
}
