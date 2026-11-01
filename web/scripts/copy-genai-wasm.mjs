// Copies the MediaPipe GenAI WASM runtime (~79 MB, not committed) into
// public/ so the browser on-device model tier is fully self-hosted — the app
// is often reachable only over a tailnet or offline as a PWA, so a CDN
// FilesetResolver would break exactly when local AI matters most. Runs as
// predev/prebuild; the service worker caches whichever variant the browser
// actually fetches. On a MediaPipe upgrade, bump the sw.js CACHE_NAME so
// cache-first clients pick up the new runtime.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(webRoot, "node_modules", "@mediapipe", "tasks-genai", "wasm");
const target = join(webRoot, "public", "mediapipe-wasm");

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
