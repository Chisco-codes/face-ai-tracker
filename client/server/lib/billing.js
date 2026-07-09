// ══════════════════════════════════════════════════════════════
//  billing.js — Premium entitlements via Paystack
//
//  Why Paystack: the project owner is based in Ghana; Paystack is
//  the practical processor there (cards + mobile money) with a
//  clean webhook model. Stripe can be added later behind the same
//  setUserPlan() call without touching anything else.
//
//  Flow:
//  1. Client opens a Paystack checkout (Payment Page or Popup) with
//     metadata.anonId = the user's anonymous id.
//  2. Paystack calls POST /billing/paystack/webhook on success.
//  3. We verify the HMAC-SHA512 signature with PAYSTACK_SECRET_KEY,
//     then upgrade the user's plan in the database.
//
//  SECURITY RULES:
//  • The plan lives server-side only. The client NEVER decides
//    entitlements — it only displays what GET /me returns.
//  • Webhook without a valid signature = 401, no exceptions.
//  • Raw request body is required for HMAC — server.js mounts this
//    route with express.raw() BEFORE the JSON body parser.
// ══════════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');
const db = require('./db');

function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret || !rawBody) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (_) {
    return false;
  }
}

// Express handler — mount with express.raw({ type: 'application/json' })
async function paystackWebhook(req, res) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(503).json({ error: 'Billing not configured.' });

  const raw = req.body; // Buffer (express.raw)
  const sig = req.headers['x-paystack-signature'];
  if (!verifySignature(raw, sig, secret)) {
    console.warn('[Billing] Rejected webhook — bad signature.');
    return res.status(401).json({ error: 'Invalid signature.' });
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch (_) { return res.status(400).json({ error: 'Bad payload.' }); }

  try {
    const data = event.data || {};
    const anonId =
      (data.metadata && (data.metadata.anonId || data.metadata.anon_id)) ||
      (data.customer && data.customer.metadata && data.customer.metadata.anonId);

    switch (event.event) {
      case 'charge.success':
      case 'subscription.create': {
        if (!anonId) {
          console.warn('[Billing] charge.success without metadata.anonId — cannot map to user.');
          break;
        }
        await db.setUserPlan(anonId, 'premium', {
          reference: data.reference || null,
          customerCode: data.customer ? data.customer.customer_code : null,
          amount: data.amount || null,
          currency: data.currency || null,
          at: new Date(),
        });
        console.log('[Billing] ✓ Premium activated for', anonId);
        break;
      }
      case 'subscription.disable':
      case 'subscription.not_renew': {
        if (anonId) {
          await db.setUserPlan(anonId, 'free', { downgradedAt: new Date() });
          console.log('[Billing] Plan downgraded for', anonId);
        }
        break;
      }
      default:
        // Acknowledge everything else so Paystack stops retrying.
        break;
    }
    res.json({ received: true });
  } catch (e) {
    console.error('[Billing] Webhook error:', e.message);
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
}

module.exports = { paystackWebhook, verifySignature };
