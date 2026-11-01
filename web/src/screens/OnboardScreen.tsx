import { FormEvent, useEffect, useState } from "react";
import {
  beginPasskeyLogin,
  beginPasskeyRegistration,
  finishPasskeyLogin,
  finishPasskeyRegistration,
  forgetRememberedDevice,
  joinWithInvite,
  listRememberedDevices,
  loginAsRememberedDevice,
  registerIdentity,
} from "../lib/api";
import { humanizeError } from "../lib/errors";
import { createLocalIdentity, enableLocalOnly, isLocalOnly } from "../lib/localMode";
import { createPasskeyFromOptionsJson, getPasskeyFromOptionsJson, isPasskeySupported } from "../lib/passkey";
import type { DeviceIdentity } from "../types";

type Props = {
  onComplete: () => Promise<void>;
};

export default function OnboardScreen({ onComplete }: Props) {
  const [createName, setCreateName] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | "login" | "passkey" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remembered, setRemembered] = useState<DeviceIdentity[]>([]);
  const [freshIdentity, setFreshIdentity] = useState<DeviceIdentity | null>(null);
  const [passkeyDone, setPasskeyDone] = useState<"registered" | "skipped" | null>(null);
  const [loginParticipantId, setLoginParticipantId] = useState("");
  // A first-time visitor has nothing to sign in to, so the two sign-in paths
  // start collapsed behind a link. Finding a remembered identity is evidence
  // this browser has been here before — then signing in IS the likely intent,
  // so open it automatically rather than hiding what they came for.
  const [showSignIn, setShowSignIn] = useState(false);

  useEffect(() => {
    void listRememberedDevices().then((identities) => {
      setRemembered(identities);
      if (identities.length > 0) {
        setShowSignIn(true);
      }
    });
  }, []);

  useEffect(() => {
    if (freshIdentity && passkeyDone) {
      void onComplete();
    }
  }, [freshIdentity, passkeyDone, onComplete]);

  async function handleSetupPasskey() {
    if (!freshIdentity) return;
    setBusy("passkey");
    setError(null);
    try {
      const { flowId, optionsJson } = await beginPasskeyRegistration();
      const credential = await createPasskeyFromOptionsJson(optionsJson);
      await finishPasskeyRegistration(flowId, credential);
      setPasskeyDone("registered");
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function handleLoginWithPasskey() {
    if (!loginParticipantId.trim()) return;
    setBusy("passkey");
    setError(null);
    try {
      const { flowId, optionsJson } = await beginPasskeyLogin(loginParticipantId.trim());
      const credential = await getPasskeyFromOptionsJson(optionsJson);
      await finishPasskeyLogin(flowId, loginParticipantId.trim(), credential);
      await onComplete();
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function handleLoginAs(participantId: string) {
    setBusy("login");
    setError(null);
    try {
      await loginAsRememberedDevice(participantId);
      await onComplete();
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function handleForget(participantId: string) {
    await forgetRememberedDevice(participantId);
    setRemembered((current) => current.filter((device) => device.participantId !== participantId));
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!createName.trim()) {
      return;
    }
    // Arrived via the native "use without a server" skip: create locally.
    if (isLocalOnly()) {
      await handleCreateLocal();
      return;
    }
    setBusy("create");
    setError(null);
    try {
      const identity = await registerIdentity(createName.trim());
      if (isPasskeySupported()) {
        setFreshIdentity(identity);
      } else {
        await onComplete();
      }
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setBusy(null);
    }
  }

  // Local-only path (unified-expense-os-1r4): identity is generated on this
  // device, no server round-trip, no passkey (there's no account to secure).
  async function handleCreateLocal() {
    if (!createName.trim()) {
      setError("Enter your name first, then choose local-only.");
      return;
    }
    setBusy("create");
    setError(null);
    try {
      enableLocalOnly();
      await createLocalIdentity(createName.trim());
      await onComplete();
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function handleJoin(event: FormEvent) {
    event.preventDefault();
    if (!joinName.trim() || !joinCode.trim()) {
      return;
    }
    setBusy("join");
    setError(null);
    try {
      await joinWithInvite(joinCode.trim(), joinName.trim());
      await onComplete();
    } catch (cause) {
      setError(humanizeError(cause));
    } finally {
      setBusy(null);
    }
  }

  if (freshIdentity && !passkeyDone) {
    return (
      <main className="shell onboard">
        <section className="hero">
          <p className="eyebrow">One more step</p>
          <h1>Secure {freshIdentity.displayName}'s identity</h1>
          <p className="lede">
            A passkey lets you log back in as this identity from a new device — no bearer token to copy around. Your
            ID (needed to log in elsewhere): <code>{freshIdentity.participantId}</code>
          </p>
          {error ? <p className="status error-text">{error}</p> : null}
        </section>
        <section className="grid">
          <article className="panel">
            <div className="panel-header">
              <h2>Set up a passkey</h2>
              <span>Recommended</span>
            </div>
            <div className="form-actions wide">
              <button className="primary" disabled={busy !== null} onClick={handleSetupPasskey}>
                {busy === "passkey" ? "Setting up…" : "Set up passkey"}
              </button>
              <button className="secondary" disabled={busy !== null} onClick={() => setPasskeyDone("skipped")}>
                Skip for now
              </button>
            </div>
          </article>
        </section>
      </main>
    );
  }

  return (
    <main className="shell onboard">
      <section className="hero">
        <p className="eyebrow">Self-hosted. Works offline. Your data stays yours.</p>
        <h1>Unified Expense OS</h1>
        <p className="lede">
          Personal and shared money in one ledger. Set up this device once — your identity and its key stay here.
        </p>
        {error ? <p className="status error-text">{error}</p> : null}
        {!showSignIn && isPasskeySupported() && !isLocalOnly() ? (
          <button type="button" className="link-button" onClick={() => setShowSignIn(true)}>
            Already set up on another device? Sign in
          </button>
        ) : null}
      </section>

      {isPasskeySupported() && !isLocalOnly() && showSignIn ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Log in with a passkey</h2>
            <span>Returning on a new device</span>
          </div>
          <div className="entry-form">
            <label className="wide">
              Your ID
              <input
                value={loginParticipantId}
                onChange={(event) => setLoginParticipantId(event.target.value)}
                placeholder="p-xxxxxxxx"
                autoComplete="off"
              />
            </label>
            <div className="form-actions wide">
              <button
                className="primary"
                disabled={busy !== null || !loginParticipantId.trim()}
                onClick={handleLoginWithPasskey}
              >
                {busy === "passkey" ? "Verifying…" : "Continue with passkey"}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {remembered.length > 0 && showSignIn ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Log back in</h2>
            <span>No password — this browser remembers identities used here before</span>
          </div>
          <div className="context-list">
            {remembered.map((identity) => (
              <div key={identity.participantId} className="context-card">
                <div>
                  <strong>{identity.displayName}</strong>
                </div>
                <div className="form-actions">
                  <button
                    className="primary compact"
                    disabled={busy !== null}
                    onClick={() => handleLoginAs(identity.participantId)}
                  >
                    {busy === "login" ? "Logging in…" : "Log in"}
                  </button>
                  <button
                    className="secondary compact"
                    disabled={busy !== null}
                    onClick={() => handleForget(identity.participantId)}
                  >
                    Forget
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="grid">
        <article className="panel">
          <div className="panel-header">
            <h2>Start fresh</h2>
            <span>First device in the household</span>
          </div>
          <form className="entry-form" onSubmit={handleCreate}>
            <label className="wide">
              Your name
              <input
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="e.g. Alice"
                autoComplete="name"
              />
            </label>
            <div className="form-actions wide">
              <button type="submit" className="primary" disabled={busy !== null || !createName.trim()}>
                {busy === "create" ? "Creating…" : "Create my identity"}
              </button>
              {!isLocalOnly() ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy !== null || !createName.trim()}
                  onClick={() => void handleCreateLocal()}
                >
                  Use without a server
                </button>
              ) : null}
            </div>
          </form>
          <div className="info-strip">
            <span>
              You'll set up your first group next. “Use without a server” keeps everything on
              this device only — members are added by name, and nothing ever syncs.
            </span>
          </div>
        </article>

        {isLocalOnly() ? null : (
        <article className="panel">
          <div className="panel-header">
            <h2>Join a group</h2>
            <span>Got an invite code?</span>
          </div>
          <form className="entry-form" onSubmit={handleJoin}>
            <label>
              Your name
              <input
                value={joinName}
                onChange={(event) => setJoinName(event.target.value)}
                placeholder="e.g. Bob"
                autoComplete="name"
              />
            </label>
            <label>
              Invite code
              <input
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value)}
                placeholder="XXXX-XXXX"
                autoCapitalize="characters"
                autoComplete="off"
              />
            </label>
            <div className="form-actions wide">
              <button
                type="submit"
                className="primary"
                disabled={busy !== null || !joinName.trim() || !joinCode.trim()}
              >
                {busy === "join" ? "Joining…" : "Join with code"}
              </button>
            </div>
          </form>
          <div className="info-strip">
            <span>The code joins this device to the group, with its own key.</span>
          </div>
        </article>
        )}
      </section>
    </main>
  );
}
