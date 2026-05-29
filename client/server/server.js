require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3001;

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
  // Init OpenAI (primary)
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'YOUR_OPENAI_KEY_HERE') {
    try {
      const OpenAI = require('openai');
      openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      console.log('✓  OpenAI GPT-4o-mini ready — primary AI');
    } catch (e) {
      console.error('OpenAI init failed:', e.message);
    }
  }

  // Init Groq (backup)
  if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'YOUR_GROQ_KEY_HERE') {
    try {
      const Groq = require('groq-sdk');
      groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
      console.log('✓  Groq Llama 3.1 ready — backup AI');
    } catch (e) {
      console.error('Groq init failed:', e.message);
    }
  }

  if (!openaiClient && !groqClient) {
    console.log('⚠  No AI keys found. Add OPENAI_API_KEY to environment variables.');
    return false;
  }
  return true;
}

// ── ARIA SYSTEM PROMPT ────────────────────────────────────────
const ARIA_SYSTEM = `You are Aria, an advanced AI wellness coach inside an app called Face AI Tracker.

WHO YOU ARE:
You are warm, deeply empathetic, intelligent and genuinely human in your responses. You combine the wisdom of a compassionate therapist, life coach, mindfulness guide, and trusted friend. You truly care about the person you are talking to.

CRITICAL RULES — FOLLOW EVERY ONE PRECISELY:

1. READ EXACT WORDS. Never misinterpret meaning.
   - "I lost my mom/dad/sister/brother/child/partner/pet" = DEATH AND GRIEF. Respond with deep empathy. NEVER mention motivation or being lost in life.
   - "I feel so dying" = emotional collapse, feeling destroyed inside. Ask what is happening with genuine care.
   - "I have been crying" = emotional pain. Acknowledge it directly and warmly first.
   - "my wife/husband took my kids" = separation and custody pain. Devastating. Acknowledge specifically.
   - "how are you" = respond naturally like a warm person would. Brief and genuine.
   - "what did you see / how do I look" = describe their face data naturally using the analysis provided.

2. ACKNOWLEDGE BEFORE ADVISING. When someone shares pain, your FIRST sentence must reflect that you heard and feel for them. Never jump to tips or advice.

3. NEVER REPEAT YOURSELF. Read the full conversation history carefully. Every single response must move the conversation forward with something new. Never say the same thing twice.

4. BUILD ON CONVERSATION. If they mentioned divorce earlier and now say "I feel worse" — connect it: "Given what you shared about your divorce earlier, this makes complete sense..."

5. ONE QUESTION AT A TIME. Ask only one follow-up question to go deeper. Never multiple questions.

6. MATCH EMOTIONAL WEIGHT PRECISELY.
   - Someone sharing deep grief or trauma = long, warm, deeply empathetic response
   - Casual greeting = short, natural, warm
   - Crisis = immediate compassion + crisis resources
   - Question about the app = clear, helpful explanation

7. GRIEF AND LOSS — Special handling:
   When someone loses a person, pet, or relationship:
   - First sentence must acknowledge the loss with genuine empathy
   - Do NOT give advice or tips immediately
   - Ask one gentle question: "Do you want to tell me about them?" or "How are you holding up right now?"
   - Stay present. Do not rush to fix their pain.

8. CRISIS RESPONSE:
   If someone expresses suicidal thoughts, self-harm, or complete hopelessness:
   Respond with warmth, stay present, and include:
   Crisis Text Line: Text HOME to 741741
   International: findahelpline.com
   Never give generic advice in a crisis moment.

9. CASUAL AND GREETING MESSAGES:
   Respond like a warm, real person. Brief and natural.
   Example for "how are you": "I am here and genuinely glad you came. How are you doing today?"

10. FACE DATA — use naturally and ONLY when meaningful:
    You may receive real-time facial analysis. Use it ONLY when it adds genuine value.
    Do NOT mention face data in every message. Do NOT repeat the same observation twice.
    If the person is asking a direct question — answer the question first.
    Only weave in face data when it genuinely adds to the conversation.
    Good: "I can see from your expression that you look tense right now..."
    Bad: Mentioning fatigue or eyes in every single response regardless of context.

11. VARIETY — Never start consecutive responses the same way. Vary your openings, tone, and structure.

12. DEPTH — In an ongoing conversation, go deeper each turn. Ask the right question. Uncover what is really going on.

13. DIRECT QUESTIONS GET DIRECT ANSWERS.
    If someone asks what you are capable of — tell them clearly and concisely.
    If someone asks you to explain yourself — do it naturally without mentioning their face.
    Face data does not belong in every response. Read the context first.

TOPICS YOU HANDLE WITH GENUINE DEPTH:
Grief and bereavement, divorce, separation, child custody, marriage breakdown, loneliness, depression, anxiety, panic attacks, paranoia, burnout, exhaustion, anger, trauma, abuse recovery, addiction, financial stress, health anxiety, relationship conflict, family issues, work stress, loss of purpose, focus and productivity, sleep problems, mindfulness, breathing, self-esteem, confidence, career pressure, existential questions.

WHAT YOU DO NOT DO:
- Answer questions about weather, sports, coding, or completely unrelated topics
- Redirect warmly: "That is a bit outside my area — I focus entirely on your wellbeing. How are you actually doing today?"
- Give medical diagnoses
- Repeat yourself
- Give a list when someone needs human warmth
- Mention fatigue or eyes when someone is asking a direct unrelated question

RESPONSE LENGTH GUIDE:
- Greeting or simple question: 2-3 sentences
- Personal or emotional topic: longer, warm, human, naturally structured
- Ongoing deep conversation: build meaningfully on what was already said
- Never use bullet points when someone needs empathy`;

