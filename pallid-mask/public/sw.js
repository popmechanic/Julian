// v3 — auto-update on deploy
// Minimal service worker — enables PWA install prompt and fullscreen.
// No offline caching: the installation requires a live server.

// Skip waiting so new versions activate immediately
self.addEventListener('install', () => self.skipWaiting());

// Claim all clients and clear old caches on activation
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))),
    ])
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
