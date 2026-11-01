import { Capacitor } from "@capacitor/core";
import { getMeta, setMeta } from "./localDb";

// Where the app talks to its backend. On the web PWA this is normally the
// same host that served the page (`//<hostname>:8000`). Native shells have no
// same-origin server, so the user must point the app at their self-hosted
// backend; that choice is persisted in the `meta` store and cached here so the
// synchronous request builders in api.ts can read it without an await.
const SERVER_URL_KEY = "serverBaseUrl";

let cachedBase: string | null = null;

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

// "web" | "android" | "ios"
export function platformName(): string {
  return Capacitor.getPlatform();
}

export function normalizeBase(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

// The default (no explicit override) base URL. A build-time VITE_API_BASE_URL
// wins everywhere. On native there is no sensible same-origin default, so we
// return "" to signal "not configured yet" and the UI routes to setup.
function resolveDefaultBase(): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configured) {
    return normalizeBase(configured);
  }
  if (isNativePlatform()) {
    return "";
  }
  if (typeof window === "undefined") {
    return "http://localhost:8000";
  }
  return `${window.location.protocol}//${window.location.hostname}:8000`;
}

// Load the persisted override into the synchronous cache. Call once at boot,
// before any request is issued.
export async function loadServerBaseUrl(): Promise<string> {
  const stored = await getMeta<string>(SERVER_URL_KEY);
  cachedBase = stored ? normalizeBase(stored) : null;
  return getServerBaseUrl();
}

export function getServerBaseUrl(): string {
  if (cachedBase) {
    return cachedBase;
  }
  return resolveDefaultBase();
}

// True when a build-time override or a persisted URL (or a usable web default)
// exists. On an unconfigured native shell this is false, which gates the UI.
export function isServerConfigured(): boolean {
  return getServerBaseUrl().length > 0;
}

// True only when the user explicitly picked a backend URL (vs. an inferred
// default). Used to decide whether to show the "change server" affordance.
export function hasExplicitServerUrl(): boolean {
  return cachedBase !== null;
}

export async function setServerBaseUrl(url: string): Promise<string> {
  const normalized = normalizeBase(url);
  if (!normalized) {
    throw new Error("server_url_required");
  }
  // Throws on a malformed URL — surfaced to the setup form as a validation error.
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("server_url_scheme");
  }
  cachedBase = normalized;
  await setMeta(SERVER_URL_KEY, normalized);
  return normalized;
}

export async function clearServerBaseUrl(): Promise<void> {
  cachedBase = null;
  await setMeta(SERVER_URL_KEY, "");
}

// Connectivity + shape check against the backend's public health endpoint.
// Used by the setup form to give the user immediate confirmation.
export async function probeServer(url: string): Promise<boolean> {
  const base = normalizeBase(url);
  if (!base) {
    return false;
  }
  try {
    const response = await fetch(`${base}/healthz`, { method: "GET" });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json().catch(() => null)) as { status?: string } | null;
    return body?.status === "ok";
  } catch {
    return false;
  }
}