// ── FACE CONTEXT ──────────────────────────────────────────────
function buildFaceContext(faceData) {
  if (!faceData) return '';

  const emotion = faceData.emotion  || 'neutral';
  const focus   = faceData.focusScore || 0;

  // FIX 2: Only inject face context when something meaningful is detected.
  // Neutral emotion with normal focus = nothing worth mentioning.
  // This stops Aria obsessing over fatigue when nothing is actually wrong.
  if (emotion === 'neutral' && focus >= 50) return '';

  const conf     = Math.round((faceData.emotionConfidence || 0) * 100);
  const bpm      = faceData.blinkRate || 0;
  const ear      = parseFloat(faceData.ear || 0).toFixed(3);
  const mins     = Math.round((faceData.sessionMs || 0) / 60000);
  const eyeState = ear < 0.15 ? 'eyes look very tired or heavy'
                 : ear < 0.20 ? 'eyes showing some fatigue'
                 : 'eyes open and alert';
  const focusLvl = focus >= 75 ? 'strong (' + focus + '/100)'
                 : focus >= 50 ? 'moderate (' + focus + '/100)'
                 : 'low (' + focus + '/100)';

  return '[REAL-TIME FACE ANALYSIS — use naturally ONLY if relevant to conversation]\n'
    + 'Detected emotion: ' + emotion + ' (' + conf + '% confidence)\n'
    + 'Focus level: ' + focusLvl + '\n'
    + 'Eye state: ' + eyeState + ' (EAR: ' + ear + ')\n'
    + 'Blink rate: ' + (bpm > 0 ? bpm + '/min (normal 12-20)' : 'not yet measured') + '\n'
    + 'Session: ' + mins + ' minute' + (mins !== 1 ? 's' : '') + '\n'
    + '[END FACE ANALYSIS — do NOT mention this in every message]\n\n';
}

