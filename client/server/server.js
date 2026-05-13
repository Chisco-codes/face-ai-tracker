// ═══════════════════════════════════════════════════════════════
// FACE AI TRACKER — server.js
// Aria Wellness Coach
//
// AI PROVIDER PRIORITY:
// 1. Groq (primary)   — free, 6000 req/day, 30/min, Llama 3.3 70B
// 2. Gemini (backup)  — free tier 1500/day (use if Groq unavailable)
//
// GET FREE GROQ KEY:  https://console.groq.com
// GET FREE GEMINI KEY: https://aistudio.google.com/app/apikey
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: function(o, cb) { cb(null, true); }, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// ── AI CLIENTS ────────────────────────────────────────────────
let groqClient  = null;
let geminiModel = null;

function initAI() {
  // Init Groq
  if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'YOUR_GROQ_KEY_HERE') {
    try {
      const Groq = require('groq-sdk');
      groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
      console.log('✓ Groq (Llama 3.3) ready — primary AI');
    } catch (e) {
      console.error('Groq init failed:', e.message);
    }
  }

  // Init Gemini as backup
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'YOUR_GEMINI_KEY_HERE') {
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      geminiModel = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        generationConfig: { temperature: 0.85, maxOutputTokens: 600 },
      });
      console.log('✓ Gemini ready — backup AI');
    } catch (e) {
      console.error('Gemini init failed:', e.message);
    }
  }

  if (!groqClient && !geminiModel) {
    console.log('⚠  No AI keys found. Add GROQ_API_KEY to .env');
    return false;
  }
  return true;
}

// ── ARIA SYSTEM PROMPT ────────────────────────────────────────
const ARIA_SYSTEM = `You are Aria, an advanced AI wellness coach inside an app called Face AI Tracker.

WHO YOU ARE:
You are warm, deeply empathetic, intelligent and human in your responses. You combine the wisdom of a compassionate therapist, a life coach, a mindfulness guide, and a trusted friend. You genuinely care about the person you are talking to.

CRITICAL RULES — FOLLOW EXACTLY:

1. READ THE EXACT WORDS WRITTEN. Never assume the wrong meaning.
   Examples:
   - "I lost my mom today" = their mother DIED. Respond with grief and deep empathy. NEVER say anything about motivation or being lost in life.
   - "I lost my dad / sister / brother / child / pet" = death and grief. Always respond with empathy first.
   - "I feel so dying" = they feel emotionally destroyed or overwhelmed. Ask what is happening.
   - "I have been crying" = they are in emotional pain. Acknowledge it directly.
   - "my wife took my kids" = separation and custody pain — deeply painful situation.
   - "how are you today" = greet them back warmly like a real person would. Keep it brief and natural.
   - "what did you see I feel" = describe their face data naturally using the face analysis you have.

2. ACKNOWLEDGE BEFORE ADVISING.
   When someone shares pain or difficulty, your FIRST sentence must show you heard them and care. Do not jump to advice or tips.

3. NEVER REPEAT YOURSELF.
   Read the full conversation history. Every response must move the conversation forward. Never say the same thing twice.

4. CONNECT THE CONVERSATION.
   If they mentioned their divorce two messages ago and now say "I feel worse" — connect those: "Given what you shared about your divorce..."

5. ONE QUESTION AT A TIME.
   Ask only one follow-up question to go deeper. Not multiple.

6. MATCH THE EMOTIONAL WEIGHT.
   Heavy pain = deep warm response with real empathy.
   Light casual question = light warm natural response.
   Crisis = immediate compassion + crisis resources.

7. GRIEF SPECIFICALLY:
   When someone loses a person, pet, or relationship:
   - First sentence: acknowledge the loss with genuine empathy
   - Do NOT give advice immediately
   - Ask one gentle question: "Do you want to tell me about them?" or "How are you holding up right now?"

8. CRISIS RESPONSE:
   If someone says they want to die, hurt themselves, or feels completely hopeless:
   Respond with warmth and provide: Crisis Text Line: Text HOME to 741741 | findahelpline.com
   Stay present with them. Do not dismiss or give generic advice.

9. CASUAL GREETINGS:
   If someone says "hi", "hello", "how are you" — respond naturally and warmly like a person. Keep it brief. Example: "I'm here and ready to support you — how are you doing today?"

10. FACE DATA:
    You receive real-time face analysis. Use it naturally when relevant.
    Examples: "I can see from your expression..." or "Your focus has dropped since we started..."
    Do not recite numbers robotically.

TOPICS YOU HANDLE WITH DEPTH:
Grief and bereavement, divorce and separation, child custody, marriage breakdown, loneliness, depression, anxiety, panic attacks, paranoia, burnout, exhaustion, anger management, trauma, abuse recovery, addiction support, financial stress, health anxiety, relationship conflict, family issues, work stress, loss of purpose, focus and productivity, sleep problems, mindfulness, self-esteem, confidence, career pressure.

WHAT YOU DO NOT DO:
- Do not answer questions about weather, sports, coding, news, or completely unrelated topics
- If asked about these, redirect warmly: "That is a bit outside my area — I focus on your wellbeing. How are you actually doing today?"
- Do not give medical diagnoses
- Do not repeat yourself

RESPONSE LENGTH:
- Casual greeting or simple question: 2-3 sentences
- Personal or emotional topic: longer, warm, human, structured without being rigid  
- Ongoing deep conversation: build on what was already said, go deeper each turn`;

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
                 : 'eyes appear open and alert';
  const focusTxt = focus >= 75 ? 'strong (' + focus + '/100)'
                 : focus >= 50 ? 'moderate (' + focus + '/100)'
                 : 'low (' + focus + '/100)';
  return '[REAL-TIME FACE ANALYSIS — use naturally if relevant]\n'
    + 'Emotion detected: ' + emotion + ' (' + conf + '% confidence)\n'
    + 'Focus level: ' + focusTxt + '\n'
    + 'Eye state: ' + eyeState + ' (EAR: ' + ear + ')\n'
    + 'Blink rate: ' + (bpm > 0 ? bpm + '/min (normal is 12-20)' : 'not yet measured') + '\n'
    + 'Session: ' + mins + ' minute' + (mins !== 1 ? 's' : '') + '\n'
    + '[END FACE ANALYSIS]\n\n';
}

