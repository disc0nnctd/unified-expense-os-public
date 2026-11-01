import { FormEvent, useState } from "react";
import { humanizeError } from "../lib/errors";
import { getServerBaseUrl, probeServer, setServerBaseUrl } from "../lib/serverConfig";

type Props = {
  // Called after a server URL is saved (and, if tested, reachable).
  onComplete: () => void;
  // When present, the screen is being shown to change an existing server, so a
  // "Cancel" affordance returns without changing anything.
  onCancel?: () => void;
  // First-run only: opt out of having a server at all (local-only mode).
  onLocalOnly?: () => void;
};

type Probe = "idle" | "checking" | "ok" | "fail";

// Native shells have no same-origin backend, so the very first thing a user
// does is tell the app where their self-hosted server lives. This screen owns
// that one decision and persists it via serverConfig.
export default function ServerSetupScreen({ onComplete, onCancel, onLocalOnly }: Props) {
  const [url, setUrl] = useState(() => getServerBaseUrl() || "http://");
  const [probe, setProbe] = useState<Probe>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleTest() {
    setError(null);
    setProbe("checking");
    try {
      const reachable = await probeServer(url);
      setProbe(reachable ? "ok" : "fail");
    } catch {
      setProbe("fail");
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await setServerBaseUrl(url);
      onComplete();
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell onboard">
      <section className="hero">
        <p className="eyebrow">Self-hosted. Local-first.</p>
        <h1>Connect to your server</h1>
        <p className="lede">
          Enter the address of your self-hosted Expense OS backend — the same host and port you reach in a browser,
          e.g. <code>http://192.168.1.20:8000</code> on your home network.
        </p>
        {error ? <p className="status error-text">{error}</p> : null}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Server address</h2>
          <span>You can change this later</span>
        </div>
        <form className="entry-form" onSubmit={handleSave}>
          <label className="wide">
            Backend URL
            <input
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setProbe("idle");
              }}
              placeholder="http://192.168.1.20:8000"
              autoComplete="url"
              autoCapitalize="none"
              autoCorrect="off"
              inputMode="url"
              spellCheck={false}
            />
          </label>
          {probe === "ok" ? <p className="status">Reachable — server responded.</p> : null}
          {probe === "fail" ? (
            <p className="status error-text">Couldn't reach that server. Check the address and that it's running.</p>
          ) : null}
          <div className="form-actions wide">
            <button type="button" className="secondary" disabled={busy || probe === "checking"} onClick={handleTest}>
              {probe === "checking" ? "Testing…" : "Test connection"}
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Saving…" : "Save & continue"}
            </button>
            {onCancel ? (
              <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
        <div className="info-strip">
          <span>Your data stays on this device and syncs only with the server you choose.</span>
        </div>
      </section>

      {onLocalOnly ? (
        <section className="panel">
          <div className="panel-header">
            <h2>No server?</h2>
            <span>Track expenses on this phone only</span>
          </div>
          <div className="info-strip">
            <span>
              Use the app entirely on this device: add household members by name, split and settle locally, no
              account and no network. You can't sync with other people's devices in this mode.
            </span>
          </div>
          <div className="form-actions">
            <button type="button" className="secondary" disabled={busy} onClick={onLocalOnly}>
              Use without a server
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