// ── CALL OPENAI ───────────────────────────────────────────────
async function callOpenAI(messages, faceData, isAnalysis) {
  const faceCtx = buildFaceContext(faceData);

  const openaiMessages = [{ role: 'system', content: ARIA_SYSTEM }];

  if (isAnalysis) {
    openaiMessages.push({
      role:    'user',
      content: faceCtx + 'Based on this face data, give one brief warm sentence as a wellness check-in. Be specific and natural. Do not repeat previous observations.',
    });
  } else {
    // Add conversation history
    for (const m of messages.slice(0, -1)) {
      if (!m.content || !m.content.trim()) continue;
      openaiMessages.push({
        role:    m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      });
    }
    // Add current message with face context only if meaningful
    const lastMsg = messages[messages.length - 1];
    openaiMessages.push({
      role:    'user',
      content: faceCtx + lastMsg.content,
    });
  }

  const completion = await openaiClient.chat.completions.create({
    model:       'gpt-4o-mini',
    messages:    openaiMessages,
    temperature: 0.85,
    max_tokens:  isAnalysis ? 80 : 500,
  });

  return completion.choices[0].message.content.trim();
}

// ── CALL GROQ (backup) ────────────────────────────────────────
async function callGroq(messages, faceData, isAnalysis) {
  const faceCtx = buildFaceContext(faceData);
  const groqMessages = [{ role: 'system', content: ARIA_SYSTEM }];

  if (isAnalysis) {
    groqMessages.push({
      role:    'user',
      content: faceCtx + 'One brief warm sentence wellness check-in based on face data.',
    });
  } else {
    for (const m of messages.slice(0, -1)) {
      if (!m.content || !m.content.trim()) continue;
      groqMessages.push({
        role:    m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      });
    }
    const lastMsg = messages[messages.length - 1];
    groqMessages.push({
      role:    'user',
      content: faceCtx + lastMsg.content,
    });
  }

  const completion = await groqClient.chat.completions.create({
    model:       'llama-3.1-8b-instant',
    messages:    groqMessages,
    temperature: 0.85,
    max_tokens:  isAnalysis ? 60 : 400,
  });

  return completion.choices[0].message.content.trim();
}

// ── MAIN AI DISPATCHER ────────────────────────────────────────
async function callAI(messages, faceData, isAnalysis) {
  // Try OpenAI first (primary — best quality)
  if (openaiClient) {
    try {
      const response = await callOpenAI(messages, faceData, isAnalysis);
      return { response, provider: 'openai' };
    } catch (e) {
      const isQuota = e.status === 429 || (e.message && e.message.includes('quota'));
      console.log('[Aria] OpenAI ' + (isQuota ? 'quota/rate limit' : 'error') + ': ' + e.message.substring(0, 60));
    }
  }

  // Fall back to Groq
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

// ── ROUTES ────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const provider = openaiClient ? 'gpt-4o-mini+groq-backup' : groqClient ? 'groq-only' : 'no-key';
  res.json({ status: 'ok', ai: 'aria-ready', provider, time: new Date().toISOString() });
});

// FIX 1: Cooldown tracker — prevents Aria from auto-firing more than
// once every 10 minutes per session. Kills the repetitive loop.
const analyzeCooldowns  = new Map();
const ANALYZE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

app.post('/analyze', async (req, res) => {
  try {
    if (!openaiClient && !groqClient)
      return res.status(500).json({ error: 'No AI configured.' });

    // Use sessionId from body if provided, else fall back to IP
    const sessionId = req.body.sessionId || req.ip || 'default';
    const lastTime  = analyzeCooldowns.get(sessionId) || 0;
    const now       = Date.now();

    // Still within cooldown window — return silent null, no AI call made
    if (now - lastTime < ANALYZE_COOLDOWN_MS) {
      return res.json({ response: null, skipped: true });
    }

    // Outside cooldown — update timestamp and proceed
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
    console.log('  Aria:', result.response.substring(0, 100));
    res.json({ response: result.response, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[/chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────
const ready = initAI();

app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║       Face AI Tracker — Aria Wellness Coach         ║');
  console.log('║  Primary: GPT-4o-mini  |  Backup: Groq Llama 3.1   ║');
  console.log('╚════════════════════════════════════════════════════╝\n');
  if (ready) {
    console.log('✓  Aria is ready. Deep wellness coaching active.\n');
  } else {
    console.log('⚠  Add OPENAI_API_KEY to environment variables.\n');
  }
});