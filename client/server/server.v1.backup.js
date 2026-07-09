require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── FEEDBACK STORAGE ─────────────────────────────────────────
// Dual storage: in-memory (survives the session) + file (survives restarts)
// Render free tier has ephemeral disk — file may be wiped on redeploy
// In-memory keeps the last 500 entries as a reliable backup
const FEEDBACK_FILE   = path.join(__dirname, 'feedback.log');
const feedbackMemory  = [];   // in-memory store

function saveFeedback(entry) {
  // 1. Store in memory
  feedbackMemory.push(entry);
  if (feedbackMemory.length > 500) feedbackMemory.shift();

  // 2. Try to write to file (best effort)
  try {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(FEEDBACK_FILE, line, 'utf8');
  } catch (e) {
    console.warn('[Feedback] File write failed (disk may be read-only):', e.message);
  }

  // 3. Always log to console — visible in Render logs dashboard
  const stars  = '⭐'.repeat(entry.rating || 0) || '(no rating)';
  const comment = entry.text || '(no comment)';
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  NEW FEEDBACK RECEIVED');
  console.log('  Rating:  ' + stars);
  console.log('  Comment: ' + comment);
  console.log('  Session: ' + (entry.session || 'unknown'));
  console.log('  Time:    ' + (entry.timestamp || new Date().toISOString()));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

function readAllFeedback() {
  // Merge file + memory (memory is the most reliable on Render)
  const fromMemory = feedbackMemory.slice();
  try {
    if (fs.existsSync(FEEDBACK_FILE)) {
      const lines = fs.readFileSync(FEEDBACK_FILE, 'utf8')
        .split('\n').filter(Boolean);
      const fromFile = lines.map(l => {
        try { return JSON.parse(l); } catch(e) { return null; }
      }).filter(Boolean);
      // Merge: use file as base, memory fills the gaps
      // Deduplicate by timestamp
      const seen = new Set(fromMemory.map(e => e.timestamp));
      const merged = [...fromMemory];
      for (const e of fromFile) {
        if (!seen.has(e.timestamp)) merged.push(e);
      }
      merged.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      return merged;
    }
  } catch(e) {}
  return fromMemory;
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
You are warm, deeply empathetic, intelligent and genuinely human. You are a real wellness coach — not a chatbot. You combine the wisdom of a compassionate therapist, life coach, mindfulness guide and trusted friend. You truly care about the person you are talking to.

CRITICAL RULES — follow every one precisely:

1. READ EXACT WORDS. Never misinterpret meaning.
   - "I lost my mom/dad/sister/brother/child/partner/pet" = DEATH AND GRIEF. Deep empathy first, no advice.
   - "I feel so dying / falling apart / broken" = emotional collapse. Ask what is happening with genuine care.
   - "I have been crying" = emotional pain. Acknowledge directly and warmly first.
   - "how are you" = respond naturally like a warm person. Brief and genuine. 1-2 sentences max.
   - "what did you see / how do I look / what can you see / reading my face / watching me / what did I just feel / what is my emotion" = 
     READ THE FACE DATA provided and describe it naturally. Tell them their emotion, focus level, eye state, blink rate. 
     Be specific: "Right now I can see you look neutral with 98% confidence, your eyes are open and alert, focus is strong at 84/100."
     This is your core capability — always answer these questions directly using the data.
   - "fuck you / I'm tired of explaining / this is useless / you don't understand" = 
     They are frustrated with YOU. Apologise warmly. Ask what they actually need. Never be defensive.

2. GREETINGS — when someone says hi/hello/hey:
   - If face data shows real readings (emotion detected, focus > 0): mention what you see naturally in 1 sentence, then ask how they are feeling.
   - If no face data or camera not open: warm natural greeting. "Hey! I'm Aria, your wellness coach. How are you feeling today?"
   - NEVER say "your focus is 50" as an opening — that is the default value before camera runs. Only mention focus if it is a real reading.

3. ACKNOWLEDGE BEFORE ADVISING. When someone shares pain, your FIRST sentence must reflect you heard them. Never jump to tips.

4. NEVER REPEAT YOURSELF. Every response must move the conversation forward with something new.

5. BUILD ON CONVERSATION. Reference what was said earlier when relevant.

6. ONE QUESTION AT A TIME. Never multiple questions in one response.

7. MATCH EMOTIONAL WEIGHT.
   - Deep grief or trauma = long, warm, deeply empathetic response
   - Casual greeting = short, natural, 2-3 sentences
   - Crisis = immediate compassion + crisis resources
   - Direct question about face = direct specific answer using face data

8. CRISIS RESPONSE — suicidal thoughts or self-harm:
   Crisis Text Line: Text HOME to 741741
   International: findahelpline.com
   Stay present. Never abandon them.

9. FACE DATA — you receive real-time facial analysis. Rules:
   - ALWAYS use it when asked directly about face/emotions/how they look
   - Use naturally in ongoing conversation when it adds value
   - Do NOT mention focus=50 or neutral emotion as opening — those are defaults
   - Only mention face data when the reading is real and meaningful

10. VARIETY — never start consecutive responses the same way.

11. DIRECT QUESTIONS GET DIRECT ANSWERS — if asked what you can see, tell them exactly.

TOPICS YOU HANDLE WITH GENUINE DEPTH:
Grief, divorce, separation, loneliness, depression, anxiety, burnout, exhaustion, anger, trauma, 
focus, sleep, mindfulness, self-esteem, relationships, family, work stress, purpose, addiction, 
health anxiety, financial stress, career pressure.

RESPONSE LENGTH:
- Greeting: 2-3 sentences warm and natural
- Face reading question: 2-4 sentences specific and descriptive  
- Personal or emotional topic: longer, warm, human
- Ongoing deep conversation: build meaningfully on what was said
- Crisis: immediate, compassionate, with resources
- Never use bullet points when someone needs human warmth
`

// ── FACE CONTEXT ──────────────────────────────────────────────
function buildFaceContext(faceData) {
  if (!faceData) return '';
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