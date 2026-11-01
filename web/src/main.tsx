import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initNativeShell, isNative } from "./lib/native";
import { loadServerBaseUrl } from "./lib/serverConfig";
import "./styles.css";

// A packaged native shell serves its assets locally, so the PWA service worker
// is redundant there (and its navigation fallback can interfere). Only register
// it on the web build.
if (!isNative() && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

// Resolve the persisted backend URL into the synchronous cache before the app
// issues its first request, then apply native chrome. Neither step should block
// rendering on failure.
async function bootstrap() {
  await loadServerBaseUrl().catch(() => undefined);
  void initNativeShell();

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
