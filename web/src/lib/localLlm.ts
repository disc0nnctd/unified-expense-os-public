// Bridge to the custom Android `LocalLlm` Capacitor plugin
// (web/android/.../localllm/LocalLlmPlugin.java) — on-device small-model
// inference via MediaPipe LLM Inference (unified-expense-os-iqa).
//
// Why: a phone-local model gives assist parsing/chat a private middle tier —
// deterministic rules first, then this (nothing leaves the device), then the
// opt-in server LLM. The runtime is model-agnostic: it loads any MediaPipe
// LLM bundle (.task/.litertlm) the user imports — Gemma 3 1B int4 (~530 MB)
// is the recommended default; converted Llama 3.2 3B / Phi-style bundles work
// too. The user downloads a model once and imports it via the system file
// picker; we copy it into app storage so no broad storage permission is
// needed.
//
// Same hard rule as every assist path: model output only ever becomes a
// draft the user reviews — it never writes to the ledger.
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { ensureBrowserModel, generateBrowser } from "./browserLlm";

export type InstalledModel = { name: string; sizeBytes: number; current: boolean };

export type LocalLlmStatus = {
  supported: boolean;
  modelPath: string | null;
  modelName: string | null;
  loaded: boolean;
  // All installed model files; several can coexist and the user switches
  // the "current" one with selectModel.
  models?: InstalledModel[];
  // Finished background downloads nothing is tracking (app was away or
  // reinstalled) — recoverable without redownloading.
  pendingFiles?: { name: string; sizeBytes: number }[];
};

// One row per tracked background download — several models can download at
// once (the system DownloadManager runs them concurrently).
export type BackgroundDownloadItem = {
  downloadId: number;
  fileName: string;
  active: boolean;
  bytesDownloaded?: number;
  totalBytes?: number | null;
  paused?: boolean;
  // Why a still-active download isn't moving ("Waiting for Wi-Fi…", queued,
  // retrying after a network error) — shown verbatim in the UI.
  stateDetail?: string;
  finalized?: boolean;
  modelName?: string;
  error?: string;
};

export type BackgroundDownloadStatus = {
  active: boolean;
  downloads?: BackgroundDownloadItem[];
};

interface LocalLlmPlugin {
  getStatus(): Promise<LocalLlmStatus>;
  getStorageInfo(): Promise<{ freeBytes: number; modelSizeBytes: number | null }>;
  // Opens the system file picker (SAF), copies the chosen model bundle into
  // app-private storage, and returns its path. No storage permission needed.
  importModel(): Promise<{ modelPath: string; modelName: string }>;
  // Streams a model straight into app storage with downloadProgress events;
  // optional bearer token for license-gated hosts.
  downloadModel(options: {
    url: string;
    fileName?: string;
    authToken?: string;
  }): Promise<{ modelPath: string; modelName: string; sizeBytes: number }>;
  cancelDownload(): Promise<void>;
  // Background download via the system DownloadManager: keeps going when
  // the app is backgrounded/killed, with a system progress notification.
  downloadModelInBackground(options: {
    url: string;
    fileName?: string;
    authToken?: string;
  }): Promise<{ downloadId: number; fileName: string; totalBytes: number | null }>;
  getBackgroundDownloadStatus(): Promise<BackgroundDownloadStatus>;
  cancelBackgroundDownload(options?: { downloadId?: number }): Promise<void>;
  loadModel(options: { modelPath?: string; maxTokens?: number }): Promise<{ loaded: boolean }>;
  selectModel(options: { modelName: string }): Promise<void>;
  generate(options: { prompt: string; maxTokens?: number }): Promise<{ text: string }>;
  unload(): Promise<void>;
  deleteModel(options?: { modelName?: string }): Promise<void>;
  recoverDownloadedFile(options: { name: string }): Promise<{ modelName: string }>;
  discardDownloadedFile(options: { name: string }): Promise<void>;
  addListener(
    eventName: "downloadProgress",
    handler: (payload: { bytesDownloaded: number; totalBytes: number | null }) => void,
  ): Promise<PluginListenerHandle>;
}

