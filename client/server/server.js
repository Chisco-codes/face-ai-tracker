// ═══════════════════════════════════════════════════════════════
// FACE AI TRACKER — server.js  (Phase 5 — Final)
// Google Gemini AI backend with clean error handling
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: ['http://localhost:5500','http://127.0.0.1:5500',
           'http://localhost:3000','http://127.0.0.1:3000',
           'http://localhost:5173'],
}));
app.use(express.json());

// ── GEMINI SETUP ─────────────────────────────────────────────
let genAI = null;
let model = null;

function initGemini() {
  if (!process.env.GEMINI_API_KEY ||
      process.env.GEMINI_API_KEY === 'YOUR_GEMINI_KEY_HERE') return false;
  try {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    return true;
  } catch (e) {
    console.error('Gemini init failed:', e.message);
    return false;
  }
}

// ── SYSTEM PROMPT ────────────────────────────────────────────
const SYSTEM = `You are a real-time wellness AI in a face tracking app called "Face AI Tracker".
You see the user's live emotion, focus score, eye metrics and head position.
Rules: 1-3 sentences max. Be warm and specific. One actionable tip if needed.
Never repeat raw numbers — interpret them naturally. Vary your responses.`;

// ── CLEAN ERROR MESSAGES ─────────────────────────────────────
// This converts Gemini's raw JSON errors into short readable text
function cleanGeminiError(err) {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('quota') || msg.includes('429') || msg.includes('resource_exhausted')) {
    return { status: 429, text: 'Daily quota reached — resets at midnight Pacific time. Try again tomorrow or upgrade your Gemini plan.' };
  }
  if (msg.includes('api_key_invalid') || msg.includes('401')) {
    return { status: 401, text: 'Invalid API key. Check your server/.env file.' };
  }
  if (msg.includes('not found') || msg.includes('404')) {
    return { status: 404, text: 'Gemini model not found. Check your API key at aistudio.google.com.' };
  }
  return { status: 500, text: 'AI temporarily unavailable. Please try again in a moment.' };
}

// ── BUILD ANALYSIS PROMPT ────────────────────────────────────
function buildPrompt(data) {
  const emotion     = data.emotion      || 'neutral';
  const conf        = Math.round((data.emotionConfidence || 0) * 100);
  const focus       = data.focusScore   || 0;
  const bpm         = data.blinkRate    || 0;
  const blinks      = data.blinkCount   || 0;
  const ear         = parseFloat(data.ear || 0).toFixed(3);
  const tilt        = parseFloat(data.headTilt || 0);
  const nod         = parseFloat(data.headNod  || 0);
  const mins        = Math.round((data.sessionMs || 0) / 60000);

  const tiltDesc = Math.abs(tilt) < 3 ? 'level'
    : `tilted ${tilt > 0 ? 'right' : 'left'} ${Math.abs(tilt).toFixed(1)}°`;
  const nodDesc = Math.abs(nod) < 5 ? 'level'
    : `nodding ${nod > 0 ? 'down' : 'up'} ${Math.abs(nod).toFixed(1)}°`;
  const blinkDesc = bpm === 0 ? 'still measuring'
    : bpm < 8  ? `low at ${bpm}/min`
    : bpm > 25 ? `high at ${bpm}/min`
    : `normal at ${bpm}/min`;

  return `${SYSTEM}

Live data snapshot:
- Emotion: ${emotion} (${conf}% confidence)
- Focus score: ${focus}/100
- Eye openness (EAR): ${ear}
- Blink rate: ${blinkDesc}, total blinks: ${blinks}
- Head: ${tiltDesc}, ${nodDesc}
- Session: ${mins} minute${mins !== 1 ? 's' : ''}

Give a brief 1-3 sentence observation about this person's current state.`;
}

// ── ROUTES ───────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({
  status: 'ok', ai: model ? 'ready' : 'no-key', time: new Date().toISOString()
}));

// Auto-analysis endpoint (called every 45s)
app.post('/analyze', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object')
      return res.status(400).json({ error: 'Invalid request' });
    if (!model)
      return res.status(500).json({ error: 'Gemini key not set. Add it to server/.env' });

    const result   = await model.generateContent(buildPrompt(req.body));
    const response = result.response.text().trim();

    console.log(`[Auto] ${req.body.emotion} | focus:${req.body.focusScore} | bpm:${req.body.blinkRate}`);
    console.log(`  → ${response}`);
    res.json({ response, timestamp: new Date().toISOString() });

  } catch (err) {
    const clean = cleanGeminiError(err);
    console.error('[/analyze]', clean.text);
    res.status(clean.status).json({ error: clean.text });
  }
});

// Manual chat endpoint
app.post('/chat', async (req, res) => {
  try {
    const { message, faceData, history } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });
    if (!model)   return res.status(500).json({ error: 'Gemini key not set. Add it to server/.env' });

    const faceCtx = faceData
      ? `[Face data: emotion=${faceData.emotion}(${Math.round((faceData.emotionConfidence||0)*100)}%), `
      + `focus=${faceData.focusScore}/100, blinks=${faceData.blinkRate}/min, `
      + `session=${Math.round((faceData.sessionMs||0)/60000)}min]\n\n`
      : '';

    // Convert history to Gemini format
    const geminiHistory = (history || []).slice(-6).map(h => ({
      role:  h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    }));

    const chat     = model.startChat({ history: geminiHistory });
    const result   = await chat.sendMessage(SYSTEM + '\n\n' + faceCtx + 'User: ' + message);
    const response = result.response.text().trim();

    console.log(`[Chat] "${message}" → "${response}"`);
    res.json({ response, timestamp: new Date().toISOString() });

  } catch (err) {
    const clean = cleanGeminiError(err);
    console.error('[/chat]', clean.text);
    res.status(clean.status).json({ error: clean.text });
  }
});

// ── START ────────────────────────────────────────────────────
const keyReady = initGemini();

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║    Face AI Tracker — Backend Server      ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Port   : ${PORT}                             ║`);
  console.log(`║  Health : http://localhost:${PORT}/health    ║`);
  console.log('╚══════════════════════════════════════════╝\n');
  if (!keyReady) {
    console.log('⚠  No Gemini key — get one free at:');
    console.log('   https://aistudio.google.com/app/apikey\n');
  } else {
    console.log('✓  Gemini 2.0 Flash ready');
    console.log('✓  Free tier: 1,500 requests/day, 15/min\n');
  }
});