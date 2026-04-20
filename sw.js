// ═══════════════════════════════════════════════════════════════
// Face AI Tracker — Service Worker
// Enables: offline use, fast loading, PWA installation
//
// HOW IT WORKS:
// 1. On first visit: caches all app files
// 2. On later visits: serves from cache instantly (fast!)
// 3. If offline: still works with cached files
// 4. AI models: cached after first download (~5MB total)
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME    = 'face-ai-tracker-v1';
const CACHE_TIMEOUT = 5000; // 5 second network timeout

// Files to cache on install
// These are the core app files — always available offline
const CORE_FILES = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.json',
];

// ── INSTALL ──────────────────────────────────────────────────
// Runs once when the service worker is first registered.
// Pre-caches all core app files.
self.addEventListener('install', function(event) {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      console.log('[SW] Caching core files');
      return cache.addAll(CORE_FILES);
    }).then(function() {
      // Activate immediately without waiting for old SW to die
      return self.skipWaiting();
    })
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────
// Runs when the new service worker takes control.
// Cleans up old caches from previous versions.
self.addEventListener('activate', function(event) {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function(name) { return name !== CACHE_NAME; })
          .map(function(name) {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(function() {
      // Take control of all open pages immediately
      return self.clients.claim();
    })
  );
});

// ── FETCH ─────────────────────────────────────────────────────
// Intercepts every network request.
// Strategy: Cache First for app files, Network First for API calls
self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);

  // Don't intercept API calls to the backend server
  // These need live network — cache would give stale AI responses
  if (url.port === '3001' || url.hostname.includes('googleapis') ||
      url.hostname.includes('anthropic') || url.hostname.includes('cdn.jsdelivr')) {
    return; // Let it go through normally
  }

  // Don't intercept non-GET requests (POST etc)
  if (event.request.method !== 'GET') return;

  // For everything else: try cache first, fall back to network
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) {
        // Serve from cache instantly
        // Also update cache in background (stale-while-revalidate)
        var fetchPromise = fetch(event.request).then(function(response) {
          if (response && response.status === 200) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        }).catch(function() {
          // Network failed — that's fine, we already served from cache
        });
        return cached;
      }

      // Not in cache — fetch from network and cache it
      return fetch(event.request).then(function(response) {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, clone);
        });
        return response;
      }).catch(function() {
        // Completely offline and not cached — show offline page
        if (event.request.destination === 'document') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

// ── BACKGROUND SYNC ───────────────────────────────────────────
// When connection returns after being offline,
// notify the app so it can reconnect to the AI server
self.addEventListener('sync', function(event) {
  if (event.tag === 'server-reconnect') {
    console.log('[SW] Background sync — checking server');
  }
});

console.log('[SW] Service worker loaded — Face AI Tracker v1');