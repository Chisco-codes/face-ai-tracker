// ═══════════════════════════════════════════════════════════════
// Face AI Tracker — Service Worker v4
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME    = 'face-ai-tracker-v4';
const CACHE_TIMEOUT = 5000;

const CORE_FILES = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.json',
];

self.addEventListener('install', function(event) {
  console.log('[SW] Installing v4...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      console.log('[SW] Caching core files');
      return cache.addAll(CORE_FILES);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event) {
  console.log('[SW] Activating v4...');
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
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);

  // Do not intercept API calls — these need live network
  if (url.port === '3001' ||
      url.hostname.includes('googleapis') ||
      url.hostname.includes('anthropic') ||
      url.hostname.includes('cdn.jsdelivr') ||
      url.hostname.includes('onrender.com') ||
      url.hostname.includes('facewellnessai.com') && url.pathname.startsWith('/chat') ||
      url.hostname.includes('facewellnessai.com') && url.pathname.startsWith('/analyze') ||
      url.hostname.includes('facewellnessai.com') && url.pathname.startsWith('/health') ||
      url.hostname.includes('facewellnessai.com') && url.pathname.startsWith('/feedback')) {
    return;
  }

  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) {
        // Serve from cache, update in background
        fetch(event.request).then(function(response) {
          if (response && response.status === 200) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(event.request, clone);
            });
          }
        }).catch(function() {});
        return cached;
      }

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
        if (event.request.destination === 'document') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

self.addEventListener('sync', function(event) {
  if (event.tag === 'server-reconnect') {
    console.log('[SW] Background sync — checking server');
  }
});

console.log('[SW] Service worker loaded — Face AI Tracker v4');