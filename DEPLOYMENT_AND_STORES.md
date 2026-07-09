# Face AI Tracker — Ship It: Desktop, Play Store, App Store & Hosting

This guide takes the v2 codebase to installed apps on every platform.
Everything here assumes the v2 code is pushed to GitHub and deployed.

---

## 1. Desktop app (Electron) — Windows / macOS / Linux

Everything lives in `desktop/`. The desktop app is the SAME web app in a
native window, with camera permission granted natively and all other
permissions denied.

```powershell
cd desktop
npm install
node build-app.js        # copies the web app into desktop/app
npm start                # run it locally — camera should prompt once

# Build installers:
npm run dist:win         # → desktop/dist/Face AI Tracker Setup 2.0.0.exe
npm run dist:mac         # (must be run on a Mac)
npm run dist:linux       # → .AppImage
```

Publish the installers as **GitHub Releases** on the repo, then add a
"Download for Desktop" button on facewellnessai.com linking to the latest
release. That's a real downloadable app shipped — no store review needed.

Auto-update later: add `electron-updater` + `publish: github` in the
builder config. Not required for v2.0.

---

## 2. Android app (Capacitor) → Google Play Store

Capacitor wraps the same `client/` folder in a native Android shell.
`capacitor.config.json` is already in the repo root.

### One-time setup (needs Android Studio installed)
```powershell
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap add android
```

### Every build
```powershell
# 1. Make sure client/ is current (the usual copy step)
# 2. Sync web code into the native project
npx cap sync android
# 3. Open in Android Studio to run/build
npx cap open android
```

### Required Android tweaks (do once, inside android/)
1. **Camera permission** — in `android/app/src/main/AndroidManifest.xml` add:
   ```xml
   <uses-permission android:name="android.permission.CAMERA" />
   <uses-feature android:name="android.hardware.camera" android:required="true" />
   ```
2. **WebView camera prompt** — Capacitor's Bridge WebChromeClient handles
   `onPermissionRequest` for you on recent versions; test on a real device.
3. **WASM backend is automatic** — app.js detects `window.Capacitor` +
   Android and switches TensorFlow.js to the WASM backend (with WebGL
   fallback). This is the experiment that should let you RE-ENABLE emotion
   detection on Android:
   - Test on a low-end device with `?wasm=1` in Chrome first.
   - If stable at ≥10fps, raise Android `FRAME_MS` from 300 → 100 in app.js
     and re-enable the emotion pass every 6th frame.

### Play Store submission
1. Google Play Console account — **$25 one-time** (pay with a card that
   works for Google; mobile money won't work here).
2. In Android Studio: **Build → Generate Signed Bundle (.aab)**. Create a
   keystore and BACK IT UP — losing it means you can never update the app.
3. Play Console → Create app → upload the .aab to Internal testing first.
4. Store listing essentials:
   - Category: Health & Fitness
   - **Data safety form**: declare camera use, state that video is processed
     on-device and never transmitted (this is true and is your best asset).
   - Privacy policy URL: host one at facewellnessai.com/privacy (required).
   - Because the app discusses wellbeing, include the coach-not-therapist
     disclaimer in the store description too.
5. Promote Internal → Closed → Production. First review typically 1–7 days.

---

## 3. iOS app (Capacitor) → Apple App Store

Requires a Mac with Xcode + Apple Developer Program (**$99/year**).
Until then, the PWA (Add to Home Screen) remains the iOS channel — that's
fine, ship Android first.

```bash
npm install @capacitor/ios
npx cap add ios
npx cap sync ios
npx cap open ios
```

In Xcode:
1. `Info.plist` → add `NSCameraUsageDescription`:
   "Face AI Tracker uses your camera to analyse focus and emotion on-device.
    Video never leaves your phone."
2. Signing & Capabilities → your team.
3. Product → Archive → distribute to TestFlight, then App Store review.
4. App Review notes: state clearly it's a wellness/coaching app, on-device
   video processing, crisis resources included. Apple reviews wellbeing
   apps carefully — the disclaimer and crisis layer are exactly what they
   look for.

Bonus: Capacitor's native keyboard handling resolves the iOS
keyboard-over-input bug in the app version automatically.

---

## 4. Hosting — should you leave Render?

**Verdict: keep Render, upgrade the plan. Don't migrate now.**

| Option | Cost | Reality |
|---|---|---|
| Render Free (current) | $0 | Spins down after 15 min → 30–60s cold start; the 14-min keep-alive ping is a workaround, not a fix. Fine for testing, bad for paying users. |
| **Render Starter** ★ | ~$7/mo | Always-on, same repo, same env vars, ZERO migration work. Flip the plan in the dashboard. |
| Railway / Fly.io | ~$5+/mo | Fine platforms, but migrating buys you nothing Render Starter doesn't give you, and costs a day of deploy debugging. |

The moment the first premium user pays, the $7/mo is covered. Migration is
only worth revisiting if Render's region latency to Ghana becomes a real
user complaint (then consider Fly.io's Johannesburg region).

**Database is already solved**: MongoDB Atlas M0 (free) — create the
cluster, set `MONGODB_URI` in Render env vars, done. The server logs
`✓ MongoDB Atlas connected` on boot. Without it, everything still runs
in-memory (nothing crashes), you just lose persistence.

### New environment variables (Render dashboard)
```
MONGODB_URI          = mongodb+srv://...@cluster0.xxx.mongodb.net/faceai?retryWrites=true&w=majority
PAYSTACK_SECRET_KEY  = sk_live_...        (when billing goes live)
PREMIUM_ALL          = true               (TEMPORARY dev flag — remove before charging money)
```

---

## 5. Paystack — going live with premium

1. paystack.com → business account (Ghana supported: cards + mobile money).
2. Create a **Payment Page** for the premium plan (or a Plan for
   subscriptions). Copy its URL into `PAYSTACK_PAYMENT_URL` at the top of
   `sessions.js`.
3. Dashboard → Settings → API Keys & Webhooks:
   - Webhook URL: `https://face-ai-tracker.onrender.com/billing/paystack/webhook`
   - Copy the secret key into Render env `PAYSTACK_SECRET_KEY`.
4. The flow is already built: checkout carries `metadata[anonId]`, the
   webhook verifies the HMAC-SHA512 signature and flips the user's plan to
   premium in MongoDB. Test mode first: Paystack test keys + test cards.
5. Remove `PREMIUM_ALL=true` from Render before launch.

---

## 6. Launch order (recommended)

1. Push v2 → verify Render deployed → run the C.3 checklist live.
2. Create MongoDB Atlas cluster → set `MONGODB_URI` → confirm boot log.
3. Upgrade Render to Starter.
4. Electron: build the Windows installer → GitHub Release → site button.
5. Capacitor Android → Internal testing → Play Store production.
6. Paystack test mode → live mode → remove PREMIUM_ALL.
7. iOS/App Store when revenue justifies the $99 + Mac access.
