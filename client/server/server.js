// ══════════════════════════════════════════════════════════════
//  Face AI Tracker — Aria Wellness Coach server  (v2.0)
//
//  v2 architecture: this file is routing + wiring only.
//  Logic lives in lib/:
//    prompts.js   — ARIA_SYSTEM + session mode prompts (composed, never forked)
//    db.js        — MongoDB Atlas layer with in-memory fallback
//    crisis.js    — two-stage crisis safety layer (runs on EVERY message)
//    sessions.js  — Deep Wellness Session state machine
//    billing.js   — Paystack webhook → server-enforced entitlements
//
//  Backwards compatibility: /health /chat /analyze /feedback
//  /feedback/summary behave identically to v1 for the live client.
// ══════════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const db       = require('./lib/db');
const crisis   = require('./lib/crisis');
const sessions = require('./lib/sessions');
const billing  = require('./lib/billing');
const { ARIA_SYSTEM } = require('./lib/prompts');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: false }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});
// Paystack webhook needs the RAW body for HMAC — mount BEFORE json parser.
app.post('/billing/paystack/webhook',
  express.raw({ type: '*/*', limit: '1mb' }),
  billing.paystackWebhook);
app.use(express.json({ limit: '10mb' }));

// ── AI CLIENTS ────────────────────────────────────────────────
let openaiClient = null;
let groqClient   = null;

function initAI() {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'YOUR_OPENAI_KEY_HERE') {
    try {
      const OpenAI = require('openai');
      openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      console.log('✓  OpenAI GPT-4o-mini ready — primary AI');
    } catch (e) { console.error('OpenAI init failed:', e.message); }
  }
  if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'YOUR_GROQ_KEY_HERE') {
    try {
      const Groq = require('groq-sdk');
      groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
      console.log('✓  Groq Llama 3.1 ready — backup AI');
    } catch (e) { console.error('Groq init failed:', e.message); }
  }
  if (!openaiClient && !groqClient) {
    console.log('⚠  No AI keys found. Add OPENAI_API_KEY to .env');
    return false;
  }
  return true;
}

// ── FACE CONTEXT (unchanged from v1 — the fixed, unfiltered version) ──
function buildFaceContext(faceData) {
  if (!faceData || typeof faceData !== 'object') {
    return '[CAMERA STATUS: OFF]\n'
      + 'No face data available. Do NOT mention the camera or say you cannot see them — '
      + 'help fully with words alone, like any skilled human helper would.\n'
      + 'Only if they directly ask what you see: one warm line that the camera is off, '
      + 'and they can start detection anytime.\n'
      + '[END CAMERA STATUS]\n\n';
  }
  const emotion = faceData.emotion   || 'neutral';
  const focus   = faceData.focusScore || 0;
  // NEVER filter out face data — always send it so Aria can answer
  // face-reading questions accurately regardless of emotion state
  const conf     = Math.round((faceData.emotionConfidence || 0) * 100);
  const bpm      = faceData.blinkRate || 0;
  const ear      = parseFloat(faceData.ear || 0).toFixed(3);
  const mins     = Math.round((faceData.sessionMs || 0) / 60000);
  const eyeState = ear < 0.15 ? 'eyes very tired or heavy'
                 : ear < 0.20 ? 'eyes showing some fatigue'
                 : 'eyes open and alert';
  const focusLvl = focus >= 75 ? 'strong (' + focus + '/100)'
                 : focus >= 50 ? 'moderate (' + focus + '/100)'
                 : 'low (' + focus + '/100)';
  return '[REAL-TIME FACE ANALYSIS — use naturally ONLY if relevant]\n'
    + 'Detected emotion: ' + emotion + ' (' + conf + '% confidence)\n'
    + (faceData.undertone
        ? 'Emotional undertone: a subtle trace of ' + faceData.undertone
          + ' (' + (faceData.undertoneStrength || 0) + '%) beneath the surface — '
          + 'worth gently acknowledging if the conversation touches feelings, never diagnosing.\n'
        : '')
    + 'Focus level: ' + focusLvl + '\n'
    + 'Eye state: ' + eyeState + ' (EAR: ' + ear + ')\n'
    + 'Blink rate: ' + (bpm > 0 ? bpm + '/min (normal 12-20)' : 'not yet measured') + '\n'
    + 'Session: ' + mins + ' minute' + (mins !== 1 ? 's' : '') + '\n'
    + '[END FACE ANALYSIS]\n\n';
}