const LocalLlm = registerPlugin<LocalLlmPlugin>("LocalLlm");

export function isLocalLlmSupported(): boolean {
  return Capacitor.getPlatform() === "android";
}

export async function localLlmStatus(): Promise<LocalLlmStatus> {
  if (!isLocalLlmSupported()) {
    return { supported: false, modelPath: null, modelName: null, loaded: false };
  }
  try {
    return await LocalLlm.getStatus();
  } catch {
    return { supported: false, modelPath: null, modelName: null, loaded: false };
  }
}

export async function importLocalModel(): Promise<{ modelPath: string; modelName: string }> {
  return LocalLlm.importModel();
}

// Suggested models for the in-app downloader. Sizes are approximate and
// shown to the user before download; the plugin re-checks free space against
// the server's Content-Length. Gated entries need a (free) Hugging Face
// token after accepting the model license on huggingface.co.
export type ModelCatalogEntry = {
  id: string;
  name: string;
  approxBytes: number;
  url: string;
  fileName: string;
  gated: boolean;
  note: string;
};

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  // Verified against the Hugging Face API 2026-07-22: gated flags and exact
  // file sizes. Gemma 4 (Apr 2026) is Apache-2.0 — NOT license-gated, so no
  // token needed; Gemma 3 models remain under the gated Gemma license.
  {
    id: "gemma4-e2b",
    name: "Gemma 4 E2B Instruct — recommended, no token",
    approxBytes: 2_588_147_712,
    url: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm",
    fileName: "gemma-4-E2B-it.litertlm",
    gated: false,
    note: "Apache 2.0, no token needed. Best quality; wants a phone with ~3 GB free RAM.",
  },
  // NOTE: the embedded MediaPipe engine only loads models with a
  // SentencePiece tokenizer baked in (Gemma/Llama family). Qwen3's
  // .litertlm bundles use a BPE tokenizer and fail with "SentencePiece
  // tokenizer is not found" — they target Google's newer LiteRT-LM
  // runtime, so Qwen was dropped from this catalog (2026-07-22).
  {
    id: "tinyllama-1.1b-q8",
    name: "TinyLlama 1.1B Chat (q8) — small, no token",
    approxBytes: 1_148_331_545,
    url: "https://huggingface.co/litert-community/TinyLlama-1.1B-Chat-v1.0/resolve/main/TinyLlama-1.1B-Chat-v1.0_multi-prefill-seq_q8_ekv1280.task",
    fileName: "TinyLlama-1.1B-Chat-v1.0_multi-prefill-seq_q8_ekv1280.task",
    gated: false,
    note: "Apache 2.0, no token needed. Lighter alternative for mid-range phones.",
  },
  {
    id: "gemma3-270m-q8",
    name: "Gemma 3 270M Instruct (q8) — tiny Gemma",
    approxBytes: 303_950_933,
    url: "https://huggingface.co/litert-community/gemma-3-270m-it/resolve/main/gemma3-270m-it-q8.task",
    fileName: "gemma3-270m-it-q8.task",
    gated: true,
    note: "Needs a free Hugging Face token (accept the Gemma license on huggingface.co first).",
  },
  {
    id: "gemma3-1b-int4",
    name: "Gemma 3 1B Instruct (int4)",
    approxBytes: 555 * 1024 * 1024,
    url: "https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-int4.task",
    fileName: "gemma3-1b-it-int4.task",
    gated: true,
    note: "Needs a free Hugging Face token (accept the Gemma license on huggingface.co first).",
  },
];

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export async function localStorageInfo(): Promise<{ freeBytes: number; modelSizeBytes: number | null } | null> {
  if (!isLocalLlmSupported()) {
    return null;
  }
  try {
    return await LocalLlm.getStorageInfo();
  } catch {
    return null;
  }
}

