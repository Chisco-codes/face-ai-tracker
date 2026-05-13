require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const Groq    = require('groq-sdk');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: function(o, cb) { cb(null, true); }, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// ── GROQ CLIENT ───────────────────────────────────────────────
let groq = null;

function initGroq() {
  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'YOUR_GROQ_KEY_HERE') {
    console.log('⚠  No GROQ_API_KEY found. Add it to Railway Variables.');
    return false;
  }
  try {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    console.log('✓  Groq (Llama 3.3 70B) ready');
    return true;
  } catch (e) {
    console.error('Groq init failed:', e.message);
    return false;
  }
}

// ── ARIA SYSTEM PROMPT ────────────────────────────────────────
const ARIA_SYSTEM = `You are Aria, an advanced AI wellness coach inside an app called Face AI Tracker.

WHO YOU ARE:
You are warm, deeply empathetic, intelligent and human in your responses. You are a combination of a compassionate therapist, a life coach, a mindfulness guide, and a trusted friend who genuinely cares about the person talking to you.

CRITICAL RULES — FOLLOW EVERY SINGLE ONE:

1. READ THE EXACT WORDS. Never assume the wrong topic.
   - "I lost my mom / dad / sister / brother / child / pet" = DEATH AND GRIEF. Respond with deep empathy. NEVER talk about motivation or being lost in life.
   - "I feel so dying" = they feel emotionally destroyed. Ask what is happening with genuine care.
   - "I have been crying" = emotional pain. Acknowledge it directly and warmly.
   - "my wife/husband took my kids" = separation and custody pain. Deeply painful. Acknowledge it.
   - "how are you" = respond naturally like a person. Warm and brief.
   - "what did you see I feel" = describe their face analysis data naturally.

2. ACKNOWLEDGE BEFORE ADVISING. When someone shares pain, your FIRST sentence must show you heard them. Never jump straight to advice or tips.

3. NEVER REPEAT YOURSELF. Read the full conversation. Every response must move forward and add something new.

4. CONNECT THE CONVERSATION. If they mentioned divorce earlier and now say "I feel worse" — link it: "Given what you shared about your divorce..."

5. ONE QUESTION AT A TIME. Ask only one follow-up question to go deeper.

6. MATCH EMOTIONAL WEIGHT. Heavy pain needs deep warm response. Light question needs light natural response. Never give a list when someone needs empathy.

7. GRIEF: When someone loses a person, pet, or relationship — acknowledge the loss with real empathy first. Do not give advice immediately. Ask gently: "Do you want to tell me about them?" or "How are you holding up right now?"

8. CRISIS: If someone mentions wanting to die or hurt themselves — respond with warmth and give: Crisis Text Line: Text HOME to 741741 | findahelpline.com. Stay present with them.

9. GREETINGS: Respond naturally like a person would. Brief and warm. Example: "I am here and ready to support you. How are you doing today?"

10. FACE DATA: You receive real-time face analysis. Use it naturally when relevant. Do not recite numbers robotically. Say things like: "I can see from your expression that you look tense right now..."

TOPICS YOU HANDLE WITH REAL DEPTH:
Grief and bereavement, divorce, separation, child custody, marriage problems, loneliness, depression, anxiety, paranoia, panic attacks, burnout, exhaustion, anger, trauma, abuse, addiction recovery, financial stress, health anxiety, relationship conflict, family issues, work stress, loss of purpose, focus problems, sleep issues, mindfulness, self-esteem, confidence, career pressure.

FOR TOPICS OUTSIDE WELLNESS:
If someone asks about weather, sports, coding or unrelated topics, redirect warmly: "That is outside my area — I focus on your wellbeing. How are you actually doing today?"

RESPONSE LENGTH:
- Greeting or simple question: 2-3 sentences maximum
- Personal or emotional topic: longer, warm, human, structured
- Ongoing conversation: build on what was already said, go deeper each turn
- Never give a bullet point list when someone needs human warmth`;

