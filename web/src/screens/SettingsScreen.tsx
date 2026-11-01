import { useEffect, useRef, useState } from "react";
import BrowserModelPanel from "../components/BrowserModelPanel";
import DeviceSecurityPanel from "../components/DeviceSecurityPanel";
import NotificationsPanel from "../components/NotificationsPanel";
import SmsAccessPanel from "../components/SmsAccessPanel";
import { deleteLlmConfig, getLlmConfig, putLlmConfig, type LlmConfigView } from "../lib/api";
import { humanizeError } from "../lib/errors";
import {
  MODEL_CATALOG,
  backgroundDownloadStatus,
  cancelBackgroundModelDownload,
  deleteLocalModel,
  formatBytes,
  startBackgroundModelDownload,
  discardDownloadedModel,
  importLocalModel,
  isLocalLlmSupported,
  recoverDownloadedModel,
  useLocalModel,
  loadLocalModel,
  localLlmStatus,
  localStorageInfo,
  unloadLocalModel,
  type BackgroundDownloadItem,
  type LocalLlmStatus,
} from "../lib/localLlm";
import { isLocalOnly } from "../lib/localMode";
import { isNativePlatform } from "../lib/serverConfig";
import {
  getPhoneEndpoint,
  getServerLlmEnabled,
  getThemePref,
  isLoopbackUrl,
  setPhoneEndpoint,
  setServerLlmEnabled,
  setThemePref,
  type ThemePref,
} from "../lib/prefs";
import type { DeviceIdentity } from "../types";

type Props = {
  device: DeviceIdentity;
  online: boolean;
  back: () => void;
  refresh: () => Promise<void>;
  onEditServer: () => void;
  setStatus: (message: string) => void;
};

// Preset base URLs for OpenAI-compatible providers. The key is stored on the
// user's own self-hosted backend and used server-side only.
const LLM_PROVIDER_PRESETS = [
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "google/gemma-3-4b-it",
    keyHint: "sk-or-…",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "meta/llama-3.3-70b-instruct",
    keyHint: "nvapi-…",
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    keyHint: "gsk_…",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    keyHint: "AIza…",
  },
  {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1",
    model: "@cf/meta/llama-3.1-8b-instruct",
    keyHint: "Cloudflare API token",
  },
  {
    id: "opencode",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    model: "",
    keyHint: "API key",
  },
  { id: "custom", name: "Custom (any OpenAI-compatible URL)", baseUrl: "", model: "", keyHint: "optional for LAN servers" },
] as const;

type SettingsSection = "general" | "ai" | "advanced";

const SETTINGS_SECTIONS: [SettingsSection, string][] = [
  ["general", "General"],
  ["ai", "AI"],
  ["advanced", "Advanced"],
];