export async function downloadLocalModel(
  entry: { url: string; fileName?: string },
  authToken: string | undefined,
  onProgress: (bytesDownloaded: number, totalBytes: number | null) => void,
): Promise<{ modelPath: string; modelName: string; sizeBytes: number }> {
  const handle = await LocalLlm.addListener("downloadProgress", (payload) =>
    onProgress(payload.bytesDownloaded, payload.totalBytes),
  );
  try {
    return await LocalLlm.downloadModel({
      url: entry.url,
      fileName: entry.fileName,
      authToken: authToken || undefined,
    });
  } finally {
    void handle.remove();
  }
}

export async function cancelLocalModelDownload(): Promise<void> {
  await LocalLlm.cancelDownload().catch(() => undefined);
}

// Preferred download path: hands the (redirect-resolved) URL to the system
// DownloadManager so the user can leave the app; progress shows in the
// notification shade and the app finalizes the file on next status poll.
// Several downloads can run at once — each call adds one.
export async function startBackgroundModelDownload(
  entry: { url: string; fileName?: string },
  authToken: string | undefined,
): Promise<{ downloadId: number; fileName: string; totalBytes: number | null }> {
  return LocalLlm.downloadModelInBackground({
    url: entry.url,
    fileName: entry.fileName,
    authToken: authToken || undefined,
  });
}

export async function backgroundDownloadStatus(): Promise<BackgroundDownloadStatus> {
  if (!isLocalLlmSupported()) {
    return { active: false };
  }
  try {
    return await LocalLlm.getBackgroundDownloadStatus();
  } catch {
    return { active: false };
  }
}

// Cancel one background download (by id) or, with no id, all of them.
export async function cancelBackgroundModelDownload(downloadId?: number): Promise<void> {
  await LocalLlm.cancelBackgroundDownload(
    downloadId !== undefined ? { downloadId } : undefined,
  ).catch(() => undefined);
}

export async function loadLocalModel(): Promise<boolean> {
  const { loaded } = await LocalLlm.loadModel({ maxTokens: 512 });
  return loaded;
}

export async function unloadLocalModel(): Promise<void> {
  await LocalLlm.unload().catch(() => undefined);
}

export async function deleteLocalModel(modelName?: string): Promise<void> {
  await LocalLlm.deleteModel(modelName ? { modelName } : {});
}

export async function recoverDownloadedModel(name: string): Promise<string> {
  const { modelName } = await LocalLlm.recoverDownloadedFile({ name });
  return modelName;
}

export async function discardDownloadedModel(name: string): Promise<void> {
  await LocalLlm.discardDownloadedFile({ name });
}

// Make an installed model the current one and load it.
export async function useLocalModel(modelName: string): Promise<void> {
  await LocalLlm.selectModel({ modelName });
  await LocalLlm.loadModel({ maxTokens: 512 });
}

// One-shot completion. Callers own prompt construction and response parsing
// (see lib/assistant.ts); this stays a dumb text-in/text-out pipe. On
// Android it runs through the native plugin; in a plain browser it runs the
// WebGPU engine (lib/browserLlm.ts) — same tier, same privacy.
export async function generateLocal(prompt: string, maxTokens = 256): Promise<string> {
  if (isLocalLlmSupported()) {
    const { text } = await LocalLlm.generate({ prompt, maxTokens });
    return text;
  }
  return generateBrowser(prompt);
}

// Whether the local model is ready to answer right now (cheap check used to
// pick the assist tier per message). The browser side lazily re-loads a
// previously enabled model, so tier 3b survives page reloads.
export async function isLocalModelReady(): Promise<boolean> {
  if (isLocalLlmSupported()) {
    const status = await localLlmStatus();
    return status.supported && status.loaded;
  }
  return ensureBrowserModel();
}
