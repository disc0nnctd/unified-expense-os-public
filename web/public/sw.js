const CACHE_NAME = "expense-os-shell-v2";
const FALLBACK_URL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([FALLBACK_URL, "/manifest.webmanifest", "/icon.svg"]))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(FALLBACK_URL, copy));
          return response;
        })
        .catch(() => caches.match(FALLBACK_URL))
    );
    return;
  }

  const url = new URL(request.url);
  // Never cache the sideload APK: it's ~54 MB of CacheStorage, and
  // cache-first would keep serving a stale build after redeploys.
  if (url.origin === self.location.origin && !url.pathname.endsWith(".apk")) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) {
          return cached;
        }
        return fetch(request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        });
      })
    );
  }
});

// Push handling is deliberately dumb: it only renders whatever payload the
// server sends (title/body/tag), nothing else. Real delivery requires a
// deployed HTTPS origin + VAPID keys + a server-side sender job (not
// implemented — see the web-push follow-up ticket), so this is structurally
// complete but unverified end-to-end outside a real deployment.
self.addEventListener("push", (event) => {
  let payload = { title: "Unified Expense OS", body: "New activity", tag: "generic" };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: "/icon.svg",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clientsList) => {
      for (const windowClient of clientsList) {
        if ("focus" in windowClient) {
          return windowClient.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow("/");
      }
    })
  );
});
