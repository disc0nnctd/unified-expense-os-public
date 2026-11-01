import { useState } from "react";
import { beginPasskeyRegistration, finishPasskeyRegistration, renameSelf, rotateOwnToken } from "../lib/api";
import { humanizeError } from "../lib/errors";
import { createPasskeyFromOptionsJson, isPasskeySupported } from "../lib/passkey";
import type { DeviceIdentity } from "../types";

type Props = {
  online: boolean;
  device: DeviceIdentity;
  refresh: () => Promise<void>;
};

// Device management, this-device half: this app models "one device == one
// participant identity", so managing *other* devices happens in
// MembersPanel's "Revoke device" button (owner-only, per-context). This
// panel covers the self-service half — rotating this device's own token,
// registering a passkey, and renaming.
export default function DeviceSecurityPanel({ online, device, refresh }: Props) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [name, setName] = useState(device.displayName);

  async function handleRotate() {
    if (!window.confirm("Rotate this device's token? You'll stay logged in here; nothing else changes.")) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await rotateOwnToken();
      setStatus("Token rotated.");
    } catch (cause) {
      setStatus(humanizeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleSetupPasskey() {
    setBusy(true);
    setStatus(null);
    try {
      const { flowId, optionsJson } = await beginPasskeyRegistration();
      const credential = await createPasskeyFromOptionsJson(optionsJson);
      await finishPasskeyRegistration(flowId, credential);
      setStatus("Passkey registered.");
    } catch (cause) {
      setStatus(humanizeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleRename() {
    if (!name.trim() || name.trim() === device.displayName) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await renameSelf(name.trim());
      await refresh();
      setStatus("Name updated.");
    } catch (cause) {
      setStatus(humanizeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>This device</h2>
        <span>Security</span>
      </div>
      <label className="field">
        Your name
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="form-actions">
        <button className="secondary compact" disabled={busy || !online || name.trim() === device.displayName} onClick={handleRename}>
          Save name
        </button>
        <button className="secondary compact" disabled={busy || !online} onClick={handleRotate}>
          {busy ? "Working…" : "Rotate my token"}
        </button>
        {isPasskeySupported() ? (
          <button className="secondary compact" disabled={busy || !online} onClick={handleSetupPasskey}>
            Set up passkey
          </button>
        ) : null}
      </div>
      {status ? <p className="status">{status}</p> : null}
    </article>
  );
}
