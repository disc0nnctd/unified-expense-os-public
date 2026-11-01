// Browser on-device LLM — the web counterpart of the Android LocalLlm plugin
// (unified-expense-os-iqa family). MediaPipe's GenAI web runtime executes the
// same .task/.litertlm bundles over WebGPU, entirely inside the tab: nothing
// leaves the device, and the WASM runtime is self-hosted (public/mediapipe-
// wasm, see scripts/copy-genai-wasm.mjs) so it works tailnet-only/offline.
//
// The model file is imported once via the file picker and persisted in OPFS
// (origin-private file system), so it survives reloads without redownloading.
// Same constraint as the Android engine: SentencePiece-tokenizer bundles only
// (Gemma/Llama family), and the same hard rule as every assist path — model
// output only ever becomes a draft the user reviews, never a ledger write.
import type { LlmInference } from "@mediapipe/tasks-genai";

const OPFS_DIR = "browser-llm";
// Reload-survival: set after a successful load so the assistant tier can lazily
// re-load the engine next session without a trip through Settings.
const AUTOLOAD_KEY = "expense-os-browser-llm-autoload";
const MAX_TOKENS = 512;

let engine: LlmInference | null = null;
let engineUrl: string | null = null;
let loadInFlight: Promise<boolean> | null = null;
// MediaPipe rejects overlapping generateResponse calls; serialize them.
let generateChain: Promise<unknown> = Promise.resolve();

export function isBrowserLlmSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "gpu" in navigator &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

// This TS version's lib.dom omits FileSystemDirectoryHandle's async
// iteration members (they're standard and shipped in every OPFS-capable
// browser); declare the two we use.
interface IterableDirectoryHandle extends FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
  keys(): AsyncIterableIterator<string>;
}

async function modelDir(): Promise<IterableDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return (await root.getDirectoryHandle(OPFS_DIR, { create: true })) as IterableDirectoryHandle;
}

export async function browserModelInfo(): Promise<{ name: string; sizeBytes: number } | null> {
  if (!isBrowserLlmSupported()) {
    return null;
  }
  try {
    const dir = await modelDir();
    for await (const handle of dir.values()) {
      if (handle.kind === "file") {
        const file = await (handle as FileSystemFileHandle).getFile();
        return { name: file.name, sizeBytes: file.size };
      }
    }
  } catch {
    // OPFS unavailable (private browsing etc.) — treat as no model.
  }
  return null;
}

// Stream the picked file into OPFS. One model at a time: a second import
// replaces the first (browser storage quotas make hoarding GB bundles rude).
export async function importBrowserModel(
  source: File,
  onProgress?: (bytesDone: number, totalBytes: number) => void,
): Promise<{ name: string }> {
  await unloadBrowserModel();
  const dir = await modelDir();
  for await (const existing of dir.keys()) {
    await dir.removeEntry(existing).catch(() => undefined);
  }
  const handle = await dir.getFileHandle(source.name, { create: true });
  const writable = await handle.createWritable();
  const reader = source.stream().getReader();
  let done = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      await writable.write(chunk.value);
      done += chunk.value.byteLength;
      onProgress?.(done, source.size);
    }
    await writable.close();
  } catch (cause) {
    await writable.abort().catch(() => undefined);
    await dir.removeEntry(source.name).catch(() => undefined);
    throw cause;
  }
  return { name: source.name };
}

export async function loadBrowserModel(): Promise<boolean> {
  if (engine) {
    return true;
  }
  if (loadInFlight) {
    return loadInFlight;
  }
  loadInFlight = (async () => {
    const info = await browserModelInfo();
    if (!info) {
      throw new Error("No model imported yet — pick a .task/.litertlm file first.");
    }
    const dir = await modelDir();
    const handle = await dir.getFileHandle(info.name);
    const file = await handle.getFile();
    // Dynamic import keeps the ~1 MB JS runtime out of the main bundle for
    // everyone who never enables the browser model.
    const { FilesetResolver, LlmInference: Llm } = await import("@mediapipe/tasks-genai");
    const fileset = await FilesetResolver.forGenAiTasks("/mediapipe-wasm");
    const url = URL.createObjectURL(file);
    try {
      engine = await Llm.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: url },
        maxTokens: MAX_TOKENS,
      });
      engineUrl = url;
      localStorage.setItem(AUTOLOAD_KEY, "1");
      return true;
    } catch (cause) {
      URL.revokeObjectURL(url);
      throw cause;
    }
  })();
  try {
    return await loadInFlight;
  } finally {
    loadInFlight = null;
  }
}

export function isBrowserModelLoaded(): boolean {
  return engine !== null;
}

// Lazy tier check: loaded, or auto-loadable because the user loaded it in a
// previous session and the model file is still in OPFS. Never throws.
export async function ensureBrowserModel(): Promise<boolean> {
  if (engine) {
    return true;
  }
  if (!isBrowserLlmSupported() || localStorage.getItem(AUTOLOAD_KEY) !== "1") {
    return false;
  }
  try {
    return await loadBrowserModel();
  } catch {
    return false;
  }
}

export async function generateBrowser(prompt: string): Promise<string> {
  const run = generateChain.then(async () => {
    if (!engine) {
      throw new Error("Browser model is not loaded.");
    }
    return engine.generateResponse(prompt);
  });
  generateChain = run.catch(() => undefined);
  return run;
}

export async function unloadBrowserModel(): Promise<void> {
  if (engine) {
    try {
      engine.close();
    } catch {
      // Already closed.
    }
    engine = null;
  }
  if (engineUrl) {
    URL.revokeObjectURL(engineUrl);
    engineUrl = null;
  }
  localStorage.removeItem(AUTOLOAD_KEY);
}

export async function deleteBrowserModel(): Promise<void> {
  await unloadBrowserModel();
  try {
    const dir = await modelDir();
    for await (const name of dir.keys()) {
      await dir.removeEntry(name).catch(() => undefined);
    }
  } catch {
    // Nothing to delete.
  }
}