// Consolidated Settings (unified-expense-os-hy0): appearance, AI/assist
// consent + on-device model management, notifications, device security, and
// (native) server selection — previously scattered across Home and the
// topbar.
export default function SettingsScreen({ device, online, back, refresh, onEditServer, setStatus }: Props) {
  const [theme, setTheme] = useState<ThemePref>(() => getThemePref());
  const [serverLlm, setServerLlm] = useState(() => getServerLlmEnabled());
  const [llm, setLlm] = useState<LocalLlmStatus | null>(null);
  const [llmBusy, setLlmBusy] = useState<"import" | "load" | "delete" | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [hfToken, setHfToken] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  // Background downloads in flight — several can run at once; the system
  // DownloadManager owns the transfers, we just poll while the screen is up.
  const [bgDownloads, setBgDownloads] = useState<BackgroundDownloadItem[]>([]);
  const pollTimer = useRef<number | null>(null);

  // Server-side provider config (per identity, key never returned).
  const [providerCfg, setProviderCfg] = useState<LlmConfigView | null>(null);
  const [presetId, setPresetId] = useState<string>("openrouter");
  const [providerUrl, setProviderUrl] = useState("");
  const [providerModel, setProviderModel] = useState("");
  const [providerKey, setProviderKey] = useState("");
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);

  // Direct endpoint the device itself calls (Termux Ollama, llama.cpp, LAN).
  const stored = getPhoneEndpoint();
  const [epEnabled, setEpEnabled] = useState(stored?.enabled ?? false);
  const [epUrl, setEpUrl] = useState(stored?.baseUrl ?? "http://127.0.0.1:11434/v1");
  const [epModel, setEpModel] = useState(stored?.model ?? "");
  const [epKey, setEpKey] = useState(stored?.apiKey ?? "");
  const [epStatus, setEpStatus] = useState<string | null>(null);
  const [section, setSection] = useState<SettingsSection>("general");

  useEffect(() => {
    if (isLocalLlmSupported()) {
      void localLlmStatus().then(setLlm);
      void localStorageInfo().then((info) => setFreeBytes(info?.freeBytes ?? null));
      // Pick up (and finalize) any download that ran while the app was away.
      void pollBackgroundDownload();
    }
    if (isLocalOnly()) {
      return;
    }
    void getLlmConfig()
      .then((cfg) => {
        setProviderCfg(cfg);
        if (cfg.configured) {
          setProviderUrl(cfg.base_url ?? "");
          setProviderModel(cfg.model ?? "");
          const preset = LLM_PROVIDER_PRESETS.find((entry) => entry.baseUrl && cfg.base_url?.startsWith(entry.baseUrl.split("/accounts/")[0]));
          setPresetId(preset?.id ?? "custom");
        }
      })
      .catch(() => setProviderCfg(null));
  }, []);

  // Stop the download poll loop when leaving Settings — the transfers
  // themselves continue in the system DownloadManager regardless.
  useEffect(
    () => () => {
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current);
      }
    },
    [],
  );

  function applyPreset(id: string) {
    setPresetId(id);
    const preset = LLM_PROVIDER_PRESETS.find((entry) => entry.id === id);
    if (preset && preset.id !== "custom") {
      setProviderUrl(preset.baseUrl);
      setProviderModel(preset.model);
    }
  }

  async function handleSaveProvider() {
    setProviderBusy(true);
    setProviderError(null);
    try {
      const saved = await putLlmConfig({
        baseUrl: providerUrl.trim(),
        model: providerModel.trim(),
        // Blank input keeps any stored key; the explicit Remove button clears
        // the whole config instead.
        apiKey: providerKey.trim() ? providerKey.trim() : undefined,
      });
      setProviderCfg(saved);
      setProviderKey("");
      setStatus("AI provider saved — the server will use it for your requests.");
    } catch (cause) {
      setProviderError(humanizeError(cause));
    } finally {
      setProviderBusy(false);
    }
  }

  async function handleRemoveProvider() {
    setProviderBusy(true);
    setProviderError(null);
    try {
      await deleteLlmConfig();
      setProviderCfg({ configured: false, base_url: null, model: null, has_api_key: false });
      setProviderUrl("");
      setProviderModel("");
      setProviderKey("");
      setStatus("AI provider removed — back to the server's default (if any).");
    } catch (cause) {
      setProviderError(humanizeError(cause));
    } finally {
      setProviderBusy(false);
    }
  }

  function saveEndpoint(enabled: boolean) {
    if (enabled && isLocalOnly() && !isLoopbackUrl(epUrl.trim())) {
      setEpStatus("Local-only mode allows only this-device endpoints (localhost / 127.0.0.1).");
      return;
    }
    if (enabled && (!epUrl.trim().startsWith("http") || !epModel.trim())) {
      setEpStatus("Enter the endpoint URL and a model name first.");
      return;
    }
    setEpEnabled(enabled);
    setPhoneEndpoint(
      epUrl.trim() && epModel.trim()
        ? { enabled, baseUrl: epUrl.trim(), model: epModel.trim(), apiKey: epKey.trim() || undefined }
        : null,
    );
    setEpStatus(enabled ? "Enabled — the assistant will try this endpoint first." : "Disabled.");
  }

  async function testEndpoint() {
    setEpStatus("Testing…");
    try {
      const headers: Record<string, string> = {};
      if (epKey.trim()) {
        headers.Authorization = `Bearer ${epKey.trim()}`;
      }
      const response = await fetch(`${epUrl.trim().replace(/\/$/, "")}/models`, { headers });
      setEpStatus(
        response.ok
          ? "Reachable — endpoint responded."
          : `Endpoint answered HTTP ${response.status} — check the URL/key (and CORS, e.g. OLLAMA_ORIGINS='*').`,
      );
    } catch {
      setEpStatus("Couldn't reach it. Is the server running? For Ollama in Termux: OLLAMA_ORIGINS='*' ollama serve");
    }
  }

  function chooseTheme(pref: ThemePref) {
    setThemePref(pref);
    setTheme(pref);
  }

  function toggleServerLlm(enabled: boolean) {
    setServerLlmEnabled(enabled);
    setServerLlm(enabled);
  }

  async function refreshLlm() {
    setLlm(await localLlmStatus());
    const info = await localStorageInfo();
    setFreeBytes(info?.freeBytes ?? null);
  }

  // Background downloads (unified-expense-os-44z, -v3s): the system
  // DownloadManager owns the transfers + notifications, so leaving the app is
  // fine and several models can download in parallel. While this screen is
  // open we poll for progress and finalize each completion as it lands.
  async function pollBackgroundDownload() {
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
    const status = await backgroundDownloadStatus();
    const items = status.downloads ?? [];
    setBgDownloads(items.filter((item) => item.active));
    const failed = items.filter((item) => item.error);
    if (failed.length > 0) {
      setLlmError(failed.map((item) => `${item.fileName}: ${item.error}`).join(" · "));
    }
    const finalized = items.filter((item) => item.finalized);
    if (finalized.length > 0) {
      await refreshLlm();
      const names = finalized.map((item) => item.modelName ?? item.fileName).join(", ");
      setStatus(`Downloaded ${names}. Pick “Use” on a model to make it the active one.`);
    }
    if (items.some((item) => item.active)) {
      pollTimer.current = window.setTimeout(() => void pollBackgroundDownload(), 1500);
    }
  }

  async function handleDownload(url: string, fileName: string | undefined, needsToken: boolean) {
    setLlmError(null);
    try {
      await startBackgroundModelDownload({ url, fileName }, needsToken ? hfToken.trim() || undefined : undefined);
      setStatus("Downloading in the background — start more, keep using the app, or leave; progress shows as notifications.");
      void pollBackgroundDownload();
    } catch (cause) {
      setLlmError(humanizeError(cause));
    }
  }

  async function handleRecover(name: string) {
    setLlmBusy("import");
    setLlmError(null);
    try {
      await recoverDownloadedModel(name);
      await refreshLlm();
      setStatus(`Recovered ${name} — no redownload needed. Pick “Use” to make it the active model.`);
    } catch (cause) {
      setLlmError(humanizeError(cause));
    } finally {
      setLlmBusy(null);
    }
  }

  async function handleUseModel(name: string) {
    setLlmBusy("load");
    setLlmError(null);
    try {
      await useLocalModel(name);
      await refreshLlm();
      setStatus(`${name} is now the active on-device model.`);
    } catch (cause) {
      setLlmError(humanizeError(cause));
    } finally {
      setLlmBusy(null);
    }
  }

  async function handleDeleteNamedModel(name: string) {
    setLlmBusy("delete");
    setLlmError(null);
    try {
      await deleteLocalModel(name);
      await refreshLlm();
      setStatus(`Deleted ${name}.`);
    } catch (cause) {
      setLlmError(humanizeError(cause));
    } finally {
      setLlmBusy(null);
    }
  }

  async function handleImportModel() {
    setLlmBusy("import");
    setLlmError(null);
    try {
      const { modelName } = await importLocalModel();
      await refreshLlm();
      setStatus(`Imported ${modelName}. Load it to start using on-device AI.`);
    } catch (cause) {
      setLlmError(humanizeError(cause));
    } finally {
      setLlmBusy(null);
    }
  }

  async function handleLoadModel() {
    setLlmBusy("load");
    setLlmError(null);
    try {
      if (llm?.loaded) {
        await unloadLocalModel();
        setStatus("On-device model unloaded.");
      } else {
        await loadLocalModel();
        setStatus("On-device model loaded — the assistant now parses privately on this phone.");
      }
      await refreshLlm();
    } catch (cause) {
      setLlmError(humanizeError(cause));
    } finally {
      setLlmBusy(null);
    }
  }

  async function handleDeleteModel() {
    setLlmBusy("delete");
    setLlmError(null);
    try {
      await deleteLocalModel();
      await refreshLlm();
      setStatus("On-device model deleted.");
    } catch (cause) {
      setLlmError(humanizeError(cause));
    } finally {
      setLlmBusy(null);
    }
  }

  return (
    <>
      <section className="context-header">
        <button className="secondary compact" onClick={back}>
          ← Back
        </button>
        <h1>Settings</h1>
      </section>

      {/* Most people need Appearance and never open the model tiers. One flat
          scroll made every reader page past provider keys and endpoint config
          to reach anything. Same gating idea as the context tabs. */}
      <nav className="tabbar settings-tabbar" role="tablist" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      <section className="grid">
        <div className="column">
          {section === "general" ? (
          <article className="panel">
            <div className="panel-header">
              <h2>Appearance</h2>
              <span>Theme follows your system unless you pick one</span>
            </div>
            <div className="chip-row" role="radiogroup" aria-label="Theme">
              {(
                [
                  ["system", "System"],
                  ["light", "Light"],
                  ["dark", "Dark"],
                ] as const
              ).map(([pref, label]) => (
                <button
                  key={pref}
                  type="button"
                  role="radio"
                  aria-checked={theme === pref}
                  className={`chip${theme === pref ? " chip-active" : ""}`}
                  onClick={() => chooseTheme(pref)}
                >
                  {label}
                </button>
              ))}
            </div>
          </article>
          ) : null}

          {section === "ai" ? (
          <article className="panel">
            <div className="panel-header">
              <h2>AI &amp; assist</h2>
              <span>Suggestions only — nothing is ever saved without your review</span>
            </div>
            {isLocalOnly() ? null : (
            <label className="toggle-inline">
              <input
                type="checkbox"
                checked={serverLlm}
                onChange={(event) => toggleServerLlm(event.target.checked)}
              />
              <span>
                Allow the server AI to help parse text and chat. Sends the message text and member names (never
                the ledger) to the model configured below (or the server's default). Off by default;
                deterministic parsing and the on-device model work without it.
              </span>
            </label>
            )}

            {isLocalOnly() ? null : (<>
            <div className="panel-header preference-header">
              <h2>AI provider &amp; key</h2>
              <span>
                {providerCfg?.configured
                  ? `Using ${providerCfg.model ?? "?"}${providerCfg.has_api_key ? " (key set)" : " (keyless)"}`
                  : "Using the server's default"}
              </span>
            </div>
            <div className="info-strip">
              <span>
                Bring your own key — OpenRouter, NVIDIA NIM, Cloudflare Workers AI, OpenCode Zen, or any
                OpenAI-compatible URL. The key is stored on your self-hosted server and only ever used there;
                this app never sees it again after saving.
              </span>
            </div>
            {providerError ? <span className="error-text">{providerError}</span> : null}
            <div className="entry-form">
              <label>
                Provider
                <select value={presetId} onChange={(event) => applyPreset(event.target.value)}>
                  {LLM_PROVIDER_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Model
                <input
                  value={providerModel}
                  onChange={(event) => setProviderModel(event.target.value)}
                  placeholder="e.g. google/gemma-3-4b-it"
                  autoCapitalize="off"
                />
              </label>
              <label className="wide">
                Base URL
                <input
                  value={providerUrl}
                  onChange={(event) => setProviderUrl(event.target.value)}
                  placeholder="https://…/v1"
                  autoCapitalize="off"
                  autoComplete="off"
                />
              </label>
              {presetId === "cloudflare" ? (
                <span className="share-hint wide">Replace YOUR_ACCOUNT_ID in the URL with your Cloudflare account id.</span>
              ) : null}
              <label className="wide">
                API key {providerCfg?.has_api_key ? "(leave blank to keep the saved key)" : ""}
                <input
                  type="password"
                  value={providerKey}
                  onChange={(event) => setProviderKey(event.target.value)}
                  placeholder={LLM_PROVIDER_PRESETS.find((preset) => preset.id === presetId)?.keyHint ?? "…"}
                  autoCapitalize="off"
                  autoComplete="off"
                />
              </label>
              <div className="form-actions wide">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void handleSaveProvider()}
                  disabled={providerBusy || !online || !providerUrl.trim().startsWith("http") || !providerModel.trim()}
                >
                  {providerBusy ? "Saving…" : "Save provider"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void handleRemoveProvider()}
                  disabled={providerBusy || !online || !providerCfg?.configured}
                >
                  Remove
                </button>
              </div>
            </div>
            </>)}
            {isLocalLlmSupported() ? (
              <>
                <div className="panel-header preference-header">
                  <h2>On-device model</h2>
                  <span>{llm?.loaded ? "Loaded" : llm?.modelName ? "Imported" : "Not set up"}</span>
                </div>
                <div className="info-strip">
                  <span>
                    Run a small model entirely on this phone — private, works offline.
                    {llm?.modelName ? ` Current: ${llm.modelName}.` : " No model installed yet."}
                    {freeBytes !== null ? ` Free space on device: ${formatBytes(freeBytes)}.` : ""}
                  </span>
                </div>
                {llmError ? <span className="error-text">{llmError}</span> : null}
                {(llm?.pendingFiles?.length ?? 0) > 0
                  ? llm?.pendingFiles?.map((file) => (
                      <div key={file.name} className="info-strip">
                        <span>
                          Found a finished download that wasn't registered: {file.name} (
                          {formatBytes(file.sizeBytes)}). Recover it instead of redownloading.
                        </span>
                        <div className="form-actions">
                          <button
                            type="button"
                            className="secondary compact"
                            disabled={llmBusy !== null}
                            onClick={() => void handleRecover(file.name)}
                          >
                            Recover
                          </button>
                          <button
                            type="button"
                            className="secondary compact"
                            disabled={llmBusy !== null}
                            onClick={() => {
                              void discardDownloadedModel(file.name).then(() => refreshLlm());
                            }}
                          >
                            Discard
                          </button>
                        </div>
                      </div>
                    ))
                  : null}
                {(llm?.models?.length ?? 0) > 0 ? (
                  <div className="plan-list">
                    {llm?.models?.map((model) => (
                      <div className="plan-row" key={model.name}>
                        <span>
                          {model.name} · {formatBytes(model.sizeBytes)}
                          {model.current ? (llm?.loaded ? " · active" : " · selected") : ""}
                        </span>
                        <button
                          type="button"
                          className="secondary compact"
                          disabled={llmBusy !== null || (model.current && llm?.loaded)}
                          onClick={() => void handleUseModel(model.name)}
                        >
                          {model.current && llm?.loaded ? "In use" : "Use"}
                        </button>
                        <button
                          type="button"
                          className="secondary compact"
                          disabled={llmBusy !== null}
                          onClick={() => void handleDeleteNamedModel(model.name)}
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {bgDownloads.map((dl) => (
                  <div key={dl.downloadId} className="info-strip">
                    <span>
                      Downloading {dl.fileName} · {formatBytes(dl.bytesDownloaded ?? 0)}
                      {dl.totalBytes ? ` of ${formatBytes(dl.totalBytes)}` : ""}… Keeps going if you leave the app.
                    </span>
                    {dl.stateDetail ? <span className="error-text">{dl.stateDetail}</span> : null}
                    <div className="progress-track">
                      <div
                        className="progress-fill"
                        style={{
                          width: dl.totalBytes
                            ? `${Math.min(100, ((dl.bytesDownloaded ?? 0) / dl.totalBytes) * 100)}%`
                            : "10%",
                        }}
                      />
                    </div>
                    <div className="form-actions">
                      <button
                        type="button"
                        className="secondary compact"
                        onClick={() => {
                          void cancelBackgroundModelDownload(dl.downloadId).then(() => pollBackgroundDownload());
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ))}
                {MODEL_CATALOG.map((entry) => {
                  const downloading = bgDownloads.some((dl) => dl.fileName === entry.fileName);
                  return (
                    <div key={entry.id} className="info-strip">
                      <span>
                        <strong>{entry.name}</strong> · needs ≈{formatBytes(entry.approxBytes)} of storage.{" "}
                        {entry.note}
                      </span>
                      <div className="form-actions">
                        <button
                          type="button"
                          className="secondary compact"
                          disabled={downloading || (entry.gated && !hfToken.trim())}
                          onClick={() => void handleDownload(entry.url, entry.fileName, entry.gated)}
                        >
                          {downloading ? "Downloading…" : `Download (${formatBytes(entry.approxBytes)})`}
                        </button>
                      </div>
                    </div>
                  );
                })}
                <div className="info-strip">
                  <span>
                    Looking for Qwen 3, SmolLM2, or Phi-4 Mini? Those use a tokenizer the built-in engine
                    can't run (it needs SentencePiece models like Gemma/Llama). They work great via Ollama
                    instead — install Termux, run <code>pkg install ollama</code>, then e.g.{" "}
                    <code>ollama pull qwen3:1.7b</code> and <code>OLLAMA_ORIGINS='*' ollama serve</code>, and
                    connect it under “Local endpoint” below. Same privacy: nothing leaves the phone.
                  </span>
                </div>
                <label className="field">
                  Hugging Face token (only for gated models; never leaves this device except to the model host)
                  <input
                    value={hfToken}
                    onChange={(event) => setHfToken(event.target.value)}
                    placeholder="hf_…"
                    autoCapitalize="off"
                    autoComplete="off"
                  />
                </label>
                <label className="field">
                  Or a direct URL to any compatible .task/.litertlm bundle
                  <input
                    value={customUrl}
                    onChange={(event) => setCustomUrl(event.target.value)}
                    placeholder="https://…/model.task"
                    autoCapitalize="off"
                    autoComplete="off"
                  />
                </label>
                <div className="form-actions">
                  <button
                    type="button"
                    className="secondary compact"
                    disabled={!customUrl.trim().startsWith("http")}
                    onClick={() => void handleDownload(customUrl.trim(), undefined, true)}
                  >
                    Download from URL
                  </button>
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void handleImportModel()}
                    disabled={llmBusy !== null}
                  >
                    {llmBusy === "import" ? "Importing…" : "Import a downloaded file instead"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void handleLoadModel()}
                    disabled={llmBusy !== null || !llm?.modelName}
                  >
                    {llmBusy === "load" ? "Working…" : llm?.loaded ? "Unload" : "Load"}
                  </button>
                </div>
              </>
            ) : (
              <BrowserModelPanel setStatus={setStatus} />
            )}
            <div className="panel-header preference-header">
              <h2>Local endpoint (advanced)</h2>
              <span>{epEnabled ? "Enabled" : "Off"}</span>
            </div>
            <div className="info-strip">
              <span>
                Point the assistant at an OpenAI-compatible server this device can reach — e.g. Ollama in
                Termux on this phone (http://127.0.0.1:11434/v1, start with OLLAMA_ORIGINS='*') or a machine
                on your network. Tried before the built-in model; works in local-only mode for
                this-device endpoints. Good phone-sized pulls: <code>qwen3:0.6b</code> (fastest),{" "}
                <code>qwen3:1.7b</code> (multilingual), <code>smollm2:1.7b</code>, <code>gemma3:1b</code>,{" "}
                <code>phi4-mini</code> (needs ~8 GB RAM).
              </span>
            </div>
            {epStatus ? <span className="share-hint">{epStatus}</span> : null}
            <div className="entry-form">
              <label className="wide">
                Endpoint URL
                <input
                  value={epUrl}
                  onChange={(event) => setEpUrl(event.target.value)}
                  placeholder="http://127.0.0.1:11434/v1"
                  autoCapitalize="off"
                  autoComplete="off"
                />
              </label>
              <label>
                Model
                <input
                  value={epModel}
                  onChange={(event) => setEpModel(event.target.value)}
                  placeholder="e.g. qwen3:0.6b"
                  autoCapitalize="off"
                />
              </label>
              <label>
                API key (optional)
                <input
                  type="password"
                  value={epKey}
                  onChange={(event) => setEpKey(event.target.value)}
                  placeholder="usually none"
                  autoCapitalize="off"
                  autoComplete="off"
                />
              </label>
              <div className="form-actions wide">
                <button type="button" className="secondary" onClick={() => void testEndpoint()}>
                  Test
                </button>
                <button type="button" className="secondary" onClick={() => saveEndpoint(!epEnabled)}>
                  {epEnabled ? "Disable" : "Save & enable"}
                </button>
              </div>
            </div>
          </article>
          ) : null}

          {section === "advanced" && !isNativePlatform() ? (
            <article className="panel">
              <div className="panel-header">
                <h2>Android app</h2>
                <span>Same app, plus SMS auto-read, voice, and on-device AI</span>
              </div>
              <div className="info-strip">
                <span>
                  Served from this same server (works wherever you can reach this page — e.g. over your
                  tailnet). Android will warn about installing from outside Play; that's expected for a
                  self-hosted app.
                </span>
              </div>
              <div className="form-actions">
                <a className="secondary" href="/expense-os.apk" download>
                  Download APK
                </a>
              </div>
            </article>
          ) : null}

          {section === "advanced" && isNativePlatform() ? (
            <article className="panel">
              <div className="panel-header">
                <h2>Server</h2>
                <span>Which backend this app syncs with</span>
              </div>
              <div className="form-actions">
                <button type="button" className="secondary" onClick={onEditServer}>
                  Change server…
                </button>
              </div>
            </article>
          ) : null}
        </div>

        <div className="column">
          {/* Device-local and offline-safe, so it belongs in both modes. */}
          {section === "general" ? <SmsAccessPanel /> : null}
          {section !== "general" ? null : isLocalOnly() ? (
            <article className="panel">
              <div className="panel-header">
                <h2>Local-only mode</h2>
                <span>No server, no account, no sync</span>
              </div>
              <div className="info-strip">
                <span>
                  Everything — identity, members, and the ledger — lives only on this device. Members are
                  name-only; there are no invites, passkeys, or notifications. Connecting this data to a
                  server later (to sync with other devices) is planned but not available yet, so back up your
                  device if the history matters.
                </span>
              </div>
            </article>
          ) : (
            <>
              <NotificationsPanel />
              <DeviceSecurityPanel online={online} device={device} refresh={refresh} />
            </>
          )}
        </div>
      </section>
    </>
  );
}
