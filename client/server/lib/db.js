// ══════════════════════════════════════════════════════════════
//  db.js — Face AI Tracker database layer (MongoDB Atlas)
//
//  Design rules:
//  • If MONGODB_URI is set → MongoDB Atlas (permanent storage).
//  • If not set, or Mongo is unreachable → in-memory fallback so the
//    app NEVER goes down because of the database. Every write also
//    lands in memory, so reads work in both modes.
//  • Privacy: we store derived metrics, summaries and feedback only.
//    Never raw video, never raw frames. Session transcripts are kept
//    only while a session is ACTIVE, then deleted on close — only the
//    summary survives (see sessions.js).
//
//  Collections:
//    users     { _id: anonId, plan, createdAt, lastSeenAt, paystack? }
//    sessions  { _id, userId, mode, state, startedAt, endedAt,
//                summary, metricsTimeline[], exchangeCount }
//    feedback  { rating, comment, ua, createdAt }
// ══════════════════════════════════════════════════════════════
'use strict';

let MongoClient = null;
try { MongoClient = require('mongodb').MongoClient; }
catch (_) { /* mongodb not installed — memory mode only */ }

const state = {
  client: null,
  db: null,
  connected: false,
  // In-memory fallback stores (also act as hot cache in Mongo mode)
  mem: { users: new Map(), sessions: new Map(), feedback: [] },
};

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri || !MongoClient) {
    console.log('[DB] MONGODB_URI not set — running in-memory (data lost on restart).');
    return false;
  }
  try {
    state.client = new MongoClient(uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 6000,
    });
    await state.client.connect();
    state.db = state.client.db(); // db name comes from the URI path (/faceai)
    state.connected = true;
    await Promise.all([
      state.db.collection('sessions').createIndex({ userId: 1, startedAt: -1 }),
      state.db.collection('users').createIndex({ lastSeenAt: -1 }),
    ]).catch(() => {});
    console.log('[DB] ✓ MongoDB Atlas connected — data will persist.');
    return true;
  } catch (e) {
    state.connected = false;
    console.error('[DB] Mongo connection failed — falling back to memory:', e.message);
    return false;
  }
}

const col = (name) => (state.connected ? state.db.collection(name) : null);

// ── USERS ─────────────────────────────────────────────────────
async function getOrCreateUser(anonId) {
  if (!anonId || typeof anonId !== 'string' || anonId.length > 80) return null;
  const now = new Date();
  let user = state.mem.users.get(anonId);
  const c = col('users');
  if (c) {
    user = await c.findOneAndUpdate(
      { _id: anonId },
      { $set: { lastSeenAt: now }, $setOnInsert: { plan: 'free', createdAt: now } },
      { upsert: true, returnDocument: 'after' }
    );
    user = user && (user.value || user); // driver v4/v5 shape difference
  }
  if (!user) {
    user = state.mem.users.get(anonId) || { _id: anonId, plan: 'free', createdAt: now };
    user.lastSeenAt = now;
  }
  state.mem.users.set(anonId, user);
  return user;
}

async function setUserPlan(anonId, plan, paystackMeta) {
  const c = col('users');
  const update = { plan, planUpdatedAt: new Date() };
  if (paystackMeta) update.paystack = paystackMeta;
  if (c) await c.updateOne({ _id: anonId }, { $set: update }, { upsert: true });
  const u = state.mem.users.get(anonId) || { _id: anonId, createdAt: new Date() };
  Object.assign(u, update);
  state.mem.users.set(anonId, u);
  return u;
}

async function markPremiumInterest(anonId) {
  const c = col('users');
  const update = { premiumInterestAt: new Date() };
  if (c) await c.updateOne({ _id: anonId }, { $set: update }, { upsert: true });
  const u = state.mem.users.get(anonId) || { _id: anonId, plan: 'free', createdAt: new Date() };
  Object.assign(u, update);
  state.mem.users.set(anonId, u);
  return true;
}

// ── SESSIONS ──────────────────────────────────────────────────
async function saveSession(session) {
  state.mem.sessions.set(session._id, session);
  const c = col('sessions');
  if (c) await c.replaceOne({ _id: session._id }, session, { upsert: true });
  return session;
}

async function getSession(id) {
  if (state.mem.sessions.has(id)) return state.mem.sessions.get(id);
  const c = col('sessions');
  if (!c) return null;
  const s = await c.findOne({ _id: id });
  if (s) state.mem.sessions.set(id, s);
  return s;
}

async function listSessionSummaries(userId, limit = 20) {
  const c = col('sessions');
  if (c) {
    return c
      .find({ userId, state: 'closed' }, { projection: { transcript: 0, metricsTimeline: 0 } })
      .sort({ startedAt: -1 })
      .limit(Math.min(limit, 50))
      .toArray();
  }
  return [...state.mem.sessions.values()]
    .filter((s) => s.userId === userId && s.state === 'closed')
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
    .map(({ transcript, metricsTimeline, ...rest }) => rest);
}

async function deleteUserData(anonId) {
  const cS = col('sessions'), cU = col('users');
  if (cS) await cS.deleteMany({ userId: anonId });
  if (cU) await cU.deleteOne({ _id: anonId });
  for (const [id, s] of state.mem.sessions) if (s.userId === anonId) state.mem.sessions.delete(id);
  state.mem.users.delete(anonId);
  return true;
}

// ── FEEDBACK ──────────────────────────────────────────────────
async function saveFeedback(entry) {
  entry.createdAt = new Date();
  state.mem.feedback.push(entry);
  if (state.mem.feedback.length > 500) state.mem.feedback.shift();
  const c = col('feedback');
  if (c) await c.insertOne({ ...entry });
  return entry;
}

async function readAllFeedback() {
  const c = col('feedback');
  if (c) return c.find({}).sort({ createdAt: -1 }).limit(500).toArray();
  return [...state.mem.feedback].reverse();
}

function status() {
  return {
    mode: state.connected ? 'mongodb-atlas' : 'in-memory',
    persistent: state.connected,
  };
}

module.exports = {
  connect, status,
  getOrCreateUser, setUserPlan, deleteUserData, markPremiumInterest,
  saveSession, getSession, listSessionSummaries,
  saveFeedback, readAllFeedback,
};