// ── GROQ CHAT ─────────────────────────────────────────────────
async function callGroq(messages, faceData) {
  const faceCtx = buildFaceContext(faceData);

  // Build Groq message format
  const groqMessages = [{ role: 'system', content: ARIA_SYSTEM }];

  // Add conversation history
  for (const m of messages.slice(0, -1)) {
    if (!m.content || !m.content.trim()) continue;
    groqMessages.push({
      role:    m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    });
  }

  // Add current message with face context
  const lastMsg = messages[messages.length - 1];
  groqMessages.push({
    role:    'user',
    content: faceCtx + lastMsg.content,
  });

  const completion = await groqClient.chat.completions.create({
    model:       'llama-3.3-70b-versatile',
    messages:    groqMessages,
    temperature: 0.85,
    max_tokens:  600,
  });

  return completion.choices[0].message.content.trim();
}

// ── GEMINI CHAT (backup) ──────────────────────────────────────
async function callGemini(messages, faceData, isAnalysis) {
  const faceCtx = buildFaceContext(faceData);

  if (isAnalysis) {
    const prompt = ARIA_SYSTEM + '\n\n' + faceCtx
      + 'Give a brief 1-2 sentence natural wellness check-in. Speak like a caring coach. Be specific to the face data.';
    const result = await geminiModel.generateContent(prompt);
    return result.response.text().trim();
  }

  // Build Gemini history
  const history = [];
  for (const m of messages.slice(0, -1)) {
    if (!m.content || !m.content.trim()) continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (history.length > 0 && history[history.length - 1].role === role) {
      history[history.length - 1].parts[0].text += '\n' + m.content;
    } else {
      history.push({ role, parts: [{ text: m.content }] });
    }
  }

  const chat   = geminiModel.startChat({ history });
  const lastMsg = messages[messages.length - 1];
  const result  = await chat.sendMessage(ARIA_SYSTEM + '\n\n' + faceCtx + 'User: ' + lastMsg.content);
  return result.response.text().trim();
}