// ── AI CALLERS ────────────────────────────────────────────────
// extraSystem: session-mode prompt composed ON TOP of ARIA_SYSTEM.
function buildMessages(messages, faceData, isAnalysis, extraSystem) {
  const faceCtx = buildFaceContext(faceData);
  const system = extraSystem ? ARIA_SYSTEM + '\n' + extraSystem : ARIA_SYSTEM;
  const msgs = [{ role: 'system', content: system }];
  if (isAnalysis) {
    msgs.push({ role: 'user', content: faceCtx + 'Give one brief warm wellness check-in sentence based on this face data. Be specific and natural.' });
  } else {
    for (const m of messages.slice(0, -1)) {
      if (!m.content || !m.content.trim()) continue;
      msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
    const last = messages[messages.length - 1];
    msgs.push({ role: 'user', content: faceCtx + last.content });
  }
  return msgs;
}

async function callOpenAI(messages, faceData, isAnalysis, extraSystem) {
  const completion = await openaiClient.chat.completions.create({
    model:       'gpt-4o-mini',
    messages:    buildMessages(messages, faceData, isAnalysis, extraSystem),
    temperature: 0.85,
    max_tokens:  isAnalysis ? 80 : (extraSystem ? 700 : 500),
  });
  return completion.choices[0].message.content.trim();
}

async function callGroq(messages, faceData, isAnalysis, extraSystem) {
  const completion = await groqClient.chat.completions.create({
    model:       'llama-3.1-8b-instant',
    messages:    buildMessages(messages, faceData, isAnalysis, extraSystem),
    temperature: 0.85,
    max_tokens:  isAnalysis ? 60 : (extraSystem ? 600 : 400),
  });
  return completion.choices[0].message.content.trim();
}

async function callAI(messages, faceData, isAnalysis, extraSystem) {
  if (openaiClient) {
    try {
      const response = await callOpenAI(messages, faceData, isAnalysis, extraSystem);
      return { response, provider: 'openai' };
    } catch (e) { console.log('[Aria] OpenAI error:', e.message.substring(0, 60)); }
  }
  if (groqClient) {
    try {
      const response = await callGroq(messages, faceData, isAnalysis, extraSystem);
      return { response, provider: 'groq' };
    } catch (e) { console.error('[Aria] Groq error:', e.message.substring(0, 60)); }
  }
  return null;
}

// ── SERVE FRONTEND ────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../index.html'));
});
app.use(express.static(path.join(__dirname, '../../')));

// ── HEALTH ────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0',
    ai: {
      primary: openaiClient ? 'openai:gpt-4o-mini' : null,
      backup:  groqClient   ? 'groq:llama-3.1-8b-instant' : null,
    },
    database: db.status(),
    sessions: Object.keys(sessions.SESSION_MODES),
    timestamp: new Date().toISOString(),
  });
});

