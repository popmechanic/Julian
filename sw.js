// Self-unregistering service worker — clears all caches and removes itself.
// Existing installs will fetch this, activate it, and clean up.
// PWA support can be re-added once the app stabilizes.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    ).then(() => self.registration.unregister())
  );
});