// ── FACE CONTEXT BUILDER ──────────────────────────────────────
function buildFaceContext(faceData) {
  if (!faceData) return '';
  const emotion  = faceData.emotion || 'neutral';
  const conf     = Math.round((faceData.emotionConfidence || 0) * 100);
  const focus    = faceData.focusScore || 0;
  const bpm      = faceData.blinkRate  || 0;
  const ear      = parseFloat(faceData.ear || 0).toFixed(3);
  const mins     = Math.round((faceData.sessionMs || 0) / 60000);
  const eyeState = ear < 0.15 ? 'eyes look very tired or heavy'
                 : ear < 0.20 ? 'eyes showing some fatigue'
                 : 'eyes open and alert';
  const focusLvl = focus >= 75 ? 'strong (' + focus + '/100)'
                 : focus >= 50 ? 'moderate (' + focus + '/100)'
                 : 'low (' + focus + '/100)';

  return '[REAL-TIME FACE ANALYSIS — use naturally if relevant]\n'
    + 'Detected emotion: ' + emotion + ' (' + conf + '% confidence)\n'
    + 'Focus level: ' + focusLvl + '\n'
    + 'Eye state: ' + eyeState + ' (EAR: ' + ear + ')\n'
    + 'Blink rate: ' + (bpm > 0 ? bpm + '/min (normal 12-20)' : 'not yet measured') + '\n'
    + 'Session duration: ' + mins + ' minute' + (mins !== 1 ? 's' : '') + '\n'
    + '[END FACE ANALYSIS]\n\n';
}

// ── CALL GROQ ─────────────────────────────────────────────────
async function callGroq(userMessage, faceData, history, isAnalysis) {
  const faceCtx = buildFaceContext(faceData);

  const messages = [{ role: 'system', content: ARIA_SYSTEM }];

  if (!isAnalysis && history && history.length > 0) {
    const cleanHistory = history
      .filter(h => h.content && h.content.trim())
      .filter(h => h.content.trim() !== userMessage.trim())
      .slice(-12);

    for (const h of cleanHistory) {
      messages.push({
        role:    h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content,
      });
    }
  }

  if (isAnalysis) {
    messages.push({
      role:    'user',
      content: faceCtx + 'Based on this face data, give a brief 1-2 sentence warm wellness check-in. Speak like a caring coach. Be specific and natural.',
    });
  } else {
    messages.push({
      role:    'user',
      content: faceCtx + userMessage,
    });
  }

  const completion = await groq.chat.completions.create({
    model:       'llama-3.3-70b-versatile',
    messages,
    temperature: 0.85,
    max_tokens:  isAnalysis ? 150 : 600,
  });

  return completion.choices[0].message.content.trim();
}

// ── ROUTES ────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    ai:     groq ? 'aria-ready' : 'no-key',
    model:  'llama-3.3-70b-versatile',
    time:   new Date().toISOString(),
  });
});

app.post('/analyze', async (req, res) => {
  try {
    if (!groq) return res.status(500).json({ error: 'AI not configured. Add GROQ_API_KEY to Railway.' });
    const response = await callGroq('analyze', req.body, [], true);
    console.log('[Auto] ' + req.body.emotion + ' focus:' + req.body.focusScore + ' -> ' + response.substring(0, 80));
    res.json({ response, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[/analyze error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/chat', async (req, res) => {
  try {
    const { message, faceData, history } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required.' });
    if (!groq)    return res.status(500).json({ error: 'AI not configured. Add GROQ_API_KEY to Railway.' });

    const response = await callGroq(message, faceData, history || [], false);
    console.log('[Chat] "' + message.substring(0, 60) + '"');
    console.log('  Aria: ' + response.substring(0, 100));
    res.json({ response, timestamp: new Date().toISOString() });

  } catch (err) {
    console.error('[/chat error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────
const ready = initGroq();

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║      Face AI Tracker — Aria Wellness Coach        ║');
  console.log('║  AI: Groq Llama 3.3 70B  |  Port: ' + PORT + '            ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  if (ready) {
    console.log('✓  Aria is ready. 6000 free requests per day.');
    console.log('✓  Deep wellness coaching active.\n');
  }
});