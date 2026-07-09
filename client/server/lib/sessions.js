// ══════════════════════════════════════════════════════════════
//  sessions.js — Deep Wellness Session engine
//
//  State machine:  intro → active → closing → closed
//
//  Privacy model:
//  • While ACTIVE: full transcript is held so Aria has deep context.
//  • On CLOSE: an AI summary is generated, then the raw transcript
//    is DELETED. Only summary + metric timeline + metadata persist.
//  • Users can wipe everything via DELETE /me/data.
//
//  Entitlements: mode.premium is enforced here (server-side, never
//  trust the client) — but crisis handling happens BEFORE this
//  module is ever reached (see server.js) so no crisis message can
//  be blocked by a paywall.
// ══════════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');
const db = require('./db');
const { ARIA_SYSTEM, SESSION_MODES, SUMMARY_PROMPT } = require('./prompts');

const ACTIVE_TTL_MS = 90 * 60 * 1000; // auto-expire sessions after 90 min

function newId() {
  return 's_' + crypto.randomBytes(9).toString('base64url');
}

function modeOrNull(mode) {
  return SESSION_MODES[mode] ? { key: mode, ...SESSION_MODES[mode] } : null;
}

// ── Create ────────────────────────────────────────────────────
async function start(userId, modeKey) {
  const mode = modeOrNull(modeKey);
  if (!mode) return { error: 'Unknown session mode.', status: 400 };

  const user = await db.getOrCreateUser(userId);
  if (!user) return { error: 'Valid userId required.', status: 400 };

  const isPremiumUser =
    user.plan === 'premium' || process.env.PREMIUM_ALL === 'true';
  if (mode.premium && !isPremiumUser) {
    return {
      error: 'premium_required',
      message:
        mode.name +
        ' is a premium Deep Wellness Session. Upgrade to unlock deep conversations, focus reports and sleep wind-downs.',
      status: 402,
    };
  }

  const session = {
    _id: newId(),
    userId,
    mode: mode.key,
    modeName: mode.name,
    state: 'active',
    startedAt: new Date(),
    endedAt: null,
    exchangeCount: 0,
    transcript: [],        // deleted at close — summary only survives
    metricsTimeline: [],   // sampled face metrics (numbers only)
    summary: null,
  };
  await db.saveSession(session);
  return { session };
}

// ── Message within a session ──────────────────────────────────
// callAI(messages, faceData, isAnalysis, extraSystem) is injected
// from server.js so this module owns no provider clients.
async function message(sessionId, userId, text, faceData, callAI) {
  const session = await db.getSession(sessionId);
  if (!session || session.userId !== userId)
    return { error: 'Session not found.', status: 404 };
  if (session.state !== 'active')
    return { error: 'Session already closed.', status: 409 };
  if (Date.now() - new Date(session.startedAt).getTime() > ACTIVE_TTL_MS) {
    session.state = 'closing';
    await db.saveSession(session);
    return { error: 'Session expired — please end it to get your summary.', status: 410 };
  }

  const mode = modeOrNull(session.mode);

  // Sample metrics (numbers only — the privacy invariant lives here)
  if (faceData && typeof faceData === 'object') {
    session.metricsTimeline.push({
      t: Date.now(),
      focus: faceData.focusScore ?? null,
      emotion: faceData.emotion ?? null,
      ear: faceData.ear ?? null,
      blinkRate: faceData.blinkRate ?? null,
    });
    if (session.metricsTimeline.length > 240) session.metricsTimeline.shift();
  }

  // Extended in-session context: last 30 exchanges (vs 12 in free chat)
  const history = session.transcript.slice(-60); // 30 exchanges = 60 msgs
  const messages = [...history, { role: 'user', content: text }];

  const result = await callAI(messages, faceData, false, mode.prompt);
  if (!result) return { error: 'AI unavailable — please try again.', status: 500 };

  session.transcript.push({ role: 'user', content: text });
  session.transcript.push({ role: 'assistant', content: result.response });
  session.exchangeCount += 1;
  await db.saveSession(session);

  const nearLimit = session.exchangeCount >= mode.maxExchanges;
  return { response: result.response, provider: result.provider, nearLimit };
}

// ── Metric timeline → compact text for the summary prompt ─────
function timelineDigest(timeline) {
  if (!timeline || timeline.length === 0) return 'No face metrics were recorded.';
  const focuses = timeline.map((p) => p.focus).filter((v) => typeof v === 'number');
  const emotions = timeline.map((p) => p.emotion).filter(Boolean);
  const ears = timeline.map((p) => p.ear).filter((v) => typeof v === 'number');
  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null);
  const counts = {};
  emotions.forEach((e) => (counts[e] = (counts[e] || 0) + 1));
  const topEmotions = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([e, n]) => `${e} (${Math.round((n / emotions.length) * 100)}%)`).join(', ');
  const firstF = focuses.slice(0, Math.max(1, Math.floor(focuses.length / 3)));
  const lastF = focuses.slice(-Math.max(1, Math.floor(focuses.length / 3)));
  return [
    `Samples: ${timeline.length} over the session.`,
    `Focus: avg ${avg(focuses)}, early-session avg ${avg(firstF)}, late-session avg ${avg(lastF)}.`,
    `Dominant emotions: ${topEmotions || 'n/a'}.`,
    `Eye openness (EAR) avg: ${avg(ears)} (below 0.20 suggests fatigue).`,
  ].join('\n');
}

// ── End ───────────────────────────────────────────────────────
async function end(sessionId, userId, callAI) {
  const session = await db.getSession(sessionId);
  if (!session || session.userId !== userId)
    return { error: 'Session not found.', status: 404 };
  if (session.state === 'closed')
    return { session: publicView(session) }; // idempotent

  session.state = 'closing';

  // Build the summary from transcript + metrics, then delete transcript.
  let summary = null;
  if (session.transcript.length > 0 && callAI) {
    const convo = session.transcript
      .map((m) => (m.role === 'user' ? 'User: ' : 'Aria: ') + m.content)
      .join('\n');
    const digest = timelineDigest(session.metricsTimeline);
    const result = await callAI(
      [{ role: 'user', content: `SESSION TRANSCRIPT:\n${convo}\n\nFACE METRIC TIMELINE:\n${digest}\n\nNow write the summary.` }],
      null,
      false,
      SUMMARY_PROMPT
    );
    if (result) summary = result.response;
  }
  if (!summary) {
    summary =
      'Session complete (' + session.modeName + ', ' + session.exchangeCount +
      ' exchanges). Summary generation was unavailable — your metrics were still recorded.';
  }

  session.summary = summary;
  session.endedAt = new Date();
  session.state = 'closed';
  session.transcript = []; // privacy: raw conversation is not retained
  await db.saveSession(session);
  return { session: publicView(session) };
}

function publicView(s) {
  return {
    id: s._id,
    mode: s.mode,
    modeName: s.modeName,
    state: s.state,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    exchangeCount: s.exchangeCount,
    summary: s.summary,
    metrics: { samples: s.metricsTimeline ? s.metricsTimeline.length : 0 },
  };
}

async function history(userId) {
  const list = await db.listSessionSummaries(userId);
  return list.map(publicView);
}

module.exports = { start, message, end, history, SESSION_MODES };
