# Face AI Tracker v2.0 — Verification Report & Changelog
**Date:** July 2026 · **Roadmap items covered:** 1, 2, 3, 4(scaffold), 5(scaffold), 6, 7, and the stale-duplicate half of 10.

---

## ROADMAP ITEM 1 — Verification of the Aria fixes (checklist C.3)

Audited against the actual repo (`Chisco-codes/face-ai-tracker`, commit `b4625e0`):

| Bug | Where | Verdict |
|---|---|---|
| 1. Face-data filter (`emotion===neutral && focus>=50` → empty context) | server.js `buildFaceContext` | ✅ **FIXED** — filter removed, comment documents the rule, face data always sent |
| 2. Duplicate user message pushed to history before send | app.js `sendChatMessage` | ⚠️ **FIXED IN ROOT app.js ONLY** — `client/app.js` was 38 lines behind and STILL CONTAINED THE BUG. GitHub Pages serves root, so production was fixed, but the duplicate-file rule had already been violated: one wrong-direction copy would have re-shipped the bug. **v2 re-syncs everything** (now byte-identical, verified by diff). |
| 3. Broken backtick corrupting ARIA_SYSTEM | server.js | ✅ **FIXED** — `node --check` parses clean; latest commit message confirms |
| No database exists | anywhere | ✅ **CONFIRMED** — zero mongo/sqlite/postgres references in v1. Handoff §11 was a plan, not reality. v2 builds it. |

**Remaining manual step (needs your browser + the live site):** the three
chat tests — "hello" before camera, "what do you see?" during detection,
"I feel stressed" — plus confirming Render is on the latest commit. Code
verification passes; live behavioral verification is yours after you push.

---

## WHAT v2 BUILDS (all code complete, all tests passing)

### Server — rewritten as modular v2 (`client/server/`)
- **server.js** (357 lines) — routing + wiring only; v1 routes (`/health`,
  `/chat`, `/analyze`, `/feedback`, `/feedback/summary`, static) behave
  identically for the existing client. Original preserved as
  `server.v1.backup.js`.
- **lib/db.js** — the project's first real database: MongoDB Atlas with a
  graceful in-memory fallback (the app never dies because the DB is down).
  Collections: `users`, `sessions`, `feedback`. Feedback now persists
  across Render redeploys.
- **lib/crisis.js** — two-stage crisis layer: hard-pattern regex (instant,
  zero AI dependency) + model confirmation for soft/ambiguous phrases that
  FAILS SAFE (no provider → treat as crisis). Region-aware resources
  (US 988/741741, UK/IE Samaritans, CA 988, AU Lifeline, GH/NG 112,
  findahelpline.com always). Runs BEFORE AI, entitlements, and session
  validation on every message route — a paywall can never block it.
- **lib/prompts.js** — ARIA_SYSTEM moved here VERBATIM (personality
  untouched) + four session-mode prompts composed on top of it + the
  summary prompt. The word "therapy" appears nowhere.
- **lib/sessions.js** — Deep Wellness Session engine: state machine
  (active → closing → closed), 30-exchange context (vs 12 in free chat),
  face-metric timeline sampling, AI-written end-of-session summary, and a
  privacy rule enforced in code: **raw transcripts are deleted at close —
  only the summary survives.** `DELETE /me/data` wipes everything.
- **lib/billing.js** — Paystack webhook with timing-safe HMAC-SHA512
  verification; `charge.success` → premium, `subscription.disable` → free.
  Server-enforced plan; the client only displays what `/me` returns.

### New API routes
```
POST   /me                          → anon user + plan + available modes
DELETE /me/data                     → full user data wipe
POST   /session/start               → 402 premium_required for gated modes
POST   /session/message             → crisis-checked, extended context
POST   /session/end                 → summary generated, transcript deleted
GET    /session/history?userId=     → past summaries
POST   /billing/paystack/webhook    → raw-body HMAC verified
```

### Client
- **sessions.js** (new) — anonymous identity, **chat history persistence
  across reloads (Roadmap item 3 ✅)**, session picker modal with the
  coach-not-therapist disclaimer, live session banner, end-session summary
  cards, session history viewer, premium upgrade flow. If this file fails
  to load, the app behaves exactly like v1.
- **sessions.css** (new) — styled entirely with the existing design tokens.
- **app.js** — exactly TWO surgical changes: (1) the fetch inside
  `sendChatMessage` routes via `window.AriaSessions.route()` when a session
  is active; (2) opt-in TensorFlow **WASM backend** (`?wasm=1`, or automatic
  inside the Capacitor Android app) with WebGL fallback — the Android
  performance experiment, zero risk to current users. The iOS
  visualViewport keyboard fix that existed only in root is now in both
  copies (Roadmap item 2 code shipped; device test is yours).
- **index.html** — sessions.css/js wired in + WASM backend script tag.
- **sw.js** — bumped to **v6**, new files added to the core cache.
- Root ↔ client: all six files byte-identical again.

### Desktop (`desktop/`) — Roadmap item 4
Complete Electron app: camera-only permission policy (everything else
denied), sandboxed renderer, external links open in the real browser,
electron-builder targets for Windows/macOS/Linux, `build-app.js` copies
the web app in. `npm install && node build-app.js && npm run dist:win`
produces the Windows installer.

### Mobile — Roadmap item 5
`capacitor.config.json` at root, full Play Store / App Store walkthrough
in `DEPLOYMENT_AND_STORES.md`, WASM auto-enabled inside the Android shell.

---

## TEST RESULTS (run against the real server, no API keys, in-memory DB)

| # | Test | Result |
|---|---|---|
| 1 | `/health` v2 shape (ai, database, sessions) | ✅ |
| 2 | **Crisis message with ZERO AI providers** → instant supportive reply | ✅ (GH locale → 112 + findahelpline) |
| 3 | UK locale → Samaritans 116 123 | ✅ |
| 4 | `/me` creates anon user, plan=free, modes gated correctly | ✅ |
| 5 | Free user starts free Check-in session | ✅ |
| 6 | Free user requests premium Deep session → **HTTP 402** | ✅ |
| 7 | **Crisis inside an invalid/unpaid session → crisis reply anyway** | ✅ |
| 8 | `session/end` idempotent, graceful summary without AI | ✅ |
| 9 | Feedback saved + summary aggregates via db layer | ✅ |
| 10 | Unknown mode "therapy" rejected 400 | ✅ |
| 11 | `PREMIUM_ALL=true` dev override unlocks premium modes | ✅ |
| 12 | Paystack webhook: unconfigured → 503, bad signature → 401 | ✅ |
| 13 | Valid HMAC `charge.success` → user flips to premium in DB | ✅ |
| 14 | Server serves frontend with sessions.js/css (HTTP 200) | ✅ |
| 15 | `node --check` on every JS file | ✅ |

**Grep audit:** the word "therapy" appears in zero user-facing strings,
prompts, or UI (only in code comments explaining why we avoid it).

---

## WHAT NEEDS *YOU* (can't be done from here)

1. Copy this project over your local repo → `git add . && git commit -m "v2.0: sessions, database, crisis layer, desktop+mobile" && git push`
2. Verify Render deployed (Manual Deploy if not) → run C.3's three chat tests live.
3. MongoDB Atlas cluster → `MONGODB_URI` into Render → check boot log.
4. Set `PREMIUM_ALL=true` in Render to try premium sessions yourself.
5. Device tests: iPhone keyboard, Android with `?wasm=1`.
6. Follow `DEPLOYMENT_AND_STORES.md` for the desktop installer and Play Store.
