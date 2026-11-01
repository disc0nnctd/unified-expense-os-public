// Subscribes this device to web push via the already-registered service
// worker (public/sw.js) and hands the subscription to the backend so a
// future sender job can target it. This module only covers the client half:
// there is no server-side push-sending job yet (needs VAPID keys + a
// webpush library on the backend), so subscribing here doesn't yet result in
// any notification actually arriving — see the follow-up ticket. Wrapped
// defensively since Notification/PushManager support varies by browser.

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

export function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscription | null> {
  if (!isPushSupported()) {
    return null;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return null;
  }
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    return existing;
  }
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
  });
}

export function subscriptionToPayload(subscription: PushSubscription): {
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
} {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    p256dh_key: json.keys?.p256dh ?? "",
    auth_key: json.keys?.auth ?? "",
  };
}

export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) {
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  await existing?.unsubscribe();
}
