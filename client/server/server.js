require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: function(o, cb) { cb(null, true); }, credentials: true }));
app.use(express.json({ limit: '10mb' }));

let genAI = null;
let model = null;

// System instruction set once on the model — Gemini keeps it across all turns
const ARIA_SYSTEM = `You are Aria, an advanced AI wellness coach inside an app called Face AI Tracker.

WHO YOU ARE:
You are warm, deeply empathetic, intelligent, and human in how you respond. You think carefully before responding. You are a combination of a compassionate therapist, a life coach, a mindfulness guide, and a trusted friend who genuinely cares.

CRITICAL RULES YOU MUST ALWAYS FOLLOW:

1. READ THE EXACT WORDS. Do not guess or assume. "I lost my mom today" means someone's mother died — respond with grief support. "I feel so dying" means someone feels like they are falling apart inside — respond with deep empathy and ask what is going on. "I have been crying" means they have been in emotional pain — acknowledge that directly.

2. NEVER match the wrong topic. Examples:
   - "lost" in "I lost my mom" = DEATH/GRIEF — not "motivation" or "being lost"
   - "dying" = emotional collapse or feeling destroyed inside — not literal death unless they say so
   - "crying" = emotional pain — acknowledge it, do not skip it
   - "my wife took my kids" = separation, custody pain, broken family — deeply painful
   - "feel so bad" = general distress — ask what kind of bad
   - "how are you" = greet back warmly, briefly

3. ALWAYS acknowledge what was said before giving any advice. If someone shares pain, your first sentence must reflect that pain back to them so they feel heard.

4. NEVER repeat a response you already gave. Read the full conversation history and always move forward. Each response should advance the conversation, not repeat it.

5. ALWAYS stay connected to the conversation context. If they mentioned divorce two messages ago and now say "I feel worse", connect those. Say "Given what you shared about your divorce earlier..."

6. Ask only ONE question at a time to go deeper. Not multiple questions.

7. When someone asks how you are: respond warmly and naturally like a person would. Example: "I'm here and ready to support you — thanks for asking. How are you doing today?"

8. When someone asks what you see from their face: use the face data provided and describe it naturally. Example: "Right now I can see you appear neutral but your focus has dropped — sometimes our face hides what we actually feel inside."

9. Match emotional weight. Heavy pain = deep warm response. Light question = light warm response. Do not give a list when someone needs empathy.

10. If something is unclear, ask one short warm clarifying question. Never give a generic response when you do not understand — always ask.

FACE DATA:
You receive real-time face analysis. Use it naturally when relevant:
- Weave it into responses: "I can see from your expression..."
- Do not recite numbers robotically
- Use it to show you are genuinely watching and noticing

TOPICS YOU HANDLE WITH DEPTH:
Grief and loss (death of loved ones, pets, relationships), divorce, separation, child custody, marriage breakdown, loneliness, depression, anxiety, paranoia, burnout, exhaustion, anger, trauma, abuse, addiction, financial stress, health fears, purpose and direction, focus and productivity, sleep, mindfulness, breathing, self-esteem, confidence.

GRIEF SPECIFICALLY:
When someone says they lost someone (parent, child, friend, partner, pet):
- First sentence: acknowledge the loss directly and with real empathy
- Do NOT give advice immediately
- Ask one question: "Do you want to tell me about them?" or "How are you holding up right now?"
- Stay present with them

CRISIS:
If someone says they want to die, hurt themselves, or feels completely hopeless — respond with genuine warmth, stay present, and include crisis resources:
Crisis Text Line: Text HOME to 741741
International: findahelpline.com
Never dismiss a crisis moment. Never give a generic response to one.

FACE TRACKER QUESTIONS:
If someone asks about their focus, emotion, eye health, blink rate, or how the app works — answer clearly and specifically using their face data. This app tracks their face and you should be able to explain what you see.

WHAT YOU DO NOT DO:
- You do not answer questions about weather, sports, coding, news, or unrelated topics
- If asked about these, redirect warmly: "That's outside my area — I focus on your wellbeing. How are you actually doing today?"
- You never repeat yourself
- You never give a list when empathy is needed
- You never ignore what someone just said`;

function initGemini() {
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'YOUR_GEMINI_KEY_HERE') return false;
  try {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: ARIA_SYSTEM,
      generationConfig: {
        temperature:     0.85,
        topP:            0.95,
        maxOutputTokens: 600,
      },
    });
    console.log('Gemini model initialized with Aria system instruction');
    return true;
  } catch (e) {
    console.error('Gemini init failed:', e.message);
    return false;
  }
}