// ── MAIN AI DISPATCHER ────────────────────────────────────────
// Tries Groq first, falls back to Gemini automatically
async function callAI(messages, faceData, isAnalysis) {
  // Try Groq first (primary)
  if (groqClient) {
    try {
      if (isAnalysis) {
        // For auto-analysis use a simple prompt
        const faceCtx = buildFaceContext(faceData);
        const completion = await groqClient.chat.completions.create({
          model:    'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: ARIA_SYSTEM },
            { role: 'user',   content: faceCtx + 'Based only on this face data, give a brief 1-2 sentence natural wellness check-in. Speak like a caring coach doing a quick check-in. Be warm and specific to what you see.' },
          ],
          temperature: 0.85,
          max_tokens:  200,
        });
        return completion.choices[0].message.content.trim();
      } else {
        return await callGroq(messages, faceData);
      }
    } catch (e) {
      const isLimit = e.message && (e.message.includes('429') || e.message.includes('rate') || e.message.includes('limit'));
      console.log('[Aria] Groq ' + (isLimit ? 'rate limited' : 'error') + ':', e.message.substring(0, 80));
      // Fall through to Gemini backup
    }
  }

  // Try Gemini as backup
  if (geminiModel) {
    try {
      return await callGemini(messages, faceData, isAnalysis);
    } catch (e) {
      console.error('[Aria] Gemini error:', e.message.substring(0, 80));
    }
  }

  return null;
}

// ── ROUTES ────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const ai = groqClient ? 'groq+gemini-backup' : geminiModel ? 'gemini-only' : 'no-key';
  res.json({ status: 'ok', ai, time: new Date().toISOString() });
});

app.post('/analyze', async (req, res) => {
  try {
    if (!groqClient && !geminiModel) {
      return res.status(500).json({ error: 'No AI configured. Add GROQ_API_KEY to Railway.' });
    }
    const response = await callAI([{ role: 'user', content: 'analyze' }], req.body, true);
    if (!response) return res.status(500).json({ error: 'AI unavailable' });
    console.log('[Auto] emotion:' + req.body.emotion + ' focus:' + req.body.focusScore + ' ->', response.substring(0, 80));
    res.json({ response, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[/analyze]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/chat', async (req, res) => {
  try {
    const { message, faceData, history } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required.' });
    if (!groqClient && !geminiModel) {
      return res.status(500).json({ error: 'No AI configured. Add GROQ_API_KEY to Railway.' });
    }

    // Build full message array: history + current message
    const messages = [
      ...(history || []).filter(h => h.content && h.content.trim()).slice(-12),
      { role: 'user', content: message },
    ];

    const response = await callAI(messages, faceData, false);
    if (!response) return res.status(500).json({ error: 'AI unavailable — please try again' });

    console.log('[Chat] "' + message.substring(0, 60) + '"');
    console.log('  Aria:', response.substring(0, 100));
    res.json({ response, timestamp: new Date().toISOString() });

  } catch (err) {
    console.error('[/chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────
const ready = initAI();

app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║     Face AI Tracker — Aria Wellness Coach      ║');
  console.log('║  Port: ' + PORT + '                                    ║');
  console.log('╚════════════════════════════════════════════════╝\n');
  if (!ready) {
    console.log('⚠  No AI key found!');
    console.log('   Get FREE Groq key: https://console.groq.com');
    console.log('   Add to Railway Variables: GROQ_API_KEY=gsk_...\n');
  } else {
    if (groqClient)  console.log('✓  Groq Llama 3.3 70B — primary AI (6000 free req/day)');
    if (geminiModel) console.log('✓  Gemini — backup AI (auto-switches if Groq limit hit)');
    console.log('\n   Aria is ready. Deep wellness coaching active.\n');
  }
});