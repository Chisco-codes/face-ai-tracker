// ═══════════════════════════════════════════════════════════════
// FACE AI TRACKER — server.js
// Advanced Wellness AI Coach powered by Google Gemini
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: function(origin, cb) { cb(null, true); }, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// ── GEMINI SETUP ─────────────────────────────────────────────
let genAI = null;
let model = null;

function initGemini() {
  if (!process.env.GEMINI_API_KEY ||
      process.env.GEMINI_API_KEY === 'YOUR_GEMINI_KEY_HERE') return false;
  try {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: {
        temperature:     0.85,  // slightly creative for natural responses
        topP:            0.95,
        maxOutputTokens: 600,   // enough for deep responses
      },
    });
    return true;
  } catch (e) {
    console.error('Gemini init failed:', e.message);
    return false;
  }
}

// ── WELLNESS COACH SYSTEM PROMPT ─────────────────────────────
// This is the heart of the AI — it defines who it is.
// A real wellness coach: empathetic, deep, conversational,
// able to handle complex human emotions and life situations.

const WELLNESS_SYSTEM = `You are Aria — an advanced AI wellness coach built into Face AI Tracker.

WHO YOU ARE:
You are warm, empathetic, professional, and deeply human in your responses.
You combine the wisdom of a licensed therapist, a performance coach, a mindfulness expert,
and a trusted friend. You genuinely care about the person you are talking to.

WHAT YOU CAN SEE:
You have access to real-time facial analysis data — the person's detected emotion,
focus score (0-100), eye fatigue level, blink rate, head posture, and session duration.
Use this data naturally to personalise your responses, but do not recite it robotically.

CONVERSATION STYLE:
- Be conversational, warm and natural — like a real coach, not a chatbot
- Match the emotional weight of what the person shares
- When someone shares something heavy (stress, relationship problems, exhaustion, anxiety,
  paranoia, feeling like life is falling apart) — ACKNOWLEDGE it deeply first before advice
- Ask follow-up questions to go deeper when appropriate
- Remember what was said earlier in the conversation and build on it
- Vary your responses — never sound repetitive or scripted
- Use "I" naturally: "I can see from your face that..." or "I want to understand more..."
- For long or complex problems, structure your response clearly but not rigidly

WHEN SOMEONE SHARES PERSONAL/EMOTIONAL STRUGGLES:
Do NOT jump straight to a list of tips. First:
1. Acknowledge what they shared with genuine empathy
2. Reflect back what you heard so they feel understood
3. Ask one clarifying question if needed
4. THEN offer gentle, practical guidance

For example, if someone says "I'm going through marital issues and feel paranoid and exhausted":
- Do NOT say: "Here are 5 tips for stress"
- DO say: Acknowledge the pain, validate the exhaustion, ask what feels hardest right now,
  then offer something specific and compassionate

TOPICS YOU HANDLE WELL:
- Emotional wellness: stress, anxiety, sadness, anger, loneliness, paranoia, burnout
- Relationships: marital issues, family stress, workplace conflicts, friendship problems
- Mental performance: focus, concentration, motivation, procrastination, mental blocks
- Physical wellness: fatigue, eye strain, sleep issues, tension, breathing
- Life challenges: overwhelm, loss of direction, feeling stuck, low confidence
- Mindfulness: breathing exercises, grounding techniques, presence
- Career and productivity: work stress, deadlines, performance pressure
- Crisis support: if someone seems in genuine crisis, acknowledge it seriously and
  direct them to professional help while staying supportive

BOUNDARIES:
- You are not a licensed therapist — be honest about this when it matters
- For serious mental health crises (suicidal thoughts, severe trauma), warmly direct
  to professional help while staying present and supportive
- Do not give medical diagnoses

FACE DATA INTEGRATION:
When you have face data, weave it naturally into responses:
"I can see from your expression that you look tense right now..."
"Your face is showing signs of fatigue — your eyes look tired..."
"Interestingly, despite how you say you feel, your focus score is actually holding steady..."

LENGTH:
- Short personal message = 2-4 sentences, maybe a follow-up question
- Complex emotional situation = longer, structured, deeply engaged
- Advice request = clear, practical, specific to their situation
- Never give a list when a conversation is more appropriate`;