function buildFaceContext(faceData) {
  if (!faceData) return '';
  const emotion    = faceData.emotion || 'neutral';
  const conf       = Math.round((faceData.emotionConfidence || 0) * 100);
  const focus      = faceData.focusScore || 0;
  const bpm        = faceData.blinkRate  || 0;
  const ear        = parseFloat(faceData.ear || 0).toFixed(3);
  const mins       = Math.round((faceData.sessionMs || 0) / 60000);
  const eyeState   = ear < 0.15 ? 'eyes look very tired or heavy'
                   : ear < 0.20 ? 'eyes showing fatigue'
                   : 'eyes open and alert';
  const focusTxt   = focus >= 75 ? 'strong (' + focus + '/100)'
                   : focus >= 50 ? 'moderate (' + focus + '/100)'
                   : 'low (' + focus + '/100)';

  return '[REAL-TIME FACE DATA — use naturally if it adds value]\n'
    + 'Detected emotion: ' + emotion + ' (' + conf + '% confidence)\n'
    + 'Focus level: ' + focusTxt + '\n'
    + 'Eye state: ' + eyeState + ' (EAR: ' + ear + ')\n'
    + 'Blink rate: ' + (bpm > 0 ? bpm + '/min (normal 12-20)' : 'not yet measured') + '\n'
    + 'Session duration: ' + mins + ' minute' + (mins !== 1 ? 's' : '') + '\n'
    + '[END FACE DATA]\n\n';
}

function cleanError(err) {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('quota') || msg.includes('429') || msg.includes('resource_exhausted'))
    return { status: 429, text: 'quota_exceeded' };
  if (msg.includes('api_key_invalid') || msg.includes('401'))
    return { status: 401, text: 'Invalid API key. Check server/.env' };
  return { status: 500, text: 'AI error: ' + err.message };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ai: model ? 'aria-ready' : 'no-key', time: new Date().toISOString() });
});

// Auto-analysis every 45s — brief proactive check-in
app.post('/analyze', async (req, res) => {
  try {
    if (!model) return res.status(500).json({ error: 'AI not configured.' });

    const faceCtx = buildFaceContext(req.body);
    const prompt  = faceCtx
      + 'Based only on what you see in the face data above, give a brief 1-2 sentence '
      + 'natural observation about this person right now. '
      + 'Speak like a caring wellness coach doing a quick check-in. '
      + 'Do NOT repeat what you said before. Be specific to the data.';

    const result   = await model.generateContent(prompt);
    const response = result.response.text().trim();
    console.log('[Auto]', req.body.emotion, 'focus:', req.body.focusScore, '->', response.substring(0, 80));
    res.json({ response, timestamp: new Date().toISOString() });

  } catch (err) {
    const e = cleanError(err);
    console.error('[/analyze]', err.message);
    res.status(e.status).json({ error: e.text });
  }
});

// Full conversational wellness coaching
app.post('/chat', async (req, res) => {
  try {
    const { message, faceData, history } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required.' });
    if (!model)   return res.status(500).json({ error: 'AI not configured.' });

    const faceCtx = buildFaceContext(faceData);

    // Build clean alternating history for Gemini
    // Gemini requires strict alternating user/model roles
    const rawHistory = (history || [])
      .filter(h => h.content && h.content.trim())
      .filter(h => h.content.trim() !== message.trim()); // exclude current message

    const geminiHistory = [];
    for (let i = 0; i < rawHistory.length; i++) {
      const h    = rawHistory[i];
      const role = h.role === 'assistant' ? 'model' : 'user';
      if (geminiHistory.length > 0 &&
          geminiHistory[geminiHistory.length - 1].role === role) {
        // Merge consecutive same-role messages
        const last = geminiHistory[geminiHistory.length - 1];
        last.parts[0].text += '\n' + h.content;
      } else {
        geminiHistory.push({ role, parts: [{ text: h.content }] });
      }
    }

    // Start chat with history — system instruction already on the model
    const chat = model.startChat({ history: geminiHistory });

    // Send face context + message together
    const fullMessage = faceCtx + 'User says: ' + message;
    const result      = await chat.sendMessage(fullMessage);
    const response    = result.response.text().trim();

    console.log('[Chat] "' + message.substring(0, 60) + '"');
    console.log('  ->', response.substring(0, 100));
    res.json({ response, timestamp: new Date().toISOString() });

  } catch (err) {
    const e = cleanError(err);
    console.error('[/chat]', err.message);
    res.status(e.status).json({ error: e.text });
  }
});

const keyReady = initGemini();

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║      Face AI Tracker — Aria Wellness Coach    ║');
  console.log('║  Port: ' + PORT + '  |  Health: /health               ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  if (!keyReady) {
    console.log('⚠  No Gemini key. Add to server/.env\n');
  } else {
    console.log('✓  Aria is ready. Deep wellness coaching active.\n');
  }
});