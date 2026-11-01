// Small, device-local preferences (localStorage). These are per-device UI
// choices, deliberately not synced: theme and AI-assist consent live with
// the device, matching the one-device-one-identity trust model.

export type ThemePref = "system" | "light" | "dark";

const THEME_KEY = "expense-os-theme";
const SERVER_LLM_KEY = "expense-os-server-llm-optin";

export function getThemePref(): ThemePref {
  const value = localStorage.getItem(THEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function setThemePref(pref: ThemePref): void {
  if (pref === "system") {
    localStorage.removeItem(THEME_KEY);
  } else {
    localStorage.setItem(THEME_KEY, pref);
  }
  applyTheme();
}

// Sets data-theme on <html>. styles.css keys its token overrides off this
// attribute; without it, the prefers-color-scheme media query decides.
export function applyTheme(): void {
  const pref = getThemePref();
  const root = document.documentElement;
  if (pref === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", pref);
  }
}

// Consent for sending capture/chat text to the operator-configured server
// model. Default OFF — deterministic + on-device tiers need no consent
// because nothing leaves the device. Hard-off in local-only mode: there is
// no server, and nothing may leave the device.
export function getServerLlmEnabled(): boolean {
  if (localStorage.getItem("expense-os-local-mode") === "1") {
    return false;
  }
  return localStorage.getItem(SERVER_LLM_KEY) === "1";
}

export function setServerLlmEnabled(enabled: boolean): void {
  if (enabled) {
    localStorage.setItem(SERVER_LLM_KEY, "1");
  } else {
    localStorage.removeItem(SERVER_LLM_KEY);
  }
}

// --- Assistant AI-first mode --------------------------------------------------
// When on, the assistant hands messages to the model tiers first and uses the
// built-in deterministic parsing only as a fallback (or when no AI tier is
// available). Numbers are still always computed deterministically — the model
// only interprets phrasing.

const LLM_FIRST_KEY = "expense-os-assistant-llm-first";

export function getAssistantLlmFirst(): boolean {
  return localStorage.getItem(LLM_FIRST_KEY) === "1";
}

export function setAssistantLlmFirst(enabled: boolean): void {
  if (enabled) {
    localStorage.setItem(LLM_FIRST_KEY, "1");
  } else {
    localStorage.removeItem(LLM_FIRST_KEY);
  }
}

// --- Payment-SMS access (Android only) ---------------------------------------
// Two separate flags: whether the user chose to pre-grant SMS access, and
// whether we've already offered the one-time first-load prompt.
//
// Nothing reads SMS on its own — "pre-grant" means exactly that the OS
// permission is answered up front so "Read payment SMS" in the add-expense
// form doesn't have to interrupt with a dialog. The OS grant is the real
// gate; this pref only records that the user made the choice deliberately,
// which is why a revoked permission shows as "needs permission" rather than
// silently clearing their choice. (Storage key predates the rename and is
// kept so existing devices don't lose their answer.)

const SMS_PRE_GRANT_KEY = "expense-os-sms-autoread";
const SMS_ASKED_KEY = "expense-os-sms-asked";

export function getSmsPreGrantEnabled(): boolean {
  return localStorage.getItem(SMS_PRE_GRANT_KEY) === "1";
}

export function setSmsPreGrantEnabled(enabled: boolean): void {
  if (enabled) {
    localStorage.setItem(SMS_PRE_GRANT_KEY, "1");
  } else {
    localStorage.removeItem(SMS_PRE_GRANT_KEY);
  }
}

// True once the first-load prompt has been shown (allowed, declined, or
// dismissed). Settings stays the way back in after that — we never nag.
export function hasAskedSmsAccess(): boolean {
  return localStorage.getItem(SMS_ASKED_KEY) === "1";
}

export function markAskedSmsAccess(): void {
  localStorage.setItem(SMS_ASKED_KEY, "1");
}

// --- Last-used context --------------------------------------------------------
// Remembered per device so the global quick-add sheet (unified-expense-os-oi8)
// can default to where the user last worked instead of asking every time.

const LAST_CONTEXT_KEY = "expense-os-last-context";

export function getLastContextId(): string | null {
  return localStorage.getItem(LAST_CONTEXT_KEY);
}

export function setLastContextId(contextId: string): void {
  localStorage.setItem(LAST_CONTEXT_KEY, contextId);
}

// --- Phone/desktop endpoint tier ---------------------------------------------
// An OpenAI-compatible server the DEVICE reaches directly (Termux+Ollama at
// http://127.0.0.1:11434/v1, llama.cpp server, a LAN box…). Loopback is
// exempt from mixed-content blocking, so this works from the app as-is; the
// user's server must allow CORS (e.g. OLLAMA_ORIGINS='*'). In local-only
// mode only loopback hosts are allowed — nothing may leave the device.

export type PhoneEndpoint = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey?: string;
};

const PHONE_ENDPOINT_KEY = "expense-os-phone-endpoint";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function getPhoneEndpoint(): PhoneEndpoint | null {
  const raw = localStorage.getItem(PHONE_ENDPOINT_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as PhoneEndpoint;
    if (!parsed.baseUrl || !parsed.model) {
      return null;
    }
    // Local-only mode: refuse non-loopback endpoints at read time too, so a
    // stale LAN config can't silently leak after switching modes.
    if (localStorage.getItem("expense-os-local-mode") === "1" && !isLoopbackUrl(parsed.baseUrl)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function setPhoneEndpoint(endpoint: PhoneEndpoint | null): void {
  if (!endpoint) {
    localStorage.removeItem(PHONE_ENDPOINT_KEY);
  } else {
    localStorage.setItem(PHONE_ENDPOINT_KEY, JSON.stringify(endpoint));
  }
}
