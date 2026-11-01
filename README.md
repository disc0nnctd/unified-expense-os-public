# Unified Personal + Shared Expense OS

A self-hosted, offline-first expense app that treats personal tracking,
household accounting, and trip/group splitting as one system instead of three.

**Expenses belong to financial contexts.** A context (personal or shared)
defines its participants, split rules, recurring obligations, permissions, and
roll-up reporting. Your personal spending and your share of the flat's bills
live in the same ledger and the same balances view.

Principles the code actually holds to:

- **Local-first** — the PWA works fully offline against IndexedDB and converges
  with the server; the backend is the sync authority, not a prerequisite.
- **Self-hosted** — `docker compose up` is the whole deployment. Your data
  stays on your machine, including AI traffic if you point it at a local model.
- **AI is assist-only** — capture, voice, and chat can *propose*; only an
  explicit human save writes to the ledger. Deterministic code is the only
  calculator.
- **Money is integer paise** — never floats, anywhere.
- **Balances are derived** — never stored, so they cannot go stale.

---

## Quick start

```bash
docker compose up --build
```

Open <http://localhost:4173>, create your identity, and create a context.

To add a second person: open the context → **Members** → **New invite code**,
then have their device pick **Join a household** during onboarding and enter
the code. Each device holds its own credential; invite codes are single-use and
expire after 7 days. For real cross-device login (same identity, new phone),
register a **passkey** under Settings → Device security.

Prefer no server at all? Onboarding offers **"Use without a server"** — the app
generates an identity on-device, every other member is a name-only ghost, and
nothing ever syncs. One device of record; migration to a server is not
implemented yet.

If you serve the web app from a non-default host or port, set
`VITE_API_BASE_URL` before building so the browser targets the right backend.

---

## What's built

### Ledger and sync
- Contexts (personal/shared), memberships, invites, and **ghost members** —
  add someone by name, hand them the same participant (and its history) later
  via a claim invite.
- Entries with equal / ratio-share / exact-amount splits, per-entry notes,
  edit, void-with-reason, and a full audit trail.
- Multi-currency, including cross-currency settlement math. Balances only ever
  sum one currency; other-currency entries are surfaced, never silently mixed.
- Recurring templates (monthly and weekly) with idempotent generation.
- Settle-up: plan, record, copy-as-text, and optional debt simplification.
- Context lifecycle: archive, and close with a final settlement.
- **Sync**: push/pull against a server-assigned `server_seq` cursor, HLC-based
  last-write-wins with a conflict log, idempotent replay, and a visible
  `pending`/`committed`/`rejected` queue with per-entry Retry/Discard.

### Auth
Bearer device tokens (hashed at rest, one row per device), **passkeys /
WebAuthn** for cross-device login and recovery, token rotation, device
list/revoke, and an optional invite-only registration lock for exposed
deployments.

### Capture (all assist-only)
- Manual entry, CSV import, and a **raw bank-statement triage queue**
  (focus mode, flag-for-review, skip/undo).
- Splitwise balance import with opening-balance adjustments.
- In-browser OCR receipt capture with line-item splitting.
- On-device payment-SMS parsing (Android).
- **Voice → draft → review**: on-device speech recognition where available,
  parsed by a deterministic grammar (spoken numbers, splits, payer, dates).
- **Chat assistant** with four tiers, tried in order: deterministic ledger Q&A
  → deterministic grammar → on-device LLM → opt-in server LLM. Every AI tier is
  **off by default**. Mutations always render a confirm card built from
  resolved local data, never from model text.

### Reporting
Monthly reports with trends and CSV export, light per-category budgets, true
pairwise ("A owes B") balances alongside net balances, and explainable
balances — tap a number to see the entries behind it.

### Platforms
- **Web PWA** — Vite + React, no router dependency, light/dark themes.
- **Android** — the *same* bundle in a Capacitor shell (real APK,
  `com.unifiedexpenseos.app`), plus native plugins for speech, SMS, and
  on-device inference.
- **iOS** — not yet; `npx cap add ios` against the same sources needs a Mac.

---

## Development

```bash
# Backend (FastAPI + SQLAlchemy; SQLite locally, Postgres in compose)
cd backend && uv sync && uv run uvicorn app.main:app --reload
cd backend && uv run pytest

# Web (Vite + React PWA)
cd web && npm install && npm run dev
cd web && npm run build        # tsc -b && vite build
cd web && npm test             # vitest units + component tests
cd web && npm run test:e2e     # two-device Playwright slice (needs compose up)

# Android APK
./scripts/android-build.sh     # or: cd web && npm run android:assemble
```

Requires Python ≥ 3.12 and Node 20+. The public snapshot includes backend and web tests. Hosted automation is not included; run the development commands above locally. Android and two-device end-to-end checks require their respective build and deployment environments.

### Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres DSN; defaults to local SQLite |
| `CORS_ALLOWED_ORIGINS` | Explicit allowlist (never a silent `*`) |
| `REGISTRATION_MODE` | `open` (default) or `invite-only` |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` | Must match your serving domain for passkeys |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | Any OpenAI-compatible provider |
| `LLM_API_KEY_OPTIONAL` | `1` for keyless LAN inference |
| `LLM_ALLOW_PRIVATE` | `1` to allow private/LAN LLM targets (default denies, so a member-supplied URL can't probe your network) |
| `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web push |

AI is opt-in and per-participant: each user can store their own provider and
key (Settings → AI), or the deployment can set one via env. Point
`LLM_BASE_URL` at a llama.cpp/Ollama box with `LLM_ALLOW_PRIVATE=1` and assist
traffic never leaves your LAN. On-device models (Android) never leave the phone.

---

## Architecture invariants

Do not break these — they're what keep the ledger trustworthy:

- Amounts are integers (paise/cents), never floats.
- `sum(allocations.share_amount) == entry.total_amount`, enforced at write time.
- Exactly one allocation per entry has `is_payer=true`, matching `entry.payer_id`.
- Balances are always derived, never stored.
- HLC format is `{ms}-{counter}-{node}`, compared numerically as
  `(int(ms), int(counter), node)` — string comparison is **not** sufficient.
- `server_seq` is server-assigned from a row-locked counter and never regresses;
  clients must not set it. Entry `version` never regresses either, including
  after an LWW conflict resolution.
- Each device holds exactly one participant identity and only its own tokens.
- AI/capture output never writes to the ledger; user confirmation is always
  required.

---

## Repository layout

- `web/`: web application and Capacitor Android sources
- `backend/`: API and sync service
- `docker-compose.yml`: local deployment

This public snapshot excludes deployment credentials, internal planning, work logs, and private data. Set your own domain, origin, and provider configuration before deployment. The Compose database credentials are development defaults.
