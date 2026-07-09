// ══════════════════════════════════════════════════════════════
//  sessions.js — Deep Wellness Sessions (client)  v1.0
//
//  Self-contained module. app.js has exactly ONE hook into it
//  (window.AriaSessions.route() inside sendChatMessage). If this
//  file fails to load, the app behaves exactly like v1.
//
//  Provides:
//   1. Anonymous identity   — stable userId in localStorage
//   2. History persistence  — CHAT.history survives page reloads
//   3. Session UI           — picker modal, active banner, end flow
//   4. Session summaries    — rendered as cards, history viewer
//   5. Premium flow         — /me plan check, upgrade prompt (Paystack)
// ══════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────
  // Set this to your Paystack Payment Page URL when billing goes live.
  // Leave '' to show a "coming soon" note instead of a broken link.
  var PAYSTACK_PAYMENT_URL = '';

  var LS_UID     = 'aria_uid';
  var LS_HISTORY = 'aria_chat_history_v1';

  var S = {
    userId: null,
    plan: 'free',
    modes: [],
    active: null,        // { sessionId, mode, modeName }
    serverUrl: null,
  };

  // ── 1. Anonymous identity ───────────────────────────────────
  function getUserId() {
    try {
      var id = localStorage.getItem(LS_UID);
      if (!id) {
        id = 'u_' + (window.crypto && crypto.randomUUID
          ? crypto.randomUUID()
          : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
        localStorage.setItem(LS_UID, id);
      }
      return id;
    } catch (e) { return 'u_ephemeral'; }
  }

  // ── 2. Chat history persistence (Roadmap item 3) ────────────
  function saveHistory() {
    try {
      if (window.CHAT && Array.isArray(CHAT.history)) {
        localStorage.setItem(LS_HISTORY, JSON.stringify(CHAT.history.slice(-24)));
      }
    } catch (e) { /* storage full/blocked — non-fatal */ }
  }

  function restoreHistory() {
    try {
      var raw = localStorage.getItem(LS_HISTORY);
      if (!raw || !window.CHAT) return;
      var saved = JSON.parse(raw);
      if (!Array.isArray(saved) || saved.length === 0) return;
      CHAT.history = saved;
      // Re-render the last few exchanges so the user SEES continuity
      var container = document.getElementById('chat-messages');
      if (!container) return;
      var note = document.createElement('div');
      note.className = 'chat-msg chat-msg--system aria-restored-note';
      note.innerHTML = '<p>↺ Restored your previous conversation.</p>';
      container.appendChild(note);
      saved.slice(-6).forEach(function (m) {
        var div = document.createElement('div');
        div.className = 'chat-msg ' + (m.role === 'user' ? 'chat-msg--user' : 'chat-msg--ai');
        var p = document.createElement('p');
        p.textContent = m.content;
        div.appendChild(p);
        container.appendChild(div);
      });
      container.scrollTop = container.scrollHeight;
    } catch (e) { /* corrupt store — ignore */ }
  }

  // ── 3. Server helpers ───────────────────────────────────────
  function api(path, opts) {
    var base = (window.CHAT && CHAT.SERVER_URL) || S.serverUrl || '';
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(base + path, opts).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, data: j }; });
    });
  }

  function refreshPlan() {
    return api('/me', {
      method: 'POST',
      body: JSON.stringify({ userId: S.userId, locale: navigator.language }),
    }).then(function (r) {
      if (r.ok) {
        S.plan = r.data.plan;
        S.modes = r.data.modes || [];
        S.paymentUrl = r.data.paymentUrl || PAYSTACK_PAYMENT_URL || '';
        S.billingReady = !!r.data.billingReady;
      }
      renderButtonBadge();
    }).catch(function () { /* offline — sessions unavailable, chat still works */ });
  }

  // ── 4. The route() hook used by app.js ──────────────────────
  function route() {
    if (S.active) {
      return {
        path: '/session/message',
        extra: { userId: S.userId, sessionId: S.active.sessionId, locale: navigator.language },
      };
    }
    return { path: '/chat', extra: { locale: navigator.language, userId: S.userId } };
  }

  function onPremiumRequired(data) {
    endLocalSession();
    closeModal();
    var overlay = document.createElement('div');
    overlay.id = 'aria-modal-overlay';
    overlay.className = 'aria-modal-overlay';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });

    var modal = document.createElement('div');
    modal.className = 'aria-modal aria-premium-modal';
    modal.innerHTML =
      '<div class="aria-modal-head"><h3>Premium</h3>' +
      '<button class="aria-modal-close" type="button">✕</button></div>' +
      '<p class="aria-premium-lead">' +
      ((data && data.message) ? data.message : 'This session type is part of the premium plan.') +
      '</p>' +
      '<div class="aria-premium-perks">' +
        '<div class="aria-perk">' + ICON.deep +
          '<div><strong>Deep Conversations</strong><span>Structured 20–30 min sessions with real depth.</span></div></div>' +
        '<div class="aria-perk">' + ICON.focus +
          '<div><strong>Focus reports</strong><span>Your attention, measured and mapped over each session.</span></div></div>' +
        '<div class="aria-perk">' + ICON.sleep +
          '<div><strong>Sleep wind-downs</strong><span>Guided evening sessions that ease you toward rest.</span></div></div>' +
        '<div class="aria-perk">' + ICON.spark +
          '<div><strong>Saved summaries</strong><span>Every session distilled, kept, and yours to revisit.</span></div></div>' +
      '</div>';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'aria-upgrade-btn';
    var payUrl = S.paymentUrl || PAYSTACK_PAYMENT_URL;
    if (S.billingReady) {
      // Automatic checkout: email → server-initialized Paystack session.
      // The email is required by Paystack for the receipt.
      btn.textContent = 'Upgrade now';
      btn.addEventListener('click', function () {
        var existing = modal.querySelector('#aria-billing-email');
        if (!existing) {
          var wrap = document.createElement('div');
          wrap.className = 'aria-email-row';
          wrap.innerHTML =
            '<input id="aria-billing-email" type="email" inputmode="email" ' +
            'placeholder="Your email (for your receipt)" autocomplete="email">';
          modal.insertBefore(wrap, btn);
          btn.textContent = 'Continue to secure payment';
          modal.querySelector('#aria-billing-email').focus();
          return;
        }
        var email = existing.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          existing.classList.add('aria-input-error');
          existing.focus();
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Preparing secure checkout…';
        api('/billing/checkout', {
          method: 'POST',
          body: JSON.stringify({ userId: S.userId, email: email }),
        }).then(function (r) {
          if (r.ok && r.data.url) {
            btn.textContent = 'Opening Paystack…';
            window.open(r.data.url, '_blank', 'noopener');
            btn.textContent = 'Complete payment in the new tab';
          } else {
            btn.disabled = false;
            btn.textContent = 'Try again';
          }
        }).catch(function () { btn.disabled = false; btn.textContent = 'Try again'; });
      });
    } else if (payUrl) {
      btn.textContent = 'Upgrade now';
      btn.addEventListener('click', function () {
        window.open(payUrl, '_blank', 'noopener');
      });
    } else {
      btn.textContent = 'Join the waitlist';
      btn.addEventListener('click', function () {
        btn.disabled = true;
        btn.textContent = 'Saving…';
        api('/premium/interest', { method: 'POST', body: JSON.stringify({ userId: S.userId }) })
          .then(function (r) {
            btn.textContent = r.ok ? "You're on the list — you'll be the first to know." : 'Try again';
            btn.disabled = r.ok;
          })
          .catch(function () { btn.textContent = 'Try again'; btn.disabled = false; });
      });
    }
    modal.appendChild(btn);

    var note = document.createElement('p');
    note.className = 'aria-premium-note';
    note.textContent = 'Aria is a wellness coach, not a licensed therapist. Crisis support is always free, in every plan.';
    modal.appendChild(note);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    modal.querySelector('.aria-modal-close').addEventListener('click', closeModal);
  }

  function onSessionInvalid() {
    endLocalSession();
    systemCard('This session has ended. You are back in normal chat — start a new session anytime.');
  }

  // ── 5. UI ───────────────────────────────────────────────────
  function systemCard(html) {
    var container = document.getElementById('chat-messages');
    if (!container) return;
    var div = document.createElement('div');
    div.className = 'chat-msg chat-msg--system aria-session-card';
    div.innerHTML = '<p>' + html + '</p>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  var ICON = {
    checkin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/></svg>',
    deep:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 10c2.5-3 5.5-3 8 0s5.5 3 8 0"/><path d="M3 15c2.5-3 5.5-3 8 0s5.5 3 8 0"/></svg>',
    focus:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>',
    sleep:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z"/></svg>',
    spark:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
  };

  var MODE_META = {
    checkin: { icon: ICON.checkin, desc: '3-5 min - one focused reflection, one practical step.' },
    deep:    { icon: ICON.deep,    desc: '20-30 min - structured deep conversation with a saved summary.' },
    focus:   { icon: ICON.focus,   desc: '25 min - Aria stays quiet, nudging only when your focus dips.' },
    sleep:   { icon: ICON.sleep,   desc: '10 min - slow wind-down with guided breathing. Screen dims.' },
  };

  function injectButton() {
    var headerRight = document.querySelector('.chat-header-right');
    if (!headerRight || document.getElementById('aria-sessions-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'aria-sessions-btn';
    btn.className = 'aria-sessions-btn';
    btn.type = 'button';
    btn.innerHTML = ICON.spark + '<span>Sessions</span>';
    btn.addEventListener('click', openModal);
    headerRight.insertBefore(btn, headerRight.firstChild);
  }

  function renderButtonBadge() {
    var btn = document.getElementById('aria-sessions-btn');
    if (btn) btn.innerHTML = ICON.spark + '<span>Sessions</span>' + (S.plan === 'premium' ? ' <span class="aria-pro">PRO</span>' : '');
  }

  function openModal() {
    closeModal();
    var overlay = document.createElement('div');
    overlay.id = 'aria-modal-overlay';
    overlay.className = 'aria-modal-overlay';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });

    var modal = document.createElement('div');
    modal.className = 'aria-modal';
    modal.innerHTML =
      '<div class="aria-modal-head"><h3>Deep Wellness Sessions</h3>' +
      '<button class="aria-modal-close" type="button">✕</button></div>' +
      '<p class="aria-disclaimer">Aria is an AI wellness coach, not a licensed therapist or medical ' +
      'professional. Sessions are for reflection, stress relief and emotional support — not diagnosis ' +
      'or treatment. If you are in crisis, please reach out to a professional or local emergency services.</p>' +
      '<div class="aria-mode-grid" id="aria-mode-grid"></div>' +
      '<button class="aria-history-btn" type="button" id="aria-history-btn">View my past session summaries</button>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    modal.querySelector('.aria-modal-close').addEventListener('click', closeModal);
    modal.querySelector('#aria-history-btn').addEventListener('click', showHistory);

    var grid = modal.querySelector('#aria-mode-grid');
    var modes = S.modes.length ? S.modes : [
      { key: 'checkin', name: 'Quick Check-in', premium: false, available: true },
      { key: 'deep', name: 'Deep Conversation', premium: true, available: false },
      { key: 'focus', name: 'Focus Session', premium: true, available: false },
      { key: 'sleep', name: 'Sleep Wind-Down', premium: true, available: false },
    ];
    modes.forEach(function (m) {
      var meta = MODE_META[m.key] || { icon: ICON.spark, desc: '' };
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'aria-mode-card' + (m.available ? '' : ' aria-mode-locked');
      card.innerHTML =
        '<span class="aria-mode-icon">' + meta.icon + '</span>' +
        '<span class="aria-mode-name">' + m.name +
        (m.premium ? ' <span class="aria-lock">' + (m.available ? 'PRO' : '🔒 PRO') + '</span>' : '') +
        '</span><span class="aria-mode-desc">' + meta.desc + '</span>';
      card.addEventListener('click', function () { startSession(m); });
      grid.appendChild(card);
    });
  }

  function closeModal() {
    var o = document.getElementById('aria-modal-overlay');
    if (o) o.remove();
  }

  function startSession(mode) {
    closeModal();
    api('/session/start', {
      method: 'POST',
      body: JSON.stringify({ userId: S.userId, mode: mode.key }),
    }).then(function (r) {
      if (r.status === 402) return onPremiumRequired(r.data);
      if (!r.ok) return systemCard('Could not start the session (' + (r.data.error || r.status) + '). Normal chat still works.');
      S.active = { sessionId: r.data.sessionId, mode: r.data.mode, modeName: r.data.modeName };
      showBanner();
      if (mode.key === 'sleep') document.body.classList.add('aria-sleep-dim');
      systemCard('<strong>' + r.data.modeName + '</strong> started. Everything you say now is part of this ' +
        'session — Aria has deeper context here, and you\'ll get a summary when you end it.');
      var input = document.getElementById('chat-input');
      if (input) input.focus();
    }).catch(function () {
      systemCard('Server unreachable — sessions need the server online. Normal chat fallback still works.');
    });
  }

  function showBanner() {
    hideBanner();
    var inputRow = document.querySelector('.chat-input-row');
    if (!inputRow || !S.active) return;
    var b = document.createElement('div');
    b.id = 'aria-session-banner';
    b.className = 'aria-session-banner';
    b.innerHTML =
      '<span class="aria-banner-dot"></span><span class="aria-banner-name">' + S.active.modeName + '</span><span class="aria-banner-live">Live</span>' +
      '<button type="button" class="aria-end-btn">End session</button>';
    b.querySelector('.aria-end-btn').addEventListener('click', endSession);
    inputRow.parentNode.insertBefore(b, inputRow);
  }

  function hideBanner() {
    var b = document.getElementById('aria-session-banner');
    if (b) b.remove();
  }

  function endLocalSession() {
    S.active = null;
    hideBanner();
    document.body.classList.remove('aria-sleep-dim');
  }

  function endSession() {
    if (!S.active) return;
    var sid = S.active.sessionId;
    systemCard('Wrapping up your session and writing your summary…');
    api('/session/end', {
      method: 'POST',
      body: JSON.stringify({ userId: S.userId, sessionId: sid }),
    }).then(function (r) {
      endLocalSession();
      if (r.ok && r.data.session && r.data.session.summary) {
        renderSummary(r.data.session);
      } else {
        systemCard('Session ended. (Summary unavailable right now — it may appear in your history later.)');
      }
    }).catch(function () {
      endLocalSession();
      systemCard('Session ended locally. The summary will be generated when the server is reachable.');
    });
  }

  function mdLite(text) {
    // minimal, safe markdown: **bold** and newlines only, everything else escaped
    var esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  }

  function renderSummary(session) {
    var container = document.getElementById('chat-messages');
    if (!container) return;
    var card = document.createElement('div');
    card.className = 'chat-msg chat-msg--system aria-summary-card';

    var dur = '';
    if (session.startedAt && session.endedAt) {
      var mins = Math.max(1, Math.round((new Date(session.endedAt) - new Date(session.startedAt)) / 60000));
      dur = mins + ' min';
    }

    var head = document.createElement('div');
    head.className = 'aria-summary-head';
    head.innerHTML =
      '<span class="aria-summary-kicker">Session summary</span>' +
      '<span class="aria-summary-mode">' + session.modeName + (dur ? ' · ' + dur : '') + '</span>';
    card.appendChild(head);

    // Parse "**Heading** — body" / "**Heading**: body" sections into rows;
    // anything unparsed renders as plain paragraphs.
    var text = String(session.summary || '');
    var parts = text.split(/\*\*(.+?)\*\*/); // odd indexes = headings
    var body = document.createElement('div');
    body.className = 'aria-summary-body';
    if (parts.length > 2) {
      for (var i = 1; i < parts.length; i += 2) {
        var heading = parts[i].replace(/[\s—:-]+$/, '');
        var content = (parts[i + 1] || '').replace(/^[\s—:-]+/, '').trim();
        if (!content) continue;
        var row = document.createElement('div');
        row.className = 'aria-summary-row';
        var h = document.createElement('span');
        h.className = 'aria-summary-label';
        h.textContent = heading;
        var p = document.createElement('p');
        p.textContent = content;
        row.appendChild(h);
        row.appendChild(p);
        body.appendChild(row);
      }
    } else {
      var plain = document.createElement('p');
      plain.textContent = text;
      body.appendChild(plain);
    }
    card.appendChild(body);

    var foot = document.createElement('div');
    foot.className = 'aria-summary-foot';
    foot.textContent = session.exchangeCount + ' exchanges · ' +
      (session.metrics && session.metrics.samples ? session.metrics.samples + ' metric samples · ' : '') +
      'saved to your history';
    card.appendChild(foot);

    container.appendChild(card);
    container.scrollTop = container.scrollHeight;
  }

  function showHistory() {
    closeModal();
    api('/session/history?userId=' + encodeURIComponent(S.userId), { method: 'GET' })
      .then(function (r) {
        var list = (r.ok && r.data.sessions) || [];
        if (list.length === 0) return systemCard('No past session summaries yet — your first Deep Wellness Session will appear here.');
        systemCard('<strong>Your past sessions</strong> (' + list.length + ')');
        list.slice(0, 5).forEach(renderSummary);
      })
      .catch(function () { systemCard('Could not load history — server unreachable.'); });
  }

  // ── Boot ────────────────────────────────────────────────────
  function boot() {
    if (!window.CHAT) { setTimeout(boot, 300); return; } // app.js not ready yet
    S.userId = getUserId();
    restoreHistory();
    injectButton();
    refreshPlan();
    setInterval(saveHistory, 5000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') saveHistory();
    });
    window.addEventListener('beforeunload', saveHistory);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Public hook surface for app.js
  window.AriaSessions = {
    route: route,
    onPremiumRequired: onPremiumRequired,
    onSessionInvalid: onSessionInvalid,
    state: S,
  };
})();