// ── AUTO-ANALYSIS (unchanged behaviour) ───────────────────────
app.post('/analyze', async (req, res) => {
  try {
    if (!openaiClient && !groqClient)
      return res.status(500).json({ error: 'No AI configured.' });
    const result = await callAI([], req.body, true);
    if (!result) return res.status(500).json({ error: 'AI unavailable' });
    console.log('[Auto][' + result.provider + '] ' + req.body.emotion + ' focus:' + req.body.focusScore);
    res.json({ response: result.response, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[/analyze]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── FREE CHAT (v1-compatible + crisis layer) ──────────────────
app.post('/chat', async (req, res) => {
  try {
    const { message, faceData, history } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required.' });

    // CRISIS CHECK FIRST — before AI availability, before anything.
    // Stage 1 needs no provider, so this works even if OpenAI+Groq are down.
    const c = await crisis.check(message, req, openaiClient, groqClient);
    if (c.crisis) {
      console.log('[Crisis] Supportive response served (region: ' + c.country + ')');
      return res.json({ response: c.response, crisis: true, timestamp: new Date().toISOString() });
    }

    if (!openaiClient && !groqClient)
      return res.status(500).json({ error: 'No AI configured.' });

    const messages = [
      ...(history || []).filter(h => h.content && h.content.trim()).slice(-12),
      { role: 'user', content: message },
    ];
    const result = await callAI(messages, faceData, false);
    if (!result) return res.status(500).json({ error: 'AI unavailable — please try again' });

    console.log('[Chat][' + result.provider + '] "' + message.substring(0, 50) + '"');
    res.json({ response: result.response, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[/chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── USER IDENTITY & ENTITLEMENTS ──────────────────────────────
app.post('/me', async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await db.getOrCreateUser(userId);
    if (!user) return res.status(400).json({ error: 'Valid userId required.' });
    const premium = user.plan === 'premium' || process.env.PREMIUM_ALL === 'true';
    res.json({
      userId: user._id,
      plan: premium ? 'premium' : 'free',
      modes: Object.entries(sessions.SESSION_MODES).map(([key, m]) => ({
        key, name: m.name, premium: m.premium, available: !m.premium || premium,
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/me/data', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required.' });
    await db.deleteUserData(userId);
    res.json({ ok: true, deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DEEP WELLNESS SESSIONS ────────────────────────────────────
app.post('/session/start', async (req, res) => {
  try {
    const { userId, mode } = req.body;
    const out = await sessions.start(userId, mode);
    if (out.error) return res.status(out.status || 400).json(out);
    console.log('[Session] ▶ ' + out.session.modeName + ' started (' + out.session._id + ')');
    res.json({
      sessionId: out.session._id,
      mode: out.session.mode,
      modeName: out.session.modeName,
      startedAt: out.session.startedAt,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/session/message', async (req, res) => {
  try {
    const { userId, sessionId, message, faceData } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required.' });

    // CRISIS CHECK FIRST — sessions never gate safety. A crisis reply
    // is served even if the session is invalid, expired, or unpaid.
    const c = await crisis.check(message, req, openaiClient, groqClient);
    if (c.crisis) {
      console.log('[Crisis] In-session supportive response (region: ' + c.country + ')');
      return res.json({ response: c.response, crisis: true, timestamp: new Date().toISOString() });
    }

    const out = await sessions.message(sessionId, userId, message, faceData, callAI);
    if (out.error) return res.status(out.status || 400).json(out);
    res.json({ response: out.response, nearLimit: out.nearLimit, timestamp: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/session/end', async (req, res) => {
  try {
    const { userId, sessionId } = req.body;
    const out = await sessions.end(sessionId, userId, callAI);
    if (out.error) return res.status(out.status || 400).json(out);
    console.log('[Session] ■ Closed ' + sessionId + ' — summary saved, transcript deleted.');
    res.json({ session: out.session });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/session/history', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required.' });
    res.json({ sessions: await sessions.history(userId) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PREMIUM WAITLIST ──────────────────────────────────────────
// Pre-launch: captures who wants premium, straight into the users
// collection. Your launch list, building itself.
app.post('/premium/interest', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required.' });
    await db.getOrCreateUser(userId);
    await db.markPremiumInterest(userId);
    console.log('[Premium] ✋ Waitlist signup: ' + userId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── FEEDBACK (v1-compatible, now persisted to MongoDB) ────────
app.post('/feedback', async (req, res) => {
  try {
    const { rating, text, session, timestamp } = req.body;
    if (typeof rating === 'undefined')
      return res.status(400).json({ error: 'Rating required.' });

    const entry = {
      rating:    Number(rating) || 0,
      text:      (text || '').trim().substring(0, 500),
      session:   session  || 'unknown',
      timestamp: timestamp || new Date().toISOString(),
      ip:        req.ip,
    };
    await db.saveFeedback(entry);

    const stars = '⭐'.repeat(entry.rating || 0) || '(no rating)';
    console.log('\n━━━ NEW FEEDBACK ━━━  ' + stars + '  ' + (entry.text || '(no comment)'));
    res.json({ ok: true, saved: true });
  } catch (err) {
    console.error('[/feedback]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/feedback/summary', async (req, res) => {
  const secret = process.env.FEEDBACK_SECRET || '';
  if (secret && req.query.key !== secret)
    return res.status(401).json({ error: 'Unauthorized. Add ?key=YOUR_SECRET' });

  const all   = await db.readAllFeedback();
  const rated = all.filter(f => f.rating > 0);
  const avgRating = rated.length
    ? (rated.reduce((s, f) => s + f.rating, 0) / rated.length).toFixed(1)
    : 'N/A';
  res.json({
    total_responses: all.length,
    average_rating:  avgRating + ' / 5',
    with_comments:   all.filter(f => f.text && f.text.length > 0).length,
    storage:         db.status(),
    entries:         all.slice(0, 50),
  });
});

// ── START ─────────────────────────────────────────────────────
const ready = initAI();

db.connect().finally(() => {
  app.listen(PORT, () => {
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║     Face AI Tracker — Aria Wellness Coach  v2.0     ║');
    console.log('║  Primary: GPT-4o-mini  |  Backup: Groq Llama 3.1    ║');
    console.log('╚════════════════════════════════════════════════════╝\n');
    console.log(ready ? '✓  Aria is ready.' : '⚠  Add OPENAI_API_KEY to .env');
    console.log('🗄  Database: ' + db.status().mode);
    console.log('🛡  Crisis layer: active on all chat + session routes');
    console.log('🧘 Sessions: ' + Object.keys(sessions.SESSION_MODES).join(', '));
    console.log('📊 Feedback: http://localhost:' + PORT + '/feedback/summary\n');
  });
});