// ── FACE DATA CONTEXT BUILDER ────────────────────────────────
function buildFaceContext(faceData) {
  if (!faceData) return '';

  const emotion  = faceData.emotion || 'neutral';
  const conf     = Math.round((faceData.emotionConfidence || 0) * 100);
  const focus    = faceData.focusScore || 0;
  const bpm      = faceData.blinkRate  || 0;
  const ear      = parseFloat(faceData.ear || 0).toFixed(3);
  const mins     = Math.round((faceData.sessionMs || 0) / 60000);
  const tilt     = Math.abs(faceData.headTilt || 0);
  const nod      = Math.abs(faceData.headNod  || 0);

  const eyeState = ear < 0.15 ? 'eyes look very tired or heavy'
    : ear < 0.20 ? 'eyes showing some fatigue'
    : 'eyes appear open and alert';

  const focusState = focus >= 75 ? 'strong'
    : focus >= 50 ? 'moderate'
    : 'low';

  const postureNote = (tilt > 15 || nod > 12)
    ? 'Head posture is off — they may be tense or distracted.'
    : 'Posture appears level and comfortable.';

  return `\n\n[REAL-TIME FACE DATA — use naturally in your response if relevant]
Detected emotion: ${emotion} (${conf}% confidence)
Focus level: ${focusState} (${focus}/100)
Eye state: ${eyeState} (EAR: ${ear})
Blink rate: ${bpm > 0 ? bpm + '/min' : 'not yet measured'} (normal: 12-20)
Session duration: ${mins} minute${mins !== 1 ? 's' : ''}
${postureNote}
[END FACE DATA]`;
}

// ── ERROR HANDLING ────────────────────────────────────────────
function cleanGeminiError(err) {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('quota') || msg.includes('429') || msg.includes('resource_exhausted'))
    return { status: 429, text: 'quota_exceeded' };
  if (msg.includes('api_key_invalid') || msg.includes('401'))
    return { status: 401, text: 'Invalid API key.' };
  return { status: 500, text: 'AI temporarily unavailable.' };
}

// ── ROUTES ───────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({
  status: 'ok',
  ai:     model ? 'aria-ready' : 'no-key',
  time:   new Date().toISOString(),
}));

// AUTO-ANALYSIS — proactive observation every 45s
app.post('/analyze', async (req, res) => {
  try {
    if (!model)
      return res.status(500).json({ error: 'AI not configured.' });

    const data = req.body;
    const faceCtx = buildFaceContext(data);

    const prompt = WELLNESS_SYSTEM + faceCtx + `

Based on what you can see from their face right now, give a brief, warm, natural observation
about their current state. Be specific to what the data shows. 2-3 sentences maximum.
Do not list bullet points for this — speak naturally like a coach checking in.`;

    const result   = await model.generateContent(prompt);
    const response = result.response.text().trim();

    console.log(`[Auto-analyse] ${data.emotion} focus:${data.focusScore}`);
    console.log(`  Aria: ${response.substring(0, 100)}...`);
    res.json({ response, timestamp: new Date().toISOString() });

  } catch (err) {
    const clean = cleanGeminiError(err);
    console.error('[/analyze]', err.message);
    res.status(clean.status).json({ error: clean.text });
  }
});

// DEEP CHAT — full conversational wellness coaching
app.post('/chat', async (req, res) => {
  try {
    const { message, faceData, history } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required.' });
    if (!model)   return res.status(500).json({ error: 'AI not configured.' });

    // Build face context to weave into the conversation
    const faceCtx = buildFaceContext(faceData);

    // Convert conversation history to Gemini format
    // We send the last 12 turns so Gemini remembers the full conversation
    const geminiHistory = (history || [])
      .slice(-12)
      .filter(h => h.content && h.content.trim())
      .map(h => ({
        role:  h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }],
      }));

    // Start a chat session with full history for deep context
    const chat = model.startChat({
      history:          geminiHistory,
      systemInstruction: WELLNESS_SYSTEM + faceCtx,
    });

    const result   = await chat.sendMessage(message);
    const response = result.response.text().trim();

    console.log(`[Chat] User: "${message.substring(0, 60)}..."`);
    console.log(`  Aria: "${response.substring(0, 80)}..."`);
    res.json({ response, timestamp: new Date().toISOString() });

  } catch (err) {
    const clean = cleanGeminiError(err);
    console.error('[/chat]', err.message);
    res.status(clean.status).json({ error: clean.text });
  }
});

// ── START ────────────────────────────────────────────────────
const keyReady = initGemini();

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   Face AI Tracker — Aria Wellness Coach      ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Port   : ${PORT}                                 ║`);
  console.log(`║  Health : http://localhost:${PORT}/health        ║`);
  console.log('╚══════════════════════════════════════════════╝\n');
  if (!keyReady) {
    console.log('⚠  No Gemini key found in .env\n');
  } else {
    console.log('✓  Aria (Gemini 2.0 Flash) is ready');
    console.log('✓  Full wellness coaching mode active\n');
  }
});