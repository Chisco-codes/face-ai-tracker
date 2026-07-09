// ══════════════════════════════════════════════════════════════
//  crisis.js — Crisis safety layer
//
//  NON-NEGOTIABLE DESIGN RULES (Part G of the project brief):
//  1. Runs on EVERY inbound message — free chat, premium sessions,
//     everything. No paywall, no session mode, no config flag can
//     bypass it.
//  2. Stage 1 (regex) requires NO network and NO AI provider — if
//     OpenAI and Groq are both down, a person in crisis still gets
//     an immediate, warm response with real resources.
//  3. Stage 2 (model check) only runs on "soft" matches to reduce
//     false positives — never to reduce sensitivity of hard matches.
//  4. Resources are region-aware. Hard-coding one US number for a
//     global audience is a bug; findahelpline.com covers 130+
//     countries and is always included.
// ══════════════════════════════════════════════════════════════
'use strict';

// ── Stage 1: pattern detection ────────────────────────────────
// HARD: unambiguous — respond with crisis support immediately.
const HARD_PATTERNS = [
  /suicid/i,
  /kill (myself|my self)/i,
  /end (my|it all|my life)/i,
  /take my (own )?life/i,
  /don'?t want to (be here|live|exist|wake up)/i,
  /want to die/i,
  /better off (dead|without me)/i,
  /no reason to (live|go on|keep going)/i,
  /(hurt|harm|cut)(ting)? myself/i,
  /self[\s-]?harm/i,
];

// SOFT: ambiguous — could be crisis or figure of speech.
// These go to Stage 2 (model check) when a provider is available;
// if no provider is available we treat them as crisis (fail safe).
const SOFT_PATTERNS = [
  /can'?t (do this|go on|take (it|this)) anymore/i,
  /what'?s the point of (anything|living|it all)/i,
  /everyone would be better/i,
  /give up on everything/i,
  /disappear forever/i,
];

function stage1(text) {
  if (!text) return { level: 'none' };
  if (HARD_PATTERNS.some((p) => p.test(text))) return { level: 'hard' };
  if (SOFT_PATTERNS.some((p) => p.test(text))) return { level: 'soft' };
  return { level: 'none' };
}

// ── Stage 2: model confirmation for soft matches ──────────────
// Cheap, strict, single-token style check. Any failure → fail SAFE
// (treat as crisis). Sensitivity errors must always favour the user.
async function stage2(text, openaiClient, groqClient) {
  const sys =
    'You are a safety classifier. Reply with exactly one word: CRISIS if the ' +
    'message expresses suicidal ideation, intent to self-harm, or acute ' +
    'danger to self; otherwise SAFE. When uncertain, reply CRISIS.';
  try {
    if (openaiClient) {
      const r = await openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: text }],
        temperature: 0,
        max_tokens: 3,
      });
      return /crisis/i.test(r.choices[0].message.content);
    }
    if (groqClient) {
      const r = await groqClient.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: text }],
        temperature: 0,
        max_tokens: 3,
      });
      return /crisis/i.test(r.choices[0].message.content);
    }
  } catch (_) { /* fall through to fail-safe */ }
  return true; // no provider / provider error → fail safe
}

// ── Region-aware resources ────────────────────────────────────
// Only verified, stable entries. findahelpline.com is the universal
// directory and is ALWAYS included. Do not invent local numbers —
// wrong numbers are worse than the directory.
const RESOURCES = {
  US: ['📞 Call or text 988 (Suicide & Crisis Lifeline)', '💬 Crisis Text Line: text HOME to 741741'],
  CA: ['📞 Call or text 988 (Canada Suicide Crisis Helpline)'],
  GB: ['📞 Samaritans: 116 123 (free, 24/7)'],
  IE: ['📞 Samaritans: 116 123 (free, 24/7)'],
  AU: ['📞 Lifeline: 13 11 14'],
  GH: ['🚨 Emergency services: 112'],
  NG: ['🚨 Emergency services: 112'],
  DEFAULT: [],
};

function detectCountry(req) {
  // Priority: explicit client hint → proxy geo headers → Accept-Language region.
  const hint = (req.body && req.body.locale && String(req.body.locale)) || '';
  const m = hint.match(/[-_]([A-Z]{2})\b/);
  if (m) return m[1];
  const geo = req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country-code'];
  if (geo && /^[A-Z]{2}$/i.test(geo)) return geo.toUpperCase();
  const al = req.headers['accept-language'] || '';
  const m2 = al.match(/[-_]([A-Z]{2})[;,]?/);
  if (m2) return m2[1].toUpperCase();
  return null;
}

function buildCrisisResponse(country) {
  const local = RESOURCES[country] || RESOURCES.DEFAULT;
  const lines = [
    "I hear you, and I'm really glad you told me. What you're feeling right now matters, and you don't have to carry it alone.",
    '',
    'Please reach out to someone who can truly be there with you right now:',
    ...local,
    '🌍 Find a helpline in your country: findahelpline.com',
    '🚨 If you are in immediate danger, contact your local emergency services.',
    '',
    "I'm staying right here with you too. Is there someone near you — a friend, family member, anyone — you could call or be with right now?",
  ];
  return lines.join('\n');
}

// ── Public API ────────────────────────────────────────────────
// Returns { crisis: bool, response?: string }
// The caller MUST send `response` verbatim and skip normal AI flow
// when crisis === true. Never gate this behind plan checks.
async function check(text, req, openaiClient, groqClient) {
  const s1 = stage1(text);
  if (s1.level === 'none') return { crisis: false };
  if (s1.level === 'soft') {
    const confirmed = await stage2(text, openaiClient, groqClient);
    if (!confirmed) return { crisis: false };
  }
  const country = detectCountry(req);
  return { crisis: true, response: buildCrisisResponse(country), country: country || 'unknown' };
}

module.exports = { check, stage1, buildCrisisResponse, detectCountry };
