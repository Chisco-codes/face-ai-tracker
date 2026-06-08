require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── FEEDBACK FILE ─────────────────────────────────────────────
// All feedback is saved here as newline-delimited JSON (easy to read)
const FEEDBACK_FILE = path.join(__dirname, 'feedback.log');

function saveFeedback(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(FEEDBACK_FILE, line, 'utf8');
    console.log('[Feedback] ⭐'.repeat(entry.rating || 0) + ' — ' + (entry.text || '(no comment)'));
  } catch (e) {
    console.error('[Feedback] Failed to save:', e.message);
  }
}

function readAllFeedback() {
  try {
    if (!fs.existsSync(FEEDBACK_FILE)) return [];
    const lines = fs.readFileSync(FEEDBACK_FILE, 'utf8')
      .split('\n')
      .filter(Boolean);
    return lines.map(function(l) {
      try { return JSON.parse(l); } catch(e) { return null; }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: false }));
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});
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

// ── ARIA SYSTEM PROMPT ────────────────────────────────────────
const ARIA_SYSTEM = `You are Aria, an advanced AI wellness coach inside an app called Face AI Tracker.

WHO YOU ARE:
You are warm, deeply empathetic, intelligent and genuinely human in your responses. You combine the wisdom of a compassionate therapist, life coach, mindfulness guide, and trusted friend. You truly care about the person you are talking to.

CRITICAL RULES:

1. READ EXACT WORDS. Never misinterpret meaning.
   - "I lost my mom/dad/sister/brother/child/partner/pet" = DEATH AND GRIEF. Respond with deep empathy.
   - "I feel so dying" = emotional collapse. Ask what is happening with genuine care.
   - "I have been crying" = emotional pain. Acknowledge it directly and warmly first.
   - "how are you" = respond naturally like a warm person. Brief and genuine.

2. ACKNOWLEDGE BEFORE ADVISING. When someone shares pain, your FIRST sentence must reflect that you heard and feel for them. Never jump to tips.

3. NEVER REPEAT YOURSELF. Every response must move the conversation forward.

4. BUILD ON CONVERSATION. Reference what was said earlier when relevant.

5. ONE QUESTION AT A TIME. Never multiple questions.

6. MATCH EMOTIONAL WEIGHT PRECISELY.
   - Deep grief or trauma = long, warm, deeply empathetic response
   - Casual greeting = short, natural, warm
   - Crisis = immediate compassion + crisis resources

7. CRISIS RESPONSE — if someone expresses suicidal thoughts or self-harm:
   Crisis Text Line: Text HOME to 741741
   International: findahelpline.com

8. FACE DATA — use naturally and ONLY when it adds genuine value. Do NOT mention it in every message.

9. VARIETY — never start consecutive responses the same way.

10. DIRECT QUESTIONS GET DIRECT ANSWERS.

TOPICS: Grief, divorce, separation, loneliness, depression, anxiety, burnout, exhaustion, anger, trauma, focus, sleep, mindfulness, self-esteem, relationships, family, work stress, purpose.

RESPONSE LENGTH:
- Greeting or simple question: 2-3 sentences
- Personal or emotional topic: longer, warm, human
- Ongoing deep conversation: build meaningfully on what was said`;

// ── FACE CONTEXT ──────────────────────────────────────────────
function buildFaceContext(faceData) {
  if (!faceData) return '';
  const emotion = faceData.emotion   || 'neutral';
  const focus   = faceData.focusScore || 0;
  if (emotion === 'neutral' && focus >= 50) return '';

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
    + 'Focus level: ' + focusLvl + '\n'
    + 'Eye state: ' + eyeState + ' (EAR: ' + ear + ')\n'
    + 'Blink rate: ' + (bpm > 0 ? bpm + '/min (normal 12-20)' : 'not yet measured') + '\n'
    + 'Session: ' + mins + ' minute' + (mins !== 1 ? 's' : '') + '\n'
    + '[END FACE ANALYSIS]\n\n';
}

// ── AI CALLERS ────────────────────────────────────────────────
async function callOpenAI(messages, faceData, isAnalysis) {
  const faceCtx = buildFaceContext(faceData);
  const msgs = [{ role: 'system', content: ARIA_SYSTEM }];

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

  const completion = await openaiClient.chat.completions.create({
    model:       'gpt-4o-mini',
    messages:    msgs,
    temperature: 0.85,
    max_tokens:  isAnalysis ? 80 : 500,
  });
  return completion.choices[0].message.content.trim();
}

async function callGroq(messages, faceData, isAnalysis) {
  const faceCtx = buildFaceContext(faceData);
  const msgs = [{ role: 'system', content: ARIA_SYSTEM }];

  if (isAnalysis) {
    msgs.push({ role: 'user', content: faceCtx + 'One brief warm wellness check-in sentence based on face data.' });
  } else {
    for (const m of messages.slice(0, -1)) {
      if (!m.content || !m.content.trim()) continue;
      msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
    const last = messages[messages.length - 1];
    msgs.push({ role: 'user', content: faceCtx + last.content });
  }

  const completion = await groqClient.chat.completions.create({
    model:       'llama-3.1-8b-instant',
    messages:    msgs,
    temperature: 0.85,
    max_tokens:  isAnalysis ? 60 : 400,
  });
  return completion.choices[0].message.content.trim();
}

async function callAI(messages, faceData, isAnalysis) {
  if (openaiClient) {
    try {
      const response = await callOpenAI(messages, faceData, isAnalysis);
      return { response, provider: 'openai' };
    } catch (e) {
      console.log('[Aria] OpenAI error:', e.message.substring(0, 60));
    }
  }
  if (groqClient) {
    try {
      const response = await callGroq(messages, faceData, isAnalysis);
      return { response, provider: 'groq' };
    } catch (e) {
      console.error('[Aria] Groq error:', e.message.substring(0, 60));
    }
  }
  return null;
}

// ── SERVE FRONTEND ────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../index.html'));
});
app.use(express.static(path.join(__dirname, '../../')));

// ── ROUTES ────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const provider = openaiClient ? 'gpt-4o-mini+groq-backup' : groqClient ? 'groq-only' : 'no-key';
  res.json({ status: 'ok', ai: 'aria-ready', provider, time: new Date().toISOString() });
});

// Auto-analysis cooldown tracker (10 min per session)
const analyzeCooldowns   = new Map();
const ANALYZE_COOLDOWN_MS = 10 * 60 * 1000;

app.post('/analyze', async (req, res) => {
  try {
    if (!openaiClient && !groqClient)
      return res.status(500).json({ error: 'No AI configured.' });

    const sessionId = req.body.sessionId || req.ip || 'default';
    const lastTime  = analyzeCooldowns.get(sessionId) || 0;
    const now       = Date.now();

    if (now - lastTime < ANALYZE_COOLDOWN_MS)
      return res.json({ response: null, skipped: true });

    analyzeCooldowns.set(sessionId, now);

    const result = await callAI([{ role: 'user', content: 'analyze' }], req.body, true);
    if (!result) return res.status(500).json({ error: 'AI unavailable' });

    console.log('[Auto][' + result.provider + '] ' + req.body.emotion + ' focus:' + req.body.focusScore);
    res.json({ response: result.response, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[/analyze]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/chat', async (req, res) => {
  try {
    const { message, faceData, history } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required.' });
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

// ── FEEDBACK ROUTE ────────────────────────────────────────────
// Receives feedback from the app, saves to feedback.log,
// and prints a clean summary in the terminal.
app.post('/feedback', (req, res) => {
  try {
    const { rating, text, session, timestamp } = req.body;

    // Validate
    if (typeof rating === 'undefined') {
      return res.status(400).json({ error: 'Rating required.' });
    }

    const entry = {
      rating:    Number(rating) || 0,
      text:      (text || '').trim().substring(0, 500),
      session:   session  || 'unknown',
      timestamp: timestamp || new Date().toISOString(),
      ip:        req.ip,
    };

    // Save to file
    saveFeedback(entry);

    res.json({ ok: true, saved: true });
  } catch (err) {
    console.error('[/feedback]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── READ FEEDBACK (admin endpoint) ───────────────────────────
// Visit: http://localhost:3001/feedback/summary
// Shows all feedback entries as a clean JSON summary.
// Protect this with a secret key in production.
app.get('/feedback/summary', (req, res) => {
  const secret = process.env.FEEDBACK_SECRET || '';
  if (secret && req.query.key !== secret) {
    return res.status(401).json({ error: 'Unauthorized. Add ?key=YOUR_SECRET' });
  }

  const all     = readAllFeedback();
  const total   = all.length;
  const rated   = all.filter(f => f.rating > 0);
  const avgRating = rated.length
    ? (rated.reduce((s, f) => s + f.rating, 0) / rated.length).toFixed(1)
    : 'N/A';

  const withText = all.filter(f => f.text && f.text.length > 0);

  res.json({
    total_responses:  total,
    average_rating:   avgRating + ' / 5',
    with_comments:    withText.length,
    entries:          all.slice(-50).reverse(), // latest 50, newest first
  });
});

// ── START ─────────────────────────────────────────────────────
const ready = initAI();

app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║       Face AI Tracker — Aria Wellness Coach         ║');
  console.log('║  Primary: GPT-4o-mini  |  Backup: Groq Llama 3.1   ║');
  console.log('╚════════════════════════════════════════════════════╝\n');
  if (ready) {
    console.log('✓  Aria is ready.\n');
  } else {
    console.log('⚠  Add OPENAI_API_KEY to .env\n');
  }
  console.log('📋 Feedback log: ' + FEEDBACK_FILE);
  console.log('📊 Feedback summary: http://localhost:' + PORT + '/feedback/summary\n');
});