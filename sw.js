// ═══════════════════════════════════════════════════════════════
// Face AI Tracker — Service Worker (Fixed v4)
//
// FIXES:
// ─ Version bumped to v4 → clears old cache on Android
// ─ SKIP_WAITING message handler → activates immediately
//   (eliminates "old model" warning on Android Chrome)
// ─ Cache-first for app shell, network-first for AI/CDN
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME    = 'face-ai-tracker-v9';   // ← bumped from v3
const CACHE_TIMEOUT = 5000;

const CORE_FILES = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/sessions.js',
  '/sessions.css',
  '/manifest.json',
];

// ── INSTALL ──────────────────────────────────────────────────
self.addEventListener('install', function(event) {
  console.log('[SW v9] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      console.log('[SW v9] Caching core files');
      // addAll can fail if one file is missing — use individual puts
      return Promise.allSettled(
        CORE_FILES.map(function(url) {
          return fetch(url).then(function(response) {
            if (response.ok) return cache.put(url, response);
          }).catch(function(e) {
            console.warn('[SW v9] Could not cache:', url, e.message);
          });
        })
      );
    }).then(function() {
      // Do NOT call self.skipWaiting() here automatically —
      // instead wait for the SKIP_WAITING message from app.js
      // This prevents the "old model" prompt on Android
      console.log('[SW v9] Install complete — waiting for activation signal');
    })
  );
});

// ── MESSAGE HANDLER ────────────────────────────────────────────
// app.js posts SKIP_WAITING when it detects a new SW is ready
// This is the clean way to activate without the Android warning
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW v4] SKIP_WAITING received — activating now');
    self.skipWaiting();
  }
});

// ── ACTIVATE ─────────────────────────────────────────────────
self.addEventListener('activate', function(event) {
  console.log('[SW v9] Activating...');
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function(name) { return name !== CACHE_NAME; })
          .map(function(name) {
            console.log('[SW v9] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── FETCH ──────────────────────────────────────────────────────
self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);

  // Always bypass: API calls, CDN resources, AI backends
  // These must always be fresh
  var bypassHosts = [
    'googleapis.com',
    'anthropic.com',
    'cdn.jsdelivr.net',
    'onrender.com',
    'gstatic.com',
    'fonts.gstatic.com',
    'fonts.googleapis.com',
  ];
  var shouldBypass = bypassHosts.some(function(h) {
    return url.hostname.includes(h);
  });

  // Also bypass local API port
  if (url.port === '3001' || shouldBypass) return;

  // Only intercept GET requests
  if (event.request.method !== 'GET') return;

  // Cache-first with background update (stale-while-revalidate)
  // Network-first: always fetch fresh, fall back to cache
  event.respondWith(
    fetch(event.request).then(function(response) {
      if (!response || response.status !== 200 || response.type === 'opaque') {
        return response;
      }
      var clone = response.clone();
      caches.open(CACHE_NAME).then(function(cache) {
        cache.put(event.request, clone);
      });
      return response;
    }).catch(function() {
      return caches.match(event.request).then(function(cached) {
        if (cached) return cached;
        if (event.request.destination === 'document') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

console.log('[SW] Face AI Tracker service worker v5 loaded');