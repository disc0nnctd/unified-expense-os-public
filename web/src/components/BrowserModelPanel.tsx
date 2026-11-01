import { useEffect, useRef, useState } from "react";
import {
  browserModelInfo,
  deleteBrowserModel,
  importBrowserModel,
  isBrowserLlmSupported,
  isBrowserModelLoaded,
  loadBrowserModel,
  unloadBrowserModel,
} from "../lib/browserLlm";
import { humanizeError } from "../lib/errors";
import { formatBytes } from "../lib/localLlm";

// Settings card for the browser on-device model tier (web builds only — the
// Android app has the native LocalLlm plugin instead). The user downloads a
// compatible bundle in this same browser (gated Gemma models just need an HF
// login here, no token), imports it once, and it persists in OPFS.

type Props = {
  setStatus: (message: string) => void;
};

export default function BrowserModelPanel({ setStatus }: Props) {
  const [info, setInfo] = useState<{ name: string; sizeBytes: number } | null>(null);
  const [loaded, setLoaded] = useState(() => isBrowserModelLoaded());
  const [busy, setBusy] = useState<"import" | "load" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importPct, setImportPct] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void browserModelInfo().then(setInfo);
  }, []);

  if (!isBrowserLlmSupported()) {
    return (
      <>
        <div className="panel-header preference-header">
          <h2>On-device model</h2>
          <span>Not available here</span>
        </div>
        <div className="info-strip">
          <span>
            Running a model in the browser needs WebGPU (Chrome/Edge on desktop, or recent Android
            Chrome). The Android app always has on-device AI; voice capture works here when your
            browser supports speech recognition.
          </span>
        </div>
      </>
    );
  }

  async function handlePick(file: File | undefined) {
    if (!file) {
      return;
    }
    setBusy("import");
    setError(null);
    setImportPct(0);
    try {
      await importBrowserModel(file, (done, total) => {
        setImportPct(total > 0 ? Math.round((done / total) * 100) : 0);
      });
      setInfo(await browserModelInfo());
      setLoaded(false);
      setStatus(`Imported ${file.name}. Load it to start using in-browser AI.`);
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setBusy(null);
      setImportPct(null);
    }
  }

  async function handleLoadToggle() {
    setBusy("load");
    setError(null);
    try {
      if (isBrowserModelLoaded()) {
        await unloadBrowserModel();
        setLoaded(false);
        setStatus("Browser model unloaded.");
      } else {
        await loadBrowserModel();
        setLoaded(true);
        setStatus("Browser model loaded — the assistant now parses privately in this tab.");
      }
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    setBusy("delete");
    setError(null);
    try {
      await deleteBrowserModel();
      setInfo(null);
      setLoaded(false);
      setStatus("Browser model deleted.");
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="panel-header preference-header">
        <h2>On-device model (browser)</h2>
        <span>{loaded ? "Loaded" : info ? "Imported" : "Not set up"}</span>
      </div>
      <div className="info-strip">
        <span>
          Run a small model right in this tab via WebGPU — private, works offline once imported.
          {info ? ` Current: ${info.name} (${formatBytes(info.sizeBytes)}).` : " No model imported yet."}{" "}
          Download a MediaPipe bundle in this browser and import it here — e.g.{" "}
          <code>gemma3-1b-it-int4-web.task</code> (700 MB, log into huggingface.co and accept the
          Gemma license first) or Gemma 4 E2B (<code>gemma-4-E2B-it.litertlm</code>, 2.4 GB, no
          login) on a machine with a strong GPU. Same engine rule as Android: Gemma/Llama-family
          bundles only.
        </span>
      </div>
      {error ? <span className="error-text">{error}</span> : null}
      {importPct !== null ? (
        <>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${importPct}%` }} />
          </div>
          <span className="share-hint">Importing… {importPct}%</span>
        </>
      ) : null}
      <input
        ref={fileInput}
        type="file"
        accept=".task,.litertlm"
        style={{ display: "none" }}
        onChange={(event) => {
          void handlePick(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy !== null}
          onClick={() => fileInput.current?.click()}
        >
          {busy === "import" ? "Importing…" : "Import a model file"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy !== null || !info}
          onClick={() => void handleLoadToggle()}
        >
          {busy === "load" ? "Working…" : loaded ? "Unload" : "Load"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy !== null || !info}
          onClick={() => void handleDelete()}
        >
          Delete
        </button>
      </div>
    </>
  );
}
