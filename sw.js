/* =====================================================================
 *  TWC Outreach Tracker — Service Worker (split-architecture / GitHub Pages)
 * ---------------------------------------------------------------------
 *  Strategy:
 *    • App shell (HTML/CSS/JS/manifest): cache-first, with background
 *      revalidation. Lets the PWA boot instantly offline.
 *    • GAS API calls (cross-origin to script.google.com): network-only.
 *      NEVER cached — they return patient PII / session tokens.
 *    • Other cross-origin (CDN libs, etc.): network-only.
 *    • Navigation requests: network-first with cache fallback (so
 *      users get fresh shell when online, cached shell when off).
 *
 *  Scope is "./" — covers the entire GitHub Pages repo. Registered from
 *  app.js via navigator.serviceWorker.register('./sw.js', { scope:'./' }).
 *
 *  Author : TWC Labs
 * ===================================================================== */
'use strict';

var CACHE_NAME    = 'twc-tracker-v1';
var SHELL_CACHE   = CACHE_NAME + '-shell';
var SHELL_ASSETS  = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  // Lucide icon library (vanilla JS via CDN) — renders the same SVGs as
  // lucide-react. Pre-cached so icons render even on first offline boot.
  'https://unpkg.com/lucide@latest'
];

/* GAS web-app host (cross-origin API). Listed explicitly so we never
 * accidentally cache an API response. */
var GAS_API_HOSTS = [
  'script.google.com',
  'script.googleusercontent.com'
];

/* CDN hosts we explicitly cache (currently just unpkg for the lucide
 * icon script). Other cross-origin requests fall through to network. */
var CDN_CACHE_HOSTS = [
  'unpkg.com'
];

/* =====================================================================
 *  INSTALL — pre-cache the app shell
 * ===================================================================== */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // addAll is atomic; a single failure aborts the install. We use
      // add() per-URL so a missing optional asset (e.g. icon files
      // not yet added by the deployer) doesn't break installation.
      return Promise.all(SHELL_ASSETS.map(function (url) {
        return cache.add(url).catch(function (err) {
          console.warn('[SW] Could not pre-cache:', url, err && err.message);
        });
      }));
    }).then(function () {
      // Take over immediately so the SW is active on first load.
      return self.skipWaiting();
    })
  );
});

/* =====================================================================
 *  ACTIVATE — clean up old caches, claim all open clients
 * ===================================================================== */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) {
          // Remove caches from previous versions
          return k.indexOf('twc-tracker-') === 0 && k !== CACHE_NAME && k !== SHELL_CACHE;
        }).map(function (k) {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        })
      );
    }).then(function () {
      console.log('[SW] Activated. Controlling all clients.');
      return self.clients.claim();
    })
  );
});

/* =====================================================================
 *  FETCH — routing strategy
 *    - Non-GET (POST writes to the API): bypass entirely.
 *    - Cross-origin GAS API calls: network-only (no cache).
 *    - Cross-origin CDN assets (unpkg lucide): cache-first with background
 *      refresh — so icons keep working offline.
 *    - Other cross-origin: network-only.
 *    - Navigations (HTML): network-first, fallback to cached shell.
 *    - Same-origin shell assets: cache-first with background refresh.
 * ===================================================================== */
self.addEventListener('fetch', function (event) {
  var req = event.request;

  // Only handle GET. POST (the API writes) must go straight to network.
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }

  // --- Bypass: GAS API host (cross-origin, never cached) ---
  if (GAS_API_HOSTS.indexOf(url.hostname) !== -1) {
    return; // let the browser hit the network directly
  }

  // --- Cache-first: cross-origin CDN assets we explicitly trust
  //     (currently unpkg.com for the lucide icon script). Other
  //     cross-origin requests still fall through to network-only. ---
  if (url.origin !== self.location.origin && CDN_CACHE_HOSTS.indexOf(url.hostname) !== -1) {
    event.respondWith(
      caches.match(req).then(function (cached) {
        if (cached) {
          // Background refresh so we pick up updates to @latest.
          fetch(req).then(function (resp) {
            if (resp && (resp.status === 200 || resp.type === 'opaque')) {
              caches.open(SHELL_CACHE).then(function (cache) {
                cache.put(req, resp).catch(function () { /* ignore */ });
              });
            }
          }).catch(function () { /* offline — ignore */ });
          return cached;
        }
        // Not in cache — fetch from network, cache the (opaque) response,
        // and return it. Opaque responses are CORS-safely cacheable for
        // <script> tags like the lucide CDN.
        return fetch(req).then(function (resp) {
          if (!resp) return resp;
          var copy = resp.clone();
          caches.open(SHELL_CACHE).then(function (cache) {
            cache.put(req, copy).catch(function () { /* ignore */ });
          });
          return resp;
        }).catch(function () {
          // Offline and not cached — nothing we can do for a CDN asset.
          return new Response('Offline.', { status: 503, statusText: 'Offline' });
        });
      })
    );
    return;
  }

  // --- Bypass: any other cross-origin request ---
  if (url.origin !== self.location.origin) {
    return;
  }

  // --- Navigations (HTML page loads): network-first ---
  if (req.mode === 'navigate' ||
      (req.headers.get('accept') || '').indexOf('text/html') !== -1) {
    event.respondWith(
      fetch(req).then(function (resp) {
        // Cache a fresh copy in the background.
        var copy = resp.clone();
        caches.open(SHELL_CACHE).then(function (cache) {
          cache.put(req, copy).catch(function () { /* ignore */ });
        });
        return resp;
      }).catch(function () {
        // Offline -> serve cached shell (or the root fallback).
        return caches.match(req).then(function (cached) {
          return cached || caches.match('./index.html') || caches.match('./');
        });
      })
    );
    return;
  }

  // --- Same-origin assets (styles.css, app.js, manifest.json, icons):
  //     cache-first with background refresh. ---
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) {
        // Refresh in background so the next visit gets the latest version.
        fetch(req).then(function (resp) {
          if (resp && resp.status === 200 && resp.type === 'basic') {
            caches.open(SHELL_CACHE).then(function (cache) {
              cache.put(req, resp).catch(function () { /* ignore */ });
            });
          }
        }).catch(function () { /* offline — ignore */ });
        return cached;
      }
      // Not in cache — fetch from network, cache a copy, return.
      return fetch(req).then(function (resp) {
        if (!resp || resp.status !== 200 || resp.type !== 'opaque') {
          // Don't cache opaque/error responses.
          if (!resp || resp.type !== 'opaque') return resp;
        }
        var copy = resp.clone();
        caches.open(SHELL_CACHE).then(function (cache) {
          cache.put(req, copy).catch(function () { /* ignore */ });
        });
        return resp;
      }).catch(function () {
        return new Response('Offline.', { status: 503, statusText: 'Offline' });
      });
    })
  );
});

/* =====================================================================
 *  MESSAGE — manual update / skipWaiting / flush-cache from client
 * ===================================================================== */
self.addEventListener('message', function (event) {
  if (event.data === 'twc:skip-waiting') {
    self.skipWaiting();
  }
  if (event.data === 'twc:flush-cache') {
    caches.keys().then(function (keys) {
      Promise.all(keys.map(function (k) { return caches.delete(k); }))
        .then(function () {
          if (event.source && event.source.postMessage) {
            event.source.postMessage('twc:cache-flushed');
          }
        });
    });
  }
});
